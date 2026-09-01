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
import re
import sys
from collections import Counter, defaultdict
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


def match_details(payload: object) -> list[dict[str, object]]:
    """Trova la cronologia eventi (gol/cartellini/sostituzioni) del match.

    Due schemi diversi, entrambi reali, entrambi da gestire:

    - *scoreboard*: `details`, con i flag booleani `yellowCard`/`redCard` e la lista
      `athletesInvolved`. È lo schema su cui è scritto il resto della pipeline
      (`card_counts_by_team` in update_europe_data.py).
    - *summary*: `keyEvents`, con `type.text` ("Yellow Card", "Substitution", ...) e
      `participants` al posto di `athletesInvolved`. Nessun flag booleano.

    Verificato dal vivo su entrambi gli endpoint (agosto 2026). La versione precedente di
    questo file cercava ovunque i flag booleani dello scoreboard: sull'endpoint `summary` —
    l'unico che questo script interroga davvero — non esistono, quindi il conteggio cartellini
    usciva vuoto e ogni giocatore del dataset risultava con 0 gialli e 0 rossi (1701 giocatori
    su 1701). `card_tally` ora legge entrambi gli schemi."""
    if not isinstance(payload, dict):
        return []
    sources: list[object] = [payload.get("details")]
    header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
    competitions = header.get("competitions")
    if isinstance(competitions, list) and competitions and isinstance(competitions[0], dict):
        sources.append(competitions[0].get("details"))
    sources.extend(payload.get(key) for key in ("keyEvents", "plays"))

    # Unione di tutte le fonti, non la prima non vuota. Sull'endpoint `summary` reale
    # `header.competitions[0].details` esiste ma contiene SOLO i gol (2 voci), mentre
    # `keyEvents` contiene la cronologia completa (22 voci: gol, cartellini, sostituzioni).
    # Fermarsi alla prima lista trovata — come faceva la versione precedente — significava
    # scartare tutte le sostituzioni, e senza quelle non si possono ricostruire i minuti.
    #
    # Unire però espone al rischio opposto: lo stesso gol compare in due liste (senza id in una,
    # con id e con etichetta diversa nell'altra) e un cartellino contato due volte
    # raddoppierebbe il tasso di ammonizione del giocatore. La deduplicazione avviene quindi per
    # SIGNATURE (tipo normalizzato + minuto + giocatori coinvolti) e solo TRA fonti diverse: due
    # eventi identici dentro la stessa lista sono due eventi veri (due ammonizioni allo stesso
    # giocatore nella stessa partita) e vanno tenuti entrambi. Per ogni signature si tiene il
    # numero massimo di occorrenze visto in una singola fonte.
    merged: list[dict[str, object]] = []
    taken: Counter = Counter()
    for source in sources:
        if not isinstance(source, list):
            continue
        grouped: defaultdict[tuple, list[dict[str, object]]] = defaultdict(list)
        for item in source:
            if isinstance(item, dict):
                grouped[event_signature(item)].append(item)
        for signature, group in grouped.items():
            missing = len(group) - taken[signature]
            if missing > 0:
                merged.extend(group[-missing:])
                taken[signature] = len(group)
    return merged


def event_signature(entry: dict[str, object]) -> tuple:
    clock = entry.get("clock") if isinstance(entry.get("clock"), dict) else {}
    return (event_kind(entry), str(clock.get("value") or clock.get("displayValue") or ""), tuple(event_athletes(entry)))


def event_athletes(entry: dict[str, object]) -> list[str]:
    """Id dei giocatori coinvolti in un evento, nell'ordine in cui li elenca ESPN.

    Per una sostituzione l'ordine conta: `participants[0]` è chi entra, `participants[1]` chi
    esce (confermato dal testo dell'evento, "X replaces Y")."""
    identifiers: list[str] = []
    for key in ("athletesInvolved", "participants"):
        value = entry.get(key)
        if not isinstance(value, list):
            continue
        for item in value:
            if not isinstance(item, dict):
                continue
            athlete = item.get("athlete") if isinstance(item.get("athlete"), dict) else item
            player_id = str(athlete.get("id") or "")
            if player_id:
                identifiers.append(player_id)
        if identifiers:
            return identifiers
    return identifiers


def event_kind(entry: dict[str, object]) -> tuple[bool, bool, bool]:
    """(giallo, rosso, sostituzione) per un evento, in entrambi gli schemi ESPN."""
    type_block = entry.get("type") if isinstance(entry.get("type"), dict) else {}
    label = f"{type_block.get('text') or ''} {type_block.get('type') or ''}".lower()
    is_yellow = bool(entry.get("yellowCard")) or ("yellow" in label and "card" in label)
    is_red = bool(entry.get("redCard")) or ("red" in label and "card" in label)
    # "Second Yellow Card" è un rosso, non un secondo giallo: nello schema scoreboard i flag lo
    # dicono già (yellowCard False, redCard True), in quello summary lo si legge dal testo.
    if "second yellow" in label:
        is_yellow, is_red = False, True
    return is_yellow, is_red, "substitution" in label or "substitution" in str(type_block.get("type") or "").lower()


def card_tally(details: list[dict[str, object]]) -> dict[str, dict[str, float]]:
    tally: defaultdict[str, dict[str, float]] = defaultdict(lambda: {"yellow": 0.0, "red": 0.0})
    for entry in details:
        is_yellow, is_red, _ = event_kind(entry)
        if not (is_yellow or is_red):
            continue
        for player_id in event_athletes(entry):
            if is_yellow:
                tally[player_id]["yellow"] += 1
            if is_red:
                tally[player_id]["red"] += 1
            # Un cartellino riguarda un solo giocatore: se l'evento ne elenca altri (raro,
            # tipicamente il portatore di palla nel fallo) non vanno ammoniti anche loro.
            break
    return dict(tally)


