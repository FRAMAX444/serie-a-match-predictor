#!/usr/bin/env python3
"""Studio statistico completo su shotProbability / multiShotProbability / assistProbability
(estimatePlayerMarkets in model.js).

METODOLOGIA E LIMITI — leggere prima dei risultati
----------------------------------------------------------------------------------------
Questo script valida la CALIBRAZIONE TEORICA/INTERNA del modello: estimatePlayerMarkets
assume un processo di Poisson puro (tiri e assist indipendenti nel tempo, tasso costante
per tutta la partita). Con simulazione Monte Carlo verifichiamo che 1 - exp(-lambda) (e la
sua estensione per 2+ eventi, 1 - P(0) - P(1)) predica ESATTAMENTE la frequenza empirica di
quel processo generativo. Non è una tautologia: verifica che il codice — poissonPmf, i
clamp, il team scaling condiviso con gli assist — non introduca un bias tra teoria e
implementazione. Le probabilità testate sono quelle VERE restituite da model.js (chiamato
dal vivo via scripts/player_markets_bridge.mjs), non una reimplementazione Python che
potrebbe divergere silenziosamente dal codice davvero in produzione.

Questo NON è una calibrazione ESTERNA contro esiti reali di partita — richiederebbe
data/matches.json con player_context storico generato dalla pipeline dal vivo, non
disponibile in questo ambiente (nessun accesso di rete a ESPN qui). Per colmare in parte
questo limite, oltre allo scenario "Poisson puro" (l'assunzione implicita del modello)
simuliamo anche uno scenario con SOVRADISPERSIONE realistica (mix Gamma-Poisson: il tasso
vero varia partita per partita attorno al tasso storico, non è costante) per quantificare
quanto l'assunzione di Poisson puro del modello si allontana dalla calibrazione quando la
realtà è più "a scatti" — rotazioni, cambi tattici, partite più o meno intense — di quanto
un Poisson a tasso costante preveda. Chi ha accesso a data/matches.json reale con
outcome per-giocatore può ricalibrare i parametri di sovradispersione osservando la vera
varianza campionaria (vedi --overdispersion-k).

Fonti dei tassi-per-90 usati come archetipi (ricerca web, Agosto 2026) — dettagliate anche
nel campo `source` di ogni Archetype:
- ESPN FC (Marcotti, "Rasmus Hojlund Manchester United scoring woe"): tiri/90 Premier
  League 2025-26 di riferimento — Haaland 3.82, Jackson 3.24, Watkins 3.26, Isak 3.09,
  Diaz 2.71, Nunez 2.60, Solanke 2.59, Havertz 2.54; Hojlund 1.20 citato come sotto media.
- FotMob ("the standout stat which highlights Premier League teams' attacking intent"):
  Haaland 5.0 tiri/90, Duran 4.9, Muniz 4.3, Jimenez 4.0.
- Sportskeeda (top tiratori Premier League 2021-22): De Bruyne, centrocampista, 3.51
  tiri/90 — citato esplicitamente come eccezione al proprio ruolo.
- Javani, Hamedinia, Khodaei (2015), studio peer-reviewed su Iran Premier League: media
  ~0.8 tiri/competizione su TUTTI i ruoli, precisione di tiro ~31%, con centrocampisti e
  attaccanti significativamente sopra i difensori sia nel volume sia nella precisione.
- risingtransfers.com (benchmark G/90 per ruolo): 0.3-0.5 G/90 è élite per una punta,
  0.2+ è ottimo per un centrocampista centrale, 0.1 è notevole per un difensore.
Nessuna fonte fornisce assist/90 puliti e comparabili per ruolo (il dato più vicino,
"chances created" di FootyMetrics, mescola assist e passaggi chiave): gli archetipi assist
sono quindi tarati per coerenza relativa fra ruoli (creativi > mediani > centrali), non
citati 1:1 come i tassi di tiro — lo segnaliamo esplicitamente nel report finale.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "scripts" / "player_markets_bridge.mjs"
OUTPUT_DIR = ROOT / "docs" / "player-probability-study"

SHOT_CLAMP = 0.97
MULTI_SHOT_CLAMP = 0.97
ASSIST_CLAMP = 0.9


@dataclass(frozen=True)
class Archetype:
    key: str
    label: str
    position_group: str
    shots_per90: float
    assists_per90: float
    goals_per90: float
    source: str


ARCHETYPES: list[Archetype] = [
    Archetype("elite_striker", "Punta d'elite", "Attacco", 4.2, 0.12, 0.55,
              "ESPN/FotMob 2025-26: Haaland 3.82-5.0, Isak 3.09-3.82 tiri/90"),
    Archetype("good_striker", "Buona punta", "Attacco", 2.7, 0.12, 0.38,
              "ESPN 2025-26: Jackson 3.24, Watkins 3.26 tiri/90 (fascia medio-alta)"),
    Archetype("average_striker", "Punta in difficolta", "Attacco", 1.5, 0.08, 0.20,
              "ESPN 2025-26: Hojlund 1.20 tiri/90, citato esplicitamente come sotto media"),
    Archetype("creative_winger", "Esterno/trequartista creativo", "Trequarti", 2.2, 0.30, 0.24,
              "FBref shooting (volume alto sugli esterni) + ruolo di rifinitura per gli assist"),
    Archetype("central_midfielder", "Centrocampista centrale", "Centrocampo", 1.1, 0.18, 0.13,
              "Sportskeeda: De Bruyne 3.51 tiri/90 citato come eccezione al ruolo, non la norma"),
    Archetype("defensive_midfielder", "Mediano", "Centrocampo", 0.6, 0.10, 0.04,
              "Javani et al. 2015: centrocampisti sopra la media generale (~0.8/competizione)"),
    Archetype("attacking_fullback", "Terzino offensivo", "Difesa", 0.8, 0.18, 0.05,
              "Ruolo di spinta sulla fascia: pochi tiri, assist da cross comparabili a un CC"),
    Archetype("centre_back", "Difensore centrale", "Difesa", 0.45, 0.03, 0.06,
              "Javani et al. 2015: difensori sotto la media generale (~0.8 tiri/competizione)"),
]

# Stessi bound del clamp(teamLambda/teamRecentGoalsFor, 0.4, 2.2) in model.js: copriamo l'intero
# intervallo che il modello può realmente produrre, non solo lo scenario "medio".
TEAM_SCALING_SCENARIOS: list[float] = [0.4, 0.7, 1.0, 1.5, 2.2]

MINUTES_SCENARIOS: list[tuple[str, float]] = [
    ("titolare_90", 1.0),
    ("rotazione_60", 60 / 90),
    ("subentrato_20", 20 / 90),
]

TEAM_RECENT_GOALS_FOR = 1.5  # baseline arbitraria ma irrilevante: entra solo nel rapporto


def call_js_bridge(requests: list[dict]) -> list[dict]:
    """Invoca il VERO estimatePlayerMarkets di model.js (non una reimplementazione Python)."""
    proc = subprocess.run(
        ["node", str(BRIDGE)],
        input=json.dumps(requests),
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"player_markets_bridge.mjs ha fallito: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def poisson_p_at_least(lam: float, k: int) -> float:
    """P(X >= k) per X ~ Poisson(lam), ricalcolo indipendente (non importa nulla da model.js)
    usato per ricostruire il valore TEORICO non troncato dal clamp, e nei test unitari come
    riferimento esterno per il codice di analisi stesso."""
    if lam <= 0:
        return 0.0
    cumulative = 0.0
    term = math.exp(-lam)
    for i in range(k):
        cumulative += term
        term *= lam / (i + 1)
    return max(0.0, 1.0 - cumulative)


def build_scenarios() -> list[dict]:
    scenarios = []
    for archetype in ARCHETYPES:
        for scaling in TEAM_SCALING_SCENARIOS:
            for minutes_label, minutes_factor in MINUTES_SCENARIOS:
                appearances = 10
                minutes = round(appearances * 90 * minutes_factor)
                player = {
                    "appearances": appearances,
                    "minutes": minutes,
                    "goals_per90": archetype.goals_per90,
                    "assists_per90": archetype.assists_per90,
                    "yellow_per90": 0.15,
                    "red_per90": 0.01,
                    "shots_per90": archetype.shots_per90,
                }
                scenarios.append({
                    "archetype": archetype.key,
                    "archetype_label": archetype.label,
                    "position_group": archetype.position_group,
                    "team_scaling": scaling,
                    "minutes_label": minutes_label,
                    "minutes_factor": minutes_factor,
                    "player": player,
                    "teamLambda": TEAM_RECENT_GOALS_FOR * scaling,
                    "teamRecentGoalsFor": TEAM_RECENT_GOALS_FOR,
                    # Valori teorici esatti (stessa formula di model.js, ricalcolati qui solo
                    # per pilotare la simulazione e individuare dove il clamp entra in gioco —
                    # la predizione confrontata contro la simulazione resta quella VERA del
                    # bridge, mai questa).
                    "expected_shots_raw": archetype.shots_per90 * minutes_factor * scaling,
                    "expected_assists_raw": archetype.assists_per90 * minutes_factor * scaling,
                })
    return scenarios


def attach_model_predictions(scenarios: list[dict]) -> None:
    requests = [
        {"player": scenario["player"], "teamLambda": scenario["teamLambda"], "teamRecentGoalsFor": scenario["teamRecentGoalsFor"]}
        for scenario in scenarios
    ]
    results = call_js_bridge(requests)
    if len(results) != len(scenarios):
        raise RuntimeError("Il bridge ha restituito un numero di risultati diverso dalle richieste inviate")
    for scenario, result in zip(scenarios, results):
        scenario["model"] = result
        scenario["shot_clamped"] = result["shotProbability"] >= SHOT_CLAMP - 1e-9
        scenario["multi_shot_clamped"] = result["multiShotProbability"] >= MULTI_SHOT_CLAMP - 1e-9
        scenario["assist_clamped"] = result["assistProbability"] >= ASSIST_CLAMP - 1e-9


def simulate_draws(expected_value: float, n: int, overdispersion_k: float | None, rng: np.random.Generator) -> np.ndarray:
    """Genera n conteggi simulati per un processo con media `expected_value`.

    overdispersion_k=None: Poisson puro con tasso fisso, l'assunzione implicita del modello.
    overdispersion_k=k: mix Gamma-Poisson (Binomiale Negativa), media invariata =
    expected_value ma varianza = expected_value + expected_value^2/k — il tasso vero
    fluttua partita per partita invece di essere costante. k piccolo = più sovradispersione;
    k -> infinito ricade nel Poisson puro (verificato nei test unitari)."""
    if expected_value <= 0:
        return np.zeros(n, dtype=int)
    if overdispersion_k is None:
        return rng.poisson(expected_value, size=n)
    theta = rng.gamma(shape=overdispersion_k, scale=1.0 / overdispersion_k, size=n)
    return rng.poisson(expected_value * theta)


def run_monte_carlo(scenarios: list[dict], n: int, overdispersion_k: float | None, rng: np.random.Generator) -> dict:
    """Simula ogni scenario e restituisce sia le medie per-scenario sia gli array grezzi
    (predicted, outcome) impilati su tutti gli scenari, per costruire un diagramma di
    affidabilita' aggregato coerente con la letteratura di calibrazione (Guo et al. 2017)."""
    per_scenario = []
    pooled_predicted_shot = []
    pooled_outcome_shot = []
    pooled_predicted_multi = []
    pooled_outcome_multi = []
    pooled_predicted_assist = []
    pooled_outcome_assist = []

    for scenario in scenarios:
        shot_draws = simulate_draws(scenario["expected_shots_raw"], n, overdispersion_k, rng)
        assist_draws = simulate_draws(scenario["expected_assists_raw"], n, overdispersion_k, rng)

        empirical_shot_p1 = float(np.mean(shot_draws >= 1))
        empirical_shot_p2 = float(np.mean(shot_draws >= 2))
        empirical_assist_p1 = float(np.mean(assist_draws >= 1))

        theoretical_shot_p1 = poisson_p_at_least(scenario["expected_shots_raw"], 1)
        theoretical_shot_p2 = poisson_p_at_least(scenario["expected_shots_raw"], 2)
        theoretical_assist_p1 = poisson_p_at_least(scenario["expected_assists_raw"], 1)

        per_scenario.append({
            **{k: v for k, v in scenario.items() if k not in ("player",)},
            "empirical_shot_p1": empirical_shot_p1,
            "empirical_shot_p2": empirical_shot_p2,
            "empirical_assist_p1": empirical_assist_p1,
            "theoretical_shot_p1": theoretical_shot_p1,
            "theoretical_shot_p2": theoretical_shot_p2,
            "theoretical_assist_p1": theoretical_assist_p1,
            # errore vs il valore TEORICO non troncato: isola l'errore di implementazione
            # dall'effetto (voluto) del clamp, che viene invece riportato separatamente.
            "error_shot_p1_vs_theory": scenario["model"]["shotProbability"] - theoretical_shot_p1 if not scenario["shot_clamped"] else float("nan"),
            "error_shot_p2_vs_theory": scenario["model"]["multiShotProbability"] - theoretical_shot_p2 if not scenario["multi_shot_clamped"] else float("nan"),
            "error_assist_vs_theory": scenario["model"]["assistProbability"] - theoretical_assist_p1 if not scenario["assist_clamped"] else float("nan"),
            # errore vs la simulazione Monte Carlo (rumore campionario incluso, per questo il
            # controllo nei test/report usa una tolleranza più larga di quello teorico).
            "error_shot_p1_vs_mc": scenario["model"]["shotProbability"] - empirical_shot_p1,
            "error_shot_p2_vs_mc": scenario["model"]["multiShotProbability"] - empirical_shot_p2,
            "error_assist_vs_mc": scenario["model"]["assistProbability"] - empirical_assist_p1,
        })

        pooled_predicted_shot.append(np.full(n, scenario["model"]["shotProbability"]))
        pooled_outcome_shot.append((shot_draws >= 1).astype(float))
        pooled_predicted_multi.append(np.full(n, scenario["model"]["multiShotProbability"]))
        pooled_outcome_multi.append((shot_draws >= 2).astype(float))
        pooled_predicted_assist.append(np.full(n, scenario["model"]["assistProbability"]))
        pooled_outcome_assist.append((assist_draws >= 1).astype(float))

    return {
        "per_scenario": per_scenario,
        "shot_p1": (np.concatenate(pooled_predicted_shot), np.concatenate(pooled_outcome_shot)),
        "shot_p2": (np.concatenate(pooled_predicted_multi), np.concatenate(pooled_outcome_multi)),
        "assist_p1": (np.concatenate(pooled_predicted_assist), np.concatenate(pooled_outcome_assist)),
    }


