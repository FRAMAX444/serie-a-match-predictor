import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

# numpy/scipy/matplotlib servono solo allo studio Monte Carlo, non alla pipeline dati né
# all'app: requirements.txt lo dice esplicitamente e nessun workflow le installa. Importarle a
# livello di modulo faceva fallire l'INTERA suite Python con un ImportError su una dipendenza
# dichiarata facoltativa — compreso su .github/workflows/validate-pr.yml, che esegue
# `python -m unittest discover` senza alcun pip install. Un test che non può girare va saltato,
# non deve nascondere il risultato di tutti gli altri.
try:
    import numpy as np

    import validate_player_probabilities as study
except ImportError as error:  # pragma: no cover - dipende dall'ambiente, non dal codice
    raise unittest.SkipTest(
        f"Studio Monte Carlo non verificabile senza le dipendenze facoltative ({error}). "
        "Installa numpy/scipy/matplotlib con: pip install -r requirements.txt"
    ) from error


# Questi test validano il codice di STUDIO (le funzioni statistiche in
# validate_player_probabilities.py), non estimatePlayerMarkets stesso: un bug qui
# invaliderebbe la calibrazione riportata nel report senza che nessun test se ne accorga,
# esattamente come e' successo con il parsing ESPN prima che venisse aggiunta copertura.
class PoissonTailTests(unittest.TestCase):
    def test_matches_scipy_survival_function(self) -> None:
        from scipy import stats
        for lam in [0.1, 0.5, 1.0, 2.5, 5.0, 10.0]:
            for k in [1, 2, 3, 5]:
                expected = float(stats.poisson.sf(k - 1, lam))
                actual = study.poisson_p_at_least(lam, k)
                self.assertAlmostEqual(actual, expected, places=9, msg=f"lam={lam} k={k}")

    def test_zero_lambda_gives_zero_probability(self) -> None:
        self.assertEqual(study.poisson_p_at_least(0.0, 1), 0.0)
        self.assertEqual(study.poisson_p_at_least(0.0, 5), 0.0)

    def test_monotonically_decreasing_in_k(self) -> None:
        values = [study.poisson_p_at_least(3.0, k) for k in range(1, 8)]
        self.assertTrue(all(values[i] >= values[i + 1] for i in range(len(values) - 1)))

    def test_p_at_least_one_matches_simple_formula(self) -> None:
        # P(X>=1) = 1 - e^-lambda e' la formula usata direttamente in estimatePlayerMarkets:
        # deve coincidere esattamente con la ricostruzione via serie usata qui.
        import math
        for lam in [0.05, 1.0, 4.2]:
            self.assertAlmostEqual(study.poisson_p_at_least(lam, 1), 1 - math.exp(-lam), places=12)


class SimulateDrawsTests(unittest.TestCase):
    def test_pure_poisson_mean_and_variance(self) -> None:
        rng = np.random.default_rng(1)
        lam = 2.5
        draws = study.simulate_draws(lam, 200_000, overdispersion_k=None, rng=rng)
        self.assertAlmostEqual(float(draws.mean()), lam, delta=0.03)
        # Proprietà distintiva del Poisson puro: varianza == media.
        self.assertAlmostEqual(float(draws.var()), lam, delta=0.08)

    def test_overdispersed_preserves_mean_but_inflates_variance(self) -> None:
        rng = np.random.default_rng(2)
        lam = 2.5
        k = 4.0
        draws = study.simulate_draws(lam, 300_000, overdispersion_k=k, rng=rng)
        self.assertAlmostEqual(float(draws.mean()), lam, delta=0.03)
        # Binomiale Negativa risultante dal mix Gamma-Poisson: Var(X) = lambda + lambda^2/k.
        expected_variance = lam + (lam ** 2) / k
        self.assertAlmostEqual(float(draws.var()), expected_variance, delta=0.3)
        self.assertGreater(float(draws.var()), lam, "la sovradispersione deve produrre varianza sopra il livello Poisson")

    def test_zero_expected_value_gives_all_zero_draws(self) -> None:
        rng = np.random.default_rng(3)
        draws = study.simulate_draws(0.0, 1000, overdispersion_k=None, rng=rng)
        self.assertTrue(np.all(draws == 0))
        draws_od = study.simulate_draws(0.0, 1000, overdispersion_k=4.0, rng=rng)
        self.assertTrue(np.all(draws_od == 0))


