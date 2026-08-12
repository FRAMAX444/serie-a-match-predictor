import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import serie_a_sdp


class SerieASdpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.descriptor = {
            "id": "ita.1",
            "name": "Serie A",
            "country": "Italy",
            "strength": 1550,
        }

    def test_find_season_id(self) -> None:
        payload = {
            "seasons": [
                {"seasonId": "old", "seasonName": "2025/2026"},
                {"seasonId": "serie-a::Football_Season::2627", "seasonName": "2026/2027"},
            ]
        }
        self.assertEqual(
            serie_a_sdp.find_season_id(payload, 2026),
            "serie-a::Football_Season::2627",
        )

    def test_parse_matches_keeps_real_and_future_games(self) -> None:
        payload = {
            "matches": [
                {
                    "matchId": "m1",
                    "home": {"teamId": "inter", "mediaName": "Internazionale"},
                    "away": {"teamId": "monza", "mediaName": "Monza"},
                    "providerHomeScore": 2,
                    "providerAwayScore": 0,
                    "status": "FINISHED",
                    "matchDateUtc": "2026-08-22T16:30:00Z",
                    "roundName": "Matchday 1",
                    "matchSet": {"providerId": "opta:MatchDay:1"},
                },
                {
                    "matchId": "m380",
                    "home": {"teamId": "sassuolo", "officialName": "Sassuolo"},
                    "away": {"teamId": "inter", "officialName": "Inter Milan"},
                    "providerHomeScore": None,
                    "providerAwayScore": None,
                    "status": "SCHEDULED",
                    "matchDateUtc": "2027-05-29T18:00:00Z",
                    "roundName": "Matchday 38",
                    "matchSet": {"providerId": "opta:MatchDay:38"},
                },
            ]
        }

        rows = serie_a_sdp.parse_matches(payload, 2026, self.descriptor)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["round"], 1)
        self.assertEqual(rows[0]["home_team"], "Inter")
        self.assertTrue(rows[0]["completed"])
        self.assertEqual(rows[0]["home_goals"], 2)
        self.assertEqual(rows[1]["round"], 38)
        self.assertEqual(rows[1]["away_team"], "Inter")
        self.assertFalse(rows[1]["completed"])
        self.assertNotIn("home_goals", rows[1])
        self.assertEqual(rows[1]["source"], serie_a_sdp.SOURCE)


if __name__ == "__main__":
    unittest.main()