def calibration_metrics(predicted: np.ndarray, outcome: np.ndarray, n_bins: int = 10) -> dict:
    """Brier score, Expected Calibration Error (ECE) e tabella di affidabilita' per bin,
    con la definizione standard usata nella letteratura di calibrazione probabilistica
    (es. Guo, Pleiss, Sun, Weinberger 2017, 'On Calibration of Modern Neural Networks')."""
    brier = float(np.mean((predicted - outcome) ** 2))
    eps = 1e-12
    log_loss = float(-np.mean(outcome * np.log(predicted + eps) + (1 - outcome) * np.log(1 - predicted + eps)))

    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    bin_indices = np.clip(np.digitize(predicted, bin_edges[1:-1]), 0, n_bins - 1)
    total = len(predicted)
    ece = 0.0
    reliability_table = []
    for bin_index in range(n_bins):
        mask = bin_indices == bin_index
        count = int(np.sum(mask))
        if count == 0:
            reliability_table.append({
                "bin": f"{bin_edges[bin_index]:.1f}-{bin_edges[bin_index + 1]:.1f}", "count": 0,
                "mean_predicted": None, "mean_observed": None,
            })
            continue
        mean_predicted = float(np.mean(predicted[mask]))
        mean_observed = float(np.mean(outcome[mask]))
        ece += (count / total) * abs(mean_predicted - mean_observed)
        reliability_table.append({
            "bin": f"{bin_edges[bin_index]:.1f}-{bin_edges[bin_index + 1]:.1f}", "count": count,
            "mean_predicted": mean_predicted, "mean_observed": mean_observed,
        })

    return {
        "brier_score": brier,
        "log_loss": log_loss,
        "ece": ece,
        "max_bin_gap": max((abs(row["mean_predicted"] - row["mean_observed"]) for row in reliability_table if row["count"] > 0), default=0.0),
        "reliability_table": reliability_table,
        "n": total,
    }


