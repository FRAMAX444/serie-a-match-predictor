import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base
import update_top5_data as top5
import update_uefa_data as uefa


class EspnCalendarTests(unittest.TestCase):
    def test_season_is_requested_month_by_month(self) -> None:
        urls = base.espn_season_urls("ita.1", 2026)
        self.assertEqual(len(urls), 12)
        self.assertIn("dates=202607", urls[0])
        self.assertIn("dates=202706", urls[-1])
        self.assertTrue(all("limit=1000" in url for url in urls))

    def test_official_event_order_assigns_complete_rounds(self) -> None:
        fixtures = []
        ordered_ids = []
        pairs = [
            [("A", "B"), ("C", "D")], [("A", "C"), ("D", "B")],
            [("A", "D"), ("B", "C")], [("B", "A"), ("D", "C")],
            [("C", "A"), ("B", "D")], [("D", "A"), ("C", "B")],
        ]
        for round_number, round_pairs in enumerate(pairs, 1):
            for match_number, (home, away) in enumerate(round_pairs, 1):
                event_id = f"{round_number}-{match_number}"
                ordered_ids.append(event_id)
                fixtures.append({"id": event_id, "home_team": home, "away_team": away})
        self.assertTrue(base.apply_double_round_robin_order(fixtures, ordered_ids))
        self.assertEqual(sorted({item["round"] for item in fixtures}), list(range(1, 7)))

    def test_partial_snapshot_updates_results_without_deleting_calendar(self) -> None:
        previous = [
            {"id": "1", "competition_id": "ita.1", "date": "2026-08-22", "home_team": "A", "away_team": "B", "completed": False},
            {"id": "2", "competition_id": "ita.1", "date": "2026-08-23", "home_team": "C", "away_team": "D", "completed": False},
        ]
        fresh = [{
            "id": "1", "competition_id": "ita.1", "date": "2026-08-22",
            "home_team": "A", "away_team": "B", "completed": True,
            "home_goals": 2, "away_goals": 1,
        }]
        merged, guarded = base.protect_fixture_snapshot(previous, fresh)
        self.assertTrue(guarded)
        self.assertEqual(len(merged), 2)
        updated = next(item for item in merged if item["id"] == "1")
        self.assertTrue(updated["completed"])
        self.assertEqual((updated["home_goals"], updated["away_goals"]), (2, 1))


class UefaCalendarTests(unittest.TestCase):
    def test_league_phase_uses_matchday(self) -> None:
        match = {
            "round": {"metaData": {"name": "League Phase"}},
            "matchday": {
                "type": "MATCHDAY", "longName": "Matchday 3",
                "translations": {"longName": {"IT": "Giornata 3"}},
            },
        }
        self.assertEqual(uefa.round_label(match), "League Phase · Giornata 3")

    def test_qualifying_legs_remain_distinct(self) -> None:
        match = {
            "round": {"metaData": {"name": "Third qualifying round"}},
            "matchday": {"type": "SECOND_LEG", "longName": "Matchday 2"},
        }
        self.assertEqual(uefa.round_label(match), "Third qualifying round · Ritorno")

    def test_official_fixture_keeps_uefa_identity_and_espn_stats(self) -> None:
        official = [{
            "id": "uefa-1", "competition_id": "ucl", "date": "2026-09-08",
            "home_team": "Inter", "away_team": "Arsenal", "completed": True,
            "home_goals": 2, "away_goals": 0, "source": "UEFA public match API",
        }]
        espn = [{
            "id": "espn-1", "competition_id": "ucl", "date": "2026-09-08",
            "home_team": "Inter", "away_team": "Arsenal", "completed": True,
            "home_goals": 2, "away_goals": 0, "home_shots": 15.0,
        }]
        merged = base.merge_fixture_feeds(official, espn)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["id"], "uefa-1")
        self.assertEqual(merged[0]["home_shots"], 15.0)


class CalendarContractTests(unittest.TestCase):
    @staticmethod
    def domestic(competition_id: str, teams: int) -> dict:
        return {
            "id": competition_id,
            "fixtures": [
                {"round": round_number}
                for round_number in range(1, 2 * teams - 1)
                for _ in range(teams // 2)
            ],
        }

    @staticmethod
    def european(competition_id: str, rounds: int) -> dict:
        return {
            "id": competition_id,
            "fixtures": [
                {"phase": "TOURNAMENT", "round_label": f"League Phase · Giornata {round_number}"}
                for round_number in range(1, rounds + 1)
                for _ in range(18)
            ],
        }

    def valid_competitions(self) -> list[dict]:
        return [
            *(self.domestic(cid, teams) for cid, teams in top5.LEAGUE_TEAM_COUNTS.items()),
            self.european("ucl", 8), self.european("uel", 8), self.european("uecl", 6),
        ]

    def test_complete_current_calendar_passes(self) -> None:
        self.assertEqual(
            top5.calendar_contract_issues(self.valid_competitions(), 2026, date(2026, 9, 3)),
            [],
        )

    def test_truncated_domestic_calendar_fails(self) -> None:
        competitions = self.valid_competitions()
        next(item for item in competitions if item["id"] == "ita.1")["fixtures"] = [
            {"round": 1} for _ in range(10)
        ]
        issues = top5.calendar_contract_issues(competitions, 2026, date(2026, 9, 3))
        self.assertTrue(any("ita.1: 10/380" in issue for issue in issues))

    def test_collapsed_uefa_matchdays_fail(self) -> None:
        competitions = self.valid_competitions()
        ucl = next(item for item in competitions if item["id"] == "ucl")
        for fixture in ucl["fixtures"]:
            fixture["round_label"] = "League Phase"
        issues = top5.calendar_contract_issues(competitions, 2026, date(2026, 9, 3))
        self.assertTrue(any("ucl fase campionato: 1/8 giornate" in issue for issue in issues))


if __name__ == "__main__":
    unittest.main()
