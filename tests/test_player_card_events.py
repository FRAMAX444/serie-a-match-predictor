import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base
import enrich_competitions_players as enrich


# Le fixture qui sotto rispecchiano lo schema reale confermato in diretta sull'endpoint
# pubblico ESPN (site.api.espn.com/.../scoreboard): per una partita conclusa la lista
# 'statistics' contiene tiri/possesso/falli/assist/gol ma MAI una voce cartellini gialli o
# rossi. I cartellini esistono solo come eventi in 'details', ciascuno con i flag booleani
# 'yellowCard'/'redCard' e la lista 'athletesInvolved' (player-level) o 'team' (team-level).
class PlayerCardEventsTests(unittest.TestCase):
    def _summary_payload(self) -> dict[str, object]:
        return {
            "rosters": [
                {
                    "team": {"displayName": "Alpha"},
                    "roster": [
                        {
                            "athlete": {"id": "111", "displayName": "Mario Rossi", "position": {"abbreviation": "M"}},
                            "starter": True,
                            # Nessuna voce cartellini qui: come nei payload reali.
                            "stats": [
                                {"name": "minutes", "displayValue": "90"},
                                {"name": "totalGoals", "displayValue": "1"},
                                {"name": "assists", "displayValue": "0"},
                                {"name": "totalShots", "displayValue": "3"},
                            ],
                        },
                        {
                            "athlete": {"id": "222", "displayName": "Luigi Bianchi", "position": {"abbreviation": "D"}},
                            "starter": True,
                            "stats": [
                                {"name": "minutes", "displayValue": "90"},
                                {"name": "totalGoals", "displayValue": "0"},
                                {"name": "assists", "displayValue": "0"},
                                {"name": "totalShots", "displayValue": "0"},
                            ],
                        },
                    ],
                },
                {
                    "team": {"displayName": "Beta"},
                    "roster": [
                        {
                            "athlete": {"id": "333", "displayName": "Hans Muller", "position": {"abbreviation": "F"}},
                            "starter": True,
                            "stats": [
                                {"name": "minutes", "displayValue": "90"},
                                {"name": "totalGoals", "displayValue": "0"},
                                {"name": "assists", "displayValue": "0"},
                                {"name": "totalShots", "displayValue": "2"},
                            ],
                        },
                    ],
                },
            ],
            "details": [
                {"type": {"text": "Yellow Card"}, "yellowCard": True, "redCard": False,
                 "team": {"id": "1"}, "athletesInvolved": [{"id": "222", "displayName": "Luigi Bianchi"}]},
                {"type": {"text": "Yellow Card"}, "yellowCard": True, "redCard": False,
                 "team": {"id": "1"}, "athletesInvolved": [{"id": "222", "displayName": "Luigi Bianchi"}]},
                {"type": {"text": "Second Yellow Card"}, "yellowCard": False, "redCard": True,
                 "team": {"id": "1"}, "athletesInvolved": [{"id": "222", "displayName": "Luigi Bianchi"}]},
                {"type": {"text": "Goal"}, "scoringPlay": True, "yellowCard": False, "redCard": False,
                 "team": {"id": "1"}, "athletesInvolved": [{"id": "111", "displayName": "Mario Rossi"}]},
            ],
        }

    def test_parse_summary_attributes_cards_from_match_events(self) -> None:
        parsed = enrich.parse_summary(self._summary_payload(), "2026-08-15")
        by_id = {player["id"]: player for _, player in parsed}

        # Ammonito due volte + secondo giallo: 2 gialli e 1 rosso, non 0.
        self.assertEqual(by_id["222"]["yellow_cards"], 2)
        self.assertEqual(by_id["222"]["red_cards"], 1)

        # Il marcatore non coinvolto in cartellini resta a zero (nessun falso positivo).
        self.assertEqual(by_id["111"]["yellow_cards"], 0)
        self.assertEqual(by_id["111"]["red_cards"], 0)
        # Gol/tiri restano quelli letti da 'stats', non toccati dalla correzione.
        self.assertEqual(by_id["111"]["goals"], 1)
        self.assertEqual(by_id["111"]["shots"], 3)

        # Giocatore mai coinvolto in eventi cartellino: nessuna voce nel tally, default zero.
        self.assertEqual(by_id["333"]["yellow_cards"], 0)
        self.assertEqual(by_id["333"]["red_cards"], 0)

    def test_match_details_falls_back_to_header_competitions_path(self) -> None:
        payload = {
            "header": {
                "competitions": [
                    {"details": [{"yellowCard": True, "redCard": False, "athletesInvolved": [{"id": "1"}]}]}
                ]
            }
        }
        details = enrich.match_details(payload)
        self.assertEqual(len(details), 1)
        self.assertTrue(details[0]["yellowCard"])

    def test_match_details_missing_everywhere_returns_empty(self) -> None:
        self.assertEqual(enrich.match_details({"rosters": []}), [])
        self.assertEqual(enrich.match_details("not-a-dict"), [])

    def test_card_tally_ignores_events_without_athletes_or_cards(self) -> None:
        details = [
            {"yellowCard": False, "redCard": False, "athletesInvolved": [{"id": "1"}]},  # non un cartellino
            {"yellowCard": True, "redCard": False, "athletesInvolved": None},  # nessun giocatore associato
            {"yellowCard": True, "redCard": False, "athletesInvolved": [{"id": "9"}]},
        ]
        tally = enrich.card_tally(details)
        self.assertEqual(tally, {"9": {"yellow": 1.0, "red": 0.0}})

    def test_goals_use_real_espn_field_name_not_naive_guess(self) -> None:
        # Regressione mirata: "goals"/"goal" da soli sembrano un nome plausibile ma NON sono
        # quello che ESPN usa davvero (verificato dal vivo sullo scoreboard di un Mondiale
        # 2026 concluso: {"name":"totalGoals","abbreviation":"G",...}). Senza "totalGoals"
        # nella wanted-list, numeric_value non trova mai corrispondenza — e siccome il campo
        # "name" ha priorità sull'abbreviazione quando è presente (vedi numeric_value), anche
        # includere "G" da solo NON basta a recuperare il valore. Risultato osservato in
        # produzione: gol sempre a 0 per OGNI giocatore, non solo per chi non ha segnato —
        # un pattern uniforme, non casuale, che è stato il primo indizio del bug.
        payload = {
            "rosters": [{
                "team": {"displayName": "Alpha"},
                "roster": [{
                    "athlete": {"id": "111", "displayName": "Mario Rossi", "position": {"abbreviation": "F"}},
                    "starter": True,
                    "stats": [
                        {"name": "minutes", "displayValue": "90"},
                        {"name": "totalGoals", "abbreviation": "G", "displayValue": "2"},
                        {"name": "goalAssists", "abbreviation": "A", "displayValue": "1"},
                        {"name": "totalShots", "abbreviation": "SHOT", "displayValue": "5"},
                    ],
                }],
            }],
            "details": [],
        }
        parsed = enrich.parse_summary(payload, "2026-08-15")
        self.assertEqual(len(parsed), 1)
        _, player = parsed[0]
        self.assertEqual(player["goals"], 2, "con il nome reale 'totalGoals' i gol non devono più risultare 0")
        self.assertEqual(player["assists"], 1)
        self.assertEqual(player["shots"], 5)

    def test_goals_field_name_fallbacks_still_work_defensively(self) -> None:
        # Se un'altra lega/endpoint usasse davvero "goals"/"goal"/"G" come unico nome, deve
        # comunque funzionare: la wanted-list amplia, non sostituisce.
        for field_name in ("goals", "goal"):
            payload = {
                "rosters": [{
                    "team": {"displayName": "Alpha"},
                    "roster": [{
                        "athlete": {"id": "111", "displayName": "Mario Rossi"},
                        "starter": True,
                        "stats": [
                            {"name": "minutes", "displayValue": "90"},
                            {"name": field_name, "displayValue": "3"},
                        ],
                    }],
                }],
                "details": [],
            }
            parsed = enrich.parse_summary(payload, "2026-08-15")
            self.assertEqual(parsed[0][1]["goals"], 3, f"fallback su '{field_name}' non ha funzionato")


