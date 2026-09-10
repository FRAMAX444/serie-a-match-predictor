"""Contratto: le statistiche dei giocatori si accumulano sulla stagione e non si contano due volte.

Il difetto che questo file esiste per impedire. `choose_summary_events()` aveva
`samples_per_team = 2` e ogni esecuzione ricostruiva la voce di una squadra dalle sue due
partite piu' recenti, sostituendo quella precedente invece di estenderla. I contatori non
potevano quindi crescere. Misurato sul dataset pubblicato dalla CI il 09/09/2026 (`292d7bc`),
sulle 84 voci che corrispondono a una squadra del catalogo — le uniche che il sito legge — con
squadre che avevano gia' giocato da 2 a 7 partite di campionato: `squad_appearances` valeva 1 per
941 giocatori e 2 per 1083, nessuno a 3.

Le due conseguenze, entrambe silenziose:

1. `start_probability` aveva **5 valori distinti su 2024 giocatori**. Non misurava chi gioca
   titolare: misurava quante delle proprie 1-2 partite campionate un giocatore avesse iniziato,
   cioe' una tabella a cinque caselle.
2. Con `PRIOR_MINUTES = 360` contro i minuti osservati, il peso del rendimento reale nei tassi per
   90 era mediana 16% e massimo 33%: **2024 giocatori su 2024** avevano una statistica in cui
   contava piu' il prior del ruolo del proprio rendimento. I numeri restavano plausibili, ed e' il
   motivo per cui sono sopravvissuti — lo stesso meccanismo del difetto 10 di MISTAKES.md.

Non e' un dettaglio di completezza: `schedina.js` costruisce da qui i candidati marcatore
(`buildPlayerCandidates` -> `estimatePlayerMarkets`), quindi finisce nella schedina.

Il rischio che l'accumulo introduce e' l'opposto — contare due volte la stessa partita — ed e'
altrettanto silenzioso: i totali crescerebbero e basta. Da qui l'invariante sul dataset vero in
fondo al file.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "data" / "matches.json"
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base  # noqa: E402
import enrich_competitions_players as enrich  # noqa: E402

SEASON = "2627"


def event(event_id: str, date: str, season: str = SEASON) -> tuple[str, dict[str, object]]:
    return ("ita.1", {
        "id": event_id, "date": date, "season": season,
        "home_team": "Alpha", "away_team": "Beta",
    })


def summary(minutes: int = 90, goals: int = 1, shots: int = 3) -> dict[str, object]:
    """Schema ESPN ridotto a cio' che parse_summary legge davvero."""
    return {
        "rosters": [
            {
                "team": {"displayName": "Alpha"},
                "formation": "4-3-3",
                "roster": [{
                    "athlete": {"id": "111", "displayName": "Mario Rossi",
                                "position": {"abbreviation": "F"}},
                    "starter": True,
                    "stats": [
                        {"name": "minutes", "displayValue": str(minutes)},
                        {"name": "totalGoals", "displayValue": str(goals)},
                        {"name": "assists", "displayValue": "0"},
                        {"name": "totalShots", "displayValue": str(shots)},
                    ],
                }],
            },
            {
                "team": {"displayName": "Beta"},
                "formation": "4-4-2",
                "roster": [{
                    "athlete": {"id": "333", "displayName": "Hans Muller",
                                "position": {"abbreviation": "D"}},
                    "starter": True,
                    "stats": [
                        {"name": "minutes", "displayValue": str(minutes)},
                        {"name": "totalGoals", "displayValue": "0"},
                        {"name": "assists", "displayValue": "0"},
                        {"name": "totalShots", "displayValue": "0"},
                    ],
                }],
            },
        ],
        "details": [],
    }


def run(events: list[tuple[str, dict[str, object]]],
        context: dict | None = None) -> dict[str, dict[str, object]]:
    """Una esecuzione della pipeline giocatori, senza rete, partendo dal contesto dato."""
    seed = enrich.seed_player_samples(context or {}, SEASON)
    with patch.object(base, "fetch_json", lambda *a, **k: summary()):
        state = enrich.fetch_player_samples(events, 50, seed=seed)
    return enrich.build_player_context(state, SEASON)


def totals(context: dict, team: str = "Alpha", player_id: str = "111") -> dict[str, object]:
    return next(p for p in context[team]["players"] if p["id"] == player_id)


