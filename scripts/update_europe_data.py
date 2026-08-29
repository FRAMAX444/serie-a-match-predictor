#!/usr/bin/env python3
"""Build the dataset for UEFA club competition predictions.

The public app predicts only:
- UEFA Champions League
- UEFA Europa League
- UEFA Conference League

Training data contains European matches plus domestic-league matches only for clubs
currently present in one of those competitions. Sources are keyless and best-effort:
ESPN public scoreboards, Football-Data.co.uk CSVs and Understat xG for supported leagues.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import math
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "matches.json"
OVERRIDES = ROOT / "data" / "context_overrides.json"
USER_AGENT = "Mozilla/5.0 (compatible; EuropeMatchPredictor/3.0; +https://github.com/FRAMAX444/serie-a-match-predictor)"

EUROPE_COMPETITIONS = (
    {"id": "ucl", "name": "UEFA Champions League", "espn": "uefa.champions"},
    {"id": "uel", "name": "UEFA Europa League", "espn": "uefa.europa"},
    {"id": "uecl", "name": "UEFA Conference League", "espn": "uefa.europa.conf"},
)

DOMESTIC_LEAGUES = (
    {"id": "eng.1", "name": "Premier League", "country": "England", "espn": "eng.1", "fd": "E0", "understat": "EPL", "strength": 1570},
    {"id": "esp.1", "name": "LaLiga", "country": "Spain", "espn": "esp.1", "fd": "SP1", "understat": "La_liga", "strength": 1555},
    {"id": "ita.1", "name": "Serie A", "country": "Italy", "espn": "ita.1", "fd": "I1", "understat": "Serie_A", "strength": 1550},
    {"id": "ger.1", "name": "Bundesliga", "country": "Germany", "espn": "ger.1", "fd": "D1", "understat": "Bundesliga", "strength": 1540},
    {"id": "fra.1", "name": "Ligue 1", "country": "France", "espn": "fra.1", "fd": "F1", "understat": "Ligue_1", "strength": 1520},
    {"id": "ned.1", "name": "Eredivisie", "country": "Netherlands", "espn": "ned.1", "fd": "N1", "strength": 1495},
    {"id": "por.1", "name": "Primeira Liga", "country": "Portugal", "espn": "por.1", "fd": "P1", "strength": 1495},
    {"id": "bel.1", "name": "Belgian Pro League", "country": "Belgium", "espn": "bel.1", "fd": "B1", "strength": 1465},
    {"id": "tur.1", "name": "Süper Lig", "country": "Turkey", "espn": "tur.1", "fd": "T1", "strength": 1455},
    {"id": "sco.1", "name": "Scottish Premiership", "country": "Scotland", "espn": "sco.1", "fd": "SC0", "strength": 1445},
    {"id": "aut.1", "name": "Austrian Bundesliga", "country": "Austria", "espn": "aut.1", "strength": 1445},
    {"id": "sui.1", "name": "Swiss Super League", "country": "Switzerland", "espn": "sui.1", "strength": 1435},
    {"id": "gre.1", "name": "Greek Super League", "country": "Greece", "espn": "gre.1", "fd": "G1", "strength": 1430},
    {"id": "den.1", "name": "Danish Superliga", "country": "Denmark", "espn": "den.1", "strength": 1425},
    {"id": "cze.1", "name": "Czech First League", "country": "Czechia", "espn": "cze.1", "strength": 1420},
    {"id": "nor.1", "name": "Eliteserien", "country": "Norway", "espn": "nor.1", "strength": 1405},
    {"id": "swe.1", "name": "Allsvenskan", "country": "Sweden", "espn": "swe.1", "strength": 1400},
    {"id": "pol.1", "name": "Ekstraklasa", "country": "Poland", "espn": "pol.1", "strength": 1400},
    {"id": "cro.1", "name": "Croatian HNL", "country": "Croatia", "espn": "cro.1", "strength": 1395},
    {"id": "srb.1", "name": "Serbian SuperLiga", "country": "Serbia", "espn": "srb.1", "strength": 1390},
    {"id": "ukr.1", "name": "Ukrainian Premier League", "country": "Ukraine", "espn": "ukr.1", "strength": 1390},
    {"id": "rou.1", "name": "Romanian Liga I", "country": "Romania", "espn": "rou.1", "strength": 1380},
    {"id": "isr.1", "name": "Israeli Premier League", "country": "Israel", "espn": "isr.1", "strength": 1380},
    {"id": "hun.1", "name": "Hungarian NB I", "country": "Hungary", "espn": "hun.1", "strength": 1370},
    {"id": "cyp.1", "name": "Cypriot First Division", "country": "Cyprus", "espn": "cyp.1", "strength": 1365},
    {"id": "bul.1", "name": "Bulgarian First League", "country": "Bulgaria", "espn": "bul.1", "strength": 1360},
    {"id": "svn.1", "name": "Slovenian PrvaLiga", "country": "Slovenia", "espn": "svn.1", "strength": 1350},
    {"id": "svk.1", "name": "Slovak Super Liga", "country": "Slovakia", "espn": "svk.1", "strength": 1345},
    {"id": "fin.1", "name": "Veikkausliiga", "country": "Finland", "espn": "fin.1", "strength": 1335},
    {"id": "irl.1", "name": "League of Ireland", "country": "Ireland", "espn": "irl.1", "strength": 1325},
)

NAME_MAP = {
    "Internazionale": "Inter", "Internazionale Milano": "Inter", "Inter Milan": "Inter",
    "AC Milan": "Milan", "AS Roma": "Roma", "Roma FC": "Roma", "Juventus FC": "Juventus",
    "SSC Napoli": "Napoli", "Napoli SSC": "Napoli", "Bayern": "Bayern Monaco",
    "Bayern Munich": "Bayern Monaco", "Bayern München": "Bayern Monaco",
    "Borussia Dortmund": "Dortmund", "Paris Saint-Germain": "PSG", "Paris SG": "PSG",
    "Manchester United": "Man United", "Manchester City": "Man City",
    "Tottenham Hotspur": "Tottenham", "Newcastle United": "Newcastle", "Athletic Club": "Athletic Bilbao",
    "Atlético Madrid": "Atletico Madrid", "Atletico de Madrid": "Atletico Madrid", "Atletico": "Atletico Madrid",
    "Atlético": "Atletico Madrid", "Real Betis Balompié": "Real Betis", "Sporting CP": "Sporting Lisbona",
    "Sporting Lisbon": "Sporting Lisbona", "FC Porto": "Porto", "SL Benfica": "Benfica",
    "PSV Eindhoven": "PSV", "Ajax Amsterdam": "Ajax", "Olympique Marseille": "Marsiglia",
    "Olympique Lyon": "Lione", "Olympique Lyonnais": "Lione", "AS Monaco": "Monaco", "Bayer Leverkusen": "Leverkusen",
    "RB Leipzig": "Lipsia", "Eintracht Frankfurt": "Francoforte", "Club Brugge": "Club Bruges",
    "Celtic Glasgow": "Celtic", "Rangers FC": "Rangers", "Red Bull Salzburg": "Salisburgo",
    "FC Salzburg": "Salisburgo", "Shakhtar Donetsk": "Shakhtar", "Dynamo Kyiv": "Dynamo Kiev",
    "FC Copenhagen": "Copenhagen", "FC København": "Copenhagen", "Sparta Prague": "Sparta Praga",
    "Slavia Prague": "Slavia Praga", "Red Star Belgrade": "Stella Rossa", "Crvena Zvezda": "Stella Rossa",
    "Dinamo Zagreb": "Dinamo Zagabria", "Olympiacos": "Olympiakos", "Fenerbahce": "Fenerbahçe",
    "Besiktas": "Beşiktaş", "Galatasaray SK": "Galatasaray",
}


# Alias della STESSA squadra scritti in modo diverso dalle diverse fonti. Non è cosmesi:
# merge_matches() deduplica sulla chiave (competition_id, date, home_team, away_team) e
# enrich_xg() aggancia le righe Understat sulla stessa chiave. Quando ESPN scrive "Atletico
# Madrid" e Football-Data.co.uk scrive "Ath Madrid", la chiave non coincide e la stessa
# partita reale resta nel dataset DUE volte, ciascuna con metà delle statistiche — la copia
# ESPN con l'xG, la copia Football-Data con tiri e quote.
#
# Misure sul dataset del 24/08/2026 (8646 gare) prima di questa tabella:
#   · 210 coppie di righe duplicate nei Big Five, 25 famiglie di alias;
#   · Bundesliga 2425 con 22 identità di squadra invece di 18, LaLiga con 28 invece di 20:
#     "Gladbach" 6 partite e "M'gladbach" 34, quindi Elo, forma e medie di quel club erano
#     calcolati su frammenti di storia;
#   · lo split attraversa il confine coppe/campionato — Athletic Bilbao aveva 114 gare come
#     "Ath Bilbao" e 14 come "Athletic" in LaLiga, e 22 come "Athletic Bilbao" in Europa,
#     con ZERO sovrapposizione: nelle previsioni di coppa quel club era una squadra senza
#     storia, e lo stesso valeva per Lipsia/Leipzig e Rayo Vallecano/Vallecano;
#   · copertura xG 35% in esp.1 e 34% in ger.1 contro 90-99% in Serie A — non per un
#     problema di Understat (l'endpoint getTeamData risponde correttamente per tutte e
#     cinque le leghe, verificato dal vivo il 25/08/2026) ma perché per quelle squadre la
#     chiave di aggancio non esisteva.
#
# Il nome canonico scelto è quello che NAME_MAP e schedina.js già dichiarano dove esiste
# (Francoforte, Lipsia, Athletic Bilbao, Atletico Madrid), altrimenti la variante già
# dominante nel dataset: così la correzione sposta il minor numero possibile di righe.
#
# Le varianti che differiscono solo per accenti o punteggiatura ("Alavés"/"Alaves",
# "St. Pauli"/"St Pauli", "Nott'm Forest"/"Nottm Forest") NON vanno elencate: le fonde
# _fold_team_name() sotto. Qui vanno solo le abbreviazioni vere.
TEAM_ALIASES = {
    # Bundesliga
    "M'gladbach": ("Gladbach", "Borussia M'gladbach", "Borussia Monchengladbach", "Monchengladbach", "Borussia Moenchengladbach"),
    "Francoforte": ("Frankfurt", "Ein Frankfurt", "Eintracht Frankfurt", "Eintracht"),
    "Werder Bremen": ("Bremen", "Werder"),
    "FC Koln": ("Cologne", "Koln", "Colonia", "1. FC Koln", "FC Cologne"),
    "Lipsia": ("Leipzig", "RB Leipzig", "RasenBallsport Leipzig"),
    "Bayern Monaco": ("Bayern", "Bayern Munich", "Bayern Munchen", "FC Bayern Munchen"),
    # "B. Dortmund" e' la forma dell'API UEFA: 102 gare domestiche contro 37 europee, separate.
    "Dortmund": ("Borussia Dortmund", "BVB", "B. Dortmund"),
    "Leverkusen": ("Bayer Leverkusen", "Bayer 04 Leverkusen"),
    "Hoffenheim": ("TSG Hoffenheim", "1899 Hoffenheim"),
    "Stuttgart": ("VfB Stuttgart",),
    "Mainz": ("Mainz 05", "FSV Mainz 05"),
    "Heidenheim": ("FC Heidenheim", "1. FC Heidenheim"),
    "Hamburg": ("Hamburger SV",),
    "Schalke": ("Schalke 04",),
    # LaLiga
    "Celta Vigo": ("Celta",),
    "Rayo Vallecano": ("Rayo", "Vallecano"),
    "Athletic Bilbao": ("Ath Bilbao", "Athletic", "Athletic Club"),
    # "Atleti" e' la forma dell'API UEFA. Senza questa voce il club aveva 116 gare come
    # "Atletico Madrid" nei campionati e 36 come "Atleti" in Europa, con ZERO sovrapposizione:
    # esattamente lo split coppe/campionato che questa tabella era nata per chiudere.
    "Atletico Madrid": ("Ath Madrid", "Atl. Madrid", "Atletico", "Atletico de Madrid", "Club Atletico de Madrid", "Atleti"),
    "Espanyol": ("Espanol", "RCD Espanyol"),
    "Real Sociedad": ("Sociedad",),
    "Real Oviedo": ("Oviedo",),
    "Real Valladolid": ("Valladolid",),
    "Real Betis": ("Betis", "Real Betis Balompie"),
    "Deportivo La Coruna": ("Deportivo", "Dep. A Coruna", "La Coruna", "Deportivo A Coruna"),
    "Racing Santander": ("Racing", "Santander", "Racing de Santander"),
    # Premier League
    "Tottenham": ("Spurs", "Tottenham Hotspur"),
    "Crystal Palace": ("C Palace",),
    "Nottingham Forest": ("Nott'm Forest", "Nottm Forest", "Forest"),
    "Sheffield United": ("Sheffield Utd",),
    "Man United": ("Manchester United", "Man Utd"),
    "Man City": ("Manchester City",),
    "Newcastle": ("Newcastle United",),
    "Wolves": ("Wolverhampton", "Wolverhampton Wanderers"),
    "West Ham": ("West Ham United",),
    "Brighton": ("Brighton & Hove Albion", "Brighton and Hove Albion"),
    "Leeds": ("Leeds United",),
    "Leicester": ("Leicester City",),
    # Ligue 1
    "Le Havre": ("Le Havre AC",),
    "Clermont": ("Clermont Foot",),
    "Saint-Etienne": ("St Etienne", "St. Etienne", "Saint Etienne", "AS Saint-Etienne"),
    # ATTENZIONE: "Paris" NON va aggiunto qui. L'API UEFA chiama "Paris" il Paris Saint-Germain,
    # ma in Ligue 1 "Paris" e' il Paris FC, un club diverso promosso nel 2025-26 — e i due
    # coesistono nel dataset. Un alias globale li fonderebbe. La risoluzione e' quindi limitata
    # alla fonte UEFA, in update_uefa_data.py (UEFA_TEAM_OVERRIDES).
    "PSG": ("Paris Saint-Germain", "Paris SG", "Paris Saint Germain"),
    "Marsiglia": ("Marseille", "Olympique Marseille", "Olympique de Marseille"),
    "Lione": ("Lyon", "Olympique Lyon", "Olympique Lyonnais"),
    # Serie A
    "Inter": ("Internazionale", "Internazionale Milano", "Inter Milan"),
    "Milan": ("AC Milan", "A.C. Milan"),
    "Roma": ("AS Roma", "Roma FC", "A.S. Roma"),
    "Napoli": ("SSC Napoli", "Napoli SSC"),
    "Juventus": ("Juventus FC",),
    "Hellas Verona": ("Verona",),
    "Parma": ("Parma Calcio 1913",),
}


def _fold_team_name(name: str) -> str:
    """Chiave insensibile ad accenti, punteggiatura e maiuscole.

    Fonde da sola le varianti che differiscono solo per la grafia ("Alavés"/"Alaves",
    "Cádiz"/"Cadiz", "St. Pauli"/"St Pauli", "Nott'm Forest"/"Nottm Forest"), che nel
    dataset del 24/08/2026 erano 9 famiglie su 25: elencarle a mano in TEAM_ALIASES
    avrebbe significato mantenere a mano righe che una funzione deriva senza sbagliare.
    """
    stripped = unicodedata.normalize("NFKD", name or "")
    stripped = "".join(character for character in stripped if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", " ", stripped.lower()).strip()


# Squadre le cui uniche varianti osservate differiscono per accenti o punteggiatura. Basta
# dichiarare la grafia canonica: _fold_team_name() aggancia da sola ogni altra grafia della
# stessa squadra, quindi qui NON va enumerata una variante per accento. La grafia scelta è
# quella già dominante nel dataset del 24/08/2026, per spostare il minor numero di righe.
CANONICAL_SPELLINGS = (
    "St Pauli", "Alaves", "Almeria", "Cadiz", "Leganes",
)


# fold(alias) -> nome canonico. Include il fold del nome canonico stesso, altrimenti
# normalize_team() non sarebbe idempotente sui nomi che differiscono dal canonico solo per
# accenti (es. "Alavés" -> "Alaves" richiede una voce anche per il canonico "Alaves").
_ALIAS_INDEX: dict[str, str] = {}
for _canonical, _variants in TEAM_ALIASES.items():
    for _variant in (_canonical, *_variants):
        _folded = _fold_team_name(_variant)
        _existing = _ALIAS_INDEX.get(_folded)
        if _existing is not None and _existing != _canonical:
            raise ValueError(
                f"Alias ambiguo: {_variant!r} è dichiarato sia per {_existing!r} sia per {_canonical!r}"
            )
        _ALIAS_INDEX[_folded] = _canonical

# I nomi canonici già dichiarati altrove valgono come voci dell'indice, ma non devono
# sovrascrivere una famiglia esplicita: TEAM_ALIASES descrive il club intero, NAME_MAP una
# grafia alla volta. setdefault() dà quindi la precedenza alla famiglia.
for _canonical in (*CANONICAL_SPELLINGS, *NAME_MAP.values()):
    _ALIAS_INDEX.setdefault(_fold_team_name(_canonical), _canonical)


# TEAM_ALIASES copre le abbreviazioni, che richiedono di sapere che "Ath Madrid" è
# l'Atletico. Restano le divergenze di sola grafia mai viste prima ("Malaga"/"Málaga"):
# enumerarle a mano significherebbe scoprirle una alla volta a ogni run della pipeline. Due
# nomi con lo stesso fold sono però la stessa squadra per costruzione — nessuna coppia di club
# distinti dei Big Five collide dopo aver tolto accenti e punteggiatura — quindi qui la regola
# è meccanica: vince la grafia più frequente nel dataset, a parità la più lunga (la forma
# estesa "Real Oviedo" è più informativa dell'abbreviazione "Oviedo").
#
# Viveva solo in repair_dataset_identities.py, cioè fuori dalla pipeline. Conseguenza misurata
# il 28/08/2026: la rigenerazione automatica — che gira quattro volte al giorno — reintroduceva
# lo split a ogni esecuzione, il contratto lo intercettava, e qualcuno doveva eseguire la
# riparazione a mano. Ora la pipeline la applica da sé prima di scrivere; lo strumento di
# riparazione importa QUESTA funzione, così le due strade non possono divergere.
#
# Non è esprimibile come normalize_team() di un nome solo: per scegliere la grafia vincente
# serve vedere tutti i nomi insieme, quindi è una passata sull'intero dataset.
def resolve_spelling_collisions(names: Iterable[str]) -> dict[str, str]:
    counts: dict[str, int] = defaultdict(int)
    for name in names:
        if name:
            counts[str(name)] += 1
    grouped: dict[str, list[str]] = defaultdict(list)
    for name in counts:
        grouped[_fold_team_name(name)].append(name)
    mapping: dict[str, str] = {}
    for variants in grouped.values():
        if len(variants) < 2:
            continue
        winner = sorted(variants, key=lambda name: (-counts[name], -len(name), name))[0]
        for name in variants:
            if name != winner:
                mapping[name] = winner
    return mapping


def apply_spelling_collisions(rows: Iterable[dict], mapping: dict[str, str]) -> int:
    """Riscrive home_team/away_team secondo `mapping`. Ritorna il numero di riscritture."""
    renamed = 0
    for row in rows:
        for side in ("home_team", "away_team"):
            name = row.get(side)
            if name in mapping:
                row[side] = mapping[name]
                renamed += 1
    return renamed


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_team(name: str) -> str:
    clean = re.sub(r"\s+", " ", (name or "").strip())
    clean = re.sub(r"\s+(FC|CF|SC|AFC)$", "", clean, flags=re.I)
    clean = NAME_MAP.get(clean, clean)
    if not clean:
        return clean
    # L'indice degli alias ha l'ultima parola su NAME_MAP: NAME_MAP mappa una grafia alla
    # volta ed è cresciuto per casi singoli, TEAM_ALIASES dichiara la famiglia intera. Se i
    # due divergessero vincerebbe la famiglia, che è la definizione completa.
    return _ALIAS_INDEX.get(_fold_team_name(clean), clean)


def season_code(start_year: int) -> str:
    return f"{start_year % 100:02d}{(start_year + 1) % 100:02d}"


def season_start(code: str) -> int:
    clean = re.sub(r"\D", "", str(code))
    if len(clean) == 4:
        return 2000 + int(clean[:2])
    if len(clean) == 8:
        return int(clean[:4])
    raise ValueError(f"Codice stagione non valido: {code}")


def likely_start_year(today: date) -> int:
    return today.year if today.month >= 7 else today.year - 1


def resolve_target_season(raw: str | None) -> tuple[str, int]:
    start = season_start(raw) if raw else likely_start_year(date.today())
    return season_code(start), start


def fetch_bytes(url: str, timeout: int = 35) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str, timeout: int = 35) -> object:
    return json.loads(fetch_bytes(url, timeout).decode("utf-8", errors="replace"))


def parse_date(value: str) -> str:
    value = value.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"Data non riconosciuta: {value}")


def optional_float(row: dict[str, str], *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            try:
                return round(float(value), 3)
            except (TypeError, ValueError):
                pass
    return None


def numeric_stat(stats: object, *names: str) -> float | None:
    if not isinstance(stats, list):
        return None
    wanted = {name.lower() for name in names}
    for item in stats:
        if not isinstance(item, dict):
            continue
        key = str(item.get("name") or item.get("abbreviation") or item.get("label") or "").lower()
        if key not in wanted:
            continue
        raw = item.get("value", item.get("displayValue"))
        try:
            return round(float(str(raw).replace("%", "")), 3)
        except (TypeError, ValueError):
            continue
    return None


def card_counts_by_team(details: object) -> dict[str, dict[str, float]]:
    """Cartellini per squadra ricavati dagli eventi di partita, non dalla lista 'statistics'.

    Verificato sui dati live dello scoreboard ESPN: per una partita conclusa, 'statistics'
    contiene tiri/tiri-in-porta/corner/possesso/assist ma MAI una voce cartellini gialli o
    rossi — quindi numeric_stat(stats, "yellowCards", "YC") non trova mai corrispondenza e
    restituisce sempre None. I cartellini esistono invece come eventi nella lista 'details'
    del payload, ciascuno con i flag booleani 'yellowCard'/'redCard' e la squadra in
    'team.id'. Usata come fallback quando numeric_stat non trova nulla."""
    counts: dict[str, dict[str, float]] = {}
    if not isinstance(details, list):
        return counts
    for entry in details:
        if not isinstance(entry, dict):
            continue
        is_yellow = bool(entry.get("yellowCard"))
        is_red = bool(entry.get("redCard"))
        if not (is_yellow or is_red):
            continue
        team = entry.get("team") if isinstance(entry.get("team"), dict) else {}
        team_id = str(team.get("id") or "")
        if not team_id:
            continue
        bucket = counts.setdefault(team_id, {"yellow": 0.0, "red": 0.0})
        if is_yellow:
            bucket["yellow"] += 1
        if is_red:
            bucket["red"] += 1
    return counts


def event_round(event: dict[str, object], competition: dict[str, object]) -> tuple[int | None, str | None]:
    for candidate in (event.get("week"), competition.get("week")):
        if isinstance(candidate, dict):
            try:
                number = int(candidate.get("number"))
            except (TypeError, ValueError):
                number = None
            label = str(candidate.get("text") or candidate.get("name") or "").strip() or None
            if number and number > 0:
                return number, label
    notes = competition.get("notes")
    if isinstance(notes, list):
        for note in notes:
            if isinstance(note, dict):
                label = str(note.get("headline") or "").strip()
                if label:
                    return None, label[:80]
    return None, None


def parse_espn_event(event: dict[str, object], descriptor: dict[str, object], season: str, source_index: int, competition_type: str) -> dict[str, object] | None:
    competitions = event.get("competitions")
    if not isinstance(competitions, list) or not competitions or not isinstance(competitions[0], dict):
        return None
    competition = competitions[0]
    competitors = competition.get("competitors")
    if not isinstance(competitors, list):
        return None
    sides: dict[str, dict[str, object]] = {}
    for competitor in competitors:
        if isinstance(competitor, dict):
            sides[str(competitor.get("homeAway", ""))] = competitor
    if "home" not in sides or "away" not in sides:
        return None

    def team_data(side: str) -> tuple[str, str | None]:
        team = sides[side].get("team") if isinstance(sides[side].get("team"), dict) else {}
        name = normalize_team(str(team.get("shortDisplayName") or team.get("displayName") or team.get("name") or ""))
        team_id = str(team.get("id") or "").strip() or None
        return name, team_id

    home_team, home_id = team_data("home")
    away_team, away_id = team_data("away")
    raw_date = str(event.get("date") or competition.get("date") or "")
    match_date = raw_date[:10]
    if not home_team or not away_team or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", match_date):
        return None
    status = event.get("status") if isinstance(event.get("status"), dict) else {}
    status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
    completed = bool(status_type.get("completed"))
    round_number, round_label = event_round(event, competition)
    item: dict[str, object] = {
        "id": str(event.get("id") or f"espn-{descriptor['id']}-{season}-{source_index}"),
        "season": season, "competition_id": descriptor["id"], "competition_name": descriptor["name"],
        "competition_type": competition_type, "country": descriptor.get("country", "Europe"),
        "league_strength": descriptor.get("strength", 1500), "date": match_date, "kickoff": raw_date or None,
        "home_team": home_team, "away_team": away_team, "home_team_id": home_id, "away_team_id": away_id,
        "round": round_number, "round_label": round_label, "completed": completed,
        "source_index": source_index, "source": "ESPN public scoreboard",
        "importance": 1.18 if competition_type == "europe" else 1.0,
    }
    if completed:
        try:
            item["home_goals"] = int(float(sides["home"].get("score")))
            item["away_goals"] = int(float(sides["away"].get("score")))
        except (TypeError, ValueError):
            return None
        card_counts = card_counts_by_team(competition.get("details"))
        for side in ("home", "away"):
            stats = sides[side].get("statistics")
            side_id = home_id if side == "home" else away_id
            events_side = card_counts.get(side_id or "", {"yellow": 0.0, "red": 0.0})
            item[f"{side}_shots"] = numeric_stat(stats, "shotsTotal", "totalShots", "SH", "SHOT")
            item[f"{side}_sot"] = numeric_stat(stats, "shotsOnTarget", "SOG")
            item[f"{side}_corners"] = numeric_stat(stats, "wonCorners", "cornerKicks", "CK")
            item[f"{side}_possession"] = numeric_stat(stats, "possessionPct", "possession")
            fallback_yellow = numeric_stat(stats, "yellowCards", "YC")
            fallback_red = numeric_stat(stats, "redCards", "RC")
            item[f"{side}_yellow"] = fallback_yellow if fallback_yellow is not None else events_side["yellow"]
            item[f"{side}_red"] = fallback_red if fallback_red is not None else events_side["red"]
    return item


def fetch_espn_events(descriptor: dict[str, object], start_year: int, competition_type: str) -> list[dict[str, object]]:
    season = season_code(start_year)
    start_date = f"{start_year}0701"
    end_date = f"{start_year + 1}0630"
    slug = descriptor["espn"]
    urls = [
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_date}-{end_date}&limit=2000",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_year}&limit=2000",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={start_year + 1}&limit=2000",
    ]
    raw_events: list[dict[str, object]] = []
    for url in urls:
        try:
            payload = fetch_json(url)
            if isinstance(payload, dict) and isinstance(payload.get("events"), list):
                raw_events.extend(event for event in payload["events"] if isinstance(event, dict))
        except Exception as error:
            print(f"ESPN {descriptor['name']} {season}: {error}", file=sys.stderr)
    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, event in enumerate(raw_events):
        item = parse_espn_event(event, descriptor, season, index, competition_type)
        if not item or not (f"{start_year}-07-01" <= str(item["date"]) <= f"{start_year + 1}-06-30"):
            continue
        key = str(item["id"])
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return sorted(result, key=lambda item: (str(item["date"]), int(item.get("source_index", 0))))


def parse_csv(content: str, season: str, league: dict[str, object]) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for row in csv.DictReader(content.splitlines()):
        if not row.get("Date") or row.get("FTHG") in (None, "") or row.get("FTAG") in (None, ""):
            continue
        try:
            matches.append({
                "id": f"fd-{league['id']}-{season}-{len(matches)}", "date": parse_date(row["Date"]), "season": season,
                "competition_id": league["id"], "competition_name": league["name"], "competition_type": "domestic",
                "country": league["country"], "league_strength": league["strength"], "importance": 1.0,
                "home_team": normalize_team(row.get("HomeTeam", "")), "away_team": normalize_team(row.get("AwayTeam", "")),
                "home_goals": int(float(row["FTHG"])), "away_goals": int(float(row["FTAG"])),
                "home_shots": optional_float(row, "HS"), "away_shots": optional_float(row, "AS"),
                "home_sot": optional_float(row, "HST"), "away_sot": optional_float(row, "AST"),
                "home_corners": optional_float(row, "HC"), "away_corners": optional_float(row, "AC"),
                "home_yellow": optional_float(row, "HY"), "away_yellow": optional_float(row, "AY"),
                "home_red": optional_float(row, "HR"), "away_red": optional_float(row, "AR"),
                "home_xg": optional_float(row, "HxG", "HomeXG"), "away_xg": optional_float(row, "AxG", "AwayXG"),
                "home_possession": optional_float(row, "HPoss", "HomePossession"),
                "away_possession": optional_float(row, "APoss", "AwayPossession"),
                # Quote di APERTURA (senza la C): sono quelle che il dataset conteneva finora, ed
                # erano documentate per errore come "di chiusura". Restano perche' servono a una
                # cosa precisa: il movimento apertura -> chiusura, che e' l'unica metrica di
                # mercato che si traduce in profitto.
                "home_odds": optional_float(row, "AvgH", "B365H", "PSH"),
                "draw_odds": optional_float(row, "AvgD", "B365D", "PSD"),
                "away_odds": optional_float(row, "AvgA", "B365A", "PSA"),
                # Quote di CHIUSURA (la C prima dell'esito): il benchmark corretto. La linea di
                # chiusura incorpora tutta l'informazione arrivata fino al fischio d'inizio, ed e'
                # contro quella che un modello va misurato — non contro l'apertura, che e' piu'
                # debole e quindi lusinga chi la sfida.
                "home_odds_close": optional_float(row, "AvgCH", "B365CH", "PSCH"),
                "draw_odds_close": optional_float(row, "AvgCD", "B365CD", "PSCD"),
                "away_odds_close": optional_float(row, "AvgCA", "B365CA", "PSCA"),
                # Miglior prezzo di mercato alla chiusura: la media dice quanto paga il mercato,
                # il massimo quanto si poteva davvero incassare.
                "home_odds_max_close": optional_float(row, "MaxCH"),
                "draw_odds_max_close": optional_float(row, "MaxCD"),
                "away_odds_max_close": optional_float(row, "MaxCA"),
                # Over/Under 2.5, apertura e chiusura. E' la dimensione del LIVELLO (quanti gol in
                # totale), separata da quella dell'asimmetria che misura l'1X2: la calibrazione del
                # modello le tiene gia' distinte, e questi campi permettono di misurarle distinte.
                "over25_odds": optional_float(row, "Avg>2.5", "B365>2.5", "P>2.5"),
                "under25_odds": optional_float(row, "Avg<2.5", "B365<2.5", "P<2.5"),
                "over25_odds_close": optional_float(row, "AvgC>2.5", "B365C>2.5", "PC>2.5"),
                "under25_odds_close": optional_float(row, "AvgC<2.5", "B365C<2.5", "PC<2.5"),
                "over25_odds_max_close": optional_float(row, "MaxC>2.5"),
                "under25_odds_max_close": optional_float(row, "MaxC<2.5"),
                # Handicap asiatico di chiusura: la stima piu' pulita che il mercato produca della
                # sola asimmetria, con la linea (AHCh) e i due prezzi.
                "ah_line_close": optional_float(row, "AHCh", "AHh"),
                "ah_home_odds_close": optional_float(row, "AvgCAHH", "B365CAHH", "PCAHH"),
                "ah_away_odds_close": optional_float(row, "AvgCAHA", "B365CAHA", "PCAHA"),
                "referee": (row.get("Referee") or "").strip() or None,
                "completed": True, "source": "Football-Data.co.uk",
            })
        except (TypeError, ValueError):
            continue
    return [item for item in matches if item["home_team"] and item["away_team"]]


def compute_referee_stats(matches: list[dict[str, object]], prior_strength: float = 40.0) -> dict[str, dict[str, object]]:
    """Tendenze per arbitro: partite dirette, tasso di vittorie casalinghe grezzo e relativo
    scostamento REGOLARIZZATO (shrinkage bayesiano verso la media di lega) rispetto alla
    media generale, più cartellini/partita dove disponibili. prior_strength=40 equivale a
    dare a un arbitro "credito pieno" solo dopo ~40 partite dirette: sotto quella soglia la
    stima viene tirata verso la media generale, per non scambiare rumore campionario per un
    vero bias sistematico. Nessuna fonte usata da questa pipeline conosce l'arbitro di una
    partita futura prima dell'annuncio ufficiale: questi numeri sono utilizzabili solo se
    l'arbitro di una specifica partita in arrivo viene fornito manualmente (vedi
    options.refereeHomeBias in model.js).
    """
    completed = [m for m in matches if m.get("home_goals") is not None and m.get("away_goals") is not None and m.get("referee")]
    if not completed:
        return {}
    overall_home_rate = sum(1 for m in completed if m["home_goals"] > m["away_goals"]) / len(completed)

    by_referee: dict[str, list[dict[str, object]]] = {}
    for match in completed:
        by_referee.setdefault(str(match["referee"]), []).append(match)

    stats: dict[str, dict[str, object]] = {}
    for referee, games in by_referee.items():
        count = len(games)
        home_wins = sum(1 for m in games if m["home_goals"] > m["away_goals"])
        raw_home_rate = home_wins / count
        credibility = count / (count + prior_strength)
        shrunk_home_bias = credibility * (raw_home_rate - overall_home_rate)
        cards = [
            (m.get("home_yellow") or 0) + (m.get("away_yellow") or 0) + (m.get("home_red") or 0) + (m.get("away_red") or 0)
            for m in games
            if m.get("home_yellow") is not None or m.get("away_yellow") is not None
        ]
        stats[referee] = {
            "matches": count,
            "home_win_rate": round(raw_home_rate, 4),
            "home_bias": round(clamp(shrunk_home_bias, -0.12, 0.12), 4),
            "avg_cards": round(sum(cards) / len(cards), 2) if cards else None,
        }
    return stats


def download_football_data(league: dict[str, object], starts: Iterable[int]) -> list[dict[str, object]]:
    code = league.get("fd")
    if not code:
        return []
    result: list[dict[str, object]] = []
    for start in starts:
        season = season_code(start)
        url = f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv"
        try:
            content = fetch_bytes(url).decode("utf-8-sig", errors="replace")
            parsed = parse_csv(content, season, league)
            result.extend(parsed)
            print(f"Football-Data {league['name']} {season}: {len(parsed)}")
        except urllib.error.HTTPError as error:
            print(f"Football-Data {league['name']} {season}: HTTP {error.code}", file=sys.stderr)
        except Exception as error:
            print(f"Football-Data {league['name']} {season}: {error}", file=sys.stderr)
    return result


def decode_understat_json(encoded: str) -> object:
    return json.loads(html.unescape(bytes(encoded, "utf-8").decode("unicode_escape")))


def fetch_understat_xg(league: dict[str, object], start_year: int) -> list[dict[str, object]]:
    slug = league.get("understat")
    if not slug:
        return []
    text = fetch_bytes(f"https://understat.com/league/{slug}/{start_year}").decode("utf-8", errors="replace")
    match = re.search(r"datesData\s*=\s*JSON\.parse\('([^']+)'\)", text) or re.search(r'datesData\s*=\s*JSON\.parse\("([^\"]+)"\)', text)
    if not match:
        return []
    data = decode_understat_json(match.group(1))
    result: list[dict[str, object]] = []
    if not isinstance(data, list):
        return result
    for item in data:
        if not isinstance(item, dict) or not item.get("isResult"):
            continue
        home = item.get("h") if isinstance(item.get("h"), dict) else {}
        away = item.get("a") if isinstance(item.get("a"), dict) else {}
        xg = item.get("xG") if isinstance(item.get("xG"), dict) else {}
        try:
            result.append({
                "date": str(item.get("datetime", ""))[:10],
                "home_team": normalize_team(str(home.get("title", ""))),
                "away_team": normalize_team(str(away.get("title", ""))),
                "home_xg": round(float(xg.get("h")), 3), "away_xg": round(float(xg.get("a")), 3),
            })
        except (TypeError, ValueError):
            continue
    return result


def _teams_by_season(matches: list[dict[str, object]], competition_id: str) -> dict[int, set[str]]:
    grouped: dict[int, set[str]] = defaultdict(set)
    for item in matches:
        if item.get("competition_id") != competition_id:
            continue
        start = season_start(str(item.get("season", "") or ""))
        if start is None:
            continue
        for side in ("home", "away"):
            team = item.get(f"{side}_team")
            if team:
                grouped[start].add(str(team))
    return grouped


def enrich_xg(matches: list[dict[str, object]], league: dict[str, object], starts: Iterable[int]) -> int:
    index = {(str(item["date"]), str(item["home_team"]), str(item["away_team"])): item for item in matches if item.get("competition_id") == league["id"]}
    enriched = 0
    fallback_starts: list[int] = []
    for start in starts:
        try:
            rows = fetch_understat_xg(league, start)
        except Exception as error:
            print(f"Understat {league['name']} {start}: {error}", file=sys.stderr)
            rows = []
        if not rows:
            # Percorso economico (1 richiesta, parsing di datesData) a mani vuote: non è
            # detto sia un errore di rete, potrebbe essere la struttura di pagina cambiata
            # (successo a dicembre 2025). Non fallire in silenzio: prova il fallback più
            # pesante invece di limitarti a "continue" come prima di questa modifica.
            fallback_starts.append(start)
            continue
        for row in rows:
            item = index.get((str(row["date"]), str(row["home_team"]), str(row["away_team"])))
            if item:
                item["home_xg"] = row["home_xg"]
                item["away_xg"] = row["away_xg"]
                enriched += 1

    if fallback_starts and league.get("understat"):
        try:
            from understat_team_api import fetch_league_matches_via_team_api
        except ImportError as error:
            print(f"Understat {league['name']}: fallback getTeamData non disponibile ({error})", file=sys.stderr)
            return enriched
        by_season = _teams_by_season(matches, league["id"])
        for start in fallback_starts:
            team_universe = {
                str(item[f"{side}_team"])
                for item in matches
                if item.get("competition_id") == league["id"] and season_start(str(item.get("season", "") or "")) == start
                for side in ("home", "away")
                if item.get(f"{side}_team")
            }
            # Il turnover normale tra una stagione e l'altra (promozioni/retrocessioni) è
            # tipicamente di 2-4 squadre in un campionato da 18-20. Se la maggioranza delle
            # squadre di questo start-year non compare in NESSUN'ALTRA stagione tracciata
            # della stessa competizione, è un segnale forte di dati contaminati (osservato:
            # 10 squadre scozzesi di serie minori attribuite a esp.1 per una stagione appena
            # iniziata con pochissime partite reali — quasi certamente una risposta anomala
            # dell'API ESPN per una query con dataset scarso, non un problema di slug).
            # Meglio saltare esplicitamente il fallback per questo start che tentare 404 su
            # squadre quasi certamente sbagliate.
            other_teams: set[str] = set()
            for other_start, teams in by_season.items():
                if other_start != start:
                    other_teams |= teams
            if other_teams:
                unfamiliar = team_universe - other_teams
                if len(team_universe) >= 5 and len(unfamiliar) / len(team_universe) > 0.6:
                    print(
                        f"Understat {league['name']} {start}: dataset sospetto, "
                        f"{len(unfamiliar)}/{len(team_universe)} squadre mai viste in altre stagioni "
                        f"di questa competizione (probabile contaminazione a monte, es. ESPN): "
                        f"{', '.join(sorted(unfamiliar))}. Fallback saltato per questo start.",
                        file=sys.stderr,
                    )
                    continue
            try:
                rows = fetch_league_matches_via_team_api(start, team_universe, normalize_team)
            except Exception as error:
                print(f"Understat {league['name']} {start} (getTeamData): {error}", file=sys.stderr)
                continue
            for row in rows:
                item = index.get((row["date"], row["home_team"], row["away_team"]))
                if item:
                    item["home_xg"] = row["home_xg"]
                    item["away_xg"] = row["away_xg"]
                    enriched += 1
    return enriched


def team_keys(items: Iterable[dict[str, object]]) -> tuple[set[str], set[str]]:
    ids: set[str] = set()
    names: set[str] = set()
    for item in items:
        for side in ("home", "away"):
            name = str(item.get(f"{side}_team") or "")
            team_id = str(item.get(f"{side}_team_id") or "")
            if name:
                names.add(name)
            if team_id:
                ids.add(team_id)
    return ids, names


def involves_participant(item: dict[str, object], ids: set[str], names: set[str]) -> bool:
    return any(str(item.get(f"{side}_team_id") or "") in ids or str(item.get(f"{side}_team") or "") in names for side in ("home", "away"))


def discover_relevant_leagues(participants_ids: set[str], participants_names: set[str], target_start: int, cache: dict[tuple[str, int], list[dict[str, object]]]) -> list[dict[str, object]]:
    relevant: list[dict[str, object]] = []
    for league in DOMESTIC_LEAGUES:
        probe: list[dict[str, object]] = []
        for start in (target_start, target_start - 1):
            key = (str(league["id"]), start)
            if key not in cache:
                cache[key] = fetch_espn_events(league, start, "domestic")
            probe.extend(cache[key])
        if any(involves_participant(item, participants_ids, participants_names) for item in probe):
            relevant.append(dict(league))
            print(f"Campionato rilevante: {league['name']}")
    return relevant


def richness(item: dict[str, object]) -> int:
    keys = ("home_xg", "away_xg", "home_shots", "away_shots", "home_sot", "away_sot", "home_odds", "away_odds")
    return sum(item.get(key) is not None for key in keys)


def merge_matches(items: Iterable[dict[str, object]]) -> list[dict[str, object]]:
    merged: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for item in items:
        if item.get("home_goals") is None or item.get("away_goals") is None:
            continue
        key = (str(item.get("competition_id")), str(item.get("date")), str(item.get("home_team")), str(item.get("away_team")))
        previous = merged.get(key)
        if not previous:
            merged[key] = dict(item)
            continue
        richer, poorer = (item, previous) if richness(item) >= richness(previous) else (previous, item)
        combined = dict(poorer)
        combined.update({key_name: value for key_name, value in richer.items() if value is not None})
        for team_key in ("home_team_id", "away_team_id"):
            combined[team_key] = previous.get(team_key) or item.get(team_key)
        merged[key] = combined
    return sorted(merged.values(), key=lambda item: (str(item["date"]), str(item["competition_id"]), str(item["home_team"])))


def assign_rounds(fixtures: list[dict[str, object]]) -> list[dict[str, object]]:
    if not fixtures:
        return []
    ordered = sorted((dict(item) for item in fixtures), key=lambda item: (str(item["date"]), int(item.get("source_index", 0))))
    explicit = [item for item in ordered if isinstance(item.get("round"), int) and int(item["round"]) > 0]
    if len(explicit) >= max(1, int(len(ordered) * 0.75)):
        for item in ordered:
            if not item.get("round"):
                nearest = min(explicit, key=lambda candidate: abs((datetime.fromisoformat(str(candidate["date"])) - datetime.fromisoformat(str(item["date"]))).days))
                item["round"] = nearest["round"]
            if not item.get("round_label"):
                item["round_label"] = f"Turno {item['round']}"
        return ordered
    # Le coppe UEFA (fonte "UEFA public match API") non forniscono mai un round numerico
    # esplicito, ma quasi sempre un round_label testuale affidabile (es. "1° turno di
    # qualificazione", "Play-offs", "Fase a campionato - Giornata 3"). Raggruppare per
    # quell'etichetta è molto più robusto della semplice euristica per data qui sotto:
    # nelle qualificazioni più percorsi (Champions Path / League Path) e partite di
    # andata/ritorno di squadre diverse cadono a pochi giorni di distanza l'uno dall'altro,
    # e un raggruppamento puramente per data li mischiava in un unico turno fittizio.
    labeled = [item for item in ordered if str(item.get("round_label") or "").strip()]
    if len(labeled) >= max(1, int(len(ordered) * 0.75)):
        label_order: list[str] = []
        label_groups: dict[str, list[dict[str, object]]] = {}
        for item in ordered:
            label = str(item.get("round_label") or "").strip() or "Turno"
            if label not in label_groups:
                label_groups[label] = []
                label_order.append(label)
            label_groups[label].append(item)
        for index, label in enumerate(label_order, 1):
            for item in label_groups[label]:
                item["round"] = index
                item["round_label"] = label
        return ordered
    groups: list[list[dict[str, object]]] = []
    for item in ordered:
        current_date = datetime.fromisoformat(str(item["date"]))
        if not groups:
            groups.append([item])
            continue
        previous_date = datetime.fromisoformat(str(groups[-1][-1]["date"]))
        teams_in_group = {str(value[f"{side}_team"]) for value in groups[-1] for side in ("home", "away")}
        duplicate_team = str(item["home_team"]) in teams_in_group or str(item["away_team"]) in teams_in_group
        if (current_date - previous_date).days > 3 or duplicate_team:
            groups.append([item])
        else:
            groups[-1].append(item)
    for index, group in enumerate(groups, 1):
        labels = [str(item.get("round_label") or "").strip() for item in group]
        label = next((value for value in labels if value), f"Turno {index}")
        for item in group:
            item["round"] = index
            item["round_label"] = label
    return ordered


def load_existing_payload() -> dict[str, object]:
    try:
        payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def existing_competition_fixtures(existing: dict[str, object], competition_id: str, target_code: str) -> list[dict[str, object]]:
    competitions = existing.get("competitions")
    if not isinstance(competitions, list):
        return []
    for competition in competitions:
        if isinstance(competition, dict) and competition.get("id") == competition_id:
            fixtures = competition.get("fixtures")
            if isinstance(fixtures, list):
                return [dict(item) for item in fixtures if isinstance(item, dict) and str(item.get("season")) == target_code]
    return []


def load_overrides() -> dict[str, object]:
    try:
        data = json.loads(OVERRIDES.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def compute_elo(matches: list[dict[str, object]]) -> tuple[dict[str, float], str | None, dict[str, int]]:
    ratings: dict[str, float] = {}
    last_seen: dict[str, datetime] = {}
    counts: dict[str, int] = defaultdict(int)
    latest: str | None = None
    for match in sorted(matches, key=lambda item: str(item["date"])):
        match_date = datetime.fromisoformat(str(match["date"]))
        baseline = float(match.get("league_strength") or 1450)
        home, away = str(match["home_team"]), str(match["away_team"])
        for team in (home, away):
            current = ratings.get(team, baseline)
            if team in last_seen:
                gap = max(0, (match_date - last_seen[team]).days)
                current = baseline + (current - baseline) * math.exp(-gap / 1000)
            ratings[team] = current
            last_seen[team] = match_date
        home_advantage = 38 if match.get("competition_type") == "europe" else 52
        expected = 1 / (1 + 10 ** ((ratings[away] - (ratings[home] + home_advantage)) / 400))
        hg, ag = int(match["home_goals"]), int(match["away_goals"])
        actual = 1 if hg > ag else 0.5 if hg == ag else 0
        margin = min(1.85, 1 + 0.14 * abs(hg - ag))
        importance = float(match.get("importance") or 1)
        k = (22 if match.get("competition_type") == "europe" else 17) * importance
        delta = k * margin * (actual - expected)
        ratings[home] += delta
        ratings[away] -= delta
        counts[home] += 1
        counts[away] += 1
        latest = str(match["date"])
    return {team: round(value, 1) for team, value in ratings.items()}, latest, dict(counts)


def build_team_context(teams: list[str], elo: dict[str, float], counts: dict[str, int], as_of: str | None, overrides: dict[str, object]) -> dict[str, dict[str, object]]:
    team_overrides = overrides.get("teams") if isinstance(overrides.get("teams"), dict) else {}
    context: dict[str, dict[str, object]] = {}
    for team in teams:
        reliability = clamp(counts.get(team, 0) / 24, 0, 1)
        item: dict[str, object] = {
            "as_of": as_of or date.today().isoformat(), "elo": elo.get(team), "reliability": round(reliability, 3),
            "squad_attack": 1.0, "squad_creativity": 1.0, "squad_continuity": 0.85,
            "newcomer_impact": 0.0, "departure_impact": 0.0,
            "availability_attack": 1.0, "availability_defense": 1.0, "lineup_strength": 1.0,
            "promotion_attack": 1.0, "promotion_defense": 1.0, "manager_change_days": None,
            "top_players": [], "new_players": [], "source": "Elo europeo + forma nazionale ed europea",
        }
        override = team_overrides.get(team) if isinstance(team_overrides, dict) else None
        if isinstance(override, dict):
            for key, value in override.items():
                if key in {"as_of", "availability_attack", "availability_defense", "lineup_strength", "manager_change_days", "squad_attack", "squad_creativity", "squad_continuity", "newcomer_impact", "departure_impact", "promotion_attack", "promotion_defense", "top_players", "new_players", "notes"}:
                    item[key] = value
            item["source"] = f"{item['source']} + override verificati"
        context[team] = item
    return context


def competition_payload(descriptor: dict[str, object], fixtures: list[dict[str, object]], source: str, target_code: str) -> dict[str, object]:
    assigned = assign_rounds(fixtures)
    for item in assigned:
        item["season"] = target_code
    rounds = sorted({int(item["round"]) for item in assigned if item.get("round")})
    upcoming = next((number for number in rounds if any(int(item.get("round", 0)) == number and not item.get("completed") for item in assigned)), None)
    return {"id": descriptor["id"], "name": descriptor["name"], "season": target_code, "fixtures": assigned, "default_round": upcoming or (rounds[-1] if rounds else 1), "source": source}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-season", default=os.environ.get("TARGET_SEASON", "2627"))
    parser.add_argument("--history-seasons", type=int, default=4)
    parser.add_argument("--skip-understat", action="store_true")
    args = parser.parse_args()
    target_code, target_start = resolve_target_season(args.target_season)
    starts = list(range(target_start - max(2, args.history_seasons - 1), target_start + 1))
    existing = load_existing_payload()

    europe_history: list[dict[str, object]] = []
    competitions: list[dict[str, object]] = []
    target_fixtures: list[dict[str, object]] = []
    for descriptor in EUROPE_COMPETITIONS:
        current = fetch_espn_events(descriptor, target_start, "europe")
        source = "ESPN public scoreboard"
        if not current:
            current = existing_competition_fixtures(existing, str(descriptor["id"]), target_code)
            source = "dataset precedente conservato" if current else "calendario non ancora disponibile"
        competitions.append(competition_payload(descriptor, current, source, target_code))
        target_fixtures.extend(current)
        for start in starts:
            rows = current if start == target_start and current else fetch_espn_events(descriptor, start, "europe")
            europe_history.extend(item for item in rows if item.get("completed"))
        print(f"{descriptor['name']}: {len(current)} fixture target")

    participant_ids, participant_names = team_keys(target_fixtures)
    if not participant_names:
        raise SystemExit("Nessuna squadra europea disponibile: il dataset esistente non viene sovrascritto.")

    cache: dict[tuple[str, int], list[dict[str, object]]] = {}
    relevant_leagues = discover_relevant_leagues(participant_ids, participant_names, target_start, cache)
    domestic_matches: list[dict[str, object]] = []
    for league in relevant_leagues:
        espn_rows: list[dict[str, object]] = []
        for start in starts:
            key = (str(league["id"]), start)
            if key not in cache:
                cache[key] = fetch_espn_events(league, start, "domestic")
            espn_rows.extend(item for item in cache[key] if item.get("completed") and involves_participant(item, participant_ids, participant_names))
        football_data = [item for item in download_football_data(league, starts) if involves_participant(item, participant_ids, participant_names)]
        league_rows = merge_matches([*espn_rows, *football_data])
        if not args.skip_understat and league.get("understat"):
            print(f"xG {league['name']}: {enrich_xg(league_rows, league, starts)} arricchimenti")
        domestic_matches.extend(league_rows)

    matches = merge_matches([*europe_history, *domestic_matches])
    if len(matches) < 180:
        raise SystemExit("Dati europei insufficienti: il dataset esistente non viene sovrascritto.")

    # Fusione delle grafie PRIMA di compute_elo e build_team_context: dopo sarebbe inutile,
    # perché l'Elo e il contesto sarebbero già stati calcolati sulle identità spezzate e solo
    # i nomi risulterebbero uniti.
    every_name = [
        str(row[side])
        for source in (matches, *[competition.get("fixtures") or [] for competition in competitions])
        for row in source
        for side in ("home_team", "away_team")
        if row.get(side)
    ]
    spelling = resolve_spelling_collisions(every_name)
    if spelling:
        renamed = apply_spelling_collisions(matches, spelling)
        for competition in competitions:
            renamed += apply_spelling_collisions(competition.get("fixtures") or [], spelling)
        participant_names = {spelling.get(name, name) for name in participant_names}
        matches = merge_matches(matches)
        print(f"grafie fuse: {len(spelling)} nomi, {renamed} riscritture ({', '.join(f'{k}->{v}' for k, v in sorted(spelling.items())[:6])})")

    participants = sorted(participant_names)
    elo, elo_as_of, match_counts = compute_elo(matches)
    context = build_team_context(participants, elo, match_counts, elo_as_of, load_overrides())
    xg_count = sum(item.get("home_xg") is not None and item.get("away_xg") is not None for item in matches)
    unresolved = sorted(team for team in participants if not any(team in {str(row["home_team"]), str(row["away_team"])} for row in domestic_matches))
    default_competition = next((item["id"] for item in competitions if any(not fixture.get("completed") for fixture in item["fixtures"])), competitions[0]["id"])

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "target_season": target_code,
        "latest_season": target_code, "model_inputs_version": "3.0-europe-context",
        "default_competition": default_competition, "competitions": competitions,
        "teams": participants, "matches": matches, "team_context": context,
        "domestic_leagues": [{key: league[key] for key in ("id", "name", "country")} for league in relevant_leagues],
        "coverage": {"xg_actual_matches": xg_count, "participant_teams": len(participants), "relevant_domestic_leagues": len(relevant_leagues), "teams_without_domestic_feed": unresolved},
        "source_health": {"european_completed_matches": sum(item.get("competition_type") == "europe" for item in matches), "domestic_participant_matches": sum(item.get("competition_type") == "domestic" for item in matches), "target_fixtures": len(target_fixtures)},
        "sources": {"european_schedule_results": "ESPN public scoreboards", "domestic_results": "Football-Data.co.uk where available; ESPN fallback", "xg": "Understat for supported domestic leagues; transparent shot proxy otherwise", "elo": "Global Elo linked across domestic and UEFA matches", "availability": "data/context_overrides.json, verified information only"},
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Scritto {OUTPUT}: {len(competitions)} coppe, {len(participants)} squadre, {len(relevant_leagues)} campionati rilevanti, {len(matches)} partite training, {xg_count} con xG")


if __name__ == "__main__":
    main()