REGULATION_MINUTES = 90.0


def event_minute(entry: dict[str, object]) -> float | None:
    """Minuto di gioco di un evento, dai due formati che ESPN usa.

    `clock.value` è in secondi (2700.0 = 45'); `clock.displayValue` è testuale e può contenere
    il recupero ("45'+1'"). Si preferisce il valore numerico e si ricade sul testo."""
    clock = entry.get("clock") if isinstance(entry.get("clock"), dict) else {}
    raw_seconds = clock.get("value")
    if isinstance(raw_seconds, (int, float)) and raw_seconds >= 0:
        return float(raw_seconds) / 60.0
    display = str(clock.get("displayValue") or "")
    numbers = [int(part) for part in re.findall(r"\d+", display)]
    return float(sum(numbers)) if numbers else None


def minutes_played(payload: object, roster: list[dict[str, object]]) -> dict[str, float]:
    """Minuti giocati per giocatore, ricostruiti dagli eventi di sostituzione.

    L'endpoint `summary` di ESPN NON espone i minuti giocati: la lista `stats` per giocatore
    contiene appearances, subIns, gol, assist, tiri, tiri in porta, falli e cartellini — e
    nient'altro (verificato dal vivo, agosto 2026). Il codice precedente li cercava con
    `numeric_value(stats, "minutes", ...)`, che quindi restituiva 0 per OGNI giocatore. Da lì
    ogni tasso per-90 usciva 0, `minutesFactor` in estimatePlayerMarkets usciva 0, e ogni
    probabilità mostrata per ogni giocatore di ogni squadra era esattamente 0%.

    I minuti si ricavano invece dagli eventi di sostituzione, che ci sono:
      - titolare mai sostituito      -> tutta la partita;
      - titolare sostituito al 61'   -> 61;
      - subentrato al 61'            -> durata - 61;
      - in panchina e mai entrato    -> 0.
    La durata è quella regolamentare (90'): il recupero non viene aggiunto perché i tassi che
    ne derivano sono per-90 e sommare un recupero variabile li abbasserebbe artificialmente."""
    substitution_in: dict[str, float] = {}
    substitution_out: dict[str, float] = {}
    for entry in match_details(payload):
        _, _, is_substitution = event_kind(entry)
        if not is_substitution:
            continue
        minute = event_minute(entry)
        if minute is None:
            continue
        involved = event_athletes(entry)
        if involved:
            substitution_in.setdefault(involved[0], min(minute, REGULATION_MINUTES))
        if len(involved) > 1:
            substitution_out.setdefault(involved[1], min(minute, REGULATION_MINUTES))

    result: dict[str, float] = {}
    for entry in roster:
        athlete = entry.get("athlete") if isinstance(entry.get("athlete"), dict) else entry
        player_id = str(athlete.get("id") or "")
        if not player_id:
            continue
        starter = bool(entry.get("starter") or entry.get("isStarter"))
        came_on = bool(entry.get("subbedIn") or entry.get("enteredGame")) or player_id in substitution_in
        if starter:
            result[player_id] = substitution_out.get(player_id, REGULATION_MINUTES)
        elif came_on:
            entered = substitution_in.get(player_id)
            # Subentrato ma senza evento con orario: non si può inventare un minuto preciso.
            # 20' è il minutaggio mediano di un subentrato nei cinque campionati; meglio di 0
            # (che lo escluderebbe del tutto) e meglio di 90 (che lo tratterebbe da titolare).
            minutes = REGULATION_MINUTES - entered if entered is not None else 20.0
            result[player_id] = max(0.0, min(REGULATION_MINUTES, minutes))
        else:
            result[player_id] = 0.0
    return result


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


# Abbreviazioni di ruolo che ESPN usa davvero nel blocco `position` di ogni voce di roster
# (raccolte dai payload reali di più partite: G, CD, CD-L, CD-R, LB, RB, LWB, RWB, SW, DM, CM,
# CM-L, CM-R, M, AM, LM, RM, LW, RW, F, CF, CF-L, CF-R, SS, SUB). La versione precedente
# classificava per prefisso con una lista incompleta: "CD", "CD-L" e "CD-R" — cioè la
# stragrande maggioranza dei difensori centrali — non corrispondevano a nessun ramo e finivano
# nel gruppo "sconosciuto", che `formation_for` sommava ai centrocampisti. Da lì le formazioni
# assurde salvate nel dataset: 2-7-1 per 50 squadre su 97, 1-8-1 per altre 6.
POSITION_GROUPS = {
    "GK": ("G", "GK"),
    "DEF": ("CD", "CB", "LB", "RB", "LWB", "RWB", "WB", "D", "SW", "FB"),
    "MID": ("DM", "CM", "AM", "LM", "RM", "M", "LW", "RW", "W"),
    "FWD": ("CF", "ST", "SS", "F"),
}
# Prefissi più lunghi per primi: "CF-L" deve risolversi su "CF" (attaccante) e non su "CD",
# "LWB" su LWB e non su "LB". Ordinare per lunghezza decrescente rende il match deterministico
# indipendentemente dall'ordine di iterazione del dizionario.
POSITION_PREFIXES = sorted(
    ((prefix, group) for group, prefixes in POSITION_GROUPS.items() for prefix in prefixes),
    key=lambda pair: len(pair[0]),
    reverse=True,
)
# ESPN marca ogni panchinaro con position "SUB": è uno stato, non un ruolo, e non dice nulla
# su dove giochi quel giocatore. Va tenuto distinto da "ruolo non riconosciuto".
BENCH_MARKERS = {"SUB", "SUBSTITUTE", "BENCH", "PANCHINA"}