def make_plots(pure: dict, overdispersed: dict, per_scenario_pure: list[dict], out_dir: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)

    # --- Diagramma di affidabilita': shotProbability, Poisson puro vs sovradisperso -------
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.6))
    for ax, (title, market_key) in zip(axes, [
        ("Almeno 1 tiro (shotProbability)", "shot_p1"),
        ("Almeno 2 tiri (multiShotProbability)", "shot_p2"),
        ("Almeno 1 assist (assistProbability)", "assist_p1"),
    ]):
        predicted_pure, outcome_pure = pure[market_key]
        predicted_od, outcome_od = overdispersed[market_key]
        metrics_pure = calibration_metrics(predicted_pure, outcome_pure)
        metrics_od = calibration_metrics(predicted_od, outcome_od)

        for metrics, style, name in [
            (metrics_pure, dict(marker="o", linestyle="-", color="#2f6fed"), f"Poisson puro (ECE={metrics_pure['ece']:.4f})"),
            (metrics_od, dict(marker="s", linestyle="--", color="#e0673a"), f"Sovradisperso (ECE={metrics_od['ece']:.4f})"),
        ]:
            rows = [r for r in metrics["reliability_table"] if r["count"] > 0]
            xs = [r["mean_predicted"] for r in rows]
            ys = [r["mean_observed"] for r in rows]
            ax.plot(xs, ys, label=name, **style)
        ax.plot([0, 1], [0, 1], color="#999999", linestyle=":", label="Calibrazione perfetta")
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.set_xlabel("Probabilita' predetta dal modello")
        ax.set_ylabel("Frequenza empirica (simulazione)")
        ax.set_title(title, fontsize=10)
        ax.legend(fontsize=7, loc="upper left")
        ax.grid(alpha=0.25)
    fig.suptitle("Calibrazione di estimatePlayerMarkets — diagrammi di affidabilita' (Monte Carlo)", fontsize=12)
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(out_dir / "reliability_diagrams.png", dpi=150)
    plt.close(fig)

    # --- Confronto per archetipo: shotProbability vs tiri/90 reali di riferimento ---------
    fig, ax = plt.subplots(figsize=(9, 5.5))
    by_archetype: dict[str, list[dict]] = {}
    for row in per_scenario_pure:
        by_archetype.setdefault(row["archetype_label"], []).append(row)
    colors = plt.cm.tab10(np.linspace(0, 1, len(by_archetype)))
    for color, (label, rows) in zip(colors, by_archetype.items()):
        titolare = [r for r in rows if r["minutes_label"] == "titolare_90"]
        titolare.sort(key=lambda r: r["team_scaling"])
        xs = [r["team_scaling"] for r in titolare]
        ys = [r["model"]["shotProbability"] for r in titolare]
        ax.plot(xs, ys, marker="o", color=color, label=label)
    ax.set_xlabel("Team scaling in questa partita (teamLambda / teamRecentGoalsFor)")
    ax.set_ylabel("shotProbability prevista (titolare, 90')")
    ax.set_title("shotProbability per archetipo lungo l'intero range di team scaling del modello")
    ax.axhline(SHOT_CLAMP, color="#c0392b", linestyle="--", linewidth=1, label=f"Clamp a {SHOT_CLAMP:.0%}")
    ax.legend(fontsize=8, loc="lower right")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "shot_probability_by_archetype.png", dpi=150)
    plt.close(fig)


