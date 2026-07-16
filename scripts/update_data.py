#!/usr/bin/env python3
"""Build the static Serie A dataset used by the GitHub Pages app.

No API key is required. Results and match statistics are downloaded from
Football-Data.co.uk. Understat enrichment and schedule import are best-effort
and never block publication when the site layout or availability changes.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
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
USER_AGENT = "Mozilla/5.0 (compatible; SerieAPredictor/1.1; +https://github.com/)"

NAME_MAP = {
    "AS Roma": "Roma", "Internazionale": "Inter", "Inter Milan": "Inter",
    "AC Milan": "Milan", "Juventus FC": "Juventus", "Hellas Verona": "Verona",
    "SSC Napoli": "Napoli", "Atalanta BC": "Atalanta", "AC Monza": "Monza",
    "US Lecce": "Lecce", "SS Lazio": "Lazio", "ACF Fiorentina": "Fiorentina",
    "Torino FC": "Torino", "Bologna FC 1909": "Bologna", "Udinese Calcio": "Udinese",
    "Genoa CFC": "Genoa", "Cagliari Calcio": "Cagliari", "Parma Calcio 1913": "Parma",
    "Como 1907": "Como", "Venezia FC": "Venezia", "US Cremonese": "Cremonese",
    "US Sassuolo Calcio": "Sassuolo", "Pisa SC": "Pisa", "Empoli FC": "Empoli",
}


def normalize_team(name: str) -> str:
    clean = re.sub(r"\s+", " ", (name or "").strip())
    return NAME_MAP.get(clean, clean)


def season_code(start_year: int) -> str:
    return f"{start_year % 100:02d}{(start_year + 1) % 100:02d}"


def likely_start_year(today: date) -> int:
    return today.year if today.month >= 7 else today.year - 1


def season_starts(today: date, count: int = 4) -> list[int]:
    current = likely_start_year(today)
    return [current - offset for offset in range(count)]


def fetch_bytes(url: str, timeout: int = 35) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


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
            except ValueError:
                pass
    return None


def parse_csv(content: str, season: str) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for row in csv.DictReader(content.splitlines()):
        if not row.get("Date") or row.get("FTHG") in (None, "") or row.get("FTAG") in (None, ""):
            continue
        try:
            match = {
                "date": parse_date(row["Date"]), "season": season,
                "home_team": normalize_team(row.get("HomeTeam", "")), "away_team": normalize_team(row.get("AwayTeam", "")),
                "home_goals": int(float(row["FTHG"])), "away_goals": int(float(row["FTAG"])),
                "home_shots": optional_float(row, "HS"), "away_shots": optional_float(row, "AS"),
                "home_sot": optional_float(row, "HST"), "away_sot": optional_float(row, "AST"),
                "home_corners": optional_float(row, "HC"), "away_corners": optional_float(row, "AC"),
                "home_yellow": optional_float(row, "HY"), "away_yellow": optional_float(row, "AY"),
                "home_red": optional_float(row, "HR"), "away_red": optional_float(row, "AR"),
                "home_xg": optional_float(row, "HxG", "HomeXG"), "away_xg": optional_float(row, "AxG", "AwayXG"),
                "home_possession": optional_float(row, "HPoss", "HomePossession"), "away_possession": optional_float(row, "APoss", "AwayPossession"),
            }
        except (ValueError, TypeError):
            continue
        if match["home_team"] and match["away_team"]:
            matches.append(match)
    return matches


def decode_understat_json(encoded: str) -> object:
    decoded = bytes(encoded, "utf-8").decode("unicode_escape")
    return json.loads(html.unescape(decoded))


def parse_round(item: dict[str, object]) -> int | None:
    for key in ("round", "week", "matchweek", "gameweek"):
        value = item.get(key)
        if value in (None, ""):
            continue
        found = re.search(r"\d+", str(value))
        if found:
            parsed = int(found.group())
            if parsed > 0:
                return parsed
    return None


def fetch_understat_season(start_year: int) -> list[dict[str, object]]:
    url = f"https://understat.com/league/Serie_A/{start_year}"
    text = fetch_bytes(url).decode("utf-8", errors="replace")
    patterns = [
        r"datesData\s*=\s*JSON\.parse\('([^']+)'\)",
        r'datesData\s*=\s*JSON\.parse\("([^\"]+)"\)',
    ]
    data = None
    for pattern in patterns:
        found = re.search(pattern, text)
        if found:
            data = decode_understat_json(found.group(1))
            break
    if not isinstance(data, list):
        return []

    season = season_code(start_year)
    result: list[dict[str, object]] = []
    for source_index, item in enumerate(data):
        home_team = normalize_team(str(item.get("h", {}).get("title", "")))
        away_team = normalize_team(str(item.get("a", {}).get("title", "")))
        raw_datetime = str(item.get("datetime", ""))
        match_date = raw_datetime[:10]
        if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
            continue
        schedule_item: dict[str, object] = {
            "id": str(item.get("id", f"{season}-{source_index}")),
            "season": season,
            "date": match_date,
            "kickoff": raw_datetime.replace(" ", "T") if raw_datetime else None,
            "home_team": home_team,
            "away_team": away_team,
            "round": parse_round(item),
            "completed": bool(item.get("isResult")),
            "source_index": source_index,
        }
        if item.get("isResult"):
            goals = item.get("goals", {})
            xg = item.get("xG", {})
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


def fetch_understat_schedules(starts: Iterable[int]) -> dict[int, list[dict[str, object]]]:
    schedules: dict[int, list[dict[str, object]]] = {}
    for start in starts:
        try:
            items = fetch_understat_season(start)
            if items:
                schedules[start] = items
                print(f"Understat {start}: {len(items)} gare/calendario")
        except Exception as error:
            print(f"Understat {start}: {error}", file=sys.stderr)
    return schedules


def enrich_xg(matches: list[dict[str, object]], schedules: dict[int, list[dict[str, object]]]) -> int:
    index: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for match in matches:
        index[(str(match["date"]), str(match["home_team"]), str(match["away_team"]))].append(match)
    enriched = 0
    for schedule in schedules.values():
        for item in schedule:
            if item.get("home_xg") is None or item.get("away_xg") is None:
                continue
            candidates = index.get((str(item["date"]), str(item["home_team"]), str(item["away_team"])), [])
            for match in candidates:
                match["home_xg"] = item["home_xg"]
                match["away_xg"] = item["away_xg"]
                enriched += 1
    return enriched


def load_local_csvs(paths: Iterable[Path]) -> list[dict[str, object]]:
    all_matches: list[dict[str, object]] = []
    for path in paths:
        code_match = re.search(r"(\d{4})_I1", path.name)
        season = code_match.group(1) if code_match else path.stem
        all_matches.extend(parse_csv(path.read_text(encoding="utf-8-sig", errors="replace"), season))
    return all_matches


def download_recent(starts: list[int]) -> list[dict[str, object]]:
    all_matches: list[dict[str, object]] = []
    for start in starts:
        code = season_code(start)
        url = f"https://www.football-data.co.uk/mmz4281/{code}/I1.csv"
        try:
            content = fetch_bytes(url).decode("utf-8-sig", errors="replace")
            parsed = parse_csv(content, code)
            if parsed:
                print(f"{code}: {len(parsed)} partite")
                all_matches.extend(parsed)
        except urllib.error.HTTPError as error:
            print(f"{code}: non disponibile (HTTP {error.code})", file=sys.stderr)
        except Exception as error:
            print(f"{code}: errore {error}", file=sys.stderr)
    return all_matches


def assign_rounds(fixtures: list[dict[str, object]]) -> list[dict[str, object]]:
    teams = sorted({str(item["home_team"]) for item in fixtures} | {str(item["away_team"]) for item in fixtures})
    matches_per_round = max(1, len(teams) // 2 or 10)
    explicit = [item.get("round") for item in fixtures]
    if fixtures and all(isinstance(value, int) and value > 0 for value in explicit):
        return fixtures
    ordered = sorted(fixtures, key=lambda item: (int(item.get("source_index", 10**9)), str(item["date"])))
    for index, item in enumerate(ordered):
        item["round"] = index // matches_per_round + 1
    return ordered


def build_fixtures(matches: list[dict[str, object]], schedules: dict[int, list[dict[str, object]]]) -> tuple[str, list[dict[str, object]]]:
    result_index = {(str(match["date"]), str(match["home_team"]), str(match["away_team"])): match for match in matches}
    viable_schedules = {
        start: items for start, items in schedules.items()
        if len(items) >= 100 and len({str(item["home_team"]) for item in items} | {str(item["away_team"]) for item in items}) >= 18
    }
    if viable_schedules:
        latest_start = max(viable_schedules)
        latest_season = season_code(latest_start)
        fixtures = assign_rounds([dict(item) for item in viable_schedules[latest_start]])
        for fixture in fixtures:
            actual = result_index.get((str(fixture["date"]), str(fixture["home_team"]), str(fixture["away_team"])))
            if actual:
                fixture["completed"] = True
                fixture["home_goals"] = actual["home_goals"]
                fixture["away_goals"] = actual["away_goals"]
            fixture.pop("source_index", None)
        return latest_season, fixtures

    latest_season = max((str(match["season"]) for match in matches), default="")
    season_results = [dict(match) for match in matches if str(match["season"]) == latest_season]
    season_results.sort(key=lambda item: (str(item["date"]), str(item["home_team"]), str(item["away_team"])))
    teams = sorted({str(item["home_team"]) for item in season_results} | {str(item["away_team"]) for item in season_results})
    matches_per_round = max(1, len(teams) // 2 or 10)
    fixtures = []
    for index, match in enumerate(season_results):
        fixtures.append({
            "id": f"{latest_season}-{index}",
            "season": latest_season,
            "round": index // matches_per_round + 1,
            "date": match["date"],
            "kickoff": None,
            "home_team": match["home_team"],
            "away_team": match["away_team"],
            "completed": True,
            "home_goals": match["home_goals"],
            "away_goals": match["away_goals"],
        })
    return latest_season, fixtures


def write_payload(matches: list[dict[str, object]], schedules: dict[int, list[dict[str, object]]]) -> None:
    dedup = {(match["date"], match["home_team"], match["away_team"]): match for match in matches}
    ordered = sorted(dedup.values(), key=lambda match: (match["date"], match["home_team"], match["away_team"]))
    latest_season, fixtures = build_fixtures(ordered, schedules)
    teams = sorted({str(item["home_team"]) for item in fixtures} | {str(item["away_team"]) for item in fixtures})
    xg_count = sum(match.get("home_xg") is not None and match.get("away_xg") is not None for match in ordered)
    possession_count = sum(match.get("home_possession") is not None and match.get("away_possession") is not None for match in ordered)
    rounds = sorted({int(item["round"]) for item in fixtures if item.get("round")})
    upcoming_round = next((round_number for round_number in rounds if any(
        int(item.get("round", 0)) == round_number and not item.get("completed") for item in fixtures
    )), None)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_season": latest_season,
        "default_round": upcoming_round or (rounds[-1] if rounds else 1),
        "teams": teams,
        "fixtures": fixtures,
        "matches": ordered,
        "coverage": {"xg_actual_matches": xg_count, "possession_actual_matches": possession_count},
        "sources": {
            "results": "Football-Data.co.uk",
            "xg": "Understat (best effort)",
            "schedule": "Understat (best effort; fallback ricostruito dai risultati)",
        },
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Scritto {OUTPUT}: {len(ordered)} risultati, {len(fixtures)} fixture, {len(teams)} squadre, {xg_count} con xG reali")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", nargs="*", type=Path, help="CSV locali da usare al posto del download")
    parser.add_argument("--skip-understat", action="store_true")
    args = parser.parse_args()
    starts = season_starts(date.today(), 4)
    matches = load_local_csvs(args.local) if args.local else download_recent(starts)
    if not matches:
        raise SystemExit("Nessuna partita disponibile: il file esistente non viene sovrascritto.")
    schedules: dict[int, list[dict[str, object]]] = {}
    if not args.skip_understat:
        schedules = fetch_understat_schedules(starts)
        enrich_xg(matches, schedules)
    write_payload(matches, schedules)


if __name__ == "__main__":
    main()
