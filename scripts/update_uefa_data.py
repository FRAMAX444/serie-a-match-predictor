#!/usr/bin/env python3
"""Run the European dataset builder with the official UEFA match API enabled.

The base updater keeps ESPN, Football-Data and Understat integrations. This module
injects UEFA's public match endpoint as the primary source and uses UEFA country
codes to select only the domestic leagues relevant to participating clubs.
"""
from __future__ import annotations

import json
import re
import unicodedata
import urllib.parse
from pathlib import Path

import update_europe_data as base

UEFA_COMPETITION_IDS = {"ucl": 1, "uel": 14, "uecl": 2019}
PARTICIPANT_COUNTRY_CODES: set[str] = set()
CANONICAL_PARTICIPANTS: set[str] = set()

LEAGUE_COUNTRY_CODES = {
    "eng.1": {"ENG", "WAL"}, "esp.1": {"ESP", "AND"}, "ita.1": {"ITA", "SMR"},
    "ger.1": {"GER"}, "fra.1": {"FRA", "MCO"}, "ned.1": {"NED"}, "por.1": {"POR"},
    "bel.1": {"BEL"}, "tur.1": {"TUR"}, "sco.1": {"SCO"}, "aut.1": {"AUT"},
    "sui.1": {"SUI", "LIE"}, "gre.1": {"GRE"}, "den.1": {"DEN"}, "cze.1": {"CZE"},
    "nor.1": {"NOR"}, "swe.1": {"SWE"}, "pol.1": {"POL"}, "cro.1": {"CRO"},
    "srb.1": {"SRB"}, "ukr.1": {"UKR"}, "rou.1": {"ROU"}, "isr.1": {"ISR"},
    "hun.1": {"HUN"}, "cyp.1": {"CYP"}, "bul.1": {"BUL"}, "svn.1": {"SVN"},
    "svk.1": {"SVK"}, "fin.1": {"FIN"}, "irl.1": {"IRL"}, "isl.1": {"ISL"},
    "nir.1": {"NIR"}, "wal.1": {"WAL"}, "alb.1": {"ALB"}, "bih.1": {"BIH"},
    "mkd.1": {"MKD"}, "mda.1": {"MDA"}, "geo.1": {"GEO"}, "arm.1": {"ARM"},
    "aze.1": {"AZE"}, "kaz.1": {"KAZ"}, "ltu.1": {"LTU"}, "lva.1": {"LVA"},
    "est.1": {"EST"}, "blr.1": {"BLR"}, "mlt.1": {"MLT"}, "lux.1": {"LUX"},
    "gib.1": {"GIB"}, "fro.1": {"FRO"}, "kos.1": {"KOS"}, "mne.1": {"MNE"},
}

EXTRA_DOMESTIC_LEAGUES = (
    {"id": "isl.1", "name": "Besta deild", "country": "Iceland", "espn": "isl.1", "strength": 1335},
    {"id": "nir.1", "name": "NIFL Premiership", "country": "Northern Ireland", "espn": "nir.1", "strength": 1305},
    {"id": "wal.1", "name": "Cymru Premier", "country": "Wales", "espn": "wal.1", "strength": 1300},
    {"id": "alb.1", "name": "Kategoria Superiore", "country": "Albania", "espn": "alb.1", "strength": 1300},
    {"id": "bih.1", "name": "Premier League Bosnia", "country": "Bosnia and Herzegovina", "espn": "bih.1", "strength": 1300},
    {"id": "mkd.1", "name": "Macedonian First League", "country": "North Macedonia", "espn": "mkd.1", "strength": 1290},
    {"id": "mda.1", "name": "Moldovan Super Liga", "country": "Moldova", "espn": "mda.1", "strength": 1285},
    {"id": "geo.1", "name": "Erovnuli Liga", "country": "Georgia", "espn": "geo.1", "strength": 1295},
    {"id": "arm.1", "name": "Armenian Premier League", "country": "Armenia", "espn": "arm.1", "strength": 1285},
    {"id": "aze.1", "name": "Azerbaijan Premier League", "country": "Azerbaijan", "espn": "aze.1", "strength": 1320},
    {"id": "kaz.1", "name": "Kazakhstan Premier League", "country": "Kazakhstan", "espn": "kaz.1", "strength": 1315},
    {"id": "ltu.1", "name": "A Lyga", "country": "Lithuania", "espn": "ltu.1", "strength": 1275},
    {"id": "lva.1", "name": "Virsliga", "country": "Latvia", "espn": "lva.1", "strength": 1275},
    {"id": "est.1", "name": "Meistriliiga", "country": "Estonia", "espn": "est.1", "strength": 1270},
    {"id": "blr.1", "name": "Belarusian Premier League", "country": "Belarus", "espn": "blr.1", "strength": 1280},
    {"id": "mlt.1", "name": "Maltese Premier League", "country": "Malta", "espn": "mlt.1", "strength": 1245},
    {"id": "lux.1", "name": "Luxembourg National Division", "country": "Luxembourg", "espn": "lux.1", "strength": 1245},
    {"id": "gib.1", "name": "Gibraltar Football League", "country": "Gibraltar", "espn": "gib.1", "strength": 1225},
    {"id": "fro.1", "name": "Faroe Islands Premier League", "country": "Faroe Islands", "espn": "fro.1", "strength": 1260},
    {"id": "kos.1", "name": "Kosovo Superleague", "country": "Kosovo", "espn": "kos.1", "strength": 1270},
    {"id": "mne.1", "name": "Montenegrin First League", "country": "Montenegro", "espn": "mne.1", "strength": 1270},
)


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


