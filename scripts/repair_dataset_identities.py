#!/usr/bin/env python3
"""Applica al dataset già generato la canonicalizzazione dei nomi squadra di normalize_team().

Il fix in update_europe_data.py vale per le esecuzioni FUTURE della pipeline. data/matches.json
è però già stato costruito con la tabella incompleta, e rigenerarlo da zero significherebbe
riscaricare quattro stagioni da tre fonti — con il rischio di far cambiare anche ciò che non
c'entra e di rendere non confrontabili tutte le misure di riferimento. Questo script applica
la sola correzione voluta, in modo deterministico e verificabile.

Tre passaggi, nell'ordine:
  1. rinomina ogni occorrenza di un nome squadra nel payload (partite, fixture future, elenco
     squadre, team_context, player_context, coverage);
  2. rifonde le righe partita diventate duplicate, con la stessa regola di merge_matches():
     vince la riga più ricca, i campi mancanti si prendono dall'altra. È qui che le due metà
     della stessa partita — la copia ESPN con l'xG e la copia Football-Data con tiri e quote —
     tornano a essere una riga sola e completa;
  3. con --backfill-xg, riaggancia da Understat gli xG delle partite che ne restano prive.

Uso:
  python3 scripts/repair_dataset_identities.py --dry-run
  python3 scripts/repair_dataset_identities.py
  python3 scripts/repair_dataset_identities.py --backfill-xg
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from update_europe_data import (  # noqa: E402
    DOMESTIC_LEAGUES,
    _fold_team_name,
    normalize_team,
    resolve_spelling_collisions,
    richness,
)
from update_uefa_data import UEFA_TEAM_OVERRIDES  # noqa: E402

DATASET = ROOT / "data" / "matches.json"
DOMESTIC_IDS = {league["id"] for league in DOMESTIC_LEAGUES}


# `resolve_spelling_collisions` viveva qui. È stata spostata in update_europe_data.py il
# 28/08/2026 perché la pipeline la applichi da sé: finché stava solo in questo script, la
# rigenerazione automatica reintroduceva lo split "Malaga"/"Málaga" a ogni esecuzione e la
# riparazione andava lanciata a mano. Qui resta importata, così i due percorsi non divergono.


def match_key(item: dict) -> tuple[str, str, str, str]:
    return (
        str(item.get("competition_id")),
        str(item.get("date")),
        str(item.get("home_team")),
        str(item.get("away_team")),
    )


def merge_pair(previous: dict, item: dict) -> dict:
    """Stessa regola di merge_matches(): la riga più ricca vince, l'altra tappa i buchi."""
    richer, poorer = (item, previous) if richness(item) >= richness(previous) else (previous, item)
    combined = dict(poorer)
    combined.update({key: value for key, value in richer.items() if value is not None})
    for team_key in ("home_team_id", "away_team_id"):
        combined[team_key] = previous.get(team_key) or item.get(team_key)
    return combined


EUROPE_IDS = {"ucl", "uel", "uecl"}


def apply_uefa_overrides(rows: list[dict]) -> tuple[int, list[str]]:
    """Rinomina i soli nomi che l'API UEFA usa per una squadra diversa dal resto della pipeline.

    Va PRIMA di rename_rows(): normalize_team() non puo' risolvere questi casi, perche' fuori
    dalle coppe lo stesso nome indica un altro club ("Paris" in Ligue 1 e' il Paris FC).

    La guardia rifiuta la rinomina se il nome di destinazione compare gia' in una riga UEFA:
    in quel caso i due nomi convivono in Europa, sono quindi due club distinti, e fonderli
    sarebbe il difetto opposto — piu' grave di quello che si sta correggendo.
    """
    notes: list[str] = []
    european = [row for row in rows if str(row.get("competition_id")) in EUROPE_IDS]
    renamed = 0
    for source, target in UEFA_TEAM_OVERRIDES.items():
        canonical = normalize_team(target)
        present = {
            str(row[side])
            for row in european
            for side in ("home_team", "away_team")
            if row.get(side)
        }
        if source not in present:
            continue
        if canonical in present:
            notes.append(
                f"UEFA override SALTATO: {source!r} e {canonical!r} compaiono ENTRAMBI in Europa, "
                "quindi sono due club distinti e fonderli sarebbe un errore piu' grave"
            )
            continue
        touched = 0
        for row in european:
            for side in ("home_team", "away_team"):
                if str(row.get(side)) == source:
                    row[side] = canonical
                    touched += 1
        renamed += touched
        notes.append(f"UEFA override: {source!r} -> {canonical!r} su {touched} occorrenze in coppa")
    return renamed, notes


