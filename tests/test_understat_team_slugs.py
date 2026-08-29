import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import understat_team_api as understat


# Prima di questo file, TEAM_SLUG_OVERRIDES non aveva alcuna copertura di test: una chiave
# mancante o un typo nello slug di destinazione passava inosservato fino al prossimo run reale
# della pipeline (0 partite per la squadra, scoperto solo leggendo stderr) — esattamente il
# bug segnalato il 21/08/2026 per Atl. Madrid / Dep. A Coruna / Deportivo / Racing / Santander.
class ResolveSlugRegressionTests(unittest.TestCase):
    """Le 5 varianti segnalate in produzione devono risolvere allo slug corretto, non più
    ricadere sull'euristica slugify_team() (che per questi nomi produrrebbe uno slug errato:
    'Atl._Madrid', 'Dep._A_Coruna', 'Deportivo', 'Racing', 'Santander' — nessuno dei quali è
    una pagina squadra reale su understat.com)."""

    def test_atl_madrid_resolves_to_verified_atletico_slug(self) -> None:
        self.assertEqual(understat.resolve_slug("Atl. Madrid"), "Atletico_Madrid")

    def test_deportivo_short_forms_resolve_to_verified_slug(self) -> None:
        self.assertEqual(understat.resolve_slug("Deportivo"), "Deportivo_La_Coruna")
        self.assertEqual(understat.resolve_slug("Dep. A Coruna"), "Deportivo_La_Coruna")

    def test_racing_santander_variants_resolve_consistently(self) -> None:
        # Slug NON verificato dal vivo (understat.com blocca il fetch automatico) — qui
        # verifichiamo solo la coerenza interna: le tre varianti devono risolvere tutte allo
        # STESSO slug, altrimenti fetch_league_matches_via_team_api tratterebbe lo stesso club
        # come due squadre diverse. La correttezza dello slug stesso va confermata a mano
        # aprendo https://understat.com/team/Racing_Santander/2026 (vedi commento nel sorgente).
        resolved = {understat.resolve_slug(name) for name in ("Racing", "Santander", "Racing Santander")}
        self.assertEqual(resolved, {"Racing_Santander"})


class OverrideTableConsistencyTests(unittest.TestCase):
    """Controlli strutturali sull'intera tabella, non solo sulle 5 voci nuove: prevengono la
    stessa classe di bug (typo nello slug di destinazione, voce duplicata con target diverso)
    altrove nella tabella."""

    def test_no_empty_keys_or_values(self) -> None:
        for raw_name, slug in understat.TEAM_SLUG_OVERRIDES.items():
            self.assertTrue(raw_name.strip(), "chiave vuota o solo spazi in TEAM_SLUG_OVERRIDES")
            self.assertTrue(slug.strip(), f"slug vuoto per la chiave {raw_name!r}")

    def test_no_slug_contains_whitespace(self) -> None:
        # Uno slug con uno spazio non ancora sostituito da underscore darebbe quasi certamente
        # 404 su understat.com/team/<slug>/<anno>.
        for raw_name, slug in understat.TEAM_SLUG_OVERRIDES.items():
            self.assertNotIn(" ", slug, f"slug con spazio non convertito per {raw_name!r}: {slug!r}")

    def test_known_alias_groups_map_to_the_same_slug(self) -> None:
        # Gruppi di alias per lo stesso club realmente esistenti in tabella: una svista comune è
        # aggiungere un nuovo alias con un target leggermente diverso (typo, maiuscole diverse)
        # da quello già usato per lo stesso club, che fetch_league_matches_via_team_api
        # tratterebbe come due squadre distinte invece di deduplicarle.
        alias_groups = [
            ["Deportivo", "Dep. A Coruna", "La Coruna", "Deportivo La Coruna"],
            ["Atl. Madrid", "Atletico Madrid", "Ath Madrid", "Atlético", "Atlético Madrid"],
            ["Racing", "Santander", "Racing Santander"],
            ["Alaves", "Alavés", "Deportivo Alaves", "Deportivo Alavés"],
            ["Sociedad", "Real Sociedad"],
            ["Milan", "AC Milan"],
            ["Bayern", "Bayern Monaco", "Bayern Munich"],
        ]
        for group in alias_groups:
            slugs = {understat.resolve_slug(name) for name in group}
            self.assertEqual(len(slugs), 1, f"il gruppo di alias {group} risolve a slug diversi: {slugs}")


class SlugifyFallbackTests(unittest.TestCase):
    """resolve_slug() ricade su slugify_team() per qualunque nome non elencato: deve continuare
    a funzionare per squadre non ancora incontrate, non solo per quelle già in tabella."""

    def test_unlisted_team_falls_back_to_heuristic(self) -> None:
        self.assertEqual(understat.resolve_slug("Some New Team"), "Some_New_Team")

    def test_slugify_strips_accents(self) -> None:
        self.assertEqual(understat.slugify_team("São Paulo"), "Sao_Paulo")
        self.assertEqual(understat.slugify_team("Köln"), "Koln")

    def test_slugify_collapses_spaces_to_single_underscore_join(self) -> None:
        self.assertEqual(understat.slugify_team("Real Madrid"), "Real_Madrid")


class ParseTeamMatchesTests(unittest.TestCase):
    """parse_team_matches non ha copertura diretta altrove: verifichiamo che filtri
    correttamente i risultati non ancora giocati e gli item malformati."""

    def test_filters_out_non_results_and_keeps_valid_rows(self) -> None:
        payload = {
            "dates": [
                {"isResult": False, "h": {"title": "Racing Santander"}, "a": {"title": "Elche"}},
                {"isResult": True, "datetime": "2026-08-16 15:00:00",
                 "h": {"title": "Racing Santander"}, "a": {"title": "Villarreal"},
                 "xG": {"h": "1.42", "a": "0.83"}},
                {"isResult": True, "datetime": "bad-data", "h": {}, "a": {}, "xG": {}},  # deve essere scartato
            ]
        }
        rows = understat.parse_team_matches(payload, normalize_team=lambda name: name)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["home_team"], "Racing Santander")
        self.assertEqual(rows[0]["away_team"], "Villarreal")
        self.assertAlmostEqual(rows[0]["home_xg"], 1.42)

    def test_missing_dates_key_returns_empty_list(self) -> None:
        self.assertEqual(understat.parse_team_matches({}, normalize_team=lambda n: n), [])
        self.assertEqual(understat.parse_team_matches("not-a-dict", normalize_team=lambda n: n), [])


if __name__ == "__main__":
    unittest.main()
