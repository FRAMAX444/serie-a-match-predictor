"""Contratto: le quote pre-partita di fixtures.csv arrivano alle fixture giuste.

Servono all'ancoraggio della pagina principale. L'aggancio attraversa il confine piu' costoso
del progetto — i nomi delle squadre fra due fonti — e una grafia divergente non solleva niente:
lascia quella gara senza linea, cioe' con la previsione endogena, in silenzio. Da qui il
contratto sul contatore per lega, non solo l'unita' sul parser.

Verificato sul fixtures.csv del 09/11/2026 contro il dataset del 01/11: 48 righe su 48 agganciate.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "data" / "matches.json"
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as base  # noqa: E402
import update_top5_data as top5  # noqa: E402

# Oltre questa quota di righe senza NESSUNA fixture, per lega, c'e' una grafia da sistemare.
# Le righe di gare gia' concluse non contano: sono il ritardo della fonte, non un difetto.
MAX_UNMATCHED_SHARE = 0.1

HEADER = "Div,Date,Time,HomeTeam,AwayTeam,AvgH,AvgD,AvgA,Avg>2.5,Avg<2.5"
CSV = "\n".join([
    HEADER,
    "I1,22/11/2026,15:00,Inter,Milan,1.90,3.60,4.20,1.80,2.05",
    "E0,22/11/2026,15:00,Man United,Tottenham,2.10,3.50,3.40,1.70,2.15",
    "E1,22/11/2026,15:00,Leeds,Hull,1.60,3.90,5.50,1.90,1.95",  # campionato non supportato
    "SP1,22/11/2026,21:00,Barcelona,Getafe,1.25,6.50,11.0,,",  # totale mancante: niente ancora
])


def fixture(home: str, away: str, completed: bool = False, competition: str = "ita.1") -> dict[str, object]:
    return {"competition_id": competition, "home_team": home, "away_team": away, "completed": completed, "date": "2026-11-22"}


class ParseFixtureOddsTests(unittest.TestCase):
    def test_legge_solo_i_campionati_supportati_e_le_righe_complete(self) -> None:
        rows = base.parse_fixture_odds(CSV, top5.TOP_FIVE_LEAGUES)
        self.assertEqual([(row["competition_id"], row["home_team"]) for row in rows], [("ita.1", "Inter"), ("eng.1", "Man United")])
        self.assertEqual(rows[0]["odds"], {"home": 1.90, "draw": 3.60, "away": 4.20, "over25": 1.80, "under25": 2.05})
        self.assertEqual(rows[0]["date"], "2026-11-22")

    def test_i_nomi_passano_dalla_stessa_normalizzazione_dei_csv_storici(self) -> None:
        row = "\n".join([HEADER, "I1,22/11/2026,15:00,AC Milan,AS Roma,2.0,3.4,3.6,1.9,1.9"])
        [parsed] = base.parse_fixture_odds(row, top5.TOP_FIVE_LEAGUES)
        self.assertEqual((parsed["home_team"], parsed["away_team"]), (base.normalize_team("AC Milan"), base.normalize_team("AS Roma")))
        self.assertEqual((parsed["home_team"], parsed["away_team"]), ("Milan", "Roma"))


class AttachPrematchOddsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = base.parse_fixture_odds(CSV, top5.TOP_FIVE_LEAGUES)

    def test_scrive_la_linea_sulla_fixture_futura_con_la_sua_data(self) -> None:
        future = fixture("Inter", "Milan")
        health = top5.attach_prematch_odds([{"fixtures": [future]}], self.rows, {}, "2026-11-10T08:00:00+00:00")
        self.assertEqual(future["prematch_odds"]["home"], 1.90)
        self.assertEqual(future["prematch_odds"]["fetched_at"], "2026-11-10T08:00:00+00:00")
        self.assertEqual(health["ita.1"], {"rows": 1, "matched": 1, "stale": 0, "unmatched": 0})
        self.assertEqual(health["eng.1"], {"rows": 1, "matched": 0, "stale": 0, "unmatched": 1})

    def test_non_tocca_una_gara_conclusa_e_la_conta_come_ritardo_non_come_grafia(self) -> None:
        """Il caso dell'11/11/2026: fixtures.csv conteneva ancora un turno gia' giocato. Contarlo
        come grafia divergente ha bloccato la pubblicazione del dataset."""
        played = fixture("Inter", "Milan", completed=True)
        health = top5.attach_prematch_odds([{"fixtures": [played]}], self.rows, {}, "t")
        self.assertNotIn("prematch_odds", played)
        self.assertEqual(health["ita.1"], {"rows": 1, "matched": 0, "stale": 1, "unmatched": 0})

    def test_usa_la_fusione_delle_grafie(self) -> None:
        """La fixture porta il nome fuso: senza la mappa la riga resterebbe orfana in silenzio."""
        fused = fixture("Manchester Utd", "Tottenham", competition="eng.1")
        health = top5.attach_prematch_odds([{"fixtures": [fused]}], self.rows, {"Man United": "Manchester Utd"}, "t")
        self.assertIn("prematch_odds", fused)
        self.assertEqual(health["eng.1"]["matched"], 1)


class PublishedPrematchOddsContractTests(unittest.TestCase):
    def setUp(self) -> None:
        if not DATASET.exists():
            self.skipTest("data/matches.json assente")
        self.payload = json.loads(DATASET.read_text(encoding="utf8"))
        self.health = (self.payload.get("source_health") or {}).get("prematch_odds")
        if self.health is None:
            self.skipTest("dataset generato prima delle quote pre-partita")

    def test_quasi_nessuna_riga_resta_senza_fixture(self) -> None:
        high = [
            f"{league}: {counts.get('unmatched', 0)}/{counts['rows']}"
            for league, counts in sorted(self.health.items())
            if counts["rows"] and counts.get("unmatched", 0) / counts["rows"] > MAX_UNMATCHED_SHARE
        ]
        self.assertEqual(high, [], "righe di fixtures.csv senza fixture: una grafia diverge fra Football-Data ed ESPN")

    def test_le_linee_scritte_sono_leggibili_dal_modello(self) -> None:
        for competition in self.payload["competitions"]:
            for item in competition.get("fixtures") or []:
                odds = item.get("prematch_odds")
                if odds is None:
                    continue
                self.assertFalse(item.get("completed"), "linea pre-partita su una gara conclusa")
                for key in ("home", "draw", "away", "over25", "under25"):
                    self.assertGreater(float(odds[key]), 1.0, f"{item['home_team']}-{item['away_team']} {key}")
                self.assertTrue(odds.get("fetched_at"), "una linea senza data non dichiara quanto e' vecchia")


if __name__ == "__main__":
    unittest.main()
