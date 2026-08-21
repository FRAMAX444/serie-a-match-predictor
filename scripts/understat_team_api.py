#!/usr/bin/env python3
"""Fallback per l'arricchimento xG: chiama direttamente l'endpoint JSON che il frontend di
Understat stesso usa per popolare la pagina squadra, invece di fare scraping DOM con un
browser automatizzato.

fetch_understat_xg() in update_europe_data.py legge il blob 'datesData' che fino a
dicembre 2025 circa era incorporato nella pagina lega. Da allora non torna più righe:
Understat ha riscritto il frontend per caricare i dati via chiamata AJAX invece di
incorporarli nell'HTML. Un primo tentativo di fallback via la libreria 'underdata'
(Selenium, scraping del DOM renderizzato) si è rivelato anch'esso inefficace: la libreria è
scritta per una struttura di pagina precedente e trovava 0 elementi per ogni squadra,
incluse quelle senza alcuna ambiguità di nome (Arsenal, Chelsea, Liverpool).

Ispezionando il traffico di rete reale del browser sulla pagina squadra (25/07/2026) è
emerso l'endpoint effettivo: una richiesta XHR a
    https://understat.com/getTeamData/{squadra}/{anno}
GET, risposta JSON, stesso schema di datesData (isResult/h/a/xG/datetime) ma per singola
squadra invece che per l'intera lega. Questo modulo chiama quell'endpoint direttamente:
una richiesta HTTP per squadra per stagione, nessun browser, nessuna dipendenza in più
oltre alla libreria standard di Python — stesso stile del resto della pipeline.

Non essendoci un endpoint equivalente noto a livello di intera lega (non osservato nel
traffico ispezionato: la pagina lega potrebbe averne uno diverso), il costo è O(squadre)
richieste invece di O(1): più di una, ma leggerissime, non un browser intero per squadra.
"""
from __future__ import annotations

import http.cookiejar
import json
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from typing import Callable, Iterable

try:
    import requests
except ImportError:  # pragma: no cover - il runner CI potrebbe non avere il pacchetto installato
    requests = None

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
REQUEST_PAUSE_SECONDS = 0.6  # cortesia verso understat.com tra una squadra e la successiva

# Condiviso tra tutte le chiamate di un run: la prima visita alla pagina squadra imposta un
# cookie di sessione che le richieste successive devono riportare indietro. Le richieste
# successive devono quindi usare la stessa sessione, non un nuovo client isolato per ogni
# chiamata. Questo è il punto che causava i fallimenti "Expecting value: line 1 column 1"
# quando l'endpoint rispondeva con un body vuoto o con HTML invece di JSON.
_SESSION = requests.Session() if requests is not None else None
_BASE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": USER_AGENT,
}

# Fallback usato SOLO se il pacchetto 'requests' non è installato nell'ambiente che esegue lo
# script (es. il runner CI senza un passo "pip install requests" — vedi requirements.txt e
# .github/workflows/update-data.yml). Deve comunque condividere i cookie tra la richiesta alla
# pagina squadra e la chiamata AJAX, altrimenti si ripresenta esattamente il bug che la Session
# di 'requests' risolve sopra: corpo vuoto perché il cookie di sessione impostato dalla prima
# richiesta non viene rimandato indietro dalla seconda (era così anche prima di questa modifica).
_cookie_jar = http.cookiejar.CookieJar()
_urllib_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookie_jar))