def position_code(raw: object) -> str:
    if isinstance(raw, dict):
        raw = raw.get("abbreviation") or raw.get("displayName") or raw.get("name")
    value = re.sub(r"[^A-Z-]", "", str(raw or "").strip().upper())
    if not value:
        return ""
    if value in BENCH_MARKERS:
        return "SUB"
    if value in {"PORTIERE", "GOALKEEPER"}:
        return "GK"
    for prefix, group in POSITION_PREFIXES:
        if value == prefix or value.startswith(f"{prefix}-"):
            return group
    for prefix, group in POSITION_PREFIXES:
        if value.startswith(prefix):
            return group
    return ""


def parse_summary(payload: object, event_date: str) -> list[tuple[str, dict[str, object]]]:
    parsed: list[tuple[str, dict[str, object]]] = []
    cards = card_tally(match_details(payload))
    for group in event_rosters(payload):
        team_data = group.get("team") if isinstance(group.get("team"), dict) else {}
        team = base.normalize_team(str(
            team_data.get("shortDisplayName") or team_data.get("displayName") or team_data.get("name") or ""
        ))
        roster = group.get("roster") if isinstance(group.get("roster"), list) else group.get("athletes")
        if not team or not isinstance(roster, list):
            continue
        # ESPN riporta il modulo effettivamente schierato ("4-3-1-2") a livello di gruppo:
        # è un dato osservato, non una ricostruzione, e va preferito a qualunque inferenza.
        formation = str(group.get("formation") or "").strip()
        minutes_by_player = minutes_played(payload, [item for item in roster if isinstance(item, dict)])
        for entry in roster:
            if not isinstance(entry, dict):
                continue
            athlete = entry.get("athlete") if isinstance(entry.get("athlete"), dict) else entry
            name = str(
                athlete.get("shortName") or athlete.get("displayName") or athlete.get("fullName") or ""
            ).strip()
            if not name:
                continue
            player_id = str(athlete.get("id") or name)
            stats = entry.get("stats", entry.get("statistics", []))
            starter = bool(entry.get("starter") or entry.get("isStarter"))
            subbed_in = bool(entry.get("subbedIn") or entry.get("enteredGame"))
            # I minuti vengono dagli eventi di sostituzione (vedi minutes_played): nella lista
            # `stats` per giocatore ESPN non espone alcun campo minuti. Resta un tentativo di
            # lettura diretta nel caso un altro endpoint lo fornisca davvero.
            minutes = minutes_by_player.get(player_id)
            if minutes is None:
                minutes = numeric_value(stats, "minutes", "minutesPlayed", "mins", "MIN")
            # Un panchinaro rimasto in panchina va registrato lo stesso, con 0 minuti e
            # `played` falso: serve a sapere che era CONVOCATO e non ha giocato, cioè a
            # stimare la probabilità che giochi la prossima volta. Scartarlo — come faceva la
            # versione precedente — significava calcolare la quota di titolarità solo tra chi
            # è sceso in campo, sovrastimandola per tutti.
            played = bool(starter or subbed_in or minutes > 0)
            # I cartellini stanno nella lista `stats` per giocatore (verificato dal vivo:
            # {"name":"yellowCards","abbreviation":"YC",...}), con gli eventi di partita come
            # riserva quando quel campo manca. È l'opposto di quanto affermava il commento
            # precedente, che dava per assente il campo e si affidava solo agli eventi — nello
            # schema sbagliato, per giunta (vedi match_details).
            event_cards = cards.get(player_id, {"yellow": 0.0, "red": 0.0})
            parsed.append((team, {
                "id": player_id,
                "name": name,
                "position": position_code(entry.get("position") or athlete.get("position")),
                "formation_place": safe_int(entry.get("formationPlace")),
                "team_formation": formation,
                "starter": starter,
                "played": played,
                "minutes": float(minutes),
                # "totalGoals" è il nome REALE confermato dal vivo su ESPN (verificato sullo
                # scoreboard di un Mondiale 2026 già concluso: {"name":"totalGoals",
                # "abbreviation":"G",...}) — "goals"/"goal" da soli non trovano mai
                # corrispondenza. Bug scoperto solo dopo che i valori dei giocatori sono
                # arrivati a 0 in modo non casuale (uniformemente per ogni giocatore, non solo
                # per chi non ha segnato): numeric_value dava priorità al campo "name" quando
                # presente, quindi l'abbreviazione "G" nella wanted-list non veniva mai
                # controllata.
                "goals": numeric_value(stats, "totalGoals", "goals", "goal", "G"),
                "assists": numeric_value(stats, "assists", "goalAssists", "A"),
                "yellow_cards": numeric_value(stats, "yellowCards", "YC") or event_cards["yellow"],
                "red_cards": numeric_value(stats, "redCards", "RC") or event_cards["red"],
                "shots": numeric_value(stats, "totalShots", "shotsTotal", "SH", "SHOT"),
                # Tiri in porta: già presenti nel payload e mai letti prima. Servono come
                # mercato a sé ("almeno un tiro in porta") e come indicatore della qualità dei
                # tiri di un giocatore, non solo del loro numero.
                "shots_on_target": numeric_value(stats, "shotsOnTarget", "SOG"),
                "fouls": numeric_value(stats, "foulsCommitted", "FC"),
                "rating": numeric_value(stats, "rating", "playerRating"),
                "date": event_date,
            }))
    return parsed


