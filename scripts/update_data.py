#!/usr/bin/env python3
"""Build the static Serie A dataset used by the GitHub Pages app.

No API key is required. Results and match statistics are downloaded from
Football-Data.co.uk. Understat xG enrichment is best-effort and never blocks
publication when the site layout or availability changes.
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
USER_AGENT = "Mozilla/5.0 (compatible; SerieAPredictor/1.0; +https://github.com/)"

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


def fetch_understat_matches(start_year: int) -> list[dict[str, object]]:
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
            data = decode_understat_json(found.group(1)); break
    if not isinstance(data, list):
        return []
    result = []
    for item in data:
        if not item.get("isResult"):
            continue
        home_team = normalize_team(item.get("h", {}).get("title", ""))
        away_team = normalize_team(item.get("a", {}).get("title", ""))
        xg = item.get("xG", {})
        try:
            match_date = str(item.get("datetime", ""))[:10]
            result.append({"date": match_date, "home_team": home_team, "away_team": away_team,
                           "home_xg": round(float(xg.get("h")), 3), "away_xg": round(float(xg.get("a")), 3)})
        except (TypeError, ValueError):
            continue
    return result


def enrich_xg(matches: list[dict[str, object]], starts: Iterable[int]) -> int:
    index: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for match in matches:
        index[(str(match["date"]), str(match["home_team"]), str(match["away_team"]))].append(match)
    enriched = 0
    for start in starts:
        try:
            understat = fetch_understat_matches(start)
        except Exception as error:
            print(f"Understat {start}: {error}", file=sys.stderr); continue
        for item in understat:
            candidates = index.get((item["date"], item["home_team"], item["away_team"]), [])
            for match in candidates:
                match["home_xg"] = item["home_xg"]; match["away_xg"] = item["away_xg"]; enriched += 1
    return enriched


def load_local_csvs(paths: Iterable[Path]) -> list[dict[str, object]]:
    all_matches = []
    for path in paths:
        code_match = re.search(r"(\d{4})_I1", path.name)
        season = code_match.group(1) if code_match else path.stem
        all_matches.extend(parse_csv(path.read_text(encoding="utf-8-sig", errors="replace"), season))
    return all_matches


def download_recent(starts: list[int]) -> list[dict[str, object]]:
    all_matches = []
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


def write_payload(matches: list[dict[str, object]]) -> None:
    dedup = {(m["date"], m["home_team"], m["away_team"]): m for m in matches}
    ordered = sorted(dedup.values(), key=lambda m: (m["date"], m["home_team"], m["away_team"]))
    latest_season = max((str(m["season"]) for m in ordered), default="")
    teams = sorted({str(m["home_team"]) for m in ordered if str(m["season"]) == latest_season}
                   | {str(m["away_team"]) for m in ordered if str(m["season"]) == latest_season})
    xg_count = sum(m.get("home_xg") is not None and m.get("away_xg") is not None for m in ordered)
    possession_count = sum(m.get("home_possession") is not None and m.get("away_possession") is not None for m in ordered)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_season": latest_season, "teams": teams, "matches": ordered,
        "coverage": {"xg_actual_matches": xg_count, "possession_actual_matches": possession_count},
        "sources": {"results": "Football-Data.co.uk", "xg": "Understat (best effort)"},
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Scritto {OUTPUT}: {len(ordered)} partite, {len(teams)} squadre, {xg_count} con xG reali")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", nargs="*", type=Path, help="CSV locali da usare al posto del download")
    parser.add_argument("--skip-understat", action="store_true")
    args = parser.parse_args()
    starts = season_starts(date.today(), 4)
    matches = load_local_csvs(args.local) if args.local else download_recent(starts)
    if not matches:
        raise SystemExit("Nessuna partita disponibile: il file esistente non viene sovrascritto.")
    if not args.skip_understat:
        enrich_xg(matches, starts)
    write_payload(matches)

if __name__ == "__main__":
    main()