# Slug Understat per squadre il cui nome nella pipeline diverge dall'euristica spazio->underscore.
# A differenza della prima versione di questa tabella (dedotta dalla convenzione URL nota,
# mai verificata dal vivo), questa è ricavata da URL reali di understat.com trovati via
# ricerca web — le pagine squadra incorporano nel loro stesso menu a tendina l'elenco
# completo delle altre squadre della lega, quindi una sola pagina per lega conferma l'intero
# roster in un colpo solo. Corregge diversi errori della versione precedente: "Milan" da solo
# dava 404 (serve "AC_Milan"), "RB_Leipzig" dava 404 (Understat usa il nome per esteso
# "RasenBallsport_Leipzig"), "St_Pauli"/"Nottm_Forest"-style mancavano del punto/trattino
# richiesto, "Rayo"/"Sociedad"/"Oviedo"/"Valladolid" da soli non bastavano (serve il nome
# completo), "Espanol" mancava della "y" catalana ("Espanyol").
#
# Due famiglie di casi coperte per ciascuna squadra, perché non è prevedibile quale arriva a
# runtime: (a) nomi italianizzati dalla pipeline (NAME_MAP in update_europe_data.py), es.
# "Bayern Monaco"; (b) codici ABBREVIATI GREZZI di Football-Data.co.uk che normalize_team()
# lascia invariati perché non ha una voce per loro in NAME_MAP, es. "Ath Bilbao", "Spurs".
TEAM_SLUG_OVERRIDES = {
    # Serie A — solo Milan richiedeva una correzione (verificato: understat.com/team/AC_Milan/*)
    "Inter": "Inter", "Milan": "AC_Milan", "AC Milan": "AC_Milan",
    "Roma": "Roma", "Napoli": "Napoli", "Juventus": "Juventus",

    # Bundesliga — roster confermato via understat.com/team/Eintracht_Frankfurt/2023 e
    # understat.com/team/Borussia_M.Gladbach/2024 (menu a tendina completo su entrambe)
    "Bayern": "Bayern_Munich", "Bayern Monaco": "Bayern_Munich", "Bayern Munich": "Bayern_Munich",
    "Dortmund": "Borussia_Dortmund", "Borussia Dortmund": "Borussia_Dortmund",
    "Leverkusen": "Bayer_Leverkusen", "Bayer Leverkusen": "Bayer_Leverkusen",
    "Francoforte": "Eintracht_Frankfurt", "Frankfurt": "Eintracht_Frankfurt",
    "Ein Frankfurt": "Eintracht_Frankfurt", "Eintracht Frankfurt": "Eintracht_Frankfurt",
    "Lipsia": "RasenBallsport_Leipzig", "Leipzig": "RasenBallsport_Leipzig",
    "RB Leipzig": "RasenBallsport_Leipzig", "RasenBallsport Leipzig": "RasenBallsport_Leipzig",
    "Bremen": "Werder_Bremen", "Werder Bremen": "Werder_Bremen",
    "Cologne": "FC_Cologne", "Koln": "FC_Cologne", "Köln": "FC_Cologne", "FC Koln": "FC_Cologne",
    "Gladbach": "Borussia_M.Gladbach", "M'gladbach": "Borussia_M.Gladbach",
    "Borussia Monchengladbach": "Borussia_M.Gladbach", "Borussia M'gladbach": "Borussia_M.Gladbach",
    "Hamburg": "Hamburger_SV", "Hamburger SV": "Hamburger_SV",
    "Heidenheim": "FC_Heidenheim", "FC Heidenheim": "FC_Heidenheim",
    "Mainz": "Mainz_05", "Mainz 05": "Mainz_05",
    "St Pauli": "St._Pauli", "St. Pauli": "St._Pauli",
    "Stuttgart": "VfB_Stuttgart", "VfB Stuttgart": "VfB_Stuttgart",
    "Schalke": "Schalke_04", "Schalke 04": "Schalke_04",
    "Union Berlin": "Union_Berlin", "Hertha Berlin": "Hertha_Berlin",

    # Ligue 1 — roster confermato via understat.com/team/Paris_Saint_Germain/2025
    "PSG": "Paris_Saint_Germain", "Paris Saint Germain": "Paris_Saint_Germain",
    "Paris SG": "Paris_Saint_Germain",
    "Paris": "Paris_FC", "Paris FC": "Paris_FC",  # squadra distinta dal PSG, promossa in Ligue 1
    "Marsiglia": "Marseille", "Marseille": "Marseille", "Olympique Marseille": "Marseille",
    "Lione": "Lyon", "Lyon": "Lyon", "Olympique Lyon": "Lyon", "Olympique Lyonnais": "Lyon",
    "Monaco": "Monaco", "AS Monaco": "Monaco",
    "Le Havre AC": "Le_Havre", "Le Havre": "Le_Havre",
    "St Etienne": "Saint-Etienne", "St. Etienne": "Saint-Etienne", "St. Étienne": "Saint-Etienne",
    "Saint Etienne": "Saint-Etienne", "Saint-Etienne": "Saint-Etienne",

    # LaLiga — roster confermato via understat.com/team/Alaves/2023 e
    # understat.com/team/Real_Sociedad/2024 (Real Oviedo compare solo nelle stagioni più
    # recenti, dopo la promozione)
    "Athletic Bilbao": "Athletic_Club", "Ath Bilbao": "Athletic_Club", "Athletic": "Athletic_Club",
    "Atletico Madrid": "Atletico_Madrid", "Ath Madrid": "Atletico_Madrid",
    "Atlético": "Atletico_Madrid", "Atlético Madrid": "Atletico_Madrid",
    "Atl. Madrid": "Atletico_Madrid",  # variante osservata in produzione (report 21/08/2026), stesso slug già verificato sopra
    "Real Betis": "Real_Betis", "Betis": "Real_Betis",
    "Celta Vigo": "Celta_Vigo", "Celta": "Celta_Vigo",
    "Alaves": "Alaves", "Alavés": "Alaves", "Deportivo Alaves": "Alaves", "Deportivo Alavés": "Alaves",
    "Cadiz": "Cadiz", "Cádiz": "Cadiz",
    "Almeria": "Almeria", "Almería": "Almeria",
    "Espanol": "Espanyol", "Espanyol": "Espanyol", "RCD Espanyol": "Espanyol",
    "Oviedo": "Real_Oviedo", "Real Oviedo": "Real_Oviedo",
    "Rayo": "Rayo_Vallecano", "Rayo Vallecano": "Rayo_Vallecano", "Vallecano": "Rayo_Vallecano",
    "Sociedad": "Real_Sociedad", "Real Sociedad": "Real_Sociedad",
    "Valladolid": "Real_Valladolid", "Real Valladolid": "Real_Valladolid",
    "La Coruna": "Deportivo_La_Coruna", "Deportivo La Coruna": "Deportivo_La_Coruna",
    # Variabili osservate in produzione (report 21/08/2026), stesso slug già verificato sopra —
    # "Deportivo" da solo è la sigla breve che usa anche ESPN per questo club (riscontrato in un
    # box score reale: "Deportivo La CoruñaDeportivoDEP"), "Dep. A Coruna" è un'abbreviazione
    # equivalente.
    "Deportivo": "Deportivo_La_Coruna", "Dep. A Coruna": "Deportivo_La_Coruna",
    # Racing Santander e Deportivo La Coruna sono ENTRAMBE neopromosse in Liga 2026-27 (dalla
    # Segunda 2025-26: Racing campione, Deportivo secondo) — compaiono quindi nel dataset per la
    # prima volta con nomi mai normalizzati prima, il che spiega il fallimento di entrambe nello
    # stesso report. A differenza di TUTTE le altre voci di questa tabella, però, questo slug NON
    # è stato verificato dal vivo: understat.com blocca il fetch automatico via robots.txt e la
    # ricerca web non ha restituito una pagina squadra indicizzata da cui confermarlo. È dedotto
    # per analogia con le altre squadre della tabella che NON richiedono una forma abbreviata
    # (Real_Sociedad, Celta_Vigo, Athletic_Club, Rayo_Vallecano: nome pieno, spazio->underscore,
    # nessuna sorpresa), a differenza dei casi con sorpresa vera come "AC_Milan" o
    # "RasenBallsport_Leipzig" che HANNO richiesto una forma diversa dall'euristica banale.
    # Verifica manuale in 10 secondi: apri https://understat.com/team/Racing_Santander/2026 — se
    # dà 404, Understat potrebbe non aver ancora incorporato la squadra neopromossa per questa
    # stagione (in tal caso il fallimento non è uno slug sbagliato ma dati non ancora disponibili
    # lato Understat, e fetch_league_matches_via_team_api lo gestisce già senza bloccare le altre
    # squadre — vedi eccezione catturata per-squadra sotto).
    "Racing": "Racing_Santander", "Santander": "Racing_Santander", "Racing Santander": "Racing_Santander",


    # Premier League — nessun fallimento nell'ultimo run, tabella già confermata funzionante
    "Man United": "Manchester_United", "Man City": "Manchester_City",
    "Tottenham": "Tottenham", "Spurs": "Tottenham",
    "Newcastle": "Newcastle_United", "Wolves": "Wolverhampton_Wanderers",
    "Crystal Palace": "Crystal_Palace", "C Palace": "Crystal_Palace",
    "Nottingham Forest": "Nottingham_Forest", "Nott'm Forest": "Nottingham_Forest", "Nottm Forest": "Nottingham_Forest",
    "Sheffield United": "Sheffield_United", "Sheffield Utd": "Sheffield_United",
}