def safe_int(value: object) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


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
) -> tuple[dict[str, dict[str, dict[str, object]]], dict[str, int], dict[str, Counter]]:
    aggregates: dict[str, dict[str, dict[str, object]]] = defaultdict(dict)
    team_samples: defaultdict[str, int] = defaultdict(int)
    team_formations: defaultdict[str, Counter] = defaultdict(Counter)
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
        formations: dict[str, str] = {}
        for team, player in parse_summary(summary, str(event.get("date") or "")):
            teams_seen.add(team)
            if player.get("team_formation"):
                formations[team] = str(player["team_formation"])
            player_id = str(player["id"])
            current = aggregates[team].setdefault(player_id, {
                "id": player_id,
                "name": player["name"],
                # Ruolo per voto di maggioranza sulle partite campionate, non "l'ultimo visto":
                # ESPN marca ogni panchinaro come "SUB" (uno stato, non un ruolo), quindi
                # prendere l'ultimo valore farebbe perdere il ruolo vero di chiunque sia finito
                # in panchina nell'ultima gara campionata.
                "positions": Counter(),
                # squad_appearances = convocazioni; appearances = partite effettivamente
                # giocate. La distinzione è quella che permette di stimare la probabilità che
                # il giocatore scenda in campo nella PROSSIMA partita invece di assumere che
                # chi ha giocato giochi sempre.
                "squad_appearances": 0,
                "appearances": 0,
                "starts": 0,
                "minutes": 0.0,
                "goals": 0.0,
                "assists": 0.0,
                "yellow_cards": 0.0,
                "red_cards": 0.0,
                "shots": 0.0,
                "shots_on_target": 0.0,
                "fouls": 0.0,
                "ratings": [],
                "last_seen": player["date"],
            })
            position = str(player.get("position") or "")
            if position and position != "SUB":
                current["positions"][position] += 1
            current["squad_appearances"] += 1
            if not player.get("played"):
                current["last_seen"] = max(str(current["last_seen"]), str(player["date"]))
                continue
            current["appearances"] += 1
            current["starts"] += int(bool(player["starter"]))
            current["minutes"] += float(player["minutes"])
            current["goals"] += float(player["goals"])
            current["assists"] += float(player["assists"])
            current["yellow_cards"] += float(player["yellow_cards"])
            current["red_cards"] += float(player["red_cards"])
            current["shots"] += float(player["shots"])
            current["shots_on_target"] += float(player.get("shots_on_target") or 0)
            current["fouls"] += float(player.get("fouls") or 0)
            if float(player["rating"]) > 0:
                current["ratings"].append(float(player["rating"]))
            current["last_seen"] = max(str(current["last_seen"]), str(player["date"]))
        for team in teams_seen:
            team_samples[team] += 1
            if formations.get(team):
                team_formations[team][formations[team]] += 1
    return aggregates, dict(team_samples), dict(team_formations)


def main_position(player: dict[str, object]) -> str:
    positions = player.get("positions")
    if isinstance(positions, Counter) and positions:
        return positions.most_common(1)[0][0]
    if isinstance(positions, dict) and positions:
        return max(positions.items(), key=lambda pair: pair[1])[0]
    return str(player.get("position") or "")


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


# Prior per-90 per ruolo, usati per lo shrinkage dei tassi individuali. Non sono medie del
# dataset (che su tre partite campionate sarebbero esse stesse rumorose) ma valori di
# riferimento per ruolo dai benchmark pubblici citati in docs/player-probability-study.md.
# Servono a un problema molto concreto: con 200 minuti campionati, un attaccante che ha segnato
# una volta risulta a 0.45 gol/90 e uno che non ha segnato a 0.00 — entrambe stime che nessuno
# userebbe per una previsione. Lo shrinkage bayesiano le riporta verso il prior del ruolo con
# un peso proporzionale ai minuti effettivamente osservati.
ROLE_PRIORS = {
    "GK":  {"goals": 0.002, "assists": 0.01, "shots": 0.03, "shots_on_target": 0.01, "yellow": 0.08, "red": 0.006},
    "DEF": {"goals": 0.06, "assists": 0.05, "shots": 0.55, "shots_on_target": 0.17, "yellow": 0.20, "red": 0.012},
    "MID": {"goals": 0.13, "assists": 0.12, "shots": 1.20, "shots_on_target": 0.38, "yellow": 0.19, "red": 0.008},
    "FWD": {"goals": 0.38, "assists": 0.13, "shots": 2.40, "shots_on_target": 0.85, "yellow": 0.13, "red": 0.006},
}
DEFAULT_PRIOR = ROLE_PRIORS["MID"]
# Minuti "equivalenti" del prior: con PRIOR_MINUTES minuti osservati il tasso stimato sta a
# metà strada tra prior di ruolo e osservato. 360' = quattro partite intere, la soglia sotto la
# quale un tasso individuale è dominato dal rumore campionario.
PRIOR_MINUTES = 360.0


def shrunk_rate(total: float, minutes: float, prior: float) -> float:
    """Media pesata tra tasso osservato e prior di ruolo (stimatore bayesiano coniugato
    Gamma-Poisson): (eventi + prior*PRIOR_MINUTES/90) / (minuti + PRIOR_MINUTES) * 90."""
    prior_events = prior * PRIOR_MINUTES / 90.0
    return (float(total) + prior_events) * 90.0 / (float(minutes) + PRIOR_MINUTES)


