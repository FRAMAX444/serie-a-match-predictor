#!/usr/bin/env python3
"""Build the static dataset for the Serie A 2026/27 matchday predictor.

The pipeline is intentionally keyless and best-effort:
- Football-Data.co.uk: Serie A results/match statistics and Serie B promotion priors.
- Understat: xG, target-season schedule and player production/continuity.
- ESPN public scoreboard JSON: fallback target-season schedule.
- data/context_overrides.json: optional verified availability, transfers and manager changes.

The output is replaced only after enough historical data has been downloaded. Existing
2026/27 fixtures are retained if all external schedule sources are temporarily unavailable.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from statistics import median
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "matches.json"
OVERRIDES = ROOT / "data" / "context_overrides.json"
USER_AGENT = "Mozilla/5.0 (compatible; SerieAPredictor/2.0; +https://github.com/FRAMAX444/serie-a-match-predictor)"

NAME_MAP = {
    "AS Roma": "Roma", "Roma FC": "Roma", "Internazionale": "Inter", "Inter Milan": "Inter",
    "Internazionale Milano": "Inter", "AC Milan": "Milan", "Juventus FC": "Juventus",
    "Hellas Verona": "Verona", "SSC Napoli": "Napoli", "Napoli SSC": "Napoli",
    "Atalanta BC": "Atalanta", "AC Monza": "Monza", "Monza Brianza": "Monza",
    "US Lecce": "Lecce", "SS Lazio": "Lazio", "Lazio Roma": "Lazio",
    "ACF Fiorentina": "Fiorentina", "Torino FC": "Torino", "Bologna FC 1909": "Bologna",
    "Udinese Calcio": "Udinese", "Genoa CFC": "Genoa", "Cagliari Calcio": "Cagliari",
    "Parma Calcio 1913": "Parma", "Como 1907": "Como", "Venezia FC": "Venezia",
    "US Cremonese": "Cremonese", "US Sassuolo Calcio": "Sassuolo", "Sassuolo Calcio": "Sassuolo",
    "Pisa SC": "Pisa", "Empoli FC": "Empoli", "Frosinone Calcio": "Frosinone",
    "Spezia Calcio": "Spezia", "UC Sampdoria": "Sampdoria", "Salernitana 1919": "Salernitana",
}

FALLBACK_TARGET_TEAMS = {
    "2627": [
        "Atalanta", "Bologna", "Cagliari", "Como", "Fiorentina", "Frosinone", "Genoa", "Inter",
        "Juventus", "Lazio", "Lecce", "Milan", "Monza", "Napoli", "Parma", "Roma", "Sassuolo",
        "Torino", "Udinese", "Venezia",
    ]
}


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_team(name: str) -> str:
    clean = re.sub(r"\s+", " ", (name or "").strip())
    return NAME_MAP.get(clean, clean)


def season_code(start_year: int) -> str:
    return f"{start_year % 100:02d}{(start_year + 1) % 100:02d}"


def season_start(code: str) -> int:
    clean = re.sub(r"\D", "", str(code))
    if len(clean) == 4:
        return 2000 + int(clean[:2])
    if len(clean) == 8:
        return int(clean[:4])
    raise ValueError(f"Codice stagione non valido: {code}")


def likely_start_year(today: date) -> int:
    return today.year if today.month >= 7 else today.year - 1


def resolve_target_season(raw: str | None) -> tuple[str, int]:
    if raw:
        start = season_start(raw)
        return season_code(start), start
    start = likely_start_year(date.today())
    return season_code(start), start


def fetch_bytes(url: str, timeout: int = 35) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str, timeout: int = 35) -> object:
    return json.loads(fetch_bytes(url, timeout=timeout).decode("utf-8", errors="replace"))


def parse_date(value: str) -> str:
    value = value.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"Formato data non riconosciuto: {value}")


def optional_float(row: dict[str, str], *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            try:
                return round(float(value), 3)
            except (ValueError, TypeError):
                pass
    return None


def parse_csv(content: str, season: str, division: str) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for row in csv.DictReader(content.splitlines()):
        if not row.get("Date") or row.get("FTHG") in (None, "") or row.get("FTAG") in (None, ""):
            continue
        try:
            match = {
                "date": parse_date(row["Date"]), "season": season, "division": division,
                "home_team": normalize_team(row.get("HomeTeam", "")),
                "away_team": normalize_team(row.get("AwayTeam", "")),
                "home_goals": int(float(row["FTHG"])), "away_goals": int(float(row["FTAG"])),
                "home_shots": optional_float(row, "HS"), "away_shots": optional_float(row, "AS"),
                "home_sot": optional_float(row, "HST"), "away_sot": optional_float(row, "AST"),
                "home_corners": optional_float(row, "HC"), "away_corners": optional_float(row, "AC"),
                "home_yellow": optional_float(row, "HY"), "away_yellow": optional_float(row, "AY"),
                "home_red": optional_float(row, "HR"), "away_red": optional_float(row, "AR"),
                "home_xg": optional_float(row, "HxG", "HomeXG"), "away_xg": optional_float(row, "AxG", "AwayXG"),
                "home_possession": optional_float(row, "HPoss", "HomePossession"),
                "away_possession": optional_float(row, "APoss", "AwayPossession"),
                "home_odds": optional_float(row, "AvgH", "B365H", "PSH"),
                "draw_odds": optional_float(row, "AvgD", "B365D", "PSD"),
                "away_odds": optional_float(row, "AvgA", "B365A", "PSA"),
            }
        except (ValueError, TypeError):
            continue
        if match["home_team"] and match["away_team"]:
            matches.append(match)
    return matches


def download_division(starts: Iterable[int], division_file: str, division: str) -> list[dict[str, object]]:
    all_matches: list[dict[str, object]] = []
    for start in starts:
        code = season_code(start)
        url = f"https://www.football-data.co.uk/mmz4281/{code}/{division_file}.csv"
        try:
            content = fetch_bytes(url).decode("utf-8-sig", errors="replace")
            parsed = parse_csv(content, code, division)
            if parsed:
                print(f"{division} {code}: {len(parsed)} partite")
                all_matches.extend(parsed)
        except urllib.error.HTTPError as error:
            print(f"{division} {code}: non disponibile (HTTP {error.code})", file=sys.stderr)
        except Exception as error:
            print(f"{division} {code}: errore {error}", file=sys.stderr)
    return all_matches


def decode_understat_json(encoded: str) -> object:
    decoded = bytes(encoded, "utf-8").decode("unicode_escape")
    return json.loads(html.unescape(decoded))


def extract_understat_variable(text: str, names: Iterable[str]) -> object | None:
    for name in names:
        patterns = [
            rf"{re.escape(name)}\s*=\s*JSON\.parse\('([^']+)'\)",
            rf'{re.escape(name)}\s*=\s*JSON\.parse\("([^\"]+)"\)',
        ]
        for pattern in patterns:
            found = re.search(pattern, text)
            if found:
                try:
                    return decode_understat_json(found.group(1))
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                    continue
    return None


def parse_round(item: dict[str, object]) -> int | None:
    for key in ("round", "week", "matchweek", "gameweek"):
        value = item.get(key)
        if value in (None, ""):
            continue
        found = re.search(r"\d+", str(value))
        if found and int(found.group()) > 0:
            return int(found.group())
    return None


def normalize_understat_schedule(data: object, start_year: int) -> list[dict[str, object]]:
    if not isinstance(data, list):
        return []
    season = season_code(start_year)
    result: list[dict[str, object]] = []
    for source_index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        home_data = item.get("h") if isinstance(item.get("h"), dict) else {}
        away_data = item.get("a") if isinstance(item.get("a"), dict) else {}
        home_team = normalize_team(str(home_data.get("title", "")))
        away_team = normalize_team(str(away_data.get("title", "")))
        raw_datetime = str(item.get("datetime", ""))
        match_date = raw_datetime[:10]
        if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
            continue
        schedule_item: dict[str, object] = {
            "id": str(item.get("id", f"understat-{season}-{source_index}")),
            "season": season, "date": match_date,
            "kickoff": raw_datetime.replace(" ", "T") if raw_datetime else None,
            "home_team": home_team, "away_team": away_team,
            "round": parse_round(item), "completed": bool(item.get("isResult")),
            "source_index": source_index, "source": "Understat",
        }
        if item.get("isResult"):
            goals = item.get("goals") if isinstance(item.get("goals"), dict) else {}
            xg = item.get("xG") if isinstance(item.get("xG"), dict) else {}
            try:
                schedule_item["home_goals"] = int(float(goals.get("h")))
                schedule_item["away_goals"] = int(float(goals.get("a")))
            except (TypeError, ValueError):
                schedule_item["home_goals"] = None
                schedule_item["away_goals"] = None
            try:
                schedule_item["home_xg"] = round(float(xg.get("h")), 3)
                schedule_item["away_xg"] = round(float(xg.get("a")), 3)
            except (TypeError, ValueError):
                schedule_item["home_xg"] = None
                schedule_item["away_xg"] = None
        result.append(schedule_item)
    return result


def player_team(value: object) -> str:
    if isinstance(value, list):
        candidates = [normalize_team(str(item)) for item in value if item]
        return candidates[-1] if candidates else ""
    return normalize_team(str(value or ""))


def normalize_understat_players(data: object, start_year: int) -> list[dict[str, object]]:
    if not isinstance(data, list):
        return []
    season = season_code(start_year)
    rows: list[dict[str, object]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        team = player_team(item.get("team_title"))
        name = re.sub(r"\s+", " ", str(item.get("player_name", "")).strip())
        if not team or not name:
            continue
        def numeric(key: str) -> float:
            try:
                return float(item.get(key) or 0)
            except (TypeError, ValueError):
                return 0.0
        rows.append({
            "season": season, "team": team, "name": name,
            "position": str(item.get("position", "")),
            "games": int(numeric("games")), "minutes": numeric("time"),
            "goals": numeric("goals"), "assists": numeric("assists"),
            "xg": numeric("xG"), "xa": numeric("xA"),
            "shots": numeric("shots"), "key_passes": numeric("key_passes"),
            "yellow": numeric("yellow_cards"), "red": numeric("red_cards"),
            "xg_chain": numeric("xGChain"), "xg_buildup": numeric("xGBuildup"),
        })
    return rows


def fetch_understat_bundle(start_year: int) -> dict[str, object]:
    url = f"https://understat.com/league/Serie_A/{start_year}"
    text = fetch_bytes(url).decode("utf-8", errors="replace")
    schedule_data = extract_understat_variable(text, ("datesData", "dates_data"))
    players_data = extract_understat_variable(text, ("playersData", "players_data"))
    return {
        "schedule": normalize_understat_schedule(schedule_data, start_year),
        "players": normalize_understat_players(players_data, start_year),
    }


def fetch_understat_bundles(starts: Iterable[int]) -> dict[int, dict[str, object]]:
    bundles: dict[int, dict[str, object]] = {}
    for start in starts:
        try:
            bundle = fetch_understat_bundle(start)
            schedules = bundle.get("schedule") or []
            players = bundle.get("players") or []
            if schedules or players:
                bundles[start] = bundle
                print(f"Understat {start}: {len(schedules)} gare, {len(players)} righe giocatore")
        except Exception as error:
            print(f"Understat {start}: {error}", file=sys.stderr)
    return bundles


def enrich_xg(matches: list[dict[str, object]], bundles: dict[int, dict[str, object]]) -> int:
    index: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for match in matches:
        index[(str(match["date"]), str(match["home_team"]), str(match["away_team"]))].append(match)
    enriched = 0
    for bundle in bundles.values():
        for item in bundle.get("schedule", []):
            if item.get("home_xg") is None or item.get("away_xg") is None:
                continue
            for match in index.get((str(item["date"]), str(item["home_team"]), str(item["away_team"])), []):
                match["home_xg"] = item["home_xg"]
                match["away_xg"] = item["away_xg"]
                enriched += 1
    return enriched


def parse_espn_event(event: dict[str, object], target_code: str, source_index: int) -> dict[str, object] | None:
    competitions = event.get("competitions")
    if not isinstance(competitions, list) or not competitions or not isinstance(competitions[0], dict):
        return None
    competition = competitions[0]
    competitors = competition.get("competitors")
    if not isinstance(competitors, list):
        return None
    sides: dict[str, dict[str, object]] = {}
    for competitor in competitors:
        if isinstance(competitor, dict):
            sides[str(competitor.get("homeAway", ""))] = competitor
    if "home" not in sides or "away" not in sides:
        return None
    def team_name(side: str) -> str:
        team = sides[side].get("team") if isinstance(sides[side].get("team"), dict) else {}
        return normalize_team(str(team.get("shortDisplayName") or team.get("displayName") or team.get("name") or ""))
    home_team, away_team = team_name("home"), team_name("away")
    raw_date = str(event.get("date") or competition.get("date") or "")
    match_date = raw_date[:10]
    if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
        return None
    status = event.get("status") if isinstance(event.get("status"), dict) else {}
    status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
    completed = bool(status_type.get("completed"))
    week = event.get("week") if isinstance(event.get("week"), dict) else competition.get("week")
    round_number = None
    if isinstance(week, dict):
        try:
            round_number = int(week.get("number"))
        except (TypeError, ValueError):
            round_number = None
    fixture: dict[str, object] = {
        "id": str(event.get("id") or f"espn-{target_code}-{source_index}"),
        "season": target_code, "date": match_date, "kickoff": raw_date or None,
        "home_team": home_team, "away_team": away_team, "round": round_number,
        "completed": completed, "source_index": source_index, "source": "ESPN",
    }
    if completed:
        try:
            fixture["home_goals"] = int(float(sides["home"].get("score")))
            fixture["away_goals"] = int(float(sides["away"].get("score")))
        except (TypeError, ValueError):
            fixture["home_goals"] = None
            fixture["away_goals"] = None
    return fixture


def fetch_espn_schedule(target_code: str, target_start: int) -> list[dict[str, object]]:
    urls = [
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates={target_start}0801-{target_start + 1}0615&limit=1000",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates={target_start}&limit=1000",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates={target_start + 1}&limit=1000",
    ]
    events: list[dict[str, object]] = []
    for url in urls:
        try:
            payload = fetch_json(url)
            if isinstance(payload, dict) and isinstance(payload.get("events"), list):
                events.extend(item for item in payload["events"] if isinstance(item, dict))
        except Exception as error:
            print(f"ESPN calendario: {error}", file=sys.stderr)
    fixtures: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, event in enumerate(events):
        fixture = parse_espn_event(event, target_code, index)
        if not fixture:
            continue
        season_start_date = f"{target_start}-08-01"
        season_end_date = f"{target_start + 1}-06-30"
        if not (season_start_date <= str(fixture["date"]) <= season_end_date):
            continue
        key = f"{fixture['date']}|{fixture['home_team']}|{fixture['away_team']}"
        if key not in seen:
            fixtures.append(fixture)
            seen.add(key)
    return fixtures


def assign_rounds(fixtures: list[dict[str, object]]) -> list[dict[str, object]]:
    teams = sorted({str(item["home_team"]) for item in fixtures} | {str(item["away_team"]) for item in fixtures})
    matches_per_round = max(1, len(teams) // 2 or 10)
    explicit = [item.get("round") for item in fixtures]
    if fixtures and all(isinstance(value, int) and value > 0 for value in explicit):
        return fixtures
    ordered = sorted(fixtures, key=lambda item: (str(item["date"]), int(item.get("source_index", 10**9))))
    for index, item in enumerate(ordered):
        item["round"] = index // matches_per_round + 1
    return ordered


def viable_schedule(fixtures: list[dict[str, object]]) -> bool:
    teams = {str(item["home_team"]) for item in fixtures} | {str(item["away_team"]) for item in fixtures}
    return len(fixtures) >= 100 and len(teams) >= 18


def load_existing_payload() -> dict[str, object]:
    try:
        payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def target_fixtures(
    target_code: str,
    target_start: int,
    bundles: dict[int, dict[str, object]],
    existing: dict[str, object],
) -> tuple[list[dict[str, object]], str]:
    understat = [dict(item) for item in bundles.get(target_start, {}).get("schedule", [])]
    if viable_schedule(understat):
        return assign_rounds(understat), "Understat"
    espn = fetch_espn_schedule(target_code, target_start)
    if viable_schedule(espn):
        return assign_rounds(espn), "ESPN public scoreboard (fallback)"
    existing_fixtures = [
        dict(item) for item in existing.get("fixtures", [])
        if isinstance(item, dict) and str(item.get("season")) == target_code
    ]
    if viable_schedule(existing_fixtures):
        return assign_rounds(existing_fixtures), "dataset precedente conservato"
    return [], "non disponibile; nessun calendario inventato"


def merge_results_into_fixtures(fixtures: list[dict[str, object]], serie_a_matches: list[dict[str, object]]) -> None:
    result_index = {
        (str(match["date"]), str(match["home_team"]), str(match["away_team"])): match
        for match in serie_a_matches
    }
    for fixture in fixtures:
        actual = result_index.get((str(fixture["date"]), str(fixture["home_team"]), str(fixture["away_team"])))
        if actual:
            fixture["completed"] = True
            fixture["home_goals"] = actual["home_goals"]
            fixture["away_goals"] = actual["away_goals"]
        fixture.pop("source_index", None)


def compute_elo(all_matches: list[dict[str, object]]) -> tuple[dict[str, float], str | None]:
    ratings: dict[str, float] = {}
    last_seen: dict[str, datetime] = {}
    latest_date: str | None = None
    for match in sorted(all_matches, key=lambda item: str(item["date"])):
        match_date = datetime.fromisoformat(str(match["date"]))
        division = str(match.get("division", "A"))
        baseline = 1475.0 if division == "A" else 1375.0
        home, away = str(match["home_team"]), str(match["away_team"])
        for team in (home, away):
            current = ratings.get(team, baseline)
            if team in last_seen:
                gap = max(0, (match_date - last_seen[team]).days)
                current = baseline + (current - baseline) * math.exp(-gap / 850)
            ratings[team] = current
            last_seen[team] = match_date
        home_rating, away_rating = ratings[home], ratings[away]
        expected = 1 / (1 + 10 ** ((away_rating - (home_rating + 55)) / 400))
        hg, ag = int(match["home_goals"]), int(match["away_goals"])
        actual = 1.0 if hg > ag else 0.5 if hg == ag else 0.0
        margin = min(1.8, 1 + 0.14 * abs(hg - ag))
        k = 18 if division == "A" else 15
        delta = k * margin * (actual - expected)
        ratings[home] += delta
        ratings[away] -= delta
        latest_date = str(match["date"])
    return {team: round(value, 1) for team, value in ratings.items()}, latest_date


def rows_by_team(rows: Iterable[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["team"])].append(row)
    return grouped


def player_score(row: dict[str, object]) -> float:
    minutes = float(row.get("minutes") or 0)
    ninety = max(minutes / 90, 0.25)
    xg90 = float(row.get("xg") or 0) / ninety
    xa90 = float(row.get("xa") or 0) / ninety
    chain90 = float(row.get("xg_chain") or 0) / ninety
    return minutes * (0.65 + 0.55 * xg90 + 0.42 * xa90 + 0.08 * chain90)


def aggregate_player_team(rows: list[dict[str, object]]) -> dict[str, object]:
    total_minutes = sum(float(row.get("minutes") or 0) for row in rows)
    match_equivalents = max(total_minutes / 990, 0.5)
    total_xg = sum(float(row.get("xg") or 0) for row in rows)
    total_xa = sum(float(row.get("xa") or 0) for row in rows)
    total_key_passes = sum(float(row.get("key_passes") or 0) for row in rows)
    ranked = sorted(rows, key=player_score, reverse=True)
    return {
        "minutes": total_minutes,
        "match_equivalents": match_equivalents,
        "xg_per_match": total_xg / match_equivalents,
        "xa_per_match": total_xa / match_equivalents,
        "key_passes_per_match": total_key_passes / match_equivalents,
        "ranked": ranked,
    }


def load_overrides() -> dict[str, object]:
    try:
        payload = json.loads(OVERRIDES.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as error:
        print(f"Override contesto ignorati: {error}", file=sys.stderr)
        return {}


def promotion_priors(
    target_teams: list[str], target_start: int, serie_a_matches: list[dict[str, object]], serie_b_matches: list[dict[str, object]],
) -> dict[str, dict[str, float]]:
    previous_code = season_code(target_start - 1)
    previous_a = {str(match["home_team"]) for match in serie_a_matches if str(match["season"]) == previous_code}
    previous_a |= {str(match["away_team"]) for match in serie_a_matches if str(match["season"]) == previous_code}
    previous_b_rows = [match for match in serie_b_matches if str(match["season"]) == previous_code]
    if not previous_b_rows:
        return {}
    league_gf = sum(int(match["home_goals"]) + int(match["away_goals"]) for match in previous_b_rows) / (2 * len(previous_b_rows))
    priors: dict[str, dict[str, float]] = {}
    for team in target_teams:
        if team in previous_a:
            continue
        team_rows = [match for match in previous_b_rows if team in (match["home_team"], match["away_team"])]
        if not team_rows:
            continue
        gf = ga = points = 0
        for match in team_rows[-24:]:
            home = match["home_team"] == team
            team_gf = int(match["home_goals"] if home else match["away_goals"])
            team_ga = int(match["away_goals"] if home else match["home_goals"])
            gf += team_gf
            ga += team_ga
            points += 3 if team_gf > team_ga else 1 if team_gf == team_ga else 0
        count = len(team_rows[-24:])
        priors[team] = {
            "promotion_attack": round(clamp((gf / count) / max(league_gf, 0.5) * 0.91, 0.74, 1.14), 3),
            "promotion_defense": round(clamp((ga / count) / max(league_gf, 0.5) * 1.09, 0.88, 1.38), 3),
            "promotion_ppg": round(points / count, 3),
        }
    return priors


def build_team_context(
    target_code: str,
    target_start: int,
    target_teams: list[str],
    bundles: dict[int, dict[str, object]],
    elo: dict[str, float],
    elo_as_of: str | None,
    promotions: dict[str, dict[str, float]],
    overrides: dict[str, object],
) -> dict[str, dict[str, object]]:
    previous_rows = rows_by_team(bundles.get(target_start - 1, {}).get("players", []))
    current_rows = rows_by_team(bundles.get(target_start, {}).get("players", []))
    previous_metrics = {team: aggregate_player_team(rows) for team, rows in previous_rows.items() if rows}
    current_metrics = {team: aggregate_player_team(rows) for team, rows in current_rows.items() if rows}
    attack_values = [float(metrics["xg_per_match"]) for team, metrics in previous_metrics.items() if team in target_teams]
    creativity_values = [float(metrics["xa_per_match"]) for team, metrics in previous_metrics.items() if team in target_teams]
    attack_median = median(attack_values) if attack_values else 1.35
    creativity_median = median(creativity_values) if creativity_values else 0.95
    team_overrides = overrides.get("teams") if isinstance(overrides.get("teams"), dict) else {}
    context: dict[str, dict[str, object]] = {}
    generated_day = datetime.now(timezone.utc).date().isoformat()

    for team in target_teams:
        previous = previous_metrics.get(team)
        current = current_metrics.get(team)
        base = current if current and float(current["match_equivalents"]) >= 3 else previous
        prior_rows = previous_rows.get(team, [])
        current_player_rows = current_rows.get(team, [])
        prior_names = {str(row["name"]) for row in prior_rows}
        current_names = {str(row["name"]) for row in current_player_rows}
        current_reliability = clamp((float(current["match_equivalents"]) if current else 0) / 8, 0, 1)
        base_reliability = 0.72 if previous else 0.15
        reliability = max(base_reliability, current_reliability)

        squad_attack = 1.0
        squad_creativity = 1.0
        top_players: list[dict[str, object]] = []
        if base:
            squad_attack = clamp((float(base["xg_per_match"]) / max(attack_median, 0.2)) ** 0.32, 0.78, 1.24)
            squad_creativity = clamp((float(base["xa_per_match"]) / max(creativity_median, 0.15)) ** 0.30, 0.78, 1.24)
            for row in base["ranked"][:5]:
                minutes = float(row.get("minutes") or 0)
                ninety = max(minutes / 90, 0.25)
                top_players.append({
                    "name": row["name"], "position": row.get("position", ""),
                    "minutes": round(minutes), "xg90": round(float(row.get("xg") or 0) / ninety, 2),
                    "xa90": round(float(row.get("xa") or 0) / ninety, 2),
                })

        prior_weight = sum(player_score(row) for row in prior_rows)
        retained_weight = sum(player_score(row) for row in prior_rows if str(row["name"]) in current_names)
        observed_continuity = retained_weight / prior_weight if prior_weight else 0.85
        squad_continuity = 0.85 + current_reliability * (observed_continuity - 0.85)
        newcomers = sorted(
            (row for row in current_player_rows if str(row["name"]) not in prior_names),
            key=player_score, reverse=True,
        )
        new_players = [
            {"name": row["name"], "position": row.get("position", ""), "minutes": round(float(row.get("minutes") or 0))}
            for row in newcomers[:5]
        ]
        current_weight = sum(player_score(row) for row in current_player_rows)
        newcomer_weight = sum(player_score(row) for row in newcomers)
        newcomer_impact = current_reliability * (newcomer_weight / current_weight if current_weight else 0)
        departed_weight = sum(player_score(row) for row in prior_rows if str(row["name"]) not in current_names)
        departure_impact = current_reliability * (departed_weight / prior_weight if prior_weight else 0)

        item: dict[str, object] = {
            "as_of": generated_day if current else (elo_as_of or generated_day),
            "season": target_code, "elo": elo.get(team),
            "reliability": round(clamp(reliability, 0, 1), 3),
            "player_data_reliability": round(current_reliability, 3),
            "squad_attack": round(squad_attack, 3),
            "squad_creativity": round(squad_creativity, 3),
            "squad_continuity": round(clamp(squad_continuity, 0.35, 1), 3),
            "newcomer_impact": round(clamp(newcomer_impact, 0, 0.35), 3),
            "departure_impact": round(clamp(departure_impact, 0, 0.40), 3),
            "availability_attack": 1.0, "availability_defense": 1.0, "lineup_strength": 1.0,
            "manager_change_days": None,
            "promotion_attack": promotions.get(team, {}).get("promotion_attack", 1.0),
            "promotion_defense": promotions.get(team, {}).get("promotion_defense", 1.0),
            "promotion_ppg": promotions.get(team, {}).get("promotion_ppg"),
            "top_players": top_players, "new_players": new_players,
            "source": "Understat player production + Football-Data results/Elo",
        }
        override = team_overrides.get(team) if isinstance(team_overrides, dict) else None
        if isinstance(override, dict):
            for key in (
                "as_of", "availability_attack", "availability_defense", "lineup_strength",
                "manager_change_days", "squad_attack", "squad_creativity", "squad_continuity",
                "newcomer_impact", "departure_impact", "notes",
            ):
                if key in override:
                    item[key] = override[key]
            arrivals = override.get("arrivals") if isinstance(override.get("arrivals"), list) else []
            if arrivals:
                item["new_players"] = arrivals[:5]
                manual_impact = sum(float(entry.get("impact", 0)) for entry in arrivals if isinstance(entry, dict))
                item["newcomer_impact"] = round(clamp(float(item["newcomer_impact"]) + manual_impact, -0.25, 0.35), 3)
            item["source"] = f"{item['source']} + override verificati"
        context[team] = item
    return context


def load_local_csvs(paths: Iterable[Path]) -> list[dict[str, object]]:
    all_matches: list[dict[str, object]] = []
    for path in paths:
        code_match = re.search(r"(\d{4})_I([12])", path.name)
        season = code_match.group(1) if code_match else path.stem
        division = "A" if not code_match or code_match.group(2) == "1" else "B"
        all_matches.extend(parse_csv(path.read_text(encoding="utf-8-sig", errors="replace"), season, division))
    return all_matches


def write_payload(
    serie_a_matches: list[dict[str, object]],
    serie_b_matches: list[dict[str, object]],
    target_code: str,
    target_start: int,
    bundles: dict[int, dict[str, object]],
) -> None:
    dedup = {(match["date"], match["home_team"], match["away_team"]): match for match in serie_a_matches}
    ordered = sorted(dedup.values(), key=lambda match: (str(match["date"]), str(match["home_team"]), str(match["away_team"])))
    existing = load_existing_payload()
    fixtures, schedule_source = target_fixtures(target_code, target_start, bundles, existing)
    merge_results_into_fixtures(fixtures, ordered)
    target_teams = sorted({str(item["home_team"]) for item in fixtures} | {str(item["away_team"]) for item in fixtures})
    if not target_teams:
        target_teams = FALLBACK_TARGET_TEAMS.get(target_code, [])
    elo, elo_as_of = compute_elo(ordered + serie_b_matches)
    promotions = promotion_priors(target_teams, target_start, ordered, serie_b_matches)
    overrides = load_overrides()
    team_context = build_team_context(target_code, target_start, target_teams, bundles, elo, elo_as_of, promotions, overrides)

    xg_count = sum(match.get("home_xg") is not None and match.get("away_xg") is not None for match in ordered)
    possession_count = sum(match.get("home_possession") is not None and match.get("away_possession") is not None for match in ordered)
    rounds = sorted({int(item["round"]) for item in fixtures if item.get("round")})
    upcoming_round = next((round_number for round_number in rounds if any(
        int(item.get("round", 0)) == round_number and not item.get("completed") for item in fixtures
    )), None)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target_season": target_code, "latest_season": target_code,
        "model_inputs_version": "2.0-context-elo",
        "default_round": upcoming_round or (rounds[-1] if rounds else 1),
        "teams": target_teams, "fixtures": fixtures, "matches": ordered,
        "team_context": team_context,
        "coverage": {
            "xg_actual_matches": xg_count,
            "possession_actual_matches": possession_count,
            "team_context_count": sum(1 for value in team_context.values() if float(value.get("reliability", 0)) > 0),
            "promoted_team_priors": sorted(promotions),
        },
        "source_health": {
            "target_schedule_matches": len(fixtures),
            "understat_target_players": len(bundles.get(target_start, {}).get("players", [])),
            "understat_previous_players": len(bundles.get(target_start - 1, {}).get("players", [])),
            "serie_a_results": len(ordered), "serie_b_results_for_promotions": len(serie_b_matches),
        },
        "sources": {
            "results": "Football-Data.co.uk",
            "xg": "Understat (best effort; proxy trasparente se mancante)",
            "schedule": schedule_source,
            "players": "Understat player production; nuovi giocatori rilevati appena compaiono nella stagione",
            "elo": "Elo dinamico interno su Serie A + continuità Serie B per neopromosse",
            "availability": "data/context_overrides.json, solo informazioni verificate",
        },
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"Scritto {OUTPUT}: target {target_code}, {len(ordered)} risultati A, {len(fixtures)} fixture, "
        f"{len(target_teams)} squadre, {xg_count} con xG, {len(team_context)} contesti rosa"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", nargs="*", type=Path, help="CSV locali da usare al posto del download")
    parser.add_argument("--skip-understat", action="store_true")
    parser.add_argument("--target-season", default=os.environ.get("TARGET_SEASON", "2627"))
    args = parser.parse_args()
    target_code, target_start = resolve_target_season(args.target_season)
    starts = list(range(target_start - 4, target_start + 1))

    if args.local:
        local_matches = load_local_csvs(args.local)
        serie_a_matches = [match for match in local_matches if match.get("division") == "A"]
        serie_b_matches = [match for match in local_matches if match.get("division") == "B"]
    else:
        serie_a_matches = download_division(starts, "I1", "A")
        serie_b_matches = download_division(starts[-3:], "I2", "B")
    if len(serie_a_matches) < 300:
        raise SystemExit("Dati Serie A insufficienti: il file esistente non viene sovrascritto.")

    bundles: dict[int, dict[str, object]] = {}
    if not args.skip_understat:
        bundles = fetch_understat_bundles(starts)
        enriched = enrich_xg(serie_a_matches, bundles)
        print(f"xG arricchiti: {enriched}")
    write_payload(serie_a_matches, serie_b_matches, target_code, target_start, bundles)


if __name__ == "__main__":
    main()