def summarize_overdispersion_cost(pure: dict, overdispersed: dict) -> list[dict]:
    rows = []
    for label, key in [("Almeno 1 tiro", "shot_p1"), ("Almeno 2 tiri", "shot_p2"), ("Almeno 1 assist", "assist_p1")]:
        m_pure = calibration_metrics(*pure[key])
        m_od = calibration_metrics(*overdispersed[key])
        rows.append({
            "market": label,
            "brier_pure": m_pure["brier_score"], "brier_overdispersed": m_od["brier_score"],
            "ece_pure": m_pure["ece"], "ece_overdispersed": m_od["ece"],
            "max_gap_pure": m_pure["max_bin_gap"], "max_gap_overdispersed": m_od["max_bin_gap"],
        })
    return rows


def write_json_results(per_scenario_pure: list[dict], overdispersion_summary: list[dict], out_dir: Path) -> None:
    def clean(row: dict) -> dict:
        return {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in row.items()}

    payload = {
        "generated_for": "estimatePlayerMarkets (model.js) — shotProbability, multiShotProbability, assistProbability",
        "n_simulations_per_scenario": None,  # riempito da main()
        "scenarios": [clean(row) for row in per_scenario_pure],
        "overdispersion_cost_summary": overdispersion_summary,
    }
    (out_dir / "results.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--n", type=int, default=60_000, help="Simulazioni Monte Carlo per scenario (default: 60000)")
    parser.add_argument("--overdispersion-k", type=float, default=4.0, help="Forma del mix Gamma-Poisson per lo scenario sovradisperso: piu' basso = piu' sovradispersione (default: 4.0)")
    parser.add_argument("--seed", type=int, default=20260820, help="Seed RNG per riproducibilita'")
    parser.add_argument("--out", type=Path, default=OUTPUT_DIR, help="Cartella di output per grafici e risultati")
    parser.add_argument("--no-plots", action="store_true", help="Salta la generazione dei grafici (solo numeri)")
    args = parser.parse_args()

    rng = np.random.default_rng(args.seed)

    print(f"[1/5] Costruzione scenari: {len(ARCHETYPES)} archetipi x {len(TEAM_SCALING_SCENARIOS)} team scaling x {len(MINUTES_SCENARIOS)} scenari minuti...")
    scenarios = build_scenarios()
    print(f"      -> {len(scenarios)} scenari totali")

    print("[2/5] Interrogazione del VERO estimatePlayerMarkets via player_markets_bridge.mjs...")
    attach_model_predictions(scenarios)
    n_clamped_shot = sum(1 for s in scenarios if s["shot_clamped"])
    n_clamped_assist = sum(1 for s in scenarios if s["assist_clamped"])
    print(f"      -> shotProbability al clamp ({SHOT_CLAMP:.0%}) in {n_clamped_shot}/{len(scenarios)} scenari")
    print(f"      -> assistProbability al clamp ({ASSIST_CLAMP:.0%}) in {n_clamped_assist}/{len(scenarios)} scenari")

    print(f"[3/5] Simulazione Monte Carlo, Poisson puro, n={args.n} per scenario...")
    pure = run_monte_carlo(scenarios, args.n, overdispersion_k=None, rng=rng)

    print(f"[4/5] Simulazione Monte Carlo, sovradispersa (Gamma-Poisson, k={args.overdispersion_k}), n={args.n} per scenario...")
    overdispersed = run_monte_carlo(scenarios, args.n, overdispersion_k=args.overdispersion_k, rng=rng)

    args.out.mkdir(parents=True, exist_ok=True)

    if not args.no_plots:
        print("[5/5] Generazione grafici...")
        make_plots(pure, overdispersed, pure["per_scenario"], args.out)
    else:
        print("[5/5] Grafici saltati (--no-plots)")

    overdispersion_summary = summarize_overdispersion_cost(pure, overdispersed)
    write_json_results(pure["per_scenario"], overdispersion_summary, args.out)

    print("\n=== RISULTATI: calibrazione Poisson puro (assunzione implicita del modello) ===")
    for label, key in [("Almeno 1 tiro (shotProbability)", "shot_p1"), ("Almeno 2 tiri (multiShotProbability)", "shot_p2"), ("Almeno 1 assist (assistProbability)", "assist_p1")]:
        m = calibration_metrics(*pure[key])
        print(f"  {label:38s}  Brier={m['brier_score']:.6f}  ECE={m['ece']:.6f}  gap-max-bin={m['max_bin_gap']:.6f}  (n={m['n']:,})")

    print("\n=== RISULTATI: costo della sovradispersione realistica (Gamma-Poisson, k={:.1f}) ===".format(args.overdispersion_k))
    for row in overdispersion_summary:
        print(f"  {row['market']:20s}  ECE: {row['ece_pure']:.4f} -> {row['ece_overdispersed']:.4f}   Brier: {row['brier_pure']:.4f} -> {row['brier_overdispersed']:.4f}")

    max_theory_error_shot = max((abs(r["error_shot_p1_vs_theory"]) for r in pure["per_scenario"] if not math.isnan(r["error_shot_p1_vs_theory"])), default=0.0)
    max_theory_error_assist = max((abs(r["error_assist_vs_theory"]) for r in pure["per_scenario"] if not math.isnan(r["error_assist_vs_theory"])), default=0.0)
    print(f"\nScarto massimo predizione-vs-teoria (scenari non troncati dal clamp): tiri={max_theory_error_shot:.2e}  assist={max_theory_error_assist:.2e}")
    print(f"(atteso: ~0, a meno di arrotondamento in virgola mobile — un valore non trascurabile indicherebbe un bug in poissonPmf/estimatePlayerMarkets)")

    print(f"\nOutput salvato in: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