def rounded_player(player: dict[str, object], team_samples: int = 0) -> dict[str, object]:
    ratings = player.get("ratings") if isinstance(player.get("ratings"), list) else []
    minutes = float(player.get("minutes") or 0)
    per90 = (90 / minutes) if minutes > 0 else 0.0
    position = main_position(player)
    prior = ROLE_PRIORS.get(position, DEFAULT_PRIOR)
    appearances = int(player.get("appearances") or 0)
    starts = int(player.get("starts") or 0)
    squad_appearances = max(int(player.get("squad_appearances") or 0), appearances)
    samples = max(team_samples, squad_appearances, 1)
    return {
        "id": player["id"],
        "name": player["name"],
        "position": position or "—",
        "squad_appearances": squad_appearances,
        "appearances": appearances,
        "starts": starts,
        "minutes": int(round(minutes)),
        "goals": int(round(float(player.get("goals") or 0))),
        "assists": int(round(float(player.get("assists") or 0))),
        "yellow_cards": int(round(float(player.get("yellow_cards") or 0))),
        "red_cards": int(round(float(player.get("red_cards") or 0))),
        "shots": int(round(float(player.get("shots") or 0))),
        "shots_on_target": int(round(float(player.get("shots_on_target") or 0))),
        # Tassi per 90 minuti GREZZI: la media campionaria, senza correzioni. Restano esposti
        # perché è quello che il giocatore ha davvero fatto nel campione, ed è ciò che va
        # mostrato quando si dichiara uno storico.
        "goals_per90": round(float(player.get("goals") or 0) * per90, 3),
        "assists_per90": round(float(player.get("assists") or 0) * per90, 3),
        "shots_per90": round(float(player.get("shots") or 0) * per90, 3),
        "shots_on_target_per90": round(float(player.get("shots_on_target") or 0) * per90, 3),
        "yellow_per90": round(float(player.get("yellow_cards") or 0) * per90, 3),
        "red_per90": round(float(player.get("red_cards") or 0) * per90, 3),
        # ...e i tassi con shrinkage verso il prior di ruolo: sono questi che model.js usa per
        # prevedere. Su campioni di poche partite la differenza non è cosmetica — un attaccante
        # con 1 gol in 200 minuti passa da 0.45 gol/90 (implausibile, sarebbe il capocannoniere
        # d'Europa) a circa 0.40 verso il prior, e un attaccante a secco passa da 0.00
        # (altrettanto implausibile) a un valore positivo.
        "goals_per90_shrunk": round(shrunk_rate(float(player.get("goals") or 0), minutes, prior["goals"]), 4),
        "assists_per90_shrunk": round(shrunk_rate(float(player.get("assists") or 0), minutes, prior["assists"]), 4),
        "shots_per90_shrunk": round(shrunk_rate(float(player.get("shots") or 0), minutes, prior["shots"]), 4),
        "shots_on_target_per90_shrunk": round(
            shrunk_rate(float(player.get("shots_on_target") or 0), minutes, prior["shots_on_target"]), 4
        ),
        "yellow_per90_shrunk": round(shrunk_rate(float(player.get("yellow_cards") or 0), minutes, prior["yellow"]), 4),
        "red_per90_shrunk": round(shrunk_rate(float(player.get("red_cards") or 0), minutes, prior["red"]), 4),
        # Probabilità di essere titolare / di scendere in campo nella prossima partita, con la
        # stessa correzione di Laplace usata ovunque per non produrre 0% o 100% da tre
        # osservazioni. `minutes_per_start`/`minutes_per_sub` alimentano il calcolo dei minuti
        # attesi in model.js: un titolare che esce sempre al 60' non va trattato come uno che
        # gioca sempre tutta la partita.
        "start_probability": round((starts + 0.5) / (samples + 1.5), 3),
        "play_probability": round((appearances + 0.5) / (samples + 1.0), 3),
        "minutes_per_start": round(minutes / starts, 1) if starts else 0.0,
        "minutes_per_appearance": round(minutes / appearances, 1) if appearances else 0.0,
        "rating": round(sum(ratings) / len(ratings), 2) if ratings else None,
        "impact": round(player_score(player), 3),
        "last_seen": player.get("last_seen"),
    }


# Numero di giocatori per reparto nei moduli che ESPN riporta. La chiave è il modulo come
# stringa; il valore è (difensori, centrocampisti, attaccanti) escluso il portiere.
def formation_shape(formation: str) -> tuple[int, int, int] | None:
    parts = [int(part) for part in re.findall(r"\d", str(formation or ""))]
    if len(parts) < 3 or sum(parts) != 10:
        return None
    # Un modulo a quattro cifre (4-3-1-2, 4-2-3-1) distingue mediani e trequartisti: per il
    # conteggio dei reparti i blocchi centrali vanno insieme al centrocampo, l'ultimo blocco
    # è la punta o le punte.
    return parts[0], sum(parts[1:-1]), parts[-1]