class CalibrationMetricsTests(unittest.TestCase):
    def test_brier_score_matches_hand_computation(self) -> None:
        predicted = np.array([0.2, 0.2, 0.8, 0.8])
        outcome = np.array([0.0, 1.0, 1.0, 0.0])
        metrics = study.calibration_metrics(predicted, outcome, n_bins=10)
        expected_brier = float(np.mean([(0.2 - 0) ** 2, (0.2 - 1) ** 2, (0.8 - 1) ** 2, (0.8 - 0) ** 2]))
        self.assertAlmostEqual(metrics["brier_score"], expected_brier, places=9)

    def test_perfectly_calibrated_data_has_near_zero_ece(self) -> None:
        rng = np.random.default_rng(42)
        predicted, outcome = [], []
        for level in [0.1, 0.3, 0.5, 0.7, 0.9]:
            n = 20_000
            predicted.extend([level] * n)
            outcome.extend((rng.random(n) < level).astype(float))
        metrics = study.calibration_metrics(np.array(predicted), np.array(outcome), n_bins=10)
        self.assertLess(metrics["ece"], 0.01, "dati calibrati per costruzione devono avere ECE quasi nullo")
        self.assertLess(metrics["max_bin_gap"], 0.02)

    def test_worst_case_miscalibration_is_captured(self) -> None:
        # Il modello e' sicuro al 90% ma l'evento non si verifica mai: un caso di
        # miscalibrazione totale che le metriche devono rilevare senza ambiguita'.
        predicted = np.full(5000, 0.9)
        outcome = np.zeros(5000)
        metrics = study.calibration_metrics(predicted, outcome, n_bins=10)
        self.assertAlmostEqual(metrics["brier_score"], 0.81, places=6)
        self.assertAlmostEqual(metrics["ece"], 0.9, places=6)

    def test_reliability_table_counts_sum_to_total(self) -> None:
        rng = np.random.default_rng(7)
        predicted = rng.random(10_000)
        outcome = (rng.random(10_000) < predicted).astype(float)
        metrics = study.calibration_metrics(predicted, outcome, n_bins=10)
        total_binned = sum(row["count"] for row in metrics["reliability_table"])
        self.assertEqual(total_binned, 10_000)


class ScenarioConstructionTests(unittest.TestCase):
    def test_scenario_count_matches_grid_size(self) -> None:
        scenarios = study.build_scenarios()
        self.assertEqual(len(scenarios), len(study.ARCHETYPES) * len(study.TEAM_SCALING_SCENARIOS) * len(study.MINUTES_SCENARIOS))

    def test_expected_shots_raw_matches_formula(self) -> None:
        scenarios = study.build_scenarios()
        for scenario in scenarios:
            archetype = next(a for a in study.ARCHETYPES if a.key == scenario["archetype"])
            expected = archetype.shots_per90 * scenario["minutes_factor"] * scenario["team_scaling"]
            self.assertAlmostEqual(scenario["expected_shots_raw"], expected, places=9)

    @staticmethod
    def _appearance_scenarios(player: dict) -> list[tuple[float, float]]:
        # Ricostruzione indipendente di appearanceScenarios() in model.js. Il test non usa
        # minuti attesi: pesa separatamente titolare e subentrato, come il modello corrente.
        appearances = max(0.0, float(player.get("appearances") or 0))
        squad_appearances = max(float(player.get("squad_appearances") or 0), appearances)
        starts = min(appearances, max(0.0, float(player.get("starts") or 0)))
        minutes = max(0.0, float(player.get("minutes") or 0))
        sample_size = max(squad_appearances, appearances, 1.0)
        start_probability = min(
            1.0,
            max(0.0, float(player.get("start_probability") or ((starts + 0.5) / (sample_size + 1.5)))),
        )
        play_probability = min(
            1.0,
            max(
                start_probability,
                float(player.get("play_probability") or ((appearances + 0.5) / (sample_size + 1.0))),
            ),
        )
        minutes_per_start = float(player.get("minutes_per_start") or 0)
        if minutes_per_start <= 0:
            minutes_per_start = minutes / starts if starts > 0 else 80.0
        minutes_per_start = min(90.0, max(1.0, minutes_per_start))
        substitute_appearances = max(0.0, appearances - starts)
        substitute_minutes = (
            (minutes - starts * minutes_per_start) / substitute_appearances
            if substitute_appearances > 0
            else 20.0
        )
        substitute_minutes = min(90.0, max(1.0, substitute_minutes))
        return [
            (start_probability, minutes_per_start),
            (max(0.0, play_probability - start_probability), substitute_minutes),
        ]

    @staticmethod
    def _negative_binomial_at_least_one(mean: float, dispersion: float) -> float:
        if mean <= 0:
            return 0.0
        no_event = (dispersion / (dispersion + mean)) ** dispersion
        return 1.0 - no_event

    def test_bridge_predictions_match_current_model_when_not_clamped(self) -> None:
        # Il modello non usa più Poisson puro né teamScaling pieno sui tiri: usa una miscela
        # degli scenari di impiego, Binomiale Negativa e sqrt(teamScaling) per il volume tiri.
        # Il test resta indipendente dal JS, ma verifica la formula che è davvero in produzione.
        scenarios = study.build_scenarios()[:12]
        study.attach_model_predictions(scenarios)
        for scenario in scenarios:
            player = scenario["player"]
            appearances = self._appearance_scenarios(player)
            if not scenario["shot_clamped"]:
                shot_scaling = scenario["team_scaling"] ** 0.5
                theory = sum(
                    weight * self._negative_binomial_at_least_one(
                        float(player["shots_per90"]) * (minutes / 90.0) * shot_scaling,
                        5.0,
                    )
                    for weight, minutes in appearances
                )
                self.assertAlmostEqual(scenario["model"]["shotProbability"], theory, places=9)
            if not scenario["assist_clamped"]:
                theory = sum(
                    weight * self._negative_binomial_at_least_one(
                        float(player["assists_per90"]) * (minutes / 90.0) * scenario["team_scaling"],
                        8.0,
                    )
                    for weight, minutes in appearances
                )
                self.assertAlmostEqual(scenario["model"]["assistProbability"], theory, places=9)


if __name__ == "__main__":
    unittest.main()
