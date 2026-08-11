import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base
import update_top5_data as top5


class DataPipelineScopeTests(unittest.TestCase):
    def test_top_five_leagues_remain_the_only_domestic_scope(self) -> None:
        self.assertEqual(
            [descriptor["id"] for descriptor in top5.TOP_FIVE_LEAGUES],
            ["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"],
        )

    def test_team_aliases_for_major_leagues_are_normalized(self) -> None:
        self.assertEqual(base.normalize_team("Bayern"), "Bayern Monaco")
        self.assertEqual(base.normalize_team("Atletico"), "Atletico Madrid")
        self.assertEqual(base.normalize_team("Olympique Lyon"), "Lione")


if __name__ == "__main__":
    unittest.main()