class AccumulationTests(unittest.TestCase):
    def test_i_totali_superano_il_tetto_per_esecuzione(self) -> None:
        """Il contratto centrale, e va oltre `samples_per_team` di proposito: fino a due partite
        una esecuzione senza accumulo produce lo stesso risultato di una con, quindi un test che
        si ferma li' non distingue il codice corretto da quello di prima. Alla terza partita la
        differenza c'e': 3 con l'accumulo, 2 (il tetto per esecuzione) senza."""
        events = [event("e1", "2026-08-22"), event("e2", "2026-08-29"), event("e3", "2026-09-05")]
        first = run(events[:1])
        self.assertEqual(totals(first)["squad_appearances"], 1)

        second = run(events[:2], first)
        third = run(events, second)

        self.assertEqual(totals(third)["squad_appearances"], 3)
        self.assertEqual(totals(third)["minutes"], 270)
        self.assertEqual(totals(third)["goals"], 3)
        self.assertEqual(third["Alpha"]["counted_events"], ["e1", "e2", "e3"])

    def test_rileggere_una_partita_per_l_altra_squadra_non_raddoppia_i_totali(self) -> None:
        """Il rischio speculare, altrettanto silenzioso: i totali crescerebbero e basta.

        La partita va comunque riscaricata, perche' a Beta serve ancora — quindi le righe di
        Alpha tornano indietro una seconda volta e vanno scartate riga per riga. Non basta
        decidere quali partite scaricare: serve anche decidere quali righe contare."""
        first = run([event("e1", "2026-08-22")])
        only_alpha = {"Alpha": first["Alpha"]}

        second = run([event("e1", "2026-08-22")], only_alpha)

        self.assertEqual(totals(second)["squad_appearances"], 1, "Alpha ha gia' contato e1")
        self.assertEqual(totals(second)["minutes"], 90)
        self.assertEqual(second["Alpha"]["counted_events"], ["e1"])
        self.assertEqual(totals(second, "Beta", "333")["squad_appearances"], 1, "a Beta serviva")

    def test_una_partita_conteggiata_da_una_sola_squadra_serve_ancora_all_altra(self) -> None:
        """Ogni partita porta le righe di DUE squadre: scartarla perche' una l'ha gia' contata
        bloccherebbe l'altra per sempre; tenerla senza filtrare le righe raddoppierebbe la prima."""
        counted = {"Alpha": {"e1"}}
        chosen = enrich.choose_summary_events([event("e1", "2026-08-22")], 50, counted_by_team=counted)
        self.assertEqual(len(chosen), 1, "la partita serve ancora a Beta")

        counted = {"Alpha": {"e1"}, "Beta": {"e1"}}
        chosen = enrich.choose_summary_events([event("e1", "2026-08-22")], 50, counted_by_team=counted)
        self.assertEqual(chosen, [], "conteggiata per entrambe: scaricarla e' una richiesta sprecata")

    def test_i_totali_di_una_stagione_non_passano_a_quella_dopo(self) -> None:
        first = run([event("e1", "2026-08-22")])
        seed = enrich.seed_player_samples(first, "2728")
        self.assertEqual(dict(seed.aggregates), {})
        self.assertEqual(dict(seed.counted), {})

    def test_una_voce_di_schema_precedente_non_e_estendibile(self) -> None:
        """Le voci di schema 3 non dicono quali partite abbiano contato: estenderle sommerebbe
        alla cieca. Devono essere scartate, non ereditate."""
        legacy = {"Alpha": {"schema": 3, "season": SEASON, "players": [{"id": "111", "minutes": 90}]}}
        self.assertFalse(enrich.usable_player_entry(legacy["Alpha"]))
        self.assertEqual(dict(enrich.seed_player_samples(legacy, SEASON).aggregates), {})

    def test_la_voce_dichiara_stagione_e_partite_contate(self) -> None:
        context = run([event("e1", "2026-08-22")])["Alpha"]
        self.assertEqual(context["season"], SEASON)
        self.assertEqual(context["counted_events"], ["e1"])
        self.assertEqual(context["schema"], enrich.PLAYER_CONTEXT_SCHEMA)

    def test_il_ruolo_ignoto_resta_completabile(self) -> None:
        """rounded_player() scrive "—" quando il ruolo manca. Riseminarlo come se fosse un ruolo
        vero renderebbe il giocatore invisibile a fill_missing_positions, che cerca proprio
        quelli senza ruolo: il buco non si chiuderebbe mai piu'."""
        cached = {"Alpha": {
            "schema": enrich.PLAYER_CONTEXT_SCHEMA, "season": SEASON, "counted_events": ["e1"],
            "as_of": "2026-08-22",
            "players": [{"id": "999", "name": "Ignoto", "position": "—", "squad_appearances": 1}],
        }}
        seeded = enrich.seed_player_samples(cached, SEASON).aggregates["Alpha"]["999"]
        self.assertEqual(enrich.main_position(seeded), "", "un ruolo ignoto non deve sembrare noto")


class PublishedAccumulationTests(unittest.TestCase):
    def setUp(self) -> None:
        if not DATASET.exists():
            self.skipTest("data/matches.json assente")
        payload = json.loads(DATASET.read_text(encoding="utf8"))
        season = str(payload.get("target_season") or "")
        self.entries = {
            team: entry
            for team, entry in (payload.get("player_context") or {}).items()
            if isinstance(entry, dict) and str(entry.get("season") or "") == season
            and entry.get("counted_events")
        }
        if not self.entries:
            self.skipTest("nessuna voce accumulata nella stagione in corso")

    def test_nessuna_partita_e_contata_due_volte(self) -> None:
        """L'unico modo in cui l'accumulo puo' rompersi in silenzio: i totali crescono e basta.
        Nessun giocatore puo' essere stato convocato piu' volte delle partite conteggiate, e
        nessuno puo' aver giocato piu' di una partita intera per ognuna."""
        offenders = []
        for team, entry in sorted(self.entries.items()):
            matches = len(entry["counted_events"])
            self.assertEqual(matches, len(set(entry["counted_events"])), f"{team}: id ripetuti")
            for player in entry.get("players") or []:
                if int(player.get("squad_appearances") or 0) > matches:
                    offenders.append(
                        f"{team}/{player.get('name')}: {player['squad_appearances']} convocazioni "
                        f"su {matches} partite conteggiate")
                # 90' regolamentari piu' un margine largo per i recuperi.
                if float(player.get("minutes") or 0) > 100 * matches:
                    offenders.append(
                        f"{team}/{player.get('name')}: {player['minutes']}' su {matches} partite")
        self.assertEqual(offenders, [], "Totali oltre il possibile:\n  " + "\n  ".join(offenders))


if __name__ == "__main__":
    unittest.main()
