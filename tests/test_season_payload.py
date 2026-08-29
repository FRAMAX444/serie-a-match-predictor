import json
import sys
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