def rename_rows(rows: list[dict]) -> tuple[list[dict], int, dict[str, str]]:
    renames: dict[str, str] = {}
    renamed = 0
    for row in rows:
        for side in ("home_team", "away_team"):
            original = row.get(side)
            if not original:
                continue
            canonical = normalize_team(str(original))
            if canonical != original:
                renames[str(original)] = canonical
                row[side] = canonical
                renamed += 1
    return rows, renamed, renames


def collapse_matches(rows: list[dict]) -> tuple[list[dict], int]:
    merged: dict[tuple[str, str, str, str], dict] = {}
    collapsed = 0
    for row in rows:
        key = match_key(row)
        previous = merged.get(key)
        if previous is None:
            merged[key] = row
            continue
        merged[key] = merge_pair(previous, row)
        collapsed += 1
    ordered = sorted(
        merged.values(),
        key=lambda item: (str(item.get("date")), str(item.get("competition_id")), str(item.get("home_team"))),
    )
    return ordered, collapsed


def collapse_team_map(mapping: dict, label: str, spelling: dict[str, str] | None = None) -> tuple[dict, list[str]]:
    """Fonde le chiavi che collassano sullo stesso nome canonico.

    Quando due voci collidono si tiene quella con più informazione (più campi non nulli),
    a parità la più recente per as_of: fra "Ath Bilbao" e "Athletic" la prima ha la storia
    completa e la seconda i frammenti, e prendere la seconda butterebbe via proprio ciò che
    la canonicalizzazione serve a ricomporre.
    """
    def informativeness(entry: object) -> tuple[int, str]:
        if isinstance(entry, dict):
            filled = sum(1 for value in entry.values() if value not in (None, "", [], {}))
            return (filled, str(entry.get("as_of") or ""))
        if isinstance(entry, list):
            return (len(entry), "")
        return (0, "")

    collapsed: dict[str, object] = {}
    notes: list[str] = []
    for name, entry in mapping.items():
        canonical = normalize_team(str(name))
        canonical = (spelling or {}).get(canonical, canonical)
        if canonical in collapsed:
            keep, drop = (
                (collapsed[canonical], entry)
                if informativeness(collapsed[canonical]) >= informativeness(entry)
                else (entry, collapsed[canonical])
            )
            notes.append(f"{label}: {name!r} + esistente -> {canonical!r} (tenuta la voce più ricca)")
            collapsed[canonical] = keep
            _ = drop
        else:
            collapsed[canonical] = entry
    return collapsed, notes


def league_xg_coverage(matches: list[dict]) -> dict[str, dict[str, tuple[int, int]]]:
    table: dict[str, dict[str, tuple[int, int]]] = defaultdict(dict)
    counters: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for item in matches:
        competition = str(item.get("competition_id"))
        if competition not in DOMESTIC_IDS:
            continue
        if item.get("home_goals") is None or item.get("away_goals") is None:
            continue
        cell = counters[(competition, str(item.get("season")))]
        cell[1] += 1
        if item.get("home_xg") is not None and item.get("away_xg") is not None:
            cell[0] += 1
    for (competition, season), (with_xg, total) in counters.items():
        table[competition][season] = (with_xg, total)
    return table


