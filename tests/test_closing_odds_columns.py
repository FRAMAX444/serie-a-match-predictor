"""Contratto sulle colonne quote di Football-Data.co.uk.

Il difetto che questo file esiste per impedire: `home_odds` leggeva `AvgH/B365H/PSH`, che sono le
quote di APERTURA, mentre README, backtest_vs_market.mjs e ogni misura del divario dal mercato le
chiamavano "di chiusura". Le colonne di chiusura hanno una C prima dell'esito (`AvgCH`), erano
nello stesso CSV gia' scaricato, e venivano scartate in compattazione.

Non e' un dettaglio di completezza: la linea di apertura e' piu' debole di quella di chiusura,
quindi misurarsi contro l'apertura fa sembrare il modello piu' vicino al mercato di quanto sia.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base  # noqa: E402
import update_top5_data as top5  # noqa: E402

LEAGUE = {"id": "ita.1", "name": "Serie A", "country": "Italy", "strength": 1550}

# Intestazione e riga nel formato reale del CSV (nomi verificati sul file 2425/I1.csv).
HEADER = (
    "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HC,AC,HY,AY,HR,AR,Referee,"
    "B365H,B365D,B365A,PSH,PSD,PSA,MaxH,MaxD,MaxA,AvgH,AvgD,AvgA,"
    "B365>2.5,B365<2.5,P>2.5,P<2.5,Max>2.5,Max<2.5,Avg>2.5,Avg<2.5,"
    "AHh,AvgAHH,AvgAHA,"
    "B365CH,B365CD,B365CA,PSCH,PSCD,PSCA,MaxCH,MaxCD,MaxCA,AvgCH,AvgCD,AvgCA,"
    "B365C>2.5,B365C<2.5,PC>2.5,PC<2.5,MaxC>2.5,MaxC<2.5,AvgC>2.5,AvgC<2.5,"
    "AHCh,AvgCAHH,AvgCAHA"
)
ROW = (
    "I1,17/08/2024,Genoa,Inter,2,2,10,14,3,6,4,7,2,3,0,0,Mr Rossi,"
    "6.00,4.20,1.55,6.10,4.30,1.57,6.50,4.50,1.60,6.31,4.25,1.52,"
    "1.85,1.95,1.86,1.98,1.90,2.00,1.88,1.94,"
    "1.00,2.00,1.85,"
    "7.00,4.60,1.44,7.10,4.70,1.45,8.10,4.90,1.48,7.03,4.55,1.43,"
    "1.86,1.94,1.88,1.96,1.92,1.99,1.87,1.95,"
    "1.00,2.05,1.82"
)


class ClosingOddsColumns(unittest.TestCase):
    def setUp(self) -> None:
        rows = base.parse_csv(f"{HEADER}\n{ROW}\n", "2425", LEAGUE)
        self.assertEqual(len(rows), 1)
        self.row = rows[0]

    def test_apertura_e_chiusura_sono_campi_distinti(self) -> None:
        """Se i due leggessero la stessa colonna, il movimento sarebbe sempre zero e il
        benchmark sarebbe di nuovo l'apertura senza che nulla lo dica."""
        self.assertEqual(self.row["home_odds"], 6.31, "home_odds resta la media di apertura (AvgH)")
        self.assertEqual(self.row["home_odds_close"], 7.03, "home_odds_close e' la media di chiusura (AvgCH)")
        self.assertNotEqual(self.row["home_odds"], self.row["home_odds_close"])
        self.assertEqual(self.row["away_odds_close"], 1.43)
        self.assertEqual(self.row["draw_odds_close"], 4.55)

    def test_miglior_prezzo_di_chiusura(self) -> None:
        self.assertEqual(self.row["home_odds_max_close"], 8.10, "MaxCH e' il miglior prezzo, non la media")
        self.assertGreater(self.row["home_odds_max_close"], self.row["home_odds_close"])

    def test_over_under_apertura_e_chiusura(self) -> None:
        self.assertEqual(self.row["over25_odds"], 1.88)
        self.assertEqual(self.row["under25_odds"], 1.94)
        self.assertEqual(self.row["over25_odds_close"], 1.87)
        self.assertEqual(self.row["under25_odds_close"], 1.95)
        self.assertEqual(self.row["over25_odds_max_close"], 1.92)

    def test_handicap_asiatico_di_chiusura(self) -> None:
        self.assertEqual(self.row["ah_line_close"], 1.00)
        self.assertEqual(self.row["ah_home_odds_close"], 2.05)
        self.assertEqual(self.row["ah_away_odds_close"], 1.82)

    def test_un_csv_senza_colonne_di_chiusura_non_rompe_nulla(self) -> None:
        """Le stagioni piu' vecchie non hanno le colonne C: i campi devono restare None, non
        ricadere silenziosamente sull'apertura facendo sembrare l'una l'altra."""
        header = "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,AvgH,AvgD,AvgA"
        row = "I1,17/08/2024,Genoa,Inter,2,2,6.31,4.25,1.52"
        parsed = base.parse_csv(f"{header}\n{row}\n", "2425", LEAGUE)[0]
        self.assertEqual(parsed["home_odds"], 6.31)
        self.assertIsNone(parsed["home_odds_close"])
        self.assertIsNone(parsed["over25_odds_close"])
        self.assertIsNone(parsed["ah_line_close"])

    def test_i_campi_sopravvivono_alla_compattazione(self) -> None:
        """MATCH_FIELDS decide cosa finisce nel dataset pubblicato: un campo estratto e non
        elencato li' viene scartato in silenzio, ed e' come non averlo estratto."""
        compact = top5.compact_match(self.row)
        for field in (
            "home_odds_close", "draw_odds_close", "away_odds_close",
            "home_odds_max_close", "over25_odds", "under25_odds",
            "over25_odds_close", "under25_odds_close", "over25_odds_max_close",
            "ah_line_close", "ah_home_odds_close", "ah_away_odds_close",
        ):
            self.assertIn(field, compact, f"{field} non sopravvive a compact_match()")
            self.assertIsNotNone(compact[field])


if __name__ == "__main__":
    unittest.main()