class TeamCardEventsTests(unittest.TestCase):
    def _event(self) -> dict[str, object]:
        return {
            "id": "999",
            "date": "2026-08-15T19:00Z",
            "status": {"type": {"completed": True}},
            "competitions": [
                {
                    "date": "2026-08-15T19:00Z",
                    "competitors": [
                        {
                            "homeAway": "home", "team": {"id": "1", "displayName": "Alpha"}, "score": "2",
                            # Anche qui: nessuna voce cartellini nelle statistiche di squadra.
                            "statistics": [
                                {"name": "totalShots", "displayValue": "10"},
                                {"name": "totalGoals", "displayValue": "2"},
                            ],
                        },
                        {
                            "homeAway": "away", "team": {"id": "2", "displayName": "Beta"}, "score": "0",
                            "statistics": [
                                {"name": "totalShots", "displayValue": "5"},
                                {"name": "totalGoals", "displayValue": "0"},
                            ],
                        },
                    ],
                    "details": [
                        {"yellowCard": True, "redCard": False, "team": {"id": "1"}, "athletesInvolved": [{"id": "111"}]},
                        {"yellowCard": True, "redCard": False, "team": {"id": "2"}, "athletesInvolved": [{"id": "333"}]},
                        {"yellowCard": False, "redCard": True, "team": {"id": "2"}, "athletesInvolved": [{"id": "333"}]},
                    ],
                }
            ],
        }

    def test_parse_espn_event_derives_team_cards_from_details(self) -> None:
        descriptor = {"id": "ucl", "name": "UEFA Champions League", "espn": "uefa.champions", "strength": 1700}
        item = base.parse_espn_event(self._event(), descriptor, "2627", 0, "europe")
        self.assertIsNotNone(item)
        self.assertEqual(item["home_yellow"], 1.0)
        self.assertEqual(item["home_red"], 0.0)
        self.assertEqual(item["away_yellow"], 1.0)
        self.assertEqual(item["away_red"], 1.0)
        # Non tocca le statistiche già funzionanti (tiri letti da 'statistics').
        self.assertEqual(item["home_shots"], 10.0)

    def test_numeric_stat_fallback_still_wins_when_present(self) -> None:
        # Se in futuro ESPN esponesse i cartellini anche in 'statistics', quel valore deve
        # continuare a prevalere sul conteggio ricavato dagli eventi.
        event = self._event()
        event["competitions"][0]["competitors"][0]["statistics"].append(
            {"name": "yellowCards", "displayValue": "4"}
        )
        descriptor = {"id": "ucl", "name": "UEFA Champions League", "espn": "uefa.champions", "strength": 1700}
        item = base.parse_espn_event(event, descriptor, "2627", 0, "europe")
        self.assertEqual(item["home_yellow"], 4.0)


if __name__ == "__main__":
    unittest.main()
