"""normalize_team() deve fondere gli alias della STESSA squadra in un solo nome canonico.

Perché questo file esiste (misura del 25/08/2026 su data/matches.json, 8646 gare):

merge_matches() in update_europe_data.py deduplica le partite sulla chiave
(competition_id, date, home_team, away_team). Quando ESPN e Football-Data.co.uk scrivono lo
stesso club in modo diverso — "Atletico Madrid" contro "Ath Madrid", "M'gladbach" contro
"Gladbach" — la chiave non coincide, la deduplicazione non scatta e la STESSA partita reale
resta nel dataset due volte, ciascuna copia con metà delle statistiche: la riga ESPN porta
l'xG, la riga Football-Data porta tiri e quote.

Effetti misurati, tutti e tre da un'unica causa:
  1. 210 coppie di righe duplicate nei Big Five (25 famiglie di alias);
  2. identità di club spezzate — Bundesliga 2425 conta 22 squadre invece di 18, LaLiga 28
     invece di 20: "Gladbach" ha 6 partite e "M'gladbach" 34, quindi Elo, forma e medie di
     quel club sono calcolati su frammenti di storia;
  3. copertura xG di esp.1 al 35% e di ger.1 al 34% contro il 90-99% della Serie A — non
     perché Understat non risponda (l'endpoint getTeamData risponde correttamente per tutte
     e cinque le leghe, verificato dal vivo il 25/08/2026), ma perché enrich_xg() aggancia
     le righe xG sulla stessa chiave basata sui nomi, e per quelle squadre la chiave non
     esiste.

È esattamente la classe di bug descritta in R2 del brief: nessuna eccezione, nessun test
rotto, solo un numero plausibile prodotto in silenzio.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_europe_data as pipeline


# Ricavate empiricamente dal dataset, non compilate a mano: due righe della stessa
# competizione, stessa data, stesso punteggio, con un lato identico e l'altro diverso, sono
# la stessa partita scritta due volte — e i due nomi diversi sono per forza lo stesso club.
# Ogni tupla è una famiglia; il primo elemento è il nome canonico atteso.
ALIAS_FAMILIES = (
    # Bundesliga
    ("M'gladbach", "Gladbach"),
    ("Ein Frankfurt", "Frankfurt"),
    ("Werder Bremen", "Bremen"),
    ("FC Koln", "Cologne"),
    ("St Pauli", "St. Pauli"),
    # LaLiga
    ("Celta Vigo", "Celta"),
    ("Rayo Vallecano", "Rayo", "Vallecano"),
    ("Athletic Bilbao", "Ath Bilbao", "Athletic"),
    ("Atletico Madrid", "Ath Madrid", "Atl. Madrid"),
    ("Alaves", "Alavés"),
    ("Espanyol", "Espanol"),
    ("Real Sociedad", "Sociedad"),
    ("Almeria", "Almería"),
    ("Real Oviedo", "Oviedo"),
    ("Cadiz", "Cádiz"),
    ("Leganes", "Leganés"),
    ("Real Valladolid", "Valladolid"),
    ("Deportivo La Coruna", "Deportivo", "Dep. A Coruna"),
    ("Racing Santander", "Racing", "Santander"),
    # Premier League
    ("Tottenham", "Spurs"),
    ("Crystal Palace", "C Palace"),
    ("Nottingham Forest", "Nott'm Forest", "Nottm Forest"),
    ("Sheffield United", "Sheffield Utd"),
    # Ligue 1
    ("Le Havre", "Le Havre AC"),
    ("Clermont", "Clermont Foot"),
    ("Saint-Etienne", "St Etienne", "St. Étienne", "St. Etienne"),
)


class AliasFoldingTests(unittest.TestCase):
    def test_every_alias_family_collapses_to_one_name(self) -> None:
        broken = []
        for family in ALIAS_FAMILIES:
            resolved = {pipeline.normalize_team(name) for name in family}
            if len(resolved) != 1:
                broken.append(f"{family} -> {sorted(resolved)}")
        self.assertEqual(
            broken,
            [],
            "Alias della stessa squadra non fusi da normalize_team(); ognuno di questi "
            "produce una riga partita duplicata e un'identità di club spezzata:\n  "
            + "\n  ".join(broken),
        )

    def test_canonical_name_is_stable_under_repeated_normalization(self) -> None:
        # normalize_team() viene applicata sia ai nomi delle fonti sia ai nomi già in
        # dataset: se non fosse idempotente, un secondo passaggio ricreerebbe la divergenza
        # che il primo aveva appena chiuso.
        for family in ALIAS_FAMILIES:
            for name in family:
                once = pipeline.normalize_team(name)
                self.assertEqual(once, pipeline.normalize_team(once), f"non idempotente su {name!r}")

    def test_distinct_clubs_are_not_merged(self) -> None:
        # Il rischio simmetrico di una tabella di alias troppo aggressiva: fondere due club
        # diversi. Paris FC e Paris Saint-Germain sono due squadre di Ligue 1 distinte;
        # Racing Santander e Racing Club non lo stesso club; Milan e Inter ovviamente no.
        for left, right in (
            ("Paris FC", "PSG"),
            ("Paris FC", "Paris Saint-Germain"),
            ("Milan", "Inter"),
            ("Real Madrid", "Real Sociedad"),
            ("Real Betis", "Real Valladolid"),
            ("Manchester United", "Manchester City"),
            ("Union Berlin", "Hertha Berlin"),
        ):
            self.assertNotEqual(
                pipeline.normalize_team(left),
                pipeline.normalize_team(right),
                f"{left!r} e {right!r} sono club diversi ma normalize_team() li fonde",
            )


if __name__ == "__main__":
    unittest.main()


class SpellingCollisionsInPipelineTests(unittest.TestCase):
    """La fusione per grafia deve stare NELLA pipeline, non solo nello strumento di riparazione.

    Difetto del 28/08/2026: `resolve_spelling_collisions` viveva solo in
    repair_dataset_identities.py. La rigenerazione automatica — quattro volte al giorno —
    reintroduceva quindi lo split "Malaga"/"Málaga" a ogni esecuzione: il contratto di identità
    lo intercettava, ma la riparazione andava lanciata a mano ogni volta.

    Non è esprimibile come normalize_team() di un nome solo: per scegliere la grafia vincente
    serve vedere tutti i nomi insieme. Va quindi verificato che la pipeline faccia la passata.
    """

    def test_the_pipeline_module_owns_the_function(self) -> None:
        import repair_dataset_identities as repair

        self.assertIs(
            repair.resolve_spelling_collisions, pipeline.resolve_spelling_collisions,
            "lo strumento di riparazione deve IMPORTARE la funzione della pipeline, non "
            "ridefinirla: due copie possono divergere e una sola delle due verrebbe corretta",
        )

    def test_main_applies_the_collapse_before_computing_elo(self) -> None:
        # Controllo sul sorgente e non sul comportamento: eseguire main() richiede la rete.
        # Ciò che conta è l'ORDINE — fondere le grafie dopo compute_elo unirebbe i nomi
        # lasciando l'Elo calcolato sulle identità spezzate, cioè correggerebbe l'etichetta e
        # non il dato.
        source = (Path(__file__).resolve().parents[1] / "scripts" / "update_europe_data.py").read_text(encoding="utf8")
        collapse = source.find("spelling = resolve_spelling_collisions(every_name)")
        elo = source.find("elo, elo_as_of, match_counts = compute_elo(matches)")
        self.assertNotEqual(collapse, -1, "la pipeline deve applicare la fusione delle grafie prima di scrivere")
        self.assertNotEqual(elo, -1, "punto di riferimento non trovato: il test va aggiornato")
        self.assertLess(
            collapse, elo,
            "la fusione delle grafie deve precedere compute_elo(): dopo, l'Elo resterebbe "
            "calcolato sulle identità spezzate",
        )

    def test_the_winner_is_the_most_frequent_spelling(self) -> None:
        mapping = pipeline.resolve_spelling_collisions(["Malaga", "Málaga", "Málaga", "Málaga"])
        self.assertEqual(mapping, {"Malaga": "Málaga"})
        # A parità di frequenza vince la forma più lunga. Vale solo fra grafie con lo STESSO
        # fold: "Oviedo"/"Real Oviedo" hanno fold diversi e non arrivano qui — quelli li
        # dichiara TEAM_ALIASES, perché servono conoscenze di calcio e non una regola.
        self.assertEqual(
            pipeline.resolve_spelling_collisions(["St Pauli", "St. Pauli"]),
            {"St Pauli": "St. Pauli"},
        )
        # Nomi che non collidono nel fold non vanno toccati: sono club diversi.
        self.assertEqual(pipeline.resolve_spelling_collisions(["Inter", "Inter Turku"]), {})
        self.assertEqual(pipeline.resolve_spelling_collisions(["Oviedo", "Real Oviedo"]), {})
