import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_player_probabilities as study


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

    def test_bridge_predictions_match_theory_when_not_clamped(self) -> None:
        # Test di integrazione: interroga il VERO estimatePlayerMarkets (via Node) su un
        # sottoinsieme di scenari e verifica che coincida con la formula Poisson teorica,
        # esattamente come fa lo studio completo ma qui come asserzione automatica.
        scenarios = study.build_scenarios()[:12]
        study.attach_model_predictions(scenarios)
        for scenario in scenarios:
            if not scenario["shot_clamped"]:
                theory = study.poisson_p_at_least(scenario["expected_shots_raw"], 1)
                self.assertAlmostEqual(scenario["model"]["shotProbability"], theory, places=9)
            if not scenario["assist_clamped"]:
                theory = study.poisson_p_at_least(scenario["expected_assists_raw"], 1)
                self.assertAlmostEqual(scenario["model"]["assistProbability"], theory, places=9)


if __name__ == "__main__":
    unittest.main()
