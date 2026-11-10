"""La forza del campionato nazionale sulle righe di coppa (prior Elo `cupCountryPriorWeight`).

Una forza sbagliata non solleva niente: da' a un club un Elo di partenza plausibile e falso. I
casi che la tabella di origine sbaglierebbe sono scritti qui.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_top5_data as top5  # noqa: E402


class CountryStrengthTests(unittest.TestCase):
    def test_i_casi_noti(self) -> None:
        table = top5.COUNTRY_LEAGUE_STRENGTH
        self.assertEqual(table["ENG"], 1570)
        self.assertEqual(table["POR"], 1495)
        self.assertEqual(table["GIB"], 1225)
        # WAL compare in eng.1 e in wal.1: un club gallese in coppa viene dalla Cymru Premier.
        self.assertEqual(table["WAL"], 1300)
        # San Marino e Andorra compaiono solo sotto Serie A e Liga: nessuna forza invece di 1550.
        self.assertNotIn("SMR", table)
        self.assertNotIn("AND", table)

    def test_annota_solo_dove_il_codice_e_noto(self) -> None:
        rows = [
            {"home_country_code": "POR", "away_country_code": "gib"},
            {"home_country_code": "SMR", "away_country_code": None},
        ]
        self.assertEqual(top5.annotate_country_strength(rows), 2)
        self.assertEqual((rows[0]["home_league_strength"], rows[0]["away_league_strength"]), (1495, 1225))
        self.assertNotIn("home_league_strength", rows[1])
        self.assertNotIn("away_league_strength", rows[1])

    def test_i_campi_sopravvivono_alla_compattazione(self) -> None:
        for field in ("home_country_code", "away_country_code", "home_league_strength", "away_league_strength"):
            self.assertIn(field, top5.MATCH_FIELDS)


if __name__ == "__main__":
    unittest.main()
