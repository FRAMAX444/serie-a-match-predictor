"""Contratto: una fonte irraggiungibile non deve cancellare colonne gia' pubblicate.

Il difetto che questo file esiste per impedire. Il 05/09/2026 football-data.co.uk ha iniziato a
rispondere 503 su tutto il sito (homepage inclusa, con qualunque User-Agent).
``download_football_data()`` cattura l'errore e lascia proseguire il run — corretto — ma la
pipeline poi **riscrive comunque** ``data/matches.json`` a partire dai soli feed raggiungibili.
Le colonne che solo Football-Data fornisce spariscono: fra il commit delle 12:02 e quello delle
17:03 del 5 settembre, ``home_odds`` e' passato da 5355 partite a 0, e ``referee`` da 1160 a 0.
Sedici run consecutivi hanno poi ripubblicato lo stesso vuoto.

Non e' un difetto delle previsioni — ``prediction-inputs.js`` non legge le quote e il sito
funziona uguale — ma azzera la strumentazione di misura: ``npm run backtest:market`` esce con
"Nessuna delle partite valutate ha home_odds/draw_odds/away_odds", e con lui
``diag_market_execution`` e ``diag_signal_orthogonality``, cioe' esattamente le misure su cui si
regge PROMPT-sessione-4 e -5.

Due reti, perche' i modi di sbagliare sono due:

1. UNITA' su ``restore_missing_source_fields``, che riempie i buchi dal dataset precedente.
   Deve riempire solo i buchi, mai sovrascrivere un valore fresco, e mai far ricomparire una
   partita che i feed live non riportano piu'.
2. CONTRATTO sul dataset pubblicato: le quote non possono essere sparite dalle stagioni
   concluse dei Big Five. E' il controllo che sarebbe diventato rosso il 5 settembre.
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

BIG_FIVE = {"eng.1", "esp.1", "ita.1", "ger.1", "fra.1"}

# Football-Data copre integralmente le stagioni concluse dei Big Five: prima
# dell'indisponibilita' la copertura misurata era 100% su tutte e quindici (tre stagioni per
# cinque leghe). La soglia sta bassa perche' il contratto deve intercettare il crollo a zero,
# non fare da metrica di qualita' su una manciata di righe.
MIN_ODDS_COVERAGE = 0.90


def match(**overrides: object) -> dict[str, object]:
    row = {
        "competition_id": "ita.1", "date": "2025-08-17", "season": "2526",
        "home_team": "Genoa", "away_team": "Inter", "home_goals": 2, "away_goals": 2,
    }
    row.update(overrides)
    return row


class RestoreMissingSourceFieldsTests(unittest.TestCase):
    def test_riempie_le_quote_che_la_fonte_giu_non_ha_fornito(self) -> None:
        fresh = [match()]
        existing = {"matches": [match(home_odds=6.31, home_odds_close=7.03, referee="Mr Rossi")]}
        filled, touched = top5.restore_missing_source_fields(fresh, existing)
        self.assertEqual((filled, touched), (3, 1))
        self.assertEqual(fresh[0]["home_odds"], 6.31)
        self.assertEqual(fresh[0]["home_odds_close"], 7.03)
        self.assertEqual(fresh[0]["referee"], "Mr Rossi")

    def test_non_sovrascrive_un_valore_fresco(self) -> None:
        """Il dataset precedente e' un ripiego, non una fonte: quando la fonte risponde, vince lei."""
        fresh = [match(home_odds=2.00)]
        existing = {"matches": [match(home_odds=6.31)]}
        filled, touched = top5.restore_missing_source_fields(fresh, existing)
        self.assertEqual((filled, touched), (0, 0))
        self.assertEqual(fresh[0]["home_odds"], 2.00)

    def test_non_fa_ricomparire_una_partita_sparita_dai_feed(self) -> None:
        """L'insieme delle partite resta deciso dai feed live: qui si riempiono colonne, non righe.
        Altrimenti una riga corretta a monte (data sbagliata, squadra sbagliata) resterebbe nel
        dataset per sempre, e il dataset non potrebbe piu' rimpicciolirsi."""
        fresh = [match()]
        existing = {"matches": [match(date="2025-08-18", home_odds=6.31)]}
        filled, touched = top5.restore_missing_source_fields(fresh, existing)
        self.assertEqual((filled, touched), (0, 0))
        self.assertEqual(len(fresh), 1)

    def test_un_dataset_precedente_assente_non_e_un_errore(self) -> None:
        self.assertEqual(top5.restore_missing_source_fields([match()], {}), (0, 0))

    def test_la_chiave_e_la_stessa_di_merge_matches(self) -> None:
        """Se le due chiavi divergessero, il ripristino fallirebbe in silenzio su ogni partita
        e il dataset tornerebbe a perdere le quote senza che nulla lo dica."""
        same = [match(home_odds=6.31), match(home_shots=10)]
        self.assertEqual(len(base.merge_matches(same)), 1)
        self.assertEqual(base.match_identity(same[0]), base.match_identity(same[1]))
        for field, value in (("competition_id", "esp.1"), ("date", "2025-08-18"),
                             ("home_team", "Milan"), ("away_team", "Roma")):
            other = match(**{field: value})
            self.assertEqual(len(base.merge_matches([same[0], other])), 2, field)
            self.assertNotEqual(base.match_identity(same[0]), base.match_identity(other), field)

    def test_i_campi_ripristinati_sopravvivono_alla_compattazione(self) -> None:
        """MATCH_FIELDS decide cosa finisce nel dataset: un campo ripristinato e non elencato li'
        verrebbe riscartato subito dopo, e il ripristino sarebbe un giro a vuoto."""
        for field in top5.FOOTBALL_DATA_ONLY_FIELDS:
            self.assertIn(field, top5.MATCH_FIELDS, f"{field} non sopravvive a compact_match()")


class PublishedOddsCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        if not DATASET.exists():
            self.skipTest("data/matches.json assente")
        self.payload = json.loads(DATASET.read_text(encoding="utf8"))

    def test_le_stagioni_concluse_dei_big_five_hanno_le_quote(self) -> None:
        target = str(self.payload.get("target_season") or "")
        played = [
            item for item in self.payload["matches"]
            if str(item.get("competition_id")) in BIG_FIVE
            and str(item.get("season")) != target
            and item.get("home_goals") is not None
        ]
        self.assertGreater(len(played), 1000, "dataset troppo piccolo per giudicare la copertura")
        with_odds = sum(item.get("home_odds") is not None for item in played)
        coverage = with_odds / len(played)
        self.assertGreaterEqual(
            coverage, MIN_ODDS_COVERAGE,
            f"copertura quote {coverage:.1%} ({with_odds}/{len(played)}): una fonte irraggiungibile "
            "ha cancellato colonne gia' pubblicate invece di lasciarle com'erano",
        )


if __name__ == "__main__":
    unittest.main()