def probable_lineup(players: list[dict[str, object]], formation: str = "", team_samples: int = 0) -> list[dict[str, object]]:
    """Undici probabile rispettando la struttura del modulo, non solo i primi 11 per impatto.

    La versione precedente prendeva un portiere e poi i dieci giocatori con impatto più alto,
    senza guardare il ruolo: bastava che un reparto avesse giocatori più continui degli altri
    perché la formazione risultante ne contenesse otto, ed è esattamente quello che è successo
    (moduli 2-7-1 e 1-8-1 salvati nel dataset). Qui si riempie ogni reparto con i migliori del
    reparto, secondo il modulo effettivamente riportato da ESPN quando disponibile."""
    ordered = sorted(players, key=player_score, reverse=True)
    shape = formation_shape(formation) or (4, 4, 2)
    quotas = {"DEF": shape[0], "MID": shape[1], "FWD": shape[2]}
    by_position: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    for player in ordered:
        by_position[main_position(player) or "—"].append(player)

    selected = by_position.get("GK", [])[:1]
    selected_ids = {str(player["id"]) for player in selected}
    for group, quota in quotas.items():
        for player in by_position.get(group, []):
            if len(selected) >= 11 or sum(1 for item in selected if main_position(item) == group) >= quota:
                break
            selected.append(player)
            selected_ids.add(str(player["id"]))
    # Reparti incompleti (campione troppo piccolo, ruoli non riconosciuti): si completa con i
    # migliori rimasti, un XI parziale sarebbe peggio di un XI con un ruolo approssimato.
    for player in ordered:
        if len(selected) >= 11:
            break
        if str(player["id"]) not in selected_ids:
            selected.append(player)
            selected_ids.add(str(player["id"]))
    return [rounded_player(player, team_samples) for player in selected[:11]]


def formation_for(lineup: list[dict[str, object]], reported: str = "") -> str:
    """Modulo riportato da ESPN quando c'è (dato osservato), altrimenti ricostruito dai ruoli."""
    if formation_shape(reported):
        return str(reported).strip()
    defenders = sum(player.get("position") == "DEF" for player in lineup)
    midfielders = sum(player.get("position") == "MID" for player in lineup)
    forwards = sum(player.get("position") == "FWD" for player in lineup)
    unknown = max(0, 10 - defenders - midfielders - forwards)
    midfielders += unknown
    return f"{defenders}-{midfielders}-{forwards}" if defenders and forwards else "XI probabile"


# Quanto l'undici probabile si discosta da quello che la squadra ha REALMENTE schierato di
# recente. Il valore di riferimento è la squadra stessa, non la costante 1.
#
# La versione precedente era:
#     clamp(1 + reliability * ((avgRating - 6.5) * 0.018 + (startShare - 0.5) * 0.035), 0.92, 1.07)
#
# e non poteva scendere sotto 1 per due motivi indipendenti, entrambi misurati:
#   · `avgRating` vale SEMPRE 6.5 perché ESPN espone `rating: null` — verificato su tutte le
#     95 squadre coperte, 0 giocatori su 31 con un rating in un campione;
#   · `startShare` è quasi sempre >= 0.5 perché probable_lineup() seleziona proprio gli undici
#     con più presenze: il termine si confronta con una soglia che la sua stessa costruzione
#     garantisce di superare.
#
# Distribuzione risultante su 303 squadre: min 1.0000, mediana 1.0000, max 1.0175, **zero
# squadre sotto 1**, 95 sopra — e quelle 95 sono esattamente le squadre coperte da
# player_context. Un fattore che può solo premiare, e che premia solo chi la pipeline è
# riuscita a coprire, non è un effetto calcistico: è un bias a favore della copertura.
#
# La forma corretta è un RAPPORTO fra due undici della stessa squadra: quello probabile e
# quello tipo recente, misurati entrambi con l'impatto dei giocatori che li compongono.
# Sopra 1 quando rientra chi mancava, sotto 1 quando mancano i titolari. Finché nessuna fonte
# dice chi è indisponibile i due undici coincidono e il rapporto vale esattamente 1, che è la
# risposta onesta: nessuna informazione, nessun aggiustamento. Il giorno in cui una fonte di
# indisponibilità arriva (Task 12 del brief), questa funzione la usa senza altre modifiche.
LINEUP_SENSITIVITY = 0.6


def compute_lineup_strength(
    lineup: list[dict[str, object]],
    squad: list[dict[str, object]],
    reliability: float,
) -> float:
    def impact_of(player: dict[str, object]) -> float:
        value = player.get("impact")
        if value is None:
            # Ricalcolato con la STESSA formula che produce `impact`, non sostituito dai
            # minuti. Il ripiego sui minuti sembrava innocuo — "il rapporto li normalizza" —
            # ed era il difetto: i due undici arrivano qui da percorsi diversi, il probabile
            # passa da rounded_player() che aggiunge `impact`, la rosa no. Il rapporto
            # confrontava quindi impact (~10-20 a giocatore) con minuti (~180-270), valeva
            # ~0.06 per OGNI squadra e finiva schiacciato sul minimo del clamp: 0.92 su tutte
            # e 100 le squadre, cioè un fattore costante spacciato per una misura.
            # Ricalcolarlo rende la funzione indifferente alla forma dei dizionari che riceve.
            value = player_score(player)
        return max(0.0, float(value))

    probable = sum(impact_of(player) for player in lineup)
    # Undici di riferimento: gli undici che hanno giocato di più, cioè la squadra che
    # l'allenatore sta effettivamente schierando.
    reference_players = sorted(squad, key=lambda player: float(player.get("minutes") or 0), reverse=True)[:len(lineup)]
    reference = sum(impact_of(player) for player in reference_players)
    if reference <= 0 or probable <= 0:
        return 1.0
    return base.clamp(1 + reliability * LINEUP_SENSITIVITY * (probable / reference - 1), 0.92, 1.07)


