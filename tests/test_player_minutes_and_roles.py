"""Regressioni sui tre bug che azzeravano o falsavano i dati per-giocatore.

Le fixture qui sotto riproducono lo schema REALE dell'endpoint `summary` di ESPN, verificato
dal vivo (agosto 2026) su una partita di Serie A conclusa. La differenza rispetto alle fixture
di test_player_card_events.py è deliberata: quelle usano lo schema `scoreboard` (flag booleani
`yellowCard`, lista `athletesInvolved`), queste usano lo schema `summary` (`type.text`,
`participants`). Entrambi esistono, ed è proprio l'aver scritto il codice pensando solo al
primo che ha prodotto i bug corretti qui.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import enrich_competitions_players as enrich


def substitution(minute: float, entering: str, leaving: str) -> dict[str, object]:
    return {
        "type": {"id": "76", "text": "Substitution", "type": "substitution"},
        "clock": {"value": minute * 60, "displayValue": f"{int(minute)}'"},
        "participants": [
            {"athlete": {"id": entering, "displayName": entering}},
            {"athlete": {"id": leaving, "displayName": leaving}},
        ],
    }


def yellow_card(minute: float, player: str) -> dict[str, object]:
    return {
        "type": {"id": "94", "text": "Yellow Card", "type": "yellow-card"},
        "clock": {"value": minute * 60, "displayValue": f"{int(minute)}'"},
        "participants": [{"athlete": {"id": player, "displayName": player}}],
    }


def roster_entry(player_id: str, position: str, *, starter: bool, subbed_in: bool = False,
                 subbed_out: bool = False, stats: list[dict[str, object]] | None = None) -> dict[str, object]:
    return {
        "starter": starter,
        "subbedIn": subbed_in,
        "subbedOut": subbed_out,
        "position": {"abbreviation": position},
        "athlete": {"id": player_id, "displayName": player_id, "shortName": player_id},
        "stats": stats if stats is not None else [
            {"name": "appearances", "abbreviation": "APP", "displayValue": "1"},
            {"name": "totalGoals", "abbreviation": "G", "displayValue": "0"},
            {"name": "goalAssists", "abbreviation": "A", "displayValue": "0"},
            {"name": "totalShots", "abbreviation": "SHOT", "displayValue": "0"},
            {"name": "shotsOnTarget", "abbreviation": "SOG", "displayValue": "0"},
            {"name": "yellowCards", "abbreviation": "YC", "displayValue": "0"},
            {"name": "redCards", "abbreviation": "RC", "displayValue": "0"},
        ],
    }


class MinutesFromSubstitutionsTests(unittest.TestCase):
    """L'endpoint `summary` NON espone i minuti giocati: vanno ricostruiti dagli eventi.

    Il bug: `numeric_value(stats, "minutes", ...)` restituiva 0 per ogni giocatore, quindi ogni
    tasso per-90 era 0 e ogni probabilità mostrata nell'interfaccia era esattamente 0%. Non ha
    prodotto nessun errore visibile — solo previsioni tutte a zero che sembravano previsioni.
    """

    def _payload(self) -> dict[str, object]:
        return {
            "rosters": [{
                "team": {"displayName": "Alpha"},
                "formation": "4-3-3",
                "roster": [
                    roster_entry("titolare-intero", "CD-L", starter=True),
                    roster_entry("titolare-sostituito", "CM", starter=True, subbed_out=True),
                    roster_entry("subentrato", "SUB", starter=False, subbed_in=True),
                    roster_entry("panchina", "SUB", starter=False),
                ],
            }],
            "keyEvents": [substitution(61, "subentrato", "titolare-sostituito")],
        }

    def test_minutes_reconstructed_from_events(self) -> None:
        parsed = dict((player["id"], player) for _, player in enrich.parse_summary(self._payload(), "2026-08-15"))

        self.assertEqual(parsed["titolare-intero"]["minutes"], 90.0, "titolare mai sostituito = tutta la partita")
        self.assertEqual(parsed["titolare-sostituito"]["minutes"], 61.0, "titolare uscito al 61' = 61 minuti")
        self.assertEqual(parsed["subentrato"]["minutes"], 29.0, "subentrato al 61' = 29 minuti")
        self.assertEqual(parsed["panchina"]["minutes"], 0.0, "chi non entra ha 0 minuti")

    def test_bench_player_is_recorded_not_discarded(self) -> None:
        # Un panchinaro rimasto fuori va tenuto, con played=False: serve a sapere che era
        # CONVOCATO. Scartarlo — come faceva la versione precedente — significa calcolare la
        # quota di titolarità solo tra chi è sceso in campo, sovrastimandola per tutti.
        parsed = dict((player["id"], player) for _, player in enrich.parse_summary(self._payload(), "2026-08-15"))
        self.assertIn("panchina", parsed)
        self.assertFalse(parsed["panchina"]["played"])
        self.assertTrue(parsed["titolare-intero"]["played"])

    def test_total_minutes_are_internally_consistent(self) -> None:
        # Undici giocatori in campo per tutta la partita: la somma dei minuti di una squadra
        # deve fare 11 x 90 qualunque sia il numero di sostituzioni. È il controllo che scopre
        # un errore di segno o un doppio conteggio meglio di qualsiasi valore singolo.
        roster = [roster_entry(f"t{index}", "CM", starter=True) for index in range(11)]
        roster[3]["subbedOut"] = True
        roster[7]["subbedOut"] = True
        roster.append(roster_entry("s1", "SUB", starter=False, subbed_in=True))
        roster.append(roster_entry("s2", "SUB", starter=False, subbed_in=True))
        payload = {
            "rosters": [{"team": {"displayName": "Alpha"}, "formation": "4-3-3", "roster": roster}],
            "keyEvents": [substitution(55, "s1", "t3"), substitution(80, "s2", "t7")],
        }
        parsed = enrich.parse_summary(payload, "2026-08-15")
        self.assertAlmostEqual(sum(player["minutes"] for _, player in parsed), 11 * 90.0, places=6)

    def test_substituted_player_without_clock_falls_back_sensibly(self) -> None:
        payload = self._payload()
        payload["keyEvents"] = []  # sostituzione avvenuta ma senza evento con orario
        parsed = dict((player["id"], player) for _, player in enrich.parse_summary(payload, "2026-08-15"))
        # Il titolare uscito non ha un minuto noto: 90 è l'ipotesi meno dannosa (era in campo).
        self.assertEqual(parsed["titolare-sostituito"]["minutes"], 90.0)
        # Il subentrato riceve il minutaggio mediano invece di 0 (che lo escluderebbe del tutto)
        # o 90 (che lo tratterebbe da titolare).
        self.assertEqual(parsed["subentrato"]["minutes"], 20.0)


class CardsFromSummarySchemaTests(unittest.TestCase):
    """I cartellini sono nelle statistiche per giocatore, con gli eventi come riserva."""

    def test_cards_read_from_player_stats(self) -> None:
        stats = [
            {"name": "appearances", "displayValue": "1"},
            {"name": "yellowCards", "abbreviation": "YC", "displayValue": "1"},
            {"name": "redCards", "abbreviation": "RC", "displayValue": "0"},
        ]
        payload = {
            "rosters": [{
                "team": {"displayName": "Alpha"},
                "roster": [roster_entry("ammonito", "CM", starter=True, stats=stats)],
            }],
            "keyEvents": [],
        }
        parsed = enrich.parse_summary(payload, "2026-08-15")
        self.assertEqual(parsed[0][1]["yellow_cards"], 1.0)

    def test_cards_fall_back_to_summary_events(self) -> None:
        # Se le statistiche non riportano i cartellini, si contano dagli eventi — che nello
        # schema `summary` NON hanno i flag booleani `yellowCard`/`redCard` ma solo type.text
        # e `participants`. Cercare i flag booleani (come faceva la versione precedente)
        # produceva zero cartellini per tutti i 1701 giocatori del dataset.
        payload = {
            "rosters": [{
                "team": {"displayName": "Alpha"},
                "roster": [roster_entry("ammonito", "CM", starter=True, stats=[
                    {"name": "appearances", "displayValue": "1"},
                ])],
            }],
            "keyEvents": [yellow_card(43, "ammonito")],
        }
        parsed = enrich.parse_summary(payload, "2026-08-15")
        self.assertEqual(parsed[0][1]["yellow_cards"], 1.0)

    def test_second_yellow_counts_as_red(self) -> None:
        events = [{
            "type": {"text": "Second Yellow Card", "type": "red-card"},
            "clock": {"value": 4800.0},
            "participants": [{"athlete": {"id": "espulso"}}],
        }]
        tally = enrich.card_tally(events)
        self.assertEqual(tally["espulso"], {"yellow": 0.0, "red": 1.0})

    def test_same_event_in_two_sources_is_counted_once(self) -> None:
        # Lo stesso gol compare in header.competitions[0].details (senza id, senza type) e in
        # keyEvents (con id e con etichetta). Unire le fonti senza deduplicare
        # raddoppierebbe i cartellini; deduplicare troppo perderebbe due ammonizioni vere
        # allo stesso giocatore nella stessa partita.
        payload = {
            "header": {"competitions": [{"details": [yellow_card(43, "tizio")]}]},
            "keyEvents": [yellow_card(43, "tizio")],
        }
        self.assertEqual(enrich.card_tally(enrich.match_details(payload))["tizio"]["yellow"], 1.0)

    def test_two_genuine_cards_in_one_source_are_both_kept(self) -> None:
        payload = {"keyEvents": [yellow_card(20, "tizio"), yellow_card(70, "tizio")]}
        self.assertEqual(enrich.card_tally(enrich.match_details(payload))["tizio"]["yellow"], 2.0)

    def test_merged_sources_keep_substitutions_from_key_events(self) -> None:
        # Il caso reale che ha rotto i minuti: header.competitions[0].details esiste ma contiene
        # solo i gol, keyEvents contiene tutto. Fermarsi alla prima lista non vuota scartava
        # ogni sostituzione.
        payload = {
            "header": {"competitions": [{"details": [{"scoringPlay": True, "clock": {"value": 100.0}}]}]},
            "keyEvents": [substitution(61, "dentro", "fuori")],
        }
        kinds = [enrich.event_kind(event)[2] for event in enrich.match_details(payload)]
        self.assertIn(True, kinds, "la sostituzione da keyEvents deve sopravvivere all'unione delle fonti")


class PositionAndFormationTests(unittest.TestCase):
    """I ruoli ESPN non si classificano con una lista di prefissi incompleta."""

    def test_real_espn_abbreviations_map_to_the_right_group(self) -> None:
        expected = {
            "G": "GK",
            "CD": "DEF", "CD-L": "DEF", "CD-R": "DEF", "LB": "DEF", "RB": "DEF",
            "LWB": "DEF", "RWB": "DEF", "SW": "DEF",
            "DM": "MID", "CM": "MID", "CM-L": "MID", "CM-R": "MID", "AM": "MID",
            "LM": "MID", "RM": "MID", "M": "MID", "LW": "MID", "RW": "MID",
            "F": "FWD", "CF": "FWD", "CF-L": "FWD", "CF-R": "FWD", "ST": "FWD", "SS": "FWD",
        }
        for abbreviation, group in expected.items():
            with self.subTest(abbreviation=abbreviation):
                self.assertEqual(enrich.position_code({"abbreviation": abbreviation}), group)

    def test_bench_marker_is_a_state_not_a_role(self) -> None:
        self.assertEqual(enrich.position_code({"abbreviation": "SUB"}), "SUB")
        self.assertEqual(enrich.position_code(None), "")

    def test_longer_prefixes_win(self) -> None:
        # "CF-L" deve risolversi su CF (attaccante) e non su CD (difensore).
        self.assertEqual(enrich.position_code({"abbreviation": "CF-L"}), "FWD")

    def test_formation_shape_parses_three_and_four_block_formations(self) -> None:
        self.assertEqual(enrich.formation_shape("4-4-2"), (4, 4, 2))
        self.assertEqual(enrich.formation_shape("4-2-3-1"), (4, 5, 1))
        self.assertEqual(enrich.formation_shape("3-4-2-1"), (3, 6, 1))
        self.assertIsNone(enrich.formation_shape("XI probabile"))
        self.assertIsNone(enrich.formation_shape("4-4-4"), "un modulo deve sommare a 10 giocatori di movimento")

    def test_reported_formation_wins_over_reconstruction(self) -> None:
        self.assertEqual(enrich.formation_for([], "4-2-3-1"), "4-2-3-1")

    def test_probable_lineup_respects_the_formation_shape(self) -> None:
        # Il bug: si prendeva un portiere e poi i dieci con impatto più alto senza guardare il
        # ruolo. Con un reparto più continuo degli altri uscivano moduli come 2-7-1, salvati
        # nel dataset per 50 squadre su 97.
        players = []
        for index in range(3):
            players.append({"id": f"gk{index}", "name": f"GK{index}", "positions": {"GK": 3},
                            "starts": 3 - index, "appearances": 3, "minutes": 270, "goals": 0, "assists": 0, "ratings": []})
        for index in range(8):
            players.append({"id": f"mid{index}", "name": f"MID{index}", "positions": {"MID": 3},
                            "starts": 3, "appearances": 3, "minutes": 270, "goals": 2, "assists": 2, "ratings": []})
        for index in range(6):
            players.append({"id": f"def{index}", "name": f"DEF{index}", "positions": {"DEF": 3},
                            "starts": 1, "appearances": 2, "minutes": 120, "goals": 0, "assists": 0, "ratings": []})
        for index in range(3):
            players.append({"id": f"fwd{index}", "name": f"FWD{index}", "positions": {"FWD": 3},
                            "starts": 1, "appearances": 2, "minutes": 120, "goals": 1, "assists": 0, "ratings": []})

        lineup = enrich.probable_lineup(players, "4-3-3", team_samples=3)
        counts = {group: sum(player["position"] == group for player in lineup) for group in ("GK", "DEF", "MID", "FWD")}
        self.assertEqual(len(lineup), 11)
        self.assertEqual(counts["GK"], 1, "un solo portiere")
        self.assertEqual(counts["DEF"], 4, "il modulo 4-3-3 chiede quattro difensori, anche se i centrocampisti sono più continui")
        self.assertEqual(counts["MID"], 3)
        self.assertEqual(counts["FWD"], 3)


class ShrinkageTests(unittest.TestCase):
    """I tassi per-90 su campioni minuscoli non sono utilizzabili così come sono."""

    def test_shrinkage_pulls_extreme_rates_towards_the_role_prior(self) -> None:
        prior = enrich.ROLE_PRIORS["FWD"]["goals"]
        # Un gol in 200 minuti = 0.45 gol/90 grezzi, il ritmo del capocannoniere d'Europa.
        shrunk = enrich.shrunk_rate(total=1, minutes=200, prior=prior)
        self.assertLess(shrunk, 0.45)
        self.assertGreater(shrunk, prior, "resta comunque sopra il prior: un gol l'ha segnato")

        # Un attaccante a secco non deve risultare a 0 esatto.
        dry = enrich.shrunk_rate(total=0, minutes=200, prior=prior)
        self.assertGreater(dry, 0)
        self.assertLess(dry, prior)

    def test_shrinkage_fades_as_the_sample_grows(self) -> None:
        prior = enrich.ROLE_PRIORS["FWD"]["goals"]
        small = enrich.shrunk_rate(total=5, minutes=450, prior=prior)
        large = enrich.shrunk_rate(total=50, minutes=4500, prior=prior)
        raw = 1.0  # 50 gol in 4500 minuti = 1.0 gol/90
        self.assertLess(abs(large - raw), abs(small - raw), "più minuti osservati, più la stima si avvicina al dato grezzo")

    def test_goalkeeper_prior_keeps_scoring_near_zero(self) -> None:
        keeper = enrich.shrunk_rate(total=0, minutes=90, prior=enrich.ROLE_PRIORS["GK"]["goals"])
        self.assertLess(keeper, 0.01)


if __name__ == "__main__":
    unittest.main()
