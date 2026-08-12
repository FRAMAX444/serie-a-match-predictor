#!/usr/bin/env python3
"""Fetch the complete Serie A season calendar from Lega Serie A's public SDP feed."""
from __future__ import annotations

import re
from typing import Any

import update_europe_data as base

BASE_URL = "https://api-sdp.legaseriea.it/v1/serie-a/football"
COMPETITION_ID = "serie-a::Football_Competition::ec93b94f74294dc98ab5bcfd67fc0d88"
SOURCE = "Lega Serie A official SDP API"


def _list(payload: object, key: str) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get(key), list):
        return []
    return [item for item in payload[key] if isinstance(item, dict)]


def _first(mapping: object, *keys: str) -> object | None:
    if not isinstance(mapping, dict):
        return None
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            return value
    return None


def season_name(start_year: int) -> str:
    return f"{start_year}/{start_year + 1}"


def find_season_id(payload: object, start_year: int) -> str | None:
    wanted = season_name(start_year)
    for season in _list(payload, "seasons"):
        if str(season.get("seasonName") or "").strip() == wanted:
            value = str(season.get("seasonId") or "").strip()
            return value or None
    return None


def _round(match: dict[str, Any]) -> tuple[int | None, str | None]:
    label = str(match.get("roundName") or "").strip() or None
    match_set = match.get("matchSet") if isinstance(match.get("matchSet"), dict) else {}
    if not label:
        label = str(_first(match_set, "name", "displayName", "matchSetName") or "").strip() or None

    candidates = [
        _first(match_set, "providerId", "matchSetId", "id"),
        match.get("roundName"),
        match.get("matchday"),
        match.get("round"),
    ]
    for candidate in candidates:
        if candidate in (None, ""):
            continue
        text = str(candidate)
        matchday = re.search(r"(?:MatchDay[:\s_-]*|Matchday\s*|Giornata\s*)?(\d{1,2})$", text, flags=re.I)
        if matchday:
            value = int(matchday.group(1))
            if 1 <= value <= 38:
                return value, label or f"Giornata {value}"
    return None, label


def _team(match: dict[str, Any], side: str) -> tuple[str, str | None]:
    nested = match.get(side) if isinstance(match.get(side), dict) else {}
    name = _first(nested, "mediaName", "officialName", "shortName", "displayName", "name", "acronymName")
    if name in (None, ""):
        prefix = side.capitalize()
        name = _first(match, f"{side}TeamName", f"{side}Name", f"{prefix}TeamName", f"{prefix}Name")
    team_id = _first(nested, "teamId", "id", "providerId")
    return base.normalize_team(str(name or "")), str(team_id).strip() if team_id not in (None, "") else None


def _score(match: dict[str, Any], side: str) -> int | None:
    keys = ("providerHomeScore", "homeScore") if side == "home" else ("providerAwayScore", "awayScore")
    raw = _first(match, *keys)
    if raw in (None, ""):
        nested = match.get(side) if isinstance(match.get(side), dict) else {}
        raw = _first(nested, "score", "goals")
    try:
        return int(float(raw)) if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_matches(payload: object, start_year: int, descriptor: dict[str, object]) -> list[dict[str, object]]:
    season = base.season_code(start_year)
    rows: list[dict[str, object]] = []
    for index, match in enumerate(_list(payload, "matches")):
        home_team, home_id = _team(match, "home")
        away_team, away_id = _team(match, "away")
        raw_date = str(_first(match, "matchDateUtc", "matchDate", "kickoff", "date") or "")
        match_date = raw_date[:10]
        if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
            continue

        round_number, round_label = _round(match)
        status = str(match.get("status") or "").upper()
        completed = status in {"FINISHED", "PLAYED", "ENDED", "FT", "FULL_TIME"}
        home_goals = _score(match, "home")
        away_goals = _score(match, "away")
        if completed and (home_goals is None or away_goals is None):
            completed = False

        item: dict[str, object] = {
            "id": str(match.get("matchId") or match.get("id") or f"seriea-sdp-{season}-{index}"),
            "season": season,
            "competition_id": descriptor["id"],
            "competition_name": descriptor["name"],
            "competition_type": "domestic",
            "country": descriptor.get("country", "Italy"),
            "league_strength": descriptor.get("strength", 1550),
            "date": match_date,
            "kickoff": raw_date or None,
            "home_team": home_team,
            "away_team": away_team,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "round": round_number,
            "round_label": round_label,
            "completed": completed,
            "source_index": index,
            "source": SOURCE,
            "importance": 1.0,
        }
        if completed:
            item["home_goals"] = home_goals
            item["away_goals"] = away_goals
        rows.append(item)

    return sorted(rows, key=lambda item: (int(item.get("round") or 99), str(item["date"]), int(item["source_index"])))


def fetch_season(descriptor: dict[str, object], start_year: int) -> list[dict[str, object]]:
    catalogue_url = f"{BASE_URL}/competitions/{COMPETITION_ID}/seasons?locale=en-GB"
    catalogue = base.fetch_json(catalogue_url, timeout=30)
    season_id = find_season_id(catalogue, start_year)
    if not season_id:
        raise RuntimeError(f"Stagione Serie A {season_name(start_year)} non presente nel catalogo ufficiale.")

    matches_url = f"{BASE_URL}/seasons/{season_id}/matches?locale=en-GB"
    payload = base.fetch_json(matches_url, timeout=45)
    rows = parse_matches(payload, start_year, descriptor)
    if len(rows) < 300:
        raise RuntimeError(f"Feed Lega Serie A incompleto: ricevute {len(rows)} partite, attese circa 380.")
    rounds = {int(item["round"]) for item in rows if item.get("round") is not None}
    if len(rounds) < 30:
        raise RuntimeError(f"Feed Lega Serie A senza giornate complete: riconosciute solo {len(rounds)} giornate.")
    return rows