def slugify_team(name: str) -> str:
    """Euristica di riserva per squadre non elencate in TEAM_SLUG_OVERRIDES."""
    stripped = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return stripped.strip().replace(" ", "_")


def resolve_slug(canonical_name: str) -> str:
    return TEAM_SLUG_OVERRIDES.get(canonical_name, slugify_team(canonical_name))


def fetch_team_data(team_slug: str, year: int) -> object:
    encoded_slug = urllib.parse.quote(team_slug, safe="_")
    page_url = f"https://understat.com/team/{encoded_slug}/{year}"
    api_url = f"https://understat.com/getTeamData/{encoded_slug}/{year}"

    def _load_json_from_api() -> object:
        if _SESSION is not None:
            page_response = _SESSION.get(page_url, headers=_BASE_HEADERS, timeout=20)
            page_response.raise_for_status()
            api_response = _SESSION.get(
                api_url,
                headers={
                    **_BASE_HEADERS,
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Referer": page_url,
                    "X-Requested-With": "XMLHttpRequest",
                },
                timeout=20,
            )
            api_response.raise_for_status()
            body = api_response.text
        else:
            # _urllib_opener (non urllib.request.urlopen di default) è quello che porta con
            # sé _cookie_jar tra questa richiesta e la successiva: senza, il cookie impostato
            # dalla pagina squadra andrebbe perso e l'endpoint AJAX risponderebbe vuoto.
            page_request = urllib.request.Request(page_url, headers=_BASE_HEADERS)
            with _urllib_opener.open(page_request, timeout=20) as response:
                response.read()
            api_request = urllib.request.Request(
                api_url,
                headers={
                    **_BASE_HEADERS,
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Referer": page_url,
                    "X-Requested-With": "XMLHttpRequest",
                },
            )
            with _urllib_opener.open(api_request, timeout=20) as response:
                body = response.read().decode("utf-8", errors="replace")

        if not body or not body.strip():
            raise ValueError("Understat rispose con un body vuoto")
        try:
            return json.loads(body)
        except json.JSONDecodeError as error:
            if body.lstrip().startswith("<!DOCTYPE") or body.lstrip().startswith("<html"):
                raise ValueError("Understat rispose con HTML invece di JSON") from error
            raise ValueError(f"Understat rispose con JSON non valido: {error}") from error

    try:
        return _load_json_from_api()
    except Exception as error:
        # Understat può rispondere con un payload vuoto su una richiesta iniziale; riprovare
        # una volta dopo un breve ritardo, così da non far fallire subito l'intero run.
        time.sleep(1.0)
        try:
            return _load_json_from_api()
        except Exception as retry_error:
            raise ValueError(f"Understat {team_slug}/{year}: {error}; retry: {retry_error}") from retry_error


