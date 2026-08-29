from datetime import date
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base
import update_top5_data as top5


class SeasonPayloadTests(unittest.TestCase):
    def test_competition_payload_uses_target_season(self) -> None:
        fixtures = [{"date": "2026-08-15", "home_team": "A", "away_team": "B", "completed": False}]
        competition = base.competition_payload({"id": "eng.1", "name": "Premier League"}, fixtures, "test", "2627")
        self.assertEqual(competition["season"], "2627")
        self.assertEqual(competition["fixtures"][0]["season"], "2627")

    def test_top5_payload_uses_target_season_for_competitions(self) -> None:
        fixtures = [{"date": "2026-08-15", "home_team": "A", "away_team": "B", "completed": False}]
        competition = top5.competition_payload({"id": "eng.1", "name": "Premier League"}, fixtures, "test", 2026, "domestic", "2627")
        self.assertEqual(competition["season"], "2627")
        self.assertEqual(competition["fixtures"][0]["season"], "2627")

    def test_top5_payload_overwrites_existing_fixture_seasons(self) -> None:
        fixtures = [{"date": "2026-08-15", "home_team": "A", "away_team": "B", "completed": False, "season": "2324"}]
        competition = top5.competition_payload({"id": "eng.1", "name": "Premier League"}, fixtures, "test", 2026, "domestic", "2627")
        self.assertEqual(competition["fixtures"][0]["season"], "2627")

    def test_resolve_target_season_rolls_over_in_july(self) -> None:
        with patch.object(base, "date") as mocked_date:
            mocked_date.today.return_value = date(2027, 7, 1)
            code, start = base.resolve_target_season(None)
        self.assertEqual((code, start), ("2728", 2027))

    def test_existing_training_history_is_preserved_only_for_supported_scope(self) -> None:
        existing = {
            "matches": [
                {"competition_id": "ita.1", "season": "2627", "date": "2026-08-20", "home_team": "A", "away_team": "B", "completed": True, "home_goals": 1, "away_goals": 0},
                {"competition_id": "ucl", "season": "2526", "date": "2026-05-20", "home_team": "C", "away_team": "D", "completed": True, "home_goals": 2, "away_goals": 1},
                {"competition_id": "ned.1", "season": "2627", "date": "2026-08-20", "home_team": "E", "away_team": "F", "completed": True, "home_goals": 1, "away_goals": 1},
                {"competition_id": "eng.1", "season": "2223", "date": "2023-02-20", "home_team": "G", "away_team": "H", "completed": True, "home_goals": 3, "away_goals": 0},
                {"competition_id": "fra.1", "season": "2627", "date": "2026-08-20", "home_team": "I", "away_team": "J", "completed": False},
            ]
        }
        preserved = top5.existing_training_matches(existing, [2026, 2025])
        self.assertEqual({row["competition_id"] for row in preserved}, {"ita.1", "ucl"})
        self.assertEqual(len(preserved), 2)


if __name__ == "__main__":
    unittest.main()
