#!/usr/bin/env python3
"""Build a compact dataset for the five major European domestic leagues."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import update_europe_data as base

TOP_FIVE_LEAGUE_IDS = {"eng.1", "esp.1", "ita.1", "ger.1", "fra.1"}
TOP_FIVE_LEAGUES = tuple(
    descriptor for descriptor in base.DOMESTIC_LEAGUES
    if str(descriptor.get("id")) in TOP_FIVE_LEAGUE_IDS
)
MATCH_FIELDS = (
    "id", "season", "competition_id", "competition_name", "competition_type", "country",
    "league_strength", "date", "kickoff", "home_team", "away_team", "round", "round_label",
    "completed", "source", "source_index", "importance", "home_goals", "away_goals",
    "home_xg", "away_xg", "home_shots", "away_shots", "home_sot", "away_sot",
)


def league_metadata(descriptor: dict[str, object], start_year: int) -> dict[str, str]:
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
    logo = ""
    logos = league.get("logos")
    if isinstance(logos, list):
        for candidate in logos:
            if isinstance(candidate, dict) and str(candidate.get("href") or "").startswith("https://"):
                logo = str(candidate["href"])
                break
    return {"logo": logo}


def compact_match(match: dict[str, object]) -> dict[str, object]:
    return {key: match[key] for key in MATCH_FIELDS if key in match and match[key] is not None}


def competition_payload(
    descriptor: dict[str, object],
    fixtures: list[dict[str, object]],
    source: str,
    start_year: int,
) -> dict[str, object]:
    item = base.competition_payload(descriptor, fixtures, source)
    item["type"] = "domestic"
    item["country"] = descriptor["country"]
    try:
        metadata = league_metadata(descriptor, start_year)
    except Exception as error:  # best-effort metadata only
        print(f"Logo {descriptor['name']}: {error}", file=sys.stderr)
        metadata = {}
    if metadata.get("logo"):
        item["logo"] = metadata["logo"]
    return item


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
    fixture_count = 0

    for descriptor in TOP_FIVE_LEAGUES:
        current: list[dict[str, object]] = []
        espn_history: list[dict[str, object]] = []
        for start in starts:
            try:
                rows = base.fetch_espn_events(descriptor, start, "domestic")
            except Exception as error:
                print(f"ESPN {descriptor['name']} {start}: {error}", file=sys.stderr)
                rows = []
            if start == target_start:
                current = rows
            espn_history.extend(item for item in rows if item.get("completed"))

        if not current:
            current = base.existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        else:
            source = "ESPN public scoreboard"

        competitions.append(competition_payload(descriptor, current, source, target_start))
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

    matches = [compact_match(item) for item in base.merge_matches(matches)]
    if len(matches) < 400:
        raise SystemExit("Dati insufficienti per i cinque maggiori campionati: il dataset esistente non viene sovrascritto.")

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
        "model_inputs_version": "4.0-top5-core",
        "default_competition": default_competition,
        "competitions": competitions,
        "teams": teams,
        "matches": matches,
        "domestic_leagues": [
            {key: descriptor[key] for key in ("id", "name", "country")}
            for descriptor in TOP_FIVE_LEAGUES
        ],
        "coverage": {
            "supported_competitions": len(competitions),
            "training_matches": len(matches),
            "xg_actual_matches": xg_count,
            "teams": len(teams),
        },
        "source_health": {
            "target_fixtures": fixture_count,
            "completed_training_matches": len(matches),
        },
        "sources": {
            "fixtures_results": "ESPN public scoreboards",
            "match_statistics": "Football-Data.co.uk with ESPN fallback",
            "xg": "Understat where available; shot-based proxy otherwise",
            "model_inputs": "Goals/xG, shots, shots on target, form, Elo, venue and rest only",
        },
    }

    base.OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    base.OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"Scritto {base.OUTPUT}: {len(competitions)} campionati, {len(teams)} squadre, "
        f"{len(matches)} partite training, {xg_count} con xG"
    )


if __name__ == "__main__":
    main()
