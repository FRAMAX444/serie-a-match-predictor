#!/usr/bin/env python3
"""Build a compact dataset for the Big Five leagues and the three UEFA club competitions."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import update_europe_data as base
import update_uefa_data as uefa

TOP_FIVE_LEAGUE_IDS = {"eng.1", "esp.1", "ita.1", "ger.1", "fra.1"}
TOP_FIVE_LEAGUES = tuple(
    descriptor for descriptor in base.DOMESTIC_LEAGUES
    if str(descriptor.get("id")) in TOP_FIVE_LEAGUE_IDS
)
EUROPE_COMPETITIONS = tuple(base.EUROPE_COMPETITIONS)
EUROPE_COMPETITION_IDS = {str(item["id"]) for item in EUROPE_COMPETITIONS}

_existing_domestic_ids = {str(item["id"]) for item in base.DOMESTIC_LEAGUES}
ALL_DOMESTIC_LEAGUES = tuple(base.DOMESTIC_LEAGUES) + tuple(
    item for item in uefa.EXTRA_DOMESTIC_LEAGUES
    if str(item["id"]) not in _existing_domestic_ids
)

MATCH_FIELDS = (
    "id", "season", "competition_id", "competition_name", "competition_type", "country",
    "league_strength", "date", "kickoff", "home_team", "away_team", "round", "round_label",
    "completed", "source", "source_index", "importance", "home_goals", "away_goals",
    "home_xg", "away_xg", "home_shots", "away_shots", "home_sot", "away_sot",
)


def competition_metadata(descriptor: dict[str, object], start_year: int) -> dict[str, str]:
    slug = str(descriptor.get("espn") or "")
    if not slug:
        return {}
    payload = base.fetch_json(
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_year}&limit=5",
        timeout=18,
    )
    if not isinstance(payload, dict):
        return {}
    leagues = payload.get("leagues")
    if not isinstance(leagues, list) or not leagues or not isinstance(leagues[0], dict):
        return {}
    league = leagues[0]
    logos = league.get("logos")
    if isinstance(logos, list):
        for candidate in logos:
            if isinstance(candidate, dict) and str(candidate.get("href") or "").startswith("https://"):
                return {"logo": str(candidate["href"])}
    return {}


def compact_match(match: dict[str, object]) -> dict[str, object]:
    return {key: match[key] for key in MATCH_FIELDS if key in match and match[key] is not None}


def competition_payload(
    descriptor: dict[str, object],
    fixtures: list[dict[str, object]],
    source: str,
    start_year: int,
    competition_type: str,
) -> dict[str, object]:
    item = base.competition_payload(descriptor, fixtures, source)
    item["type"] = competition_type
    item["country"] = "Europe" if competition_type == "europe" else str(descriptor.get("country") or "")
    if competition_type == "europe" and any(row.get("source") == "UEFA public match API" for row in fixtures):
        item["source"] = "UEFA public match API"
    try:
        metadata = competition_metadata(descriptor, start_year)
    except Exception as error:
        print(f"Logo {descriptor['name']}: {error}", file=sys.stderr)
        metadata = {}
    if metadata.get("logo"):
        item["logo"] = metadata["logo"]
    return item


def fetch_domestic_history(
    descriptor: dict[str, object],
    starts: list[int],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    current: list[dict[str, object]] = []
    history: list[dict[str, object]] = []
    target_start = starts[-1]
    for start in starts:
        try:
            rows = base.fetch_espn_events(descriptor, start, "domestic")
        except Exception as error:
            print(f"ESPN {descriptor['name']} {start}: {error}", file=sys.stderr)
            rows = []
        if start == target_start:
            current = rows
        history.extend(item for item in rows if item.get("completed"))
    return current, history


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-season", default=os.environ.get("TARGET_SEASON", "2627"))
    parser.add_argument("--history-seasons", type=int, default=4)
    parser.add_argument("--skip-understat", action="store_true")
    args = parser.parse_args()

    target_code, target_start = base.resolve_target_season(args.target_season)
    starts = list(range(target_start - max(2, args.history_seasons - 1), target_start + 1))
    existing = base.load_existing_payload()

    competitions: list[dict[str, object]] = []
    matches: list[dict[str, object]] = []
    target_european_fixtures: list[dict[str, object]] = []
    fixture_count = 0

    # Keep the domestic collection path unchanged: complete Big Five history and statistics.
    for descriptor in TOP_FIVE_LEAGUES:
        current, espn_history = fetch_domestic_history(descriptor, starts)
        if not current:
            current = base.existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        else:
            source = "ESPN public scoreboard"

        competitions.append(competition_payload(descriptor, current, source, target_start, "domestic"))
        fixture_count += len(current)

        try:
            football_data = base.download_football_data(descriptor, starts)
        except Exception as error:
            print(f"Football-Data {descriptor['name']}: {error}", file=sys.stderr)
            football_data = []

        league_rows = base.merge_matches([*espn_history, *football_data])
        if not args.skip_understat and descriptor.get("understat"):
            try:
                print(f"xG {descriptor['name']}: {base.enrich_xg(league_rows, descriptor, starts)} arricchimenti")
            except Exception as error:
                print(f"Understat {descriptor['name']}: {error}", file=sys.stderr)
        matches.extend(league_rows)
        print(f"{descriptor['name']}: {len(current)} fixture target, {len(league_rows)} gare storiche")

    # Add the three selectable UEFA competitions, preferring the official public match API.
    for descriptor in EUROPE_COMPETITIONS:
        current: list[dict[str, object]] = []
        european_history: list[dict[str, object]] = []
        for start in starts:
            try:
                rows = uefa.fetch_europe_then_espn(descriptor, start, "europe")
            except Exception as error:
                print(f"Europa {descriptor['name']} {start}: {error}", file=sys.stderr)
                rows = []
            if start == target_start:
                current = rows
            european_history.extend(item for item in rows if item.get("completed"))

        if not current:
            current = base.existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        else:
            source = "UEFA public match API; ESPN fallback"

        competitions.append(competition_payload(descriptor, current, source, target_start, "europe"))
        target_european_fixtures.extend(current)
        fixture_count += len(current)
        matches.extend(european_history)
        print(f"{descriptor['name']}: {len(current)} fixture target, {len(european_history)} gare storiche")

    # For UEFA predictions only, retain domestic form for participating clubs outside the Big Five.
    participant_ids, participant_names = uefa.collect_team_keys(target_european_fixtures)
    support_leagues = [
        dict(descriptor) for descriptor in ALL_DOMESTIC_LEAGUES
        if str(descriptor["id"]) not in TOP_FIVE_LEAGUE_IDS
        and uefa.LEAGUE_COUNTRY_CODES.get(str(descriptor["id"]), set()) & uefa.PARTICIPANT_COUNTRY_CODES
    ]
    hidden_support_matches: list[dict[str, object]] = []
    for descriptor in support_leagues:
        _, espn_history = fetch_domestic_history(descriptor, starts)
        espn_history = [
            item for item in espn_history
            if uefa.robust_participant_match(item, participant_ids, participant_names)
        ]
        try:
            football_data = [
                item for item in base.download_football_data(descriptor, starts)
                if uefa.robust_participant_match(item, participant_ids, participant_names)
            ]
        except Exception as error:
            print(f"Football-Data supporto {descriptor['name']}: {error}", file=sys.stderr)
            football_data = []
        league_rows = base.merge_matches([*espn_history, *football_data])
        if not args.skip_understat and descriptor.get("understat"):
            try:
                base.enrich_xg(league_rows, descriptor, starts)
            except Exception as error:
                print(f"Understat supporto {descriptor['name']}: {error}", file=sys.stderr)
        hidden_support_matches.extend(league_rows)
        print(f"Supporto UEFA {descriptor['name']}: {len(league_rows)} gare dei club partecipanti")

    matches = [compact_match(item) for item in base.merge_matches([*matches, *hidden_support_matches])]
    if len(matches) < 400:
        raise SystemExit("Dati insufficienti per Big Five e coppe UEFA: il dataset esistente non viene sovrascritto.")

    teams = sorted({
        str(team)
        for competition in competitions
        for fixture in competition.get("fixtures", [])
        if isinstance(fixture, dict)
        for team in (fixture.get("home_team"), fixture.get("away_team"))
        if team
    })
    xg_count = sum(item.get("home_xg") is not None and item.get("away_xg") is not None for item in matches)
    default_competition = "ita.1" if any(item.get("id") == "ita.1" and item.get("fixtures") for item in competitions) else str(competitions[0]["id"])

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target_season": target_code,
        "latest_season": target_code,
        "model_inputs_version": "4.1-top5-uefa-core",
        "default_competition": default_competition,
        "competitions": competitions,
        "teams": teams,
        "matches": matches,
        "domestic_leagues": [
            {key: descriptor[key] for key in ("id", "name", "country")}
            for descriptor in TOP_FIVE_LEAGUES
        ],
        "training_support_leagues": [
            {key: descriptor[key] for key in ("id", "name", "country") if key in descriptor}
            for descriptor in support_leagues
        ],
        "coverage": {
            "supported_competitions": len([item for item in competitions if item.get("fixtures")]),
            "training_matches": len(matches),
            "xg_actual_matches": xg_count,
            "teams": len(teams),
            "hidden_uefa_support_matches": len(hidden_support_matches),
        },
        "source_health": {
            "target_fixtures": fixture_count,
            "completed_training_matches": len(matches),
            "european_training_matches": sum(str(item.get("competition_id")) in EUROPE_COMPETITION_IDS for item in matches),
        },
        "sources": {
            "fixtures_results": "UEFA public match API for European cups; ESPN public scoreboards for domestic leagues and fallback",
            "match_statistics": "Football-Data.co.uk with ESPN fallback",
            "xg": "Understat where available; shot-based proxy otherwise",
            "model_inputs": "Goals/xG, shots, shots on target, form, Elo, venue and rest only",
        },
    }

    base.OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    base.OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"Scritto {base.OUTPUT}: {len(competitions)} competizioni, {len(teams)} squadre, "
        f"{len(matches)} partite training, {xg_count} con xG"
    )


if __name__ == "__main__":
    main()
