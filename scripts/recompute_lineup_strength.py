#!/usr/bin/env python3
"""Ricalcola lineup_strength nel dataset già generato con la formula ancorata.

Il fix in enrich_competitions_players.py vale per le esecuzioni future della pipeline, che
richiedono di riscaricare le formazioni da ESPN. Il campo però è già nel payload con la
versione difettosa, e resta lì — con il suo bias — finché quella pipeline non gira. Questo
script applica la sola correzione voluta, in modo deterministico e senza rete, usando
compute_lineup_strength() come unica fonte di verità.

Difetto corretto (misura sul dataset del 25/08/2026, 303 squadre in team_context):

    min 1.0000 · p25 1.0000 · mediana 1.0000 · p75 1.0080 · max 1.0175
    zero squadre sotto 1.0 · 95 sopra · 208 esattamente a 1.0

Le 95 sopra 1 sono esattamente le 95 coperte da player_context. Un fattore che può solo
premiare, e che premia solo chi la pipeline è riuscita a coprire, non misura un effetto
calcistico: misura la copertura della pipeline.

Uso:
  python3 scripts/recompute_lineup_strength.py --dry-run
  python3 scripts/recompute_lineup_strength.py
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base  # noqa: E402
from enrich_competitions_players import compute_lineup_strength  # noqa: E402

DATASET = ROOT / "data" / "matches.json"


def describe(values: list[float], label: str) -> None:
    if not values:
        print(f"{label}: nessun valore")
        return
    ordered = sorted(values)
    quantile = lambda fraction: ordered[int(fraction * (len(ordered) - 1))]  # noqa: E731
    below = sum(1 for value in values if value < 1)
    above = sum(1 for value in values if value > 1)
    exact = sum(1 for value in values if value == 1)
    print(
        f"{label}: n={len(values)}  min {quantile(0):.4f}  p25 {quantile(0.25):.4f}  "
        f"mediana {quantile(0.5):.4f}  p75 {quantile(0.75):.4f}  max {quantile(1):.4f}"
    )
    print(f"    sotto 1: {below}   esattamente 1: {exact}   sopra 1: {above}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--file", default=str(DATASET))
    arguments = parser.parse_args()

    path = Path(arguments.file)
    payload = json.loads(path.read_text(encoding="utf8"))
    players = payload.get("player_context") or {}
    teams = payload.get("team_context") or {}

    describe([float(entry.get("lineup_strength") or 1) for entry in teams.values()], "team_context PRIMA")
    describe([float(entry.get("lineup_strength") or 1) for entry in players.values()], "player_context PRIMA")

    changed = 0
    for team, entry in players.items():
        lineup = entry.get("probable_lineup") or []
        squad = entry.get("players") or []
        reliability = float(entry.get("lineup_reliability") or 0)
        if not lineup or not squad:
            continue
        value = round(compute_lineup_strength(lineup, squad, reliability), 4)
        if value != entry.get("lineup_strength"):
            changed += 1
        entry["lineup_strength"] = value
        context = teams.get(team)
        if context is not None:
            # In pipeline il valore di squadra è il prodotto del valore di partenza (1.0) per
            # quello dei giocatori: ricalcolarlo qui significa quindi assegnarlo direttamente.
            context["lineup_strength"] = round(base.clamp(value, 0.82, 1.12), 4)

    print(f"\nvoci player_context aggiornate: {changed}/{len(players)}")
    describe([float(entry.get("lineup_strength") or 1) for entry in teams.values()], "team_context DOPO")
    describe([float(entry.get("lineup_strength") or 1) for entry in players.values()], "player_context DOPO")

    if arguments.dry_run:
        print("\n--dry-run: nessuna scrittura")
        return 0
    backup = path.with_suffix(path.suffix + ".pre-lineup.bak")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(f"scritto: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