def print_coverage(table: dict[str, dict[str, tuple[int, int]]], title: str) -> None:
    print(f"\n{title}")
    seasons = sorted({season for rows in table.values() for season in rows})
    print("  lega   | " + " | ".join(season.ljust(11) for season in seasons))
    for competition in sorted(table):
        cells = []
        for season in seasons:
            pair = table[competition].get(season)
            cells.append(f"{100 * pair[0] / pair[1]:5.1f}% n={pair[1]:<3}".ljust(11) if pair and pair[1] else "-".ljust(11))
        print(f"  {competition.ljust(6)} | " + " | ".join(cells))


def identity_report(matches: list[dict], title: str) -> None:
    per_season: dict[tuple[str, str], set[str]] = defaultdict(set)
    for item in matches:
        competition = str(item.get("competition_id"))
        if competition not in DOMESTIC_IDS:
            continue
        for side in ("home_team", "away_team"):
            if item.get(side):
                per_season[(competition, str(item.get("season")))].add(str(item[side]))
    print(f"\n{title}")
    for key in sorted(per_season):
        count = len(per_season[key])
        flag = "" if count <= 20 else "   <-- più identità che squadre"
        print(f"  {key[0]} {key[1]}: {count} identità{flag}")


def backfill_xg(payload: dict, cache_dir: Path | None) -> int:
    """Riaggancia gli xG mancanti da Understat, con i nomi ormai canonici da entrambi i lati."""
    import understat_team_api
    from understat_team_api import fetch_league_matches_via_team_api

    understat_team_api.CACHE_DIR = cache_dir

    matches = payload["matches"]
    index = {
        (str(item.get("competition_id")), str(item.get("date")), str(item.get("home_team")), str(item.get("away_team"))): item
        for item in matches
    }
    filled = 0
    for league in DOMESTIC_LEAGUES:
        if not league.get("understat"):
            continue
        seasons: dict[int, set[str]] = defaultdict(set)
        for item in matches:
            if str(item.get("competition_id")) != league["id"]:
                continue
            season = str(item.get("season") or "")
            if len(season) != 4 or not season.isdigit():
                continue
            start_year = 2000 + int(season[:2])
            for side in ("home_team", "away_team"):
                if item.get(side):
                    seasons[start_year].add(str(item[side]))
        for start_year in sorted(seasons):
            missing = [
                item for item in matches
                if str(item.get("competition_id")) == league["id"]
                and str(item.get("season") or "")[:2] == f"{start_year % 100:02d}"
                and item.get("home_goals") is not None
                and (item.get("home_xg") is None or item.get("away_xg") is None)
            ]
            if not missing:
                print(f"{league['id']} {start_year}: xG già completi, nessuna richiesta", file=sys.stderr)
                continue
            print(f"{league['id']} {start_year}: {len(missing)} gare senza xG, interrogo Understat...", file=sys.stderr)
            try:
                rows = fetch_league_matches_via_team_api(start_year, seasons[start_year], normalize_team)
            except Exception as error:
                print(f"{league['id']} {start_year}: fallito ({error})", file=sys.stderr)
                continue
            for row in rows:
                item = index.get((league["id"], str(row["date"]), str(row["home_team"]), str(row["away_team"])))
                if item is None or item.get("home_xg") is not None:
                    continue
                item["home_xg"] = row["home_xg"]
                item["away_xg"] = row["away_xg"]
                filled += 1
    return filled


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="mostra il diff senza scrivere")
    parser.add_argument("--backfill-xg", action="store_true", help="riaggancia gli xG mancanti da Understat")
    parser.add_argument("--file", default=str(DATASET))
    parser.add_argument("--cache-dir", default=str(ROOT / ".cache" / "understat"),
                        help="cache delle risposte Understat, per rendere ripetibile il backfill")
    arguments = parser.parse_args()

    path = Path(arguments.file)
    payload = json.loads(path.read_text(encoding="utf8"))

    before_coverage = league_xg_coverage(payload["matches"])
    identity_report(payload["matches"], "identità per lega/stagione PRIMA")
    print_coverage(before_coverage, "copertura xG PRIMA")

    # Prima di tutto il resto: gli override di fonte, che normalize_team() non puo' risolvere.
    uefa_renamed, uefa_notes = apply_uefa_overrides(payload["matches"])
    for note in uefa_notes:
        print(f"  {note}")

    payload["matches"], renamed, renames = rename_rows(payload["matches"])
    renamed += uefa_renamed

    # Secondo passaggio: le collisioni di sola grafia si vedono solo guardando tutti i nomi
    # insieme, quindi dopo la mappatura per alias e prima della rifusione delle righe.
    every_name = [
        str(row[side])
        for source in (payload["matches"], *[competition.get("fixtures") or [] for competition in payload.get("competitions", [])])
        for row in source
        for side in ("home_team", "away_team")
        if row.get(side)
    ]
    spelling = resolve_spelling_collisions(every_name)
    if spelling:
        for row in payload["matches"]:
            for side in ("home_team", "away_team"):
                if row.get(side) in spelling:
                    row[side] = spelling[str(row[side])]
                    renamed += 1
        renames.update(spelling)

    payload["matches"], collapsed = collapse_matches(payload["matches"])

    fixture_renamed = 0
    fixture_collapsed = 0
    for competition in payload.get("competitions", []):
        fixtures = competition.get("fixtures") or []
        fixtures, count, more = rename_rows(fixtures)
        renames.update(more)
        fixture_renamed += count
        for fixture in fixtures:
            for side in ("home_team", "away_team"):
                if fixture.get(side) in spelling:
                    fixture[side] = spelling[str(fixture[side])]
                    fixture_renamed += 1
        deduped: dict[tuple[str, str, str, str], dict] = {}
        for fixture in fixtures:
            key = match_key(fixture)
            if key in deduped:
                fixture_collapsed += 1
                deduped[key] = merge_pair(deduped[key], fixture)
            else:
                deduped[key] = fixture
        competition["fixtures"] = list(deduped.values())

    notes: list[str] = []
    for key in ("team_context", "player_context"):
        if isinstance(payload.get(key), dict):
            payload[key], more = collapse_team_map(payload[key], key, spelling)
            notes.extend(more)

    if isinstance(payload.get("teams"), list):
        payload["teams"] = sorted({spelling.get(normalize_team(str(name)), normalize_team(str(name))) for name in payload["teams"] if name})
    coverage = payload.get("coverage")
    if isinstance(coverage, dict):
        if isinstance(coverage.get("player_context_missing_teams"), list):
            coverage["player_context_missing_teams"] = sorted(
                {spelling.get(normalize_team(str(name)), normalize_team(str(name))) for name in coverage["player_context_missing_teams"] if name}
            )
        coverage["teams"] = len(payload.get("teams") or [])
        coverage["training_matches"] = len(payload["matches"])
        coverage["player_context_teams"] = len(payload.get("player_context") or {})

    filled = backfill_xg(payload, Path(arguments.cache_dir) if arguments.cache_dir else None) if arguments.backfill_xg else 0
    if isinstance(coverage, dict):
        coverage["xg_actual_matches"] = sum(
            1 for item in payload["matches"] if item.get("home_xg") is not None and item.get("away_xg") is not None
        )

    print("\n=== riepilogo ===")
    print(f"nomi riscritti nelle partite : {renamed}")
    print(f"nomi riscritti nelle fixture : {fixture_renamed}")
    print(f"righe partita rifuse         : {collapsed}")
    print(f"fixture rifuse               : {fixture_collapsed}")
    print(f"xG riagganciati da Understat : {filled}")
    print(f"famiglie di alias applicate  : {len(renames)}")
    for original, canonical in sorted(renames.items()):
        print(f"    {original!r} -> {canonical!r}")
    for note in notes:
        print(f"    {note}")

    identity_report(payload["matches"], "identità per lega/stagione DOPO")
    print_coverage(league_xg_coverage(payload["matches"]), "copertura xG DOPO")

    if arguments.dry_run:
        print("\n--dry-run: nessuna scrittura")
        return 0

    backup = path.with_suffix(path.suffix + ".bak")
    if not backup.exists():
        shutil.copy2(path, backup)
        print(f"\nbackup: {backup}")
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(f"scritto: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