def build_player_context(
    aggregates: dict[str, dict[str, dict[str, object]]],
    team_samples: dict[str, int],
    team_formations: dict[str, Counter] | None = None,
) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    formations = team_formations or {}
    for team, player_map in aggregates.items():
        players = list(player_map.values())
        samples = team_samples.get(team, 0)
        counted = formations.get(team)
        reported_formation = counted.most_common(1)[0][0] if counted else ""
        lineup = probable_lineup(players, reported_formation, samples)
        if not lineup:
            continue
        reliability = base.clamp((samples / 2) * (len(lineup) / 11), 0, 1)
        starters = [player for player in lineup if player.get("starts")]
        appearances = sum(int(player.get("appearances") or 0) for player in lineup)
        goals = sum(int(player.get("goals") or 0) for player in lineup)
        assists = sum(int(player.get("assists") or 0) for player in lineup)
        lineup_strength = compute_lineup_strength(lineup, players, reliability)
        attack_rate = (goals + 0.7 * assists) / max(1, appearances)
        creativity_rate = assists / max(1, appearances)
        attack_factor = base.clamp(1 + (attack_rate - 0.18) * 0.10 * reliability, 0.94, 1.08)
        creativity_factor = base.clamp(1 + (creativity_rate - 0.08) * 0.12 * reliability, 0.95, 1.07)
        ranked = sorted(players, key=player_score, reverse=True)
        result[team] = {
            "as_of": max(str(player.get("last_seen") or "") for player in players),
            "formation": formation_for(lineup, reported_formation),
            "formation_source": "ESPN" if formation_shape(reported_formation) else "ricostruito dai ruoli",
            "probable_lineup": lineup,
            "players": [rounded_player(player, samples) for player in ranked],
            "top_players": [rounded_player(player, samples) for player in ranked[:5]],
            "lineup_reliability": round(reliability, 3),
            "lineup_strength": round(lineup_strength, 4),
            "squad_attack_factor": round(attack_factor, 4),
            "squad_creativity_factor": round(creativity_factor, 4),
            "lineup_source": f"ESPN public match summaries · {samples} formazioni recenti",
            "sampled_starters": len(starters),
            "schema": PLAYER_CONTEXT_SCHEMA,
        }
    return result


# Versione dello schema di una voce di player_context. Il contesto giocatori è accumulato tra
# esecuzioni successive (una run copre solo una parte delle squadre), quindi una voce prodotta
# da una versione precedente dello script può sopravvivere per giorni dentro data/matches.json.
# Con la correzione su minuti/cartellini/ruoli quelle voci non sono solo vecchie ma sbagliate —
# minuti a zero, quindi ogni probabilità a zero — e vanno scartate invece che riusate.
#   2: minuti dagli eventi di sostituzione, cartellini dalle statistiche per giocatore, ruoli
#      mappati correttamente, modulo riportato da ESPN, tassi con shrinkage di ruolo.
#   3: ruoli completati dal roster di squadra per chi non è mai stato visto titolare.
PLAYER_CONTEXT_SCHEMA = 3


