#!/usr/bin/env python3
"""Add supported domestic calendars, league logos and player/lineup context.

This post-processing step is intentionally best-effort. The core match dataset remains
usable when ESPN metadata or individual match summaries are temporarily unavailable.
Player context is accumulated across scheduled runs so leagues with many clubs can be
covered without sending an excessive number of requests in a single execution.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable

import update_europe_data as base

try:
    import update_uefa_data as uefa
except ImportError:  # pragma: no cover - only relevant outside the repository script path
    uefa = None

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "matches.json"


def descriptor_catalog() -> dict[str, dict[str, object]]:
    descriptors = [*base.EUROPE_COMPETITIONS, *base.DOMESTIC_LEAGUES]
    if uefa is not None:
        descriptors.extend(getattr(uefa, "EXTRA_DOMESTIC_LEAGUES", ()))
    return {str(item["id"]): dict(item) for item in descriptors}


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
    logos = league.get("logos")
    logo = ""
    if isinstance(logos, list):
        for candidate in logos:
            if isinstance(candidate, dict) and str(candidate.get("href") or "").startswith("https://"):
                logo = str(candidate["href"])
                break
    return {
        "logo": logo,
        "name": str(league.get("name") or league.get("abbreviation") or descriptor.get("name") or ""),
    }


def add_competition_metadata(
    item: dict[str, object],
    descriptor: dict[str, object],
    metadata: dict[str, str],
) -> dict[str, object]:
    result = dict(item)
    competition_id = str(result.get("id") or descriptor.get("id") or "")
    result["type"] = "europe" if competition_id in {"ucl", "uel", "uecl"} else "domestic"
    result["country"] = str(descriptor.get("country") or ("Europe" if result["type"] == "europe" else ""))
    if metadata.get("logo"):
        result["logo"] = metadata["logo"]
    return result


def completed(items: Iterable[dict[str, object]]) -> list[dict[str, object]]:
    return [
        item for item in items
        if item.get("completed") and item.get("home_goals") is not None and item.get("away_goals") is not None
    ]


def event_rosters(payload: object) -> list[dict[str, object]]:
    if not isinstance(payload, dict):
        return []
    for key in ("rosters", "lineups"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def numeric_value(stats: object, *names: str) -> float:
    wanted = {name.lower() for name in names}
    if isinstance(stats, dict):
        for key, raw in stats.items():
            if str(key).lower() in wanted:
                try:
                    return float(str(raw).replace("%", ""))
                except (TypeError, ValueError):
                    pass
    if not isinstance(stats, list):
        return 0.0
    for item in stats:
        if not isinstance(item, dict):
            continue
        key = str(item.get("name") or item.get("abbreviation") or item.get("label") or "").lower()
        if key not in wanted:
            continue
        raw = item.get("value", item.get("displayValue", 0))
        try:
            return float(str(raw).replace("%", ""))
        except (TypeError, ValueError):
            continue
    return 0.0


def position_code(raw: object) -> str:
    if isinstance(raw, dict):
        raw = raw.get("abbreviation") or raw.get("displayName") or raw.get("name")
    value = str(raw or "").strip().upper()
    if value in {"G", "GK", "PORTIERE", "GOALKEEPER"}:
        return "GK"
    if value.startswith(("DM", "CM", "AM", "M", "W")):
        return "MID"
    if value.startswith(("CB", "LB", "RB", "WB", "D")):
        return "DEF"
    if value.startswith(("F", "ST", "CF", "SS")):
        return "FWD"
    return value[:4] or "—"


def parse_summary(payload: object, event_date: str) -> list[tuple[str, dict[str, object]]]:
    parsed: list[tuple[str, dict[str, object]]] = []
    for group in event_rosters(payload):
        team_data = group.get("team") if isinstance(group.get("team"), dict) else {}
        team = base.normalize_team(str(
            team_data.get("shortDisplayName") or team_data.get("displayName") or team_data.get("name") or ""
        ))
        roster = group.get("roster") if isinstance(group.get("roster"), list) else group.get("athletes")
        if not team or not isinstance(roster, list):
            continue
        for entry in roster:
            if not isinstance(entry, dict):
                continue
            athlete = entry.get("athlete") if isinstance(entry.get("athlete"), dict) else entry
            name = str(
                athlete.get("shortName") or athlete.get("displayName") or athlete.get("fullName") or ""
            ).strip()
            if not name:
                continue
            stats = entry.get("stats", entry.get("statistics", []))
            minutes = numeric_value(stats, "minutes", "mins", "MIN")
            starter = bool(entry.get("starter") or entry.get("isStarter"))
            subbed_in = bool(entry.get("subbedIn") or entry.get("enteredGame"))
            if not (starter or subbed_in or minutes > 0):
                continue
            parsed.append((team, {
                "id": str(athlete.get("id") or name),
                "name": name,
                "position": position_code(athlete.get("position") or entry.get("position")),
                "starter": starter,
                "minutes": minutes,
                "goals": numeric_value(stats, "goals", "goal", "G"),
                "assists": numeric_value(stats, "assists", "goalAssists", "A"),
                "rating": numeric_value(stats, "rating", "playerRating"),
                "date": event_date,
            }))
    return parsed


def choose_summary_events(
    events: Iterable[tuple[str, dict[str, object]]],
    max_events: int,
    samples_per_team: int = 2,
    priority_teams: set[str] | None = None,
) -> list[tuple[str, dict[str, object]]]:
    needs: defaultdict[str, int] = defaultdict(int)
    chosen: list[tuple[str, dict[str, object]]] = []
    seen: set[str] = set()
    priority = priority_teams or set()
    ordered = sorted(
        events,
        key=lambda pair: (
            int(
                str(pair[1].get("home_team") or "") in priority
                or str(pair[1].get("away_team") or "") in priority
            ),
            str(pair[1].get("date") or ""),
        ),
        reverse=True,
    )
    for slug, event in ordered:
        event_id = str(event.get("id") or "")
        if not event_id or event_id in seen:
            continue
        home = str(event.get("home_team") or "")
        away = str(event.get("away_team") or "")
        if needs[home] >= samples_per_team and needs[away] >= samples_per_team:
            continue
        seen.add(event_id)
        chosen.append((slug, event))
        needs[home] += 1
        needs[away] += 1
        if len(chosen) >= max_events:
            break
    return chosen


def fetch_player_samples(
    events: Iterable[tuple[str, dict[str, object]]],
    max_events: int,
    priority_teams: set[str] | None = None,
) -> tuple[dict[str, dict[str, dict[str, object]]], dict[str, int]]:
    aggregates: dict[str, dict[str, dict[str, object]]] = defaultdict(dict)
    team_samples: defaultdict[str, int] = defaultdict(int)
    for slug, event in choose_summary_events(events, max_events, priority_teams=priority_teams):
        event_id = str(event["id"])
        try:
            summary = base.fetch_json(
                f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/summary?event={event_id}",
                timeout=15,
            )
        except Exception as error:
            print(f"Lineup ESPN {event_id}: {error}", file=sys.stderr)
            continue
        teams_seen: set[str] = set()
        for team, player in parse_summary(summary, str(event.get("date") or "")):
            teams_seen.add(team)
            player_id = str(player["id"])
            current = aggregates[team].setdefault(player_id, {
                "id": player_id,
                "name": player["name"],
                "position": player["position"],
                "appearances": 0,
                "starts": 0,
                "minutes": 0.0,
                "goals": 0.0,
                "assists": 0.0,
                "ratings": [],
                "last_seen": player["date"],
            })
            current["appearances"] += 1
            current["starts"] += int(bool(player["starter"]))
            current["minutes"] += float(player["minutes"])
            current["goals"] += float(player["goals"])
            current["assists"] += float(player["assists"])
            if float(player["rating"]) > 0:
                current["ratings"].append(float(player["rating"]))
            current["last_seen"] = max(str(current["last_seen"]), str(player["date"]))
        for team in teams_seen:
            team_samples[team] += 1
    return aggregates, dict(team_samples)


def player_score(player: dict[str, object]) -> float:
    rating_values = player.get("ratings") if isinstance(player.get("ratings"), list) else []
    rating = sum(rating_values) / len(rating_values) if rating_values else 6.5
    return (
        4.0 * float(player.get("starts") or 0)
        + 1.2 * float(player.get("appearances") or 0)
        + float(player.get("minutes") or 0) / 90
        + 2.2 * float(player.get("goals") or 0)
        + 1.5 * float(player.get("assists") or 0)
        + 0.4 * (rating - 6.5)
    )


def rounded_player(player: dict[str, object]) -> dict[str, object]:
    ratings = player.get("ratings") if isinstance(player.get("ratings"), list) else []
    return {
        "id": player["id"],
        "name": player["name"],
        "position": player["position"],
        "appearances": int(player.get("appearances") or 0),
        "starts": int(player.get("starts") or 0),
        "minutes": int(round(float(player.get("minutes") or 0))),
        "goals": int(round(float(player.get("goals") or 0))),
        "assists": int(round(float(player.get("assists") or 0))),
        "rating": round(sum(ratings) / len(ratings), 2) if ratings else None,
        "impact": round(player_score(player), 3),
        "last_seen": player.get("last_seen"),
    }


def probable_lineup(players: list[dict[str, object]]) -> list[dict[str, object]]:
    ordered = sorted(players, key=player_score, reverse=True)
    goalkeepers = [player for player in ordered if player.get("position") == "GK"]
    selected = goalkeepers[:1]
    selected_ids = {str(player["id"]) for player in selected}
    selected.extend(
        player for player in ordered
        if str(player["id"]) not in selected_ids and len(selected) < 11
    )
    return [rounded_player(player) for player in selected[:11]]


def formation_for(lineup: list[dict[str, object]]) -> str:
    defenders = sum(player.get("position") == "DEF" for player in lineup)
    midfielders = sum(player.get("position") == "MID" for player in lineup)
    forwards = sum(player.get("position") == "FWD" for player in lineup)
    unknown = max(0, 10 - defenders - midfielders - forwards)
    midfielders += unknown
    return f"{defenders}-{midfielders}-{forwards}" if defenders and forwards else "XI probabile"


def build_player_context(
    aggregates: dict[str, dict[str, dict[str, object]]],
    team_samples: dict[str, int],
) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    for team, player_map in aggregates.items():
        players = list(player_map.values())
        lineup = probable_lineup(players)
        if not lineup:
            continue
        samples = team_samples.get(team, 0)
        reliability = base.clamp((samples / 2) * (len(lineup) / 11), 0, 1)
        starters = [player for player in lineup if player.get("starts")]
        ratings = [float(player["rating"]) for player in lineup if player.get("rating") is not None]
        average_rating = sum(ratings) / len(ratings) if ratings else 6.5
        start_share = sum(float(player.get("starts") or 0) for player in lineup) / max(1, samples * len(lineup))
        appearances = sum(int(player.get("appearances") or 0) for player in lineup)
        goals = sum(int(player.get("goals") or 0) for player in lineup)
        assists = sum(int(player.get("assists") or 0) for player in lineup)
        lineup_strength = base.clamp(
            1 + reliability * ((average_rating - 6.5) * 0.018 + (start_share - 0.5) * 0.035),
            0.92,
            1.07,
        )
        attack_rate = (goals + 0.7 * assists) / max(1, appearances)
        creativity_rate = assists / max(1, appearances)
        attack_factor = base.clamp(1 + (attack_rate - 0.18) * 0.10 * reliability, 0.94, 1.08)
        creativity_factor = base.clamp(1 + (creativity_rate - 0.08) * 0.12 * reliability, 0.95, 1.07)
        ranked = sorted(players, key=player_score, reverse=True)
        result[team] = {
            "as_of": max(str(player.get("last_seen") or "") for player in players),
            "formation": formation_for(lineup),
            "probable_lineup": lineup,
            "players": [rounded_player(player) for player in ranked[:24]],
            "top_players": [rounded_player(player) for player in ranked[:5]],
            "lineup_reliability": round(reliability, 3),
            "lineup_strength": round(lineup_strength, 4),
            "squad_attack_factor": round(attack_factor, 4),
            "squad_creativity_factor": round(creativity_factor, 4),
            "lineup_source": f"ESPN public match summaries · {samples} formazioni recenti",
            "sampled_starters": len(starters),
        }
    return result


def apply_player_context(
    team_context: dict[str, dict[str, object]],
    players: dict[str, dict[str, object]],
) -> None:
    for team, player_data in players.items():
        context = team_context.setdefault(team, {
            "as_of": player_data.get("as_of") or date.today().isoformat(),
            "elo": None,
            "reliability": 0,
            "squad_attack": 1.0,
            "squad_creativity": 1.0,
            "squad_continuity": 0.85,
            "newcomer_impact": 0.0,
            "departure_impact": 0.0,
            "availability_attack": 1.0,
            "availability_defense": 1.0,
            "lineup_strength": 1.0,
            "promotion_attack": 1.0,
            "promotion_defense": 1.0,
            "manager_change_days": None,
            "top_players": [],
            "new_players": [],
            "source": "Dati giocatori ESPN",
        })
        context["lineup_strength"] = round(base.clamp(
            float(context.get("lineup_strength") or 1) * float(player_data["lineup_strength"]),
            0.82,
            1.12,
        ), 4)
        context["squad_attack"] = round(base.clamp(
            float(context.get("squad_attack") or 1) * float(player_data["squad_attack_factor"]),
            0.72,
            1.30,
        ), 4)
        context["squad_creativity"] = round(base.clamp(
            float(context.get("squad_creativity") or 1) * float(player_data["squad_creativity_factor"]),
            0.72,
            1.30,
        ), 4)
        if not context.get("top_players"):
            context["top_players"] = player_data["top_players"]
        context["probable_lineup"] = player_data["probable_lineup"]
        context["formation"] = player_data["formation"]
        context["lineup_reliability"] = player_data["lineup_reliability"]
        context["lineup_source"] = player_data["lineup_source"]
        context["source"] = f"{context.get('source') or 'Contesto squadra'} + formazioni ESPN"


def read_previous_context(path: str | None) -> dict[str, dict[str, object]]:
    if not path:
        return {}
    try:
        previous = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"Cache giocatori precedente non leggibile: {error}", file=sys.stderr)
        return {}
    context = previous.get("player_context") if isinstance(previous, dict) else None
    return context if isinstance(context, dict) else {}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-season", default=os.environ.get("TARGET_SEASON"))
    parser.add_argument("--history-seasons", type=int, default=3)
    parser.add_argument("--max-summary-events", type=int, default=80)
    parser.add_argument("--skip-player-data", action="store_true")
    parser.add_argument("--previous-data")
    args = parser.parse_args()

    payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
    target_code = str(args.target_season or payload.get("target_season") or payload.get("latest_season") or "")
    target_start = base.season_start(target_code)
    starts = list(range(target_start - max(1, args.history_seasons - 1), target_start + 1))
    descriptors = descriptor_catalog()

    domestic_ids = [
        str(item.get("id")) for item in payload.get("domestic_leagues", []) if isinstance(item, dict)
    ]
    competitions_by_id = {
        str(item.get("id")): dict(item)
        for item in payload.get("competitions", [])
        if isinstance(item, dict) and item.get("id")
    }
    metadata_cache: dict[str, dict[str, str]] = {}
    espn_history: list[dict[str, object]] = []
    summary_candidates: list[tuple[str, dict[str, object]]] = []

    for competition_id, competition in list(competitions_by_id.items()):
        descriptor = descriptors.get(
            competition_id,
            {"id": competition_id, "name": competition.get("name", competition_id)},
        )
        try:
            metadata_cache[competition_id] = league_metadata(descriptor, target_start)
        except Exception as error:
            print(f"Logo {competition_id}: {error}", file=sys.stderr)
            metadata_cache[competition_id] = {}
        competitions_by_id[competition_id] = add_competition_metadata(
            competition,
            descriptor,
            metadata_cache[competition_id],
        )

    for competition_id in domestic_ids:
        descriptor = descriptors.get(competition_id)
        if not descriptor or not descriptor.get("espn"):
            continue
        current: list[dict[str, object]] = []
        for start in starts:
            try:
                rows = base.fetch_espn_events(descriptor, start, "domestic")
            except Exception as error:
                print(f"Calendario {descriptor['name']} {start}: {error}", file=sys.stderr)
                rows = []
            if start == target_start:
                current = rows
            finished = completed(rows)
            espn_history.extend(finished)
            summary_candidates.extend((str(descriptor["espn"]), item) for item in finished)
        if not current:
            continue
        if competition_id not in metadata_cache:
            try:
                metadata_cache[competition_id] = league_metadata(descriptor, target_start)
            except Exception as error:
                print(f"Logo {competition_id}: {error}", file=sys.stderr)
                metadata_cache[competition_id] = {}
        competition = base.competition_payload(descriptor, current, "ESPN public scoreboard")
        competitions_by_id[competition_id] = add_competition_metadata(
            competition,
            descriptor,
            metadata_cache[competition_id],
        )

    existing_matches = payload.get("matches") if isinstance(payload.get("matches"), list) else []
    matches = base.merge_matches([*existing_matches, *espn_history])
    teams = sorted({
        str(team)
        for competition in competitions_by_id.values()
        for fixture in competition.get("fixtures", [])
        if isinstance(fixture, dict)
        for team in (fixture.get("home_team"), fixture.get("away_team"))
        if team
    })
    elo, elo_as_of, counts = base.compute_elo(matches)
    team_context = base.build_team_context(teams, elo, counts, elo_as_of, base.load_overrides())

    current_context = payload.get("player_context") if isinstance(payload.get("player_context"), dict) else {}
    player_context = {**read_previous_context(args.previous_data), **current_context}
    player_context = {
        team: item for team, item in player_context.items()
        if team in teams and isinstance(item, dict)
    }
    if not args.skip_player_data:
        missing_teams = set(teams) - set(player_context)
        priority_teams = missing_teams or set(teams)
        aggregates, team_samples = fetch_player_samples(
            summary_candidates,
            max(0, args.max_summary_events),
            priority_teams=priority_teams,
        )
        player_context.update(build_player_context(aggregates, team_samples))
    apply_player_context(team_context, player_context)

    ordered_competitions = sorted(
        competitions_by_id.values(),
        key=lambda item: (
            0 if item.get("type") == "europe" else 1,
            str(item.get("name") or item.get("id")),
        ),
    )
    payload.update({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_inputs_version": "3.1-multi-league-player-lineups",
        "competitions": ordered_competitions,
        "teams": teams,
        "matches": matches,
        "team_context": team_context,
        "player_context": player_context,
    })
    coverage = payload.setdefault("coverage", {})
    if isinstance(coverage, dict):
        coverage["supported_competitions"] = len(ordered_competitions)
        coverage["player_context_teams"] = len(player_context)
        coverage["probable_lineups"] = sum(
            bool(item.get("probable_lineup"))
            for item in player_context.values()
            if isinstance(item, dict)
        )
        coverage["player_context_missing_teams"] = sorted(set(teams) - set(player_context))
    sources = payload.setdefault("sources", {})
    if isinstance(sources, dict):
        sources["competition_logos"] = "ESPN public league metadata; initials fallback in the UI"
        sources["players_lineups"] = "ESPN public match summaries; incremental recent-start inference, best effort"

    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Arricchito {OUTPUT}: {len(ordered_competitions)} competizioni, {len(teams)} squadre, "
        f"{len(matches)} partite, {len(player_context)} contesti giocatori"
    )


if __name__ == "__main__":
    main()
