#!/usr/bin/env python3
"""Build a compact dataset for the Big Five leagues and the three UEFA club competitions."""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timezone

import update_europe_data as base
import update_uefa_data as uefa

TOP_FIVE_LEAGUE_IDS = {"eng.1", "esp.1", "ita.1", "ger.1", "fra.1"}
TOP_FIVE_LEAGUES = tuple(
    descriptor for descriptor in base.DOMESTIC_LEAGUES
    if str(descriptor.get("id")) in TOP_FIVE_LEAGUE_IDS
)
EUROPE_COMPETITIONS = tuple(base.EUROPE_COMPETITIONS)
EUROPE_COMPETITION_IDS = {str(item["id"]) for item in EUROPE_COMPETITIONS}
LEAGUE_TEAM_COUNTS = {"eng.1": 20, "esp.1": 20, "ita.1": 20, "ger.1": 18, "fra.1": 18}
UEFA_LEAGUE_PHASE = {"ucl": (144, 8), "uel": (144, 8), "uecl": (108, 6)}

MATCH_FIELDS = (
    "id", "season", "competition_id", "competition_name", "competition_type", "country",
    "league_strength", "date", "kickoff", "home_team", "away_team", "round", "round_label",
    "completed", "source", "source_index", "importance", "home_goals", "away_goals",
    "home_xg", "away_xg", "home_shots", "away_shots", "home_sot", "away_sot",
    # Già scaricati da parse_csv() in update_europe_data.py (Football-Data.co.uk) ma finora
    # scartati qui: quote di chiusura (media di mercato, fallback Bet365/Pinnacle), corner
    # e cartellini. Nessuna nuova fonte dati: si smette solo di eliminarli in compattazione.
    "home_odds", "draw_odds", "away_odds",
    "home_odds_close", "draw_odds_close", "away_odds_close",
    "home_odds_max_close", "draw_odds_max_close", "away_odds_max_close",
    "over25_odds", "under25_odds",
    "over25_odds_close", "under25_odds_close",
    "over25_odds_max_close", "under25_odds_max_close",
    "ah_line_close", "ah_home_odds_close", "ah_away_odds_close",
    "home_corners", "away_corners",
    "home_yellow", "away_yellow", "home_red", "away_red",
    "home_possession", "away_possession",
    "referee",
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
    target_code: str,
) -> dict[str, object]:
    item = base.competition_payload(descriptor, fixtures, source, target_code)
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
    target_start: int,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    current: list[dict[str, object]] = []
    history: list[dict[str, object]] = []
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


def calendar_contract_issues(
    competitions: list[dict[str, object]],
    target_start: int,
    today: date | None = None,
) -> list[str]:
    """Reject green builds that would publish an incomplete current-season calendar."""
    today = today or date.today()
    if target_start != base.likely_start_year(today) or today < date(target_start, 8, 1):
        return []

    by_id = {str(item.get("id")): item for item in competitions}
    issues: list[str] = []
    for competition_id, team_count in LEAGUE_TEAM_COUNTS.items():
        competition = by_id.get(competition_id, {})
        fixtures = [item for item in competition.get("fixtures", []) if isinstance(item, dict)]
        expected_fixtures = team_count * (team_count - 1)
        if len(fixtures) != expected_fixtures:
            issues.append(f"{competition_id}: {len(fixtures)}/{expected_fixtures} fixture")
            continue
        round_sizes = Counter(int(item.get("round") or 0) for item in fixtures)
        expected_rounds = 2 * (team_count - 1)
        if len(round_sizes) != expected_rounds or any(
            round_number <= 0 or size != team_count // 2
            for round_number, size in round_sizes.items()
        ):
            issues.append(
                f"{competition_id}: giornate non valide "
                f"({len(round_sizes)}/{expected_rounds}, distribuzione {sorted(round_sizes.values())})"
            )

    if today >= date(target_start, 9, 1):
        for competition_id, (expected_fixtures, expected_rounds) in UEFA_LEAGUE_PHASE.items():
            competition = by_id.get(competition_id, {})
            fixtures = [
                item for item in competition.get("fixtures", [])
                if isinstance(item, dict) and item.get("phase") == "TOURNAMENT"
            ]
            round_sizes = Counter(str(item.get("round_label") or "") for item in fixtures)
            if len(fixtures) != expected_fixtures:
                issues.append(f"{competition_id} fase campionato: {len(fixtures)}/{expected_fixtures} fixture")
            if len(round_sizes) != expected_rounds or any(size != 18 for size in round_sizes.values()):
                issues.append(
                    f"{competition_id} fase campionato: {len(round_sizes)}/{expected_rounds} giornate, "
                    f"distribuzione {sorted(round_sizes.values())}"
                )
    return issues


