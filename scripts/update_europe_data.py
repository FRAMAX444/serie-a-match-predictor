#!/usr/bin/env python3
"""Build the dataset for UEFA club competition predictions.

The public app predicts only:
- UEFA Champions League
- UEFA Europa League
- UEFA Conference League

Training data contains European matches plus domestic-league matches only for clubs
currently present in one of those competitions. Sources are keyless and best-effort:
ESPN public scoreboards, Football-Data.co.uk CSVs and Understat xG for supported leagues.
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
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "matches.json"
OVERRIDES = ROOT / "data" / "context_overrides.json"
USER_AGENT = "Mozilla/5.0 (compatible; EuropeMatchPredictor/3.0; +https://github.com/FRAMAX444/serie-a-match-predictor)"

EUROPE_COMPETITIONS = (
    {"id": "ucl", "name": "UEFA Champions League", "espn": "uefa.champions"},
    {"id": "uel", "name": "UEFA Europa League", "espn": "uefa.europa"},
    {"id": "uecl", "name": "UEFA Conference League", "espn": "uefa.europa.conf"},
)

DOMESTIC_LEAGUES = (
    {"id": "eng.1", "name": "Premier League", "country": "England", "espn": "eng.1", "fd": "E0", "understat": "EPL", "strength": 1570},
    {"id": "esp.1", "name": "LaLiga", "country": "Spain", "espn": "esp.1", "fd": "SP1", "understat": "La_liga", "strength": 1555},
    {"id": "ita.1", "name": "Serie A", "country": "Italy", "espn": "ita.1", "fd": "I1", "understat": "Serie_A", "strength": 1550},
    {"id": "ger.1", "name": "Bundesliga", "country": "Germany", "espn": "ger.1", "fd": "D1", "understat": "Bundesliga", "strength": 1540},
    {"id": "fra.1", "name": "Ligue 1", "country": "France", "espn": "fra.1", "fd": "F1", "understat": "Ligue_1", "strength": 1520},
    {"id": "ned.1", "name": "Eredivisie", "country": "Netherlands", "espn": "ned.1", "fd": "N1", "strength": 1495},
    {"id": "por.1", "name": "Primeira Liga", "country": "Portugal", "espn": "por.1", "fd": "P1", "strength": 1495},
    {"id": "bel.1", "name": "Belgian Pro League", "country": "Belgium", "espn": "bel.1", "fd": "B1", "strength": 1465},
    {"id": "tur.1", "name": "Süper Lig", "country": "Turkey", "espn": "tur.1", "fd": "T1", "strength": 1455},
    {"id": "sco.1", "name": "Scottish Premiership", "country": "Scotland", "espn": "sco.1", "fd": "SC0", "strength": 1445},
    {"id": "aut.1", "name": "Austrian Bundesliga", "country": "Austria", "espn": "aut.1", "strength": 1445},
    {"id": "sui.1", "name": "Swiss Super League", "country": "Switzerland", "espn": "sui.1", "strength": 1435},
    {"id": "gre.1", "name": "Greek Super League", "country": "Greece", "espn": "gre.1", "fd": "G1", "strength": 1430},
    {"id": "den.1", "name": "Danish Superliga", "country": "Denmark", "espn": "den.1", "strength": 1425},
    {"id": "cze.1", "name": "Czech First League", "country": "Czechia", "espn": "cze.1", "strength": 1420},
    {"id": "nor.1", "name": "Eliteserien", "country": "Norway", "espn": "nor.1", "strength": 1405},
    {"id": "swe.1", "name": "Allsvenskan", "country": "Sweden", "espn": "swe.1", "strength": 1400},
    {"id": "pol.1", "name": "Ekstraklasa", "country": "Poland", "espn": "pol.1", "strength": 1400},
    {"id": "cro.1", "name": "Croatian HNL", "country": "Croatia", "espn": "cro.1", "strength": 1395},
    {"id": "srb.1", "name": "Serbian SuperLiga", "country": "Serbia", "espn": "srb.1", "strength": 1390},
    {"id": "ukr.1", "name": "Ukrainian Premier League", "country": "Ukraine", "espn": "ukr.1", "strength": 1390},
    {"id": "rou.1", "name": "Romanian Liga I", "country": "Romania", "espn": "rou.1", "strength": 1380},
    {"id": "isr.1", "name": "Israeli Premier League", "country": "Israel", "espn": "isr.1", "strength": 1380},
    {"id": "hun.1", "name": "Hungarian NB I", "country": "Hungary", "espn": "hun.1", "strength": 1370},
    {"id": "cyp.1", "name": "Cypriot First Division", "country": "Cyprus", "espn": "cyp.1", "strength": 1365},
    {"id": "bul.1", "name": "Bulgarian First League", "country": "Bulgaria", "espn": "bul.1", "strength": 1360},
    {"id": "svn.1", "name": "Slovenian PrvaLiga", "country": "Slovenia", "espn": "svn.1", "strength": 1350},
    {"id": "svk.1", "name": "Slovak Super Liga", "country": "Slovakia", "espn": "svk.1", "strength": 1345},
    {"id": "fin.1", "name": "Veikkausliiga", "country": "Finland", "espn": "fin.1", "strength": 1335},
    {"id": "irl.1", "name": "League of Ireland", "country": "Ireland", "espn": "irl.1", "strength": 1325},
)

NAME_MAP = {
    "Internazionale": "Inter", "Internazionale Milano": "Inter", "Inter Milan": "Inter",
    "AC Milan": "Milan", "AS Roma": "Roma", "Roma FC": "Roma", "Juventus FC": "Juventus",
    "SSC Napoli": "Napoli", "Napoli SSC": "Napoli", "Bayern Munich": "Bayern Monaco",
    "Bayern München": "Bayern Monaco", "Borussia Dortmund": "Dortmund", "Paris Saint-Germain": "PSG",
    "Paris SG": "PSG", "Manchester United": "Man United", "Manchester City": "Man City",
    "Tottenham Hotspur": "Tottenham", "Newcastle United": "Newcastle", "Athletic Club": "Athletic Bilbao",
    "Atlético Madrid": "Atletico Madrid", "Atletico de Madrid": "Atletico Madrid",
    "Real Betis Balompié": "Real Betis", "Sporting CP": "Sporting Lisbona",
    "Sporting Lisbon": "Sporting Lisbona", "FC Porto": "Porto", "SL Benfica": "Benfica",
    "PSV Eindhoven": "PSV", "Ajax Amsterdam": "Ajax", "Olympique Marseille": "Marsiglia",
    "Olympique Lyonnais": "Lione", "AS Monaco": "Monaco", "Bayer Leverkusen": "Leverkusen",
    "RB Leipzig": "Lipsia", "Eintracht Frankfurt": "Francoforte", "Club Brugge": "Club Bruges",
    "Celtic Glasgow": "Celtic", "Rangers FC": "Rangers", "Red Bull Salzburg": "Salisburgo",
    "FC Salzburg": "Salisburgo", "Shakhtar Donetsk": "Shakhtar", "Dynamo Kyiv": "Dynamo Kiev",
    "FC Copenhagen": "Copenhagen", "FC København": "Copenhagen", "Sparta Prague": "Sparta Praga",
    "Slavia Prague": "Slavia Praga", "Red Star Belgrade": "Stella Rossa", "Crvena Zvezda": "Stella Rossa",
    "Dinamo Zagreb": "Dinamo Zagabria", "Olympiacos": "Olympiakos", "Fenerbahce": "Fenerbahçe",
    "Besiktas": "Beşiktaş", "Galatasaray SK": "Galatasaray",
}


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_team(name: str) -> str:
    clean = re.sub(r"\s+", " ", (name or "").strip())
    clean = re.sub(r"\s+(FC|CF|SC|AFC)$", "", clean, flags=re.I)
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
    start = season_start(raw) if raw else likely_start_year(date.today())
    return season_code(start), start


def fetch_bytes(url: str, timeout: int = 35) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str, timeout: int = 35) -> object:
    return json.loads(fetch_bytes(url, timeout).decode("utf-8", errors="replace"))


def parse_date(value: str) -> str:
    value = value.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"Data non riconosciuta: {value}")


def optional_float(row: dict[str, str], *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            try:
                return round(float(value), 3)
            except (TypeError, ValueError):
                pass
    return None


def numeric_stat(stats: object, *names: str) -> float | None:
    if not isinstance(stats, list):
        return None
    wanted = {name.lower() for name in names}
    for item in stats:
        if not isinstance(item, dict):
            continue
        key = str(item.get("name") or item.get("abbreviation") or item.get("label") or "").lower()
        if key not in wanted:
            continue
        raw = item.get("value", item.get("displayValue"))
        try:
            return round(float(str(raw).replace("%", "")), 3)
        except (TypeError, ValueError):
            continue
    return None


def event_round(event: dict[str, object], competition: dict[str, object]) -> tuple[int | None, str | None]:
    for candidate in (event.get("week"), competition.get("week")):
        if isinstance(candidate, dict):
            try:
                number = int(candidate.get("number"))
            except (TypeError, ValueError):
                number = None
            label = str(candidate.get("text") or candidate.get("name") or "").strip() or None
            if number and number > 0:
                return number, label
    notes = competition.get("notes")
    if isinstance(notes, list):
        for note in notes:
            if isinstance(note, dict):
                label = str(note.get("headline") or "").strip()
                if label:
                    return None, label[:80]
    return None, None


def parse_espn_event(event: dict[str, object], descriptor: dict[str, object], season: str, source_index: int, competition_type: str) -> dict[str, object] | None:
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

    def team_data(side: str) -> tuple[str, str | None]:
        team = sides[side].get("team") if isinstance(sides[side].get("team"), dict) else {}
        name = normalize_team(str(team.get("shortDisplayName") or team.get("displayName") or team.get("name") or ""))
        team_id = str(team.get("id") or "").strip() or None
        return name, team_id

    home_team, home_id = team_data("home")
    away_team, away_id = team_data("away")
    raw_date = str(event.get("date") or competition.get("date") or "")
    match_date = raw_date[:10]
    if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
        return None
    status = event.get("status") if isinstance(event.get("status"), dict) else {}
    status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
    completed = bool(status_type.get("completed"))
    round_number, round_label = event_round(event, competition)
    item: dict[str, object] = {
        "id": str(event.get("id") or f"espn-{descriptor['id']}-{season}-{source_index}"),
        "season": season, "competition_id": descriptor["id"], "competition_name": descriptor["name"],
        "competition_type": competition_type, "country": descriptor.get("country", "Europe"),
        "league_strength": descriptor.get("strength", 1500), "date": match_date, "kickoff": raw_date or None,
        "home_team": home_team, "away_team": away_team, "home_team_id": home_id, "away_team_id": away_id,
        "round": round_number, "round_label": round_label, "completed": completed,
        "source_index": source_index, "source": "ESPN public scoreboard",
        "importance": 1.18 if competition_type == "europe" else 1.0,
    }
    if completed:
        try:
            item["home_goals"] = int(float(sides["home"].get("score")))
            item["away_goals"] = int(float(sides["away"].get("score")))
        except (TypeError, ValueError):
            return None
        for side in ("home", "away"):
            stats = sides[side].get("statistics")
            item[f"{side}_shots"] = numeric_stat(stats, "shotsTotal", "totalShots", "SH")
            item[f"{side}_sot"] = numeric_stat(stats, "shotsOnTarget", "SOG")
            item[f"{side}_corners"] = numeric_stat(stats, "wonCorners", "cornerKicks", "CK")
            item[f"{side}_possession"] = numeric_stat(stats, "possessionPct", "possession")
            item[f"{side}_yellow"] = numeric_stat(stats, "yellowCards", "YC")
            item[f"{side}_red"] = numeric_stat(stats, "redCards", "RC")
    return item


def fetch_espn_events(descriptor: dict[str, object], start_year: int, competition_type: str) -> list[dict[str, object]]:
    season = season_code(start_year)
    start_date = f"{start_year}0701"
    end_date = f"{start_year + 1}0630"
    slug = descriptor["espn"]
    urls = [
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_date}-{end_date}&limit=2000",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_year}&limit=2000",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_year + 1}&limit=2000",
    ]
    raw_events: list[dict[str, object]] = []
    for url in urls:
        try:
            payload = fetch_json(url)
            if isinstance(payload, dict) and isinstance(payload.get("events"), list):
                raw_events.extend(event for event in payload["events"] if isinstance(event, dict))
        except Exception as error:
            print(f"ESPN {descriptor['name']} {season}: {error}", file=sys.stderr)
    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, event in enumerate(raw_events):
        item = parse_espn_event(event, descriptor, season, index, competition_type)
        if not item or not (f"{start_year}-07-01" <= str(item["date"]) <= f"{start_year + 1}-06-30"):
            continue
        key = str(item["id"])
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return sorted(result, key=lambda item: (str(item["date"]), int(item.get("source_index", 0))))


def parse_csv(content: str, season: str, league: dict[str, object]) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for row in csv.DictReader(content.splitlines()):
        if not row.get("Date") or row.get("FTHG") in (None, "") or row.get("FTAG") in (None, ""):
            continue
        try:
            matches.append({
                "id": f"fd-{league['id']}-{season}-{len(matches)}", "date": parse_date(row["Date"]), "season": season,
                "competition_id": league["id"], "competition_name": league["name"], "competition_type": "domestic",
                "country": league["country"], "league_strength": league["strength"], "importance": 1.0,
                "home_team": normalize_team(row.get("HomeTeam", "")), "away_team": normalize_team(row.get("AwayTeam", "")),
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
                "completed": True, "source": "Football-Data.co.uk",
            })
        except (TypeError, ValueError):
            continue
    return [item for item in matches if item["home_team"] and item["away_team"]]


def download_football_data(league: dict[str, object], starts: Iterable[int]) -> list[dict[str, object]]:
    code = league.get("fd")
    if not code:
        return []
    result: list[dict[str, object]] = []
    for start in starts:
        season = season_code(start)
        url = f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv"
        try:
            content = fetch_bytes(url).decode("utf-8-sig", errors="replace")
            parsed = parse_csv(content, season, league)
            result.extend(parsed)
            print(f"Football-Data {league['name']} {season}: {len(parsed)}")
        except urllib.error.HTTPError as error:
            print(f"Football-Data {league['name']} {season}: HTTP {error.code}", file=sys.stderr)
        except Exception as error:
            print(f"Football-Data {league['name']} {season}: {error}", file=sys.stderr)
    return result


def decode_understat_json(encoded: str) -> object:
    return json.loads(html.unescape(bytes(encoded, "utf-8").decode("unicode_escape")))


def fetch_understat_xg(league: dict[str, object], start_year: int) -> list[dict[str, object]]:
    slug = league.get("understat")
    if not slug:
        return []
    text = fetch_bytes(f"https://understat.com/league/{slug}/{start_year}").decode("utf-8", errors="replace")
    match = re.search(r"datesData\s*=\s*JSON\.parse\('([^']+)'\)", text) or re.search(r'datesData\s*=\s*JSON\.parse\("([^\"]+)"\)', text)
    if not match:
        return []
    data = decode_understat_json(match.group(1))
    result: list[dict[str, object]] = []
    if not isinstance(data, list):
        return result
    for item in data:
        if not isinstance(item, dict) or not item.get("isResult"):
            continue
        home = item.get("h") if isinstance(item.get("h"), dict) else {}
        away = item.get("a") if isinstance(item.get("a"), dict) else {}
        xg = item.get("xG") if isinstance(item.get("xG"), dict) else {}
        try:
            result.append({
                "date": str(item.get("datetime", ""))[:10],
                "home_team": normalize_team(str(home.get("title", ""))),
                "away_team": normalize_team(str(away.get("title", ""))),
                "home_xg": round(float(xg.get("h")), 3), "away_xg": round(float(xg.get("a")), 3),
            })
        except (TypeError, ValueError):
            continue
    return result


def enrich_xg(matches: list[dict[str, object]], league: dict[str, object], starts: Iterable[int]) -> int:
    index = {(str(item["date"]), str(item["home_team"]), str(item["away_team"])): item for item in matches if item.get("competition_id") == league["id"]}
    enriched = 0
    for start in starts:
        try:
            rows = fetch_understat_xg(league, start)
        except Exception as error:
            print(f"Understat {league['name']} {start}: {error}", file=sys.stderr)
            continue
        for row in rows:
            item = index.get((str(row["date"]), str(row["home_team"]), str(row["away_team"])))
            if item:
                item["home_xg"] = row["home_xg"]
                item["away_xg"] = row["away_xg"]
                enriched += 1
    return enriched


def team_keys(items: Iterable[dict[str, object]]) -> tuple[set[str], set[str]]:
    ids: set[str] = set()
    names: set[str] = set()
    for item in items:
        for side in ("home", "away"):
            name = str(item.get(f"{side}_team") or "")
            team_id = str(item.get(f"{side}_team_id") or "")
            if name:
                names.add(name)
            if team_id:
                ids.add(team_id)
    return ids, names


def involves_participant(item: dict[str, object], ids: set[str], names: set[str]) -> bool:
    return any(str(item.get(f"{side}_team_id") or "") in ids or str(item.get(f"{side}_team") or "") in names for side in ("home", "away"))


def discover_relevant_leagues(participants_ids: set[str], participants_names: set[str], target_start: int, cache: dict[tuple[str, int], list[dict[str, object]]]) -> list[dict[str, object]]:
    relevant: list[dict[str, object]] = []
    for league in DOMESTIC_LEAGUES:
        probe: list[dict[str, object]] = []
        for start in (target_start, target_start - 1):
            key = (str(league["id"]), start)
            if key not in cache:
                cache[key] = fetch_espn_events(league, start, "domestic")
            probe.extend(cache[key])
        if any(involves_participant(item, participants_ids, participants_names) for item in probe):
            relevant.append(dict(league))
            print(f"Campionato rilevante: {league['name']}")
    return relevant


def richness(item: dict[str, object]) -> int:
    keys = ("home_xg", "away_xg", "home_shots", "away_shots", "home_sot", "away_sot", "home_odds", "away_odds")
    return sum(item.get(key) is not None for key in keys)


def merge_matches(items: Iterable[dict[str, object]]) -> list[dict[str, object]]:
    merged: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for item in items:
        if item.get("home_goals") is None or item.get("away_goals") is None:
            continue
        key = (str(item.get("competition_id")), str(item.get("date")), str(item.get("home_team")), str(item.get("away_team")))
        previous = merged.get(key)
        if not previous:
            merged[key] = dict(item)
            continue
        richer, poorer = (item, previous) if richness(item) >= richness(previous) else (previous, item)
        combined = dict(poorer)
        combined.update({key_name: value for key_name, value in richer.items() if value is not None})
        for team_key in ("home_team_id", "away_team_id"):
            combined[team_key] = previous.get(team_key) or item.get(team_key)
        merged[key] = combined
    return sorted(merged.values(), key=lambda item: (str(item["date"]), str(item["competition_id"]), str(item["home_team"])))


def assign_rounds(fixtures: list[dict[str, object]]) -> list[dict[str, object]]:
    if not fixtures:
        return []
    ordered = sorted((dict(item) for item in fixtures), key=lambda item: (str(item["date"]), int(item.get("source_index", 0))))
    explicit = [item for item in ordered if isinstance(item.get("round"), int) and int(item["round"]) > 0]
    if len(explicit) >= max(1, int(len(ordered) * 0.75)):
        for item in ordered:
            if not item.get("round"):
                nearest = min(explicit, key=lambda candidate: abs((datetime.fromisoformat(str(candidate["date"])) - datetime.fromisoformat(str(item["date"]))).days))
                item["round"] = nearest["round"]
            if not item.get("round_label"):
                item["round_label"] = f"Turno {item['round']}"
        return ordered
    groups: list[list[dict[str, object]]] = []
    for item in ordered:
        current_date = datetime.fromisoformat(str(item["date"]))
        if not groups:
            groups.append([item])
            continue
        previous_date = datetime.fromisoformat(str(groups[-1][-1]["date"]))
        teams_in_group = {str(value[f"{side}_team"]) for value in groups[-1] for side in ("home", "away")}
        duplicate_team = str(item["home_team"]) in teams_in_group or str(item["away_team"]) in teams_in_group
        if (current_date - previous_date).days > 3 or duplicate_team:
            groups.append([item])
        else:
            groups[-1].append(item)
    for index, group in enumerate(groups, 1):
        labels = [str(item.get("round_label") or "").strip() for item in group]
        label = next((value for value in labels if value), f"Turno {index}")
        for item in group:
            item["round"] = index
            item["round_label"] = label
    return ordered


def load_existing_payload() -> dict[str, object]:
    try:
        payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def existing_competition_fixtures(existing: dict[str, object], competition_id: str, target_code: str) -> list[dict[str, object]]:
    competitions = existing.get("competitions")
    if not isinstance(competitions, list):
        return []
    for competition in competitions:
        if isinstance(competition, dict) and competition.get("id") == competition_id:
            fixtures = competition.get("fixtures")
            if isinstance(fixtures, list):
                return [dict(item) for item in fixtures if isinstance(item, dict) and str(item.get("season")) == target_code]
    return []


def load_overrides() -> dict[str, object]:
    try:
        data = json.loads(OVERRIDES.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def compute_elo(matches: list[dict[str, object]]) -> tuple[dict[str, float], str | None, dict[str, int]]:
    ratings: dict[str, float] = {}
    last_seen: dict[str, datetime] = {}
    counts: dict[str, int] = defaultdict(int)
    latest: str | None = None
    for match in sorted(matches, key=lambda item: str(item["date"])):
        match_date = datetime.fromisoformat(str(match["date"]))
        baseline = float(match.get("league_strength") or 1450)
        home, away = str(match["home_team"]), str(match["away_team"])
        for team in (home, away):
            current = ratings.get(team, baseline)
            if team in last_seen:
                gap = max(0, (match_date - last_seen[team]).days)
                current = baseline + (current - baseline) * math.exp(-gap / 1000)
            ratings[team] = current
            last_seen[team] = match_date
        home_advantage = 38 if match.get("competition_type") == "europe" else 52
        expected = 1 / (1 + 10 ** ((ratings[away] - (ratings[home] + home_advantage)) / 400))
        hg, ag = int(match["home_goals"]), int(match["away_goals"])
        actual = 1 if hg > ag else 0.5 if hg == ag else 0
        margin = min(1.85, 1 + 0.14 * abs(hg - ag))
        importance = float(match.get("importance") or 1)
        k = (22 if match.get("competition_type") == "europe" else 17) * importance
        delta = k * margin * (actual - expected)
        ratings[home] += delta
        ratings[away] -= delta
        counts[home] += 1
        counts[away] += 1
        latest = str(match["date"])
    return {team: round(value, 1) for team, value in ratings.items()}, latest, dict(counts)


def build_team_context(teams: list[str], elo: dict[str, float], counts: dict[str, int], as_of: str | None, overrides: dict[str, object]) -> dict[str, dict[str, object]]:
    team_overrides = overrides.get("teams") if isinstance(overrides.get("teams"), dict) else {}
    context: dict[str, dict[str, object]] = {}
    for team in teams:
        reliability = clamp(counts.get(team, 0) / 24, 0, 1)
        item: dict[str, object] = {
            "as_of": as_of or date.today().isoformat(), "elo": elo.get(team), "reliability": round(reliability, 3),
            "squad_attack": 1.0, "squad_creativity": 1.0, "squad_continuity": 0.85,
            "newcomer_impact": 0.0, "departure_impact": 0.0,
            "availability_attack": 1.0, "availability_defense": 1.0, "lineup_strength": 1.0,
            "promotion_attack": 1.0, "promotion_defense": 1.0, "manager_change_days": None,
            "top_players": [], "new_players": [], "source": "Elo europeo + forma nazionale ed europea",
        }
        override = team_overrides.get(team) if isinstance(team_overrides, dict) else None
        if isinstance(override, dict):
            for key, value in override.items():
                if key in {"as_of", "availability_attack", "availability_defense", "lineup_strength", "manager_change_days", "squad_attack", "squad_creativity", "squad_continuity", "newcomer_impact", "departure_impact", "top_players", "new_players", "notes"}:
                    item[key] = value
            item["source"] = f"{item['source']} + override verificati"
        context[team] = item
    return context


def competition_payload(descriptor: dict[str, object], fixtures: list[dict[str, object]], source: str) -> dict[str, object]:
    assigned = assign_rounds(fixtures)
    rounds = sorted({int(item["round"]) for item in assigned if item.get("round")})
    upcoming = next((number for number in rounds if any(int(item.get("round", 0)) == number and not item.get("completed") for item in assigned)), None)
    return {"id": descriptor["id"], "name": descriptor["name"], "season": assigned[0]["season"] if assigned else "", "fixtures": assigned, "default_round": upcoming or (rounds[-1] if rounds else 1), "source": source}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-season", default=os.environ.get("TARGET_SEASON", "2627"))
    parser.add_argument("--history-seasons", type=int, default=4)
    parser.add_argument("--skip-understat", action="store_true")
    args = parser.parse_args()
    target_code, target_start = resolve_target_season(args.target_season)
    starts = list(range(target_start - max(2, args.history_seasons - 1), target_start + 1))
    existing = load_existing_payload()

    europe_history: list[dict[str, object]] = []
    competitions: list[dict[str, object]] = []
    target_fixtures: list[dict[str, object]] = []
    for descriptor in EUROPE_COMPETITIONS:
        current = fetch_espn_events(descriptor, target_start, "europe")
        source = "ESPN public scoreboard"
        if not current:
            current = existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        competitions.append(competition_payload(descriptor, current, source))
        target_fixtures.extend(current)
        for start in starts:
            rows = current if start == target_start and current else fetch_espn_events(descriptor, start, "europe")
            europe_history.extend(item for item in rows if item.get("completed"))
        print(f"{descriptor['name']}: {len(current)} fixture target")

    participant_ids, participant_names = team_keys(target_fixtures)
    if not participant_names:
        raise SystemExit("Nessuna squadra europea disponibile: il dataset esistente non viene sovrascritto.")

    cache: dict[tuple[str, int], list[dict[str, object]]] = {}
    relevant_leagues = discover_relevant_leagues(participant_ids, participant_names, target_start, cache)
    domestic_matches: list[dict[str, object]] = []
    for league in relevant_leagues:
        espn_rows: list[dict[str, object]] = []
        for start in starts:
            key = (str(league["id"]), start)
            if key not in cache:
                cache[key] = fetch_espn_events(league, start, "domestic")
            espn_rows.extend(item for item in cache[key] if item.get("completed") and involves_participant(item, participant_ids, participant_names))
        football_data = [item for item in download_football_data(league, starts) if involves_participant(item, participant_ids, participant_names)]
        league_rows = merge_matches([*espn_rows, *football_data])
        if not args.skip_understat and league.get("understat"):
            print(f"xG {league['name']}: {enrich_xg(league_rows, league, starts)} arricchimenti")
        domestic_matches.extend(league_rows)

    matches = merge_matches([*europe_history, *domestic_matches])
    if len(matches) < 180:
        raise SystemExit("Dati europei insufficienti: il dataset esistente non viene sovrascritto.")

    participants = sorted(participant_names)
    elo, elo_as_of, match_counts = compute_elo(matches)
    context = build_team_context(participants, elo, match_counts, elo_as_of, load_overrides())
    xg_count = sum(item.get("home_xg") is not None and item.get("away_xg") is not None for item in matches)
    unresolved = sorted(team for team in participants if not any(team in {str(row["home_team"]), str(row["away_team"])} for row in domestic_matches))
    default_competition = next((item["id"] for item in competitions if any(not fixture.get("completed") for fixture in item["fixtures"])), competitions[0]["id"])

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "target_season": target_code,
        "latest_season": target_code, "model_inputs_version": "3.0-europe-context",
        "default_competition": default_competition, "competitions": competitions,
        "teams": participants, "matches": matches, "team_context": context,
        "domestic_leagues": [{key: league[key] for key in ("id", "name", "country")} for league in relevant_leagues],
        "coverage": {"xg_actual_matches": xg_count, "participant_teams": len(participants), "relevant_domestic_leagues": len(relevant_leagues), "teams_without_domestic_feed": unresolved},
        "source_health": {"european_completed_matches": sum(item.get("competition_type") == "europe" for item in matches), "domestic_participant_matches": sum(item.get("competition_type") == "domestic" for item in matches), "target_fixtures": len(target_fixtures)},
        "sources": {"european_schedule_results": "ESPN public scoreboards", "domestic_results": "Football-Data.co.uk where available; ESPN fallback", "xg": "Understat for supported domestic leagues; transparent shot proxy otherwise", "elo": "Global Elo linked across domestic and UEFA matches", "availability": "data/context_overrides.json, verified information only"},
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Scritto {OUTPUT}: {len(competitions)} coppe, {len(participants)} squadre, {len(relevant_leagues)} campionati rilevanti, {len(matches)} partite training, {xg_count} con xG")


if __name__ == "__main__":
    main()