def usable_player_entry(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    return int(entry.get("schema") or 0) >= PLAYER_CONTEXT_SCHEMA


def squad_positions(slug: str, team_id: str) -> dict[str, str]:
    """Ruolo dichiarato di ogni giocatore in rosa, dall'endpoint roster di squadra.

    Serve a coprire un buco reale: nelle formazioni ESPN i panchinari hanno position "SUB",
    che è uno stato e non un ruolo. Un giocatore mai visto titolare nelle partite campionate
    resta quindi senza ruolo — 1544 giocatori su 3478 alla prima esecuzione della pipeline
    corretta — e senza ruolo non si può né assegnargli il prior giusto né collocarlo nel reparto
    corretto dell'undici probabile. Il roster di squadra dà un ruolo a tutti (G/D/M/F), al costo
    di una chiamata per squadra."""
    payload = base.fetch_json(
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/teams/{team_id}/roster",
        timeout=15,
    )
    if not isinstance(payload, dict):
        return {}
    result: dict[str, str] = {}
    groups = payload.get("athletes")
    if not isinstance(groups, list):
        return {}
    # Due forme possibili: lista piatta di atleti, oppure lista di gruppi con "items".
    entries: list[dict[str, object]] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        items = group.get("items")
        entries.extend(item for item in items if isinstance(item, dict)) if isinstance(items, list) else entries.append(group)
    for athlete in entries:
        player_id = str(athlete.get("id") or "")
        position = position_code(athlete.get("position"))
        if player_id and position and position != "SUB":
            result[player_id] = position
    return result


def team_espn_locations(
    payload: dict[str, object],
    descriptors: dict[str, dict[str, object]],
) -> dict[str, list[tuple[str, str]]]:
    """Nome squadra -> elenco di (slug di lega ESPN, id squadra), dai calendari già nel dataset.

    L'ordine conta: prima i campionati nazionali, poi le coppe. L'endpoint roster è indicizzato
    per LEGA, quindi `/uefa.champions/teams/110/roster` risponde 404 anche per una squadra che
    la Champions la gioca davvero — il roster dell'Inter sta sotto `ita.1`. Restituire più
    candidati permette anche di riprovare quando il primo non risponde."""
    domestic_first = sorted(
        (item for item in payload.get("competitions", []) if isinstance(item, dict)),
        key=lambda item: 1 if str(item.get("type") or "") == "europe" else 0,
    )
    locations: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
    for competition in domestic_first:
        descriptor = descriptors.get(str(competition.get("id") or ""))
        slug = str((descriptor or {}).get("espn") or competition.get("id") or "")
        if not slug:
            continue
        for fixture in competition.get("fixtures", []):
            if not isinstance(fixture, dict):
                continue
            for side in ("home", "away"):
                team = str(fixture.get(f"{side}_team") or "")
                team_id = str(fixture.get(f"{side}_team_id") or "")
                if team and team_id and (slug, team_id) not in locations[team]:
                    locations[team].append((slug, team_id))
    return dict(locations)


def fill_missing_positions(
    aggregates: dict[str, dict[str, dict[str, object]]],
    locations: dict[str, list[tuple[str, str]]],
) -> int:
    """Completa i ruoli mancanti interrogando il roster solo delle squadre che ne hanno bisogno."""
    filled = 0
    for team, player_map in aggregates.items():
        missing = [player for player in player_map.values() if not main_position(player)]
        if not missing:
            continue
        positions: dict[str, str] = {}
        for slug, team_id in locations.get(team, [])[:3]:
            try:
                positions = squad_positions(slug, team_id)
            except Exception as error:
                print(f"Roster ESPN {team} ({slug}/{team_id}): {error}", file=sys.stderr)
                continue
            if positions:
                break
        for player in missing:
            position = positions.get(str(player.get("id") or ""))
            if position:
                player["positions"][position] += 1
                filled += 1
    return filled


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
    parser.add_argument(
        "--skip-squad-positions",
        action="store_true",
        help="Non interrogare il roster di squadra per completare i ruoli dei giocatori mai visti titolari.",
    )
    parser.add_argument(
        "--rebuild-player-context",
        action="store_true",
        help=(
            "Scarta il contesto giocatori in cache e ricostruiscilo da zero. Serve dopo una "
            "correzione che cambia COME i dati vengono estratti senza cambiare lo schema: le "
            "voci in cache resterebbero altrimenti valide e non verrebbero mai riscritte."
        ),
    )
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
        competition = base.competition_payload(descriptor, current, "ESPN public scoreboard", target_code)
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
    player_context = (
        {} if args.rebuild_player_context
        else {**read_previous_context(args.previous_data), **current_context}
    )
    stale = [team for team, item in player_context.items() if not usable_player_entry(item)]
    player_context = {
        team: item for team, item in player_context.items()
        if team in teams and usable_player_entry(item)
    }
    if stale:
        print(
            f"Scartate {len(stale)} voci player_context con schema precedente a "
            f"{PLAYER_CONTEXT_SCHEMA} (minuti/cartellini/ruoli non affidabili): "
            "verranno ricostruite nelle prossime esecuzioni.",
            file=sys.stderr,
        )
    if not args.skip_player_data:
        missing_teams = set(teams) - set(player_context)
        priority_teams = missing_teams or set(teams)
        aggregates, team_samples, team_formations = fetch_player_samples(
            summary_candidates,
            max(0, args.max_summary_events),
            priority_teams=priority_teams,
        )
        if not args.skip_squad_positions:
            locations = team_espn_locations(payload, descriptors)
            filled = fill_missing_positions(aggregates, locations)
            if filled:
                print(f"Ruoli completati dal roster di squadra per {filled} giocatori", file=sys.stderr)
        player_context.update(build_player_context(aggregates, team_samples, team_formations))
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
        # NON si riscrive model_inputs_version: la versione identifica CHI ha costruito il
        # dataset (update_top5_data.py), non l'ultimo script che lo tocca. Riscriverla qui la
        # faceva scendere da "4.1-top5-uefa-core" a "3.1-...", cioe' un passo successivo
        # dichiarava una versione piu' bassa del passo precedente. Che l'arricchimento sia
        # stato eseguito si vede da player_context, che e' il campo che aggiunge.
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

    # Seconda applicazione della fusione delle grafie, perché questo script è l'ULTIMO a
    # scrivere data/matches.json. update_europe_data.main() la applica già, ma i due scrittori
    # sono processi separati: una run di questo script su un payload prodotto da una versione
    # precedente della pipeline riscriverebbe sul disco uno split che nessuno ha più tolto.
    # È la lezione del difetto 7 di MISTAKES.md — la correzione deve stare su OGNI percorso che
    # scrive, non solo su quello che si aveva in mente. Costa una passata sui nomi.
    spelling = base.resolve_spelling_collisions([
        str(row[side])
        for source in [payload.get("matches") or []] + [item.get("fixtures") or [] for item in payload.get("competitions") or []]
        for row in source
        for side in ("home_team", "away_team")
        if row.get(side)
    ])
    if spelling:
        renamed = base.apply_spelling_collisions(payload.get("matches") or [], spelling)
        for item in payload.get("competitions") or []:
            renamed += base.apply_spelling_collisions(item.get("fixtures") or [], spelling)
        # Riscrivere i nomi non basta: le due righe della stessa partita restano due righe,
        # perche' la deduplica era gia' avvenuta quando i nomi erano ancora diversi. Va rifatta
        # DOPO la fusione, come fa update_europe_data.main().
        matches = base.merge_matches(payload["matches"])
        payload["matches"] = matches
        for key in ("team_context", "player_context"):
            section = payload.get(key)
            if isinstance(section, dict):
                for source_name, target in spelling.items():
                    if source_name in section and target not in section:
                        section[target] = section.pop(source_name)
                    elif source_name in section:
                        section.pop(source_name)
        teams = payload.get("teams")
        if isinstance(teams, list):
            payload["teams"] = sorted({spelling.get(str(name), str(name)) for name in teams})
        print(f"grafie fuse in uscita: {len(spelling)} nomi, {renamed} riscritture")

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