def canonical_team_name(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"\b(fc|cf|sc|afc|fk|sk|ac|as|pfc|club|calcio|football|futbol|sporting)\b", " ", text)
    return re.sub(r"[^a-z0-9]+", "", text)


def score_value(score: object, side: str) -> int | None:
    if not isinstance(score, dict):
        return None
    for section_name in ("regular", "total"):
        section = score.get(section_name)
        if isinstance(section, dict):
            try:
                return int(float(section.get(side)))
            except (TypeError, ValueError):
                pass
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
    completed = str(match.get("status") or "").upper() == "FINISHED"
    item: dict[str, object] = {
        "id": str(match.get("id") or f"uefa-{descriptor['id']}-{season}-{source_index}"),
        "season": season, "competition_id": descriptor["id"], "competition_name": descriptor["name"],
        "competition_type": "europe", "country": "Europe", "league_strength": 1500,
        "date": match_date, "kickoff": raw_datetime or None,
        "home_team": home_team, "away_team": away_team,
        "home_team_id": str(home.get("id") or "") or None, "away_team_id": str(away.get("id") or "") or None,
        "home_country_code": str(home.get("countryCode") or "") or None,
        "away_country_code": str(away.get("countryCode") or "") or None,
        "round": None, "round_label": round_label(match), "completed": completed,
        "source_index": source_index, "source": "UEFA public match API", "importance": 1.18,
    }
    if completed:
        home_goals = score_value(match.get("score"), "home")
        away_goals = score_value(match.get("score"), "away")
        if home_goals is None or away_goals is None:
            return None
        item["home_goals"], item["away_goals"] = home_goals, away_goals
    return item


def fetch_uefa_matches(descriptor: dict[str, object], start_year: int) -> list[dict[str, object]]:
    competition_id = UEFA_COMPETITION_IDS[str(descriptor["id"])]
    season = base.season_code(start_year)
    limit, offset = 100, 0
    rows: list[dict[str, object]] = []
    while True:
        query = urllib.parse.urlencode({"competitionId": competition_id, "seasonYear": start_year + 1, "phase": "ALL", "limit": limit, "offset": offset, "order": "ASC"})
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
    return sorted({str(item["id"]): item for item in rows}.values(), key=lambda item: (str(item["date"]), str(item["id"])))


original_fetch_events = base.fetch_espn_events
original_competition_payload = base.competition_payload
original_team_keys = base.team_keys


def fetch_europe_then_espn(descriptor: dict[str, object], start_year: int, competition_type: str) -> list[dict[str, object]]:
    if competition_type != "europe":
        return original_fetch_events(descriptor, start_year, competition_type)
    try:
        official = fetch_uefa_matches(descriptor, start_year)
        if official:
            print(f"UEFA API {descriptor['name']} {base.season_code(start_year)}: {len(official)} gare")
            return official
    except Exception as error:
        print(f"UEFA API {descriptor['name']} {base.season_code(start_year)}: {error}", file=base.sys.stderr)
    try:
        return original_fetch_events(descriptor, start_year, competition_type)
    except Exception:
        return []


def collect_team_keys(items: list[dict[str, object]]) -> tuple[set[str], set[str]]:
    ids, names = original_team_keys(items)
    PARTICIPANT_COUNTRY_CODES.clear()
    CANONICAL_PARTICIPANTS.clear()
    for item in items:
        for side in ("home", "away"):
            code = str(item.get(f"{side}_country_code") or "").upper()
            if code:
                PARTICIPANT_COUNTRY_CODES.add(code)
            key = canonical_team_name(item.get(f"{side}_team"))
            if key:
                CANONICAL_PARTICIPANTS.add(key)
    return ids, names


def robust_participant_match(item: dict[str, object], ids: set[str], names: set[str]) -> bool:
    if any(str(item.get(f"{side}_team_id") or "") in ids for side in ("home", "away")):
        return True
    for side in ("home", "away"):
        candidate = canonical_team_name(item.get(f"{side}_team"))
        if not candidate:
            continue
        if candidate in CANONICAL_PARTICIPANTS:
            return True
        if len(candidate) >= 6 and any(len(participant) >= 6 and (candidate in participant or participant in candidate) for participant in CANONICAL_PARTICIPANTS):
            return True
    return False


def discover_leagues_by_country(participant_ids: set[str], participant_names: set[str], target_start: int, cache: dict[tuple[str, int], list[dict[str, object]]]) -> list[dict[str, object]]:
    relevant = []
    for league in base.DOMESTIC_LEAGUES:
        codes = LEAGUE_COUNTRY_CODES.get(str(league["id"]), set())
        if codes & PARTICIPANT_COUNTRY_CODES:
            relevant.append(dict(league))
            print(f"Campionato rilevante UEFA: {league['name']}")
    return relevant


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
            if isinstance(competition, dict) and competition.get("fixtures") and any(isinstance(item, dict) and item.get("source") == "UEFA public match API" for item in competition["fixtures"]):
                competition["source"] = "UEFA public match API"
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    existing_ids = {str(item["id"]) for item in base.DOMESTIC_LEAGUES}
    base.DOMESTIC_LEAGUES = tuple(base.DOMESTIC_LEAGUES) + tuple(item for item in EXTRA_DOMESTIC_LEAGUES if str(item["id"]) not in existing_ids)
    base.fetch_espn_events = fetch_europe_then_espn
    base.competition_payload = official_competition_payload
    base.team_keys = collect_team_keys
    base.involves_participant = robust_participant_match
    base.discover_relevant_leagues = discover_leagues_by_country
    base.main()
    correct_output_sources(base.OUTPUT)


if __name__ == "__main__":
    main()