def parse_team_matches(payload: object, normalize_team: Callable[[str], str]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    dates = payload.get("dates") if isinstance(payload, dict) else None
    if not isinstance(dates, list):
        return rows
    for item in dates:
        if not isinstance(item, dict) or not item.get("isResult"):
            continue
        home = item.get("h") if isinstance(item.get("h"), dict) else {}
        away = item.get("a") if isinstance(item.get("a"), dict) else {}
        xg = item.get("xG") if isinstance(item.get("xG"), dict) else {}
        try:
            rows.append({
                "date": str(item.get("datetime", ""))[:10],
                "home_team": normalize_team(str(home.get("title", ""))),
                "away_team": normalize_team(str(away.get("title", ""))),
                "home_xg": round(float(xg.get("h")), 3),
                "away_xg": round(float(xg.get("a")), 3),
            })
        except (TypeError, ValueError):
            continue
    return [row for row in rows if row["home_team"] and row["away_team"] and row["date"]]


def fetch_league_matches_via_team_api(
    year: int,
    team_universe: Iterable[str],
    normalize_team: Callable[[str], str],
) -> list[dict[str, object]]:
    """Ritorna righe {date, home_team, away_team, home_xg, away_xg} deduplicate: ogni
    partita compare nella risposta di ENTRAMBE le squadre coinvolte, la seconda occorrenza
    sovrascrive la prima con lo stesso valore (nessun conflitto atteso)."""
    teams = sorted({team for team in team_universe if team})
    if not teams:
        return []

    deduped: dict[tuple[str, str, str], dict[str, object]] = {}
    missing: list[str] = []
    for index, team_name in enumerate(teams):
        try:
            payload = fetch_team_data(resolve_slug(team_name), year)
            rows = parse_team_matches(payload, normalize_team)
        except Exception as error:  # una squadra fallita non deve bloccare le altre
            print(f"Understat getTeamData: {team_name} ({year}) fallita: {error}", file=sys.stderr)
            rows = []
        if not rows:
            missing.append(team_name)
        for row in rows:
            key = (row["date"], row["home_team"], row["away_team"])
            deduped[key] = row
        if index < len(teams) - 1:
            time.sleep(REQUEST_PAUSE_SECONDS)

    if missing:
        print(
            f"Understat getTeamData {year}: 0 partite per {len(missing)}/{len(teams)} squadre "
            f"(slug probabilmente errato, aggiornare TEAM_SLUG_OVERRIDES): {', '.join(missing)}",
            file=sys.stderr,
        )
    return list(deduped.values())