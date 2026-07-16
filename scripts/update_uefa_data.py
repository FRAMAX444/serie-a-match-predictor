#!/usr/bin/env python3
"""Run the European dataset builder with the official UEFA match API enabled.

The base updater keeps ESPN and domestic-league integrations. This module injects
UEFA's public, keyless match endpoint as the primary fixture/result source for
Champions League, Europa League and Conference League.
"""
from __future__ import annotations

import json
import re
import urllib.parse
from pathlib import Path

import update_europe_data as base

UEFA_COMPETITION_IDS = {
    "ucl": 1,
    "uel": 14,
    "uecl": 2019,
}


def translated_name(team: dict[str, object]) -> str:
    for key in ("internationalName", "teamCode"):
        value = str(team.get(key) or "").strip()
        if value:
            return value
    translations = team.get("translations")
    if isinstance(translations, dict):
        official = translations.get("displayOfficialName")
        if isinstance(official, dict):
            for language in ("EN", "IT"):
                value = str(official.get(language) or "").strip()
                if value:
                    return value
    return ""


def score_value(score: object, side: str) -> int | None:
    if not isinstance(score, dict):
        return None
    for section_name in ("regular", "total"):
        section = score.get(section_name)
        if not isinstance(section, dict):
            continue
        try:
            return int(float(section.get(side)))
        except (TypeError, ValueError):
            continue
    return None


def round_label(match: dict[str, object]) -> str | None:
    round_data = match.get("round")
    if isinstance(round_data, dict):
        metadata = round_data.get("metaData")
        if isinstance(metadata, dict):
            label = str(metadata.get("name") or metadata.get("type") or "").strip()
            if label:
                return label[:80]
        label = str(round_data.get("name") or "").strip()
        if label:
            return label[:80]
    matchday = match.get("matchday")
    if isinstance(matchday, dict):
        label = str(matchday.get("longName") or matchday.get("name") or "").strip()
        if label:
            return label[:80]
    phase = str(match.get("competitionPhase") or "").strip()
    return phase.title() if phase else None


def normalize_uefa_match(match: dict[str, object], descriptor: dict[str, object], season: str, source_index: int) -> dict[str, object] | None:
    home = match.get("homeTeam")
    away = match.get("awayTeam")
    kickoff = match.get("kickOffTime")
    if not isinstance(home, dict) or not isinstance(away, dict) or not isinstance(kickoff, dict):
        return None
    home_team = base.normalize_team(translated_name(home))
    away_team = base.normalize_team(translated_name(away))
    raw_datetime = str(kickoff.get("dateTime") or "").strip()
    match_date = str(kickoff.get("date") or raw_datetime[:10]).strip()[:10]
    if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
        return None
    status = str(match.get("status") or "").upper()
    completed = status == "FINISHED"
    item: dict[str, object] = {
        "id": str(match.get("id") or f"uefa-{descriptor['id']}-{season}-{source_index}"),
        "season": season,
        "competition_id": descriptor["id"],
        "competition_name": descriptor["name"],
        "competition_type": "europe",
        "country": "Europe",
        "league_strength": 1500,
        "date": match_date,
        "kickoff": raw_datetime or None,
        "home_team": home_team,
        "away_team": away_team,
        "home_team_id": str(home.get("id") or "") or None,
        "away_team_id": str(away.get("id") or "") or None,
        "home_country_code": str(home.get("countryCode") or "") or None,
        "away_country_code": str(away.get("countryCode") or "") or None,
        "round": None,
        "round_label": round_label(match),
        "completed": completed,
        "source_index": source_index,
        "source": "UEFA public match API",
        "importance": 1.18,
    }
    if completed:
        home_goals = score_value(match.get("score"), "home")
        away_goals = score_value(match.get("score"), "away")
        if home_goals is None or away_goals is None:
            return None
        item["home_goals"] = home_goals
        item["away_goals"] = away_goals
    return item


def fetch_uefa_matches(descriptor: dict[str, object], start_year: int) -> list[dict[str, object]]:
    competition_id = UEFA_COMPETITION_IDS[str(descriptor["id"])]
    season = base.season_code(start_year)
    limit = 100
    offset = 0
    rows: list[dict[str, object]] = []
    while True:
        query = urllib.parse.urlencode({
            "competitionId": competition_id,
            "seasonYear": start_year + 1,
            "phase": "ALL",
            "limit": limit,
            "offset": offset,
            "order": "ASC",
        })
        payload = base.fetch_json(f"https://match.uefa.com/v5/matches?{query}")
        page = payload if isinstance(payload, list) else payload.get("items", []) if isinstance(payload, dict) else []
        page = [item for item in page if isinstance(item, dict)]
        for item in page:
            normalized = normalize_uefa_match(item, descriptor, season, len(rows))
            if normalized:
                rows.append(normalized)
        if len(page) < limit:
            break
        offset += len(page)
        if offset >= 2500:
            break
    deduplicated = {str(item["id"]): item for item in rows}
    return sorted(deduplicated.values(), key=lambda item: (str(item["date"]), str(item["id"])))


original_fetch_events = base.fetch_espn_events
original_competition_payload = base.competition_payload


def fetch_europe_then_espn(descriptor: dict[str, object], start_year: int, competition_type: str) -> list[dict[str, object]]:
    if competition_type != "europe":
        return original_fetch_events(descriptor, start_year, competition_type)
    official: list[dict[str, object]] = []
    try:
        official = fetch_uefa_matches(descriptor, start_year)
        if official:
            print(f"UEFA API {descriptor['name']} {base.season_code(start_year)}: {len(official)} gare")
    except Exception as error:
        print(f"UEFA API {descriptor['name']} {base.season_code(start_year)}: {error}", file=base.sys.stderr)
    if official:
        return official
    try:
        return original_fetch_events(descriptor, start_year, competition_type)
    except Exception:
        return []


def official_competition_payload(descriptor: dict[str, object], fixtures: list[dict[str, object]], source: str) -> dict[str, object]:
    if any(item.get("source") == "UEFA public match API" for item in fixtures):
        source = "UEFA public match API"
    return original_competition_payload(descriptor, fixtures, source)


def correct_output_sources(output: Path) -> None:
    try:
        payload = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    sources = payload.setdefault("sources", {})
    if isinstance(sources, dict):
        sources["european_schedule_results"] = "UEFA public match API; ESPN fallback"
    competitions = payload.get("competitions")
    if isinstance(competitions, list):
        for competition in competitions:
            if isinstance(competition, dict) and competition.get("fixtures"):
                if any(isinstance(item, dict) and item.get("source") == "UEFA public match API" for item in competition["fixtures"]):
                    competition["source"] = "UEFA public match API"
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    base.fetch_espn_events = fetch_europe_then_espn
    base.competition_payload = official_competition_payload
    base.main()
    correct_output_sources(base.OUTPUT)


if __name__ == "__main__":
    main()