def fixture_statistics_health(competitions: list[dict[str, object]]) -> dict[str, dict[str, int]]:
    fields = (
        "home_shots", "away_shots", "home_sot", "away_sot", "home_corners", "away_corners",
        "home_yellow", "away_yellow", "home_possession", "away_possession",
    )
    result: dict[str, dict[str, int]] = {}
    for competition in competitions:
        completed = [
            item for item in competition.get("fixtures", [])
            if isinstance(item, dict) and item.get("completed")
        ]
        result[str(competition.get("id"))] = {
            "completed": len(completed),
            "with_core_statistics": sum(
                all(item.get(field) is not None for field in fields)
                for item in completed
            ),
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-season", default=os.environ.get("TARGET_SEASON", "2627"))
    parser.add_argument("--history-seasons", type=int, default=4)
    parser.add_argument("--skip-understat", action="store_true")
    args = parser.parse_args()

    target_code, target_start = base.resolve_target_season(args.target_season)
    starts = list(reversed(range(target_start - max(2, args.history_seasons - 1), target_start + 1)))
    existing = base.load_existing_payload()

    competitions: list[dict[str, object]] = []
    matches: list[dict[str, object]] = []
    fixture_count = 0
    guarded_competitions: list[str] = []

    # Keep the domestic collection path unchanged: complete Big Five history and statistics.
    for descriptor in TOP_FIVE_LEAGUES:
        current, espn_history = fetch_domestic_history(descriptor, starts, target_start)
        previous = base.existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
        if not current:
            current = previous
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        else:
            current, guarded = base.protect_fixture_snapshot(previous, current)
            if guarded:
                guarded_competitions.append(str(descriptor["id"]))
                print(
                    f"ATTENZIONE {descriptor['name']}: risposta live regressiva; "
                    f"conservato il calendario precedente ({len(previous)} fixture)",
                    file=sys.stderr,
                )
            source = "ESPN public scoreboard"

        competitions.append(competition_payload(descriptor, current, source, target_start, "domestic", target_code))
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

        previous = base.existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
        if not current:
            current = previous
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        else:
            current, guarded = base.protect_fixture_snapshot(previous, current)
            if guarded:
                guarded_competitions.append(str(descriptor["id"]))
                print(
                    f"ATTENZIONE {descriptor['name']}: risposta live regressiva; "
                    f"conservato il calendario precedente ({len(previous)} fixture)",
                    file=sys.stderr,
                )
            source = "UEFA public match API; ESPN fallback"

        competitions.append(competition_payload(descriptor, current, source, target_start, "europe", target_code))
        fixture_count += len(current)
        matches.extend(european_history)
        print(f"{descriptor['name']}: {len(current)} fixture target, {len(european_history)} gare storiche")

    # La deduplica usa i nomi delle squadre: risolvi prima le differenze di sola grafia
    # (per esempio Malaga/Málaga), altrimenti una partita rimane presente due volte.
    # Fusione delle grafie PRIMA di merge_matches: la chiave di deduplica contiene i nomi delle
    # squadre, quindi "Malaga" (Football-Data.co.uk) e "Málaga" (ESPN) sono due partite distinte e
    # un club spezzato in due identità, ciascuna con metà della storia. update_europe_data.main()
    # la applica già, ma l'entry point della pipeline automatica è QUESTO: è il difetto 7 di
    # MISTAKES.md rientrato dal percorso che non era stato coperto.
    spelling = base.resolve_spelling_collisions([
        str(row[side])
        for source in (matches, *[competition.get("fixtures") or [] for competition in competitions])
        for row in source
        for side in ("home_team", "away_team")
        if row.get(side)
    ])
    if spelling:
        renamed = base.apply_spelling_collisions(matches, spelling)
        for competition in competitions:
            renamed += base.apply_spelling_collisions(competition.get("fixtures") or [], spelling)
        print(
            f"grafie fuse: {len(spelling)} nomi, {renamed} riscritture "
            f"({', '.join(f'{key}->{value}' for key, value in sorted(spelling.items())[:6])})"
        )

    calendar_issues = calendar_contract_issues(competitions, target_start)
    if calendar_issues:
        raise SystemExit(
            "Calendario corrente incompleto o incoerente; il dataset esistente non viene "
            "sovrascritto:\n- " + "\n- ".join(calendar_issues)
        )

    matches = [compact_match(item) for item in base.merge_matches(matches)]
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
    referee_stats = base.compute_referee_stats(matches)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target_season": target_code,
        "latest_season": target_code,
        "model_inputs_version": "4.1-top5-uefa-core",
        "default_competition": default_competition,
        "competitions": competitions,
        "teams": teams,
        "matches": matches,
        "referee_stats": referee_stats,
        "domestic_leagues": [
            {key: descriptor[key] for key in ("id", "name", "country")}
            for descriptor in TOP_FIVE_LEAGUES
        ],
        "coverage": {
            "supported_competitions": len([item for item in competitions if item.get("fixtures")]),
            "training_matches": len(matches),
            "xg_actual_matches": xg_count,
            "teams": len(teams),
            "referees_tracked": len(referee_stats),
        },
        "source_health": {
            "target_fixtures": fixture_count,
            "completed_training_matches": len(matches),
            "european_training_matches": sum(str(item.get("competition_id")) in EUROPE_COMPETITION_IDS for item in matches),
            "fixture_snapshot_guards": sorted(set(guarded_competitions)),
            "fixture_statistics": fixture_statistics_health(competitions),
        },
        "sources": {
            "fixtures_results": "UEFA public match API for European cups; ESPN public scoreboards for domestic leagues and fallback",
            "match_statistics": "Football-Data.co.uk (odds, corners, cards, possession, referee retained) with ESPN fallback",
            "xg": "Understat datesData where the page still exposes it; getTeamData JSON endpoint per-team fallback otherwise; shot-based proxy when neither returns data",
            "model_inputs": "Goals/xG, shots, shots on target, form, Elo, venue, rest, and optional pre-match team_context (lineup/availability/promotion) or refereeHomeBias when supplied",
            "referee_stats": "Regularized (shrinkage) home-win-rate bias per referee from Football-Data.co.uk results. No source used here exposes an upcoming fixture's referee before it is officially announced, so applying this to a specific future match is a manual step, not automatic.",
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
