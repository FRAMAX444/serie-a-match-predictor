"""lineup_strength deve poter punire, non solo premiare.

Difetto misurato sul dataset del 25/08/2026, prima della correzione (303 squadre in
team_context, 95 coperte da player_context):

    min 1.0000 · p25 1.0000 · mediana 1.0000 · p75 1.0080 · max 1.0175
    ZERO squadre sotto 1.0 · 95 sopra · 208 esattamente a 1.0

Le 95 sopra 1 erano esattamente le 95 coperte da player_context. Due cause indipendenti,
entrambe strutturali e nessuna delle due segnalata da un errore:

  · `average_rating` valeva SEMPRE 6.5, perché ESPN espone `rating: null` per ogni giocatore
    (verificato: 0 su 31 in un campione), quindi il primo addendo della formula era
    identicamente zero;
  · `start_share` era quasi sempre >= 0.5 perché probable_lineup() seleziona proprio gli
    undici con più presenze: il termine si confrontava con una soglia che la sua stessa
    costruzione garantiva di superare.

Un fattore che può solo premiare, e che premia solo le squadre che la pipeline è riuscita a
coprire, non misura un effetto calcistico: misura la copertura della pipeline, e la
trasferisce nei lambda come se fosse forza.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "data" / "matches.json"

sys.path.insert(0, str(ROOT / "scripts"))
from enrich_competitions_players import (  # noqa: E402
    center_lineup_strength_factors,
    compute_lineup_strength,
    rounded_player,
  )


def values_from(section: dict) -> list[float]:
    return [
        float(entry["lineup_strength"])
        for entry in section.values()
        if isinstance(entry, dict) and entry.get("lineup_strength") is not None
    ]


class LineupStrengthContractTests(unittest.TestCase):
    def setUp(self) -> None:
        if not DATASET.exists():
            self.skipTest("data/matches.json assente")
        self.payload = json.loads(DATASET.read_text(encoding="utf8"))

    def test_factor_is_not_one_sided(self) -> None:
        """Il contratto centrale: o il fattore non dice niente (tutti esattamente 1), o dice
        qualcosa in entrambe le direzioni. Quello che NON può fare è premiare e basta."""
        for name in ("team_context", "player_context"):
            values = values_from(self.payload.get(name) or {})
            if not values:
                continue
            below = [value for value in values if value < 1]
            above = [value for value in values if value > 1]
            if not above and not below:
                continue  # nessuna informazione disponibile: legittimo
            self.assertTrue(
                below,
                f"{name}: {len(above)} squadre sopra 1 e NESSUNA sotto. Un fattore di "
                f"formazione che può solo premiare trasferisce nei lambda la copertura della "
                f"pipeline invece della forza della squadra (min osservato "
                f"{min(values):.4f}, max {max(values):.4f}).",
            )

    def test_median_is_centred_on_one(self) -> None:
        for name in ("team_context", "player_context"):
            values = sorted(values_from(self.payload.get(name) or {}))
            if not values:
                continue
            median = values[len(values) // 2]
            self.assertAlmostEqual(
                median, 1.0, delta=0.01,
                msg=f"{name}: mediana {median:.4f}. Il fattore è un rapporto fra l'undici "
                    f"probabile e quello tipo della STESSA squadra: senza notizie di "
                    f"indisponibilità i due coincidono e il rapporto vale 1.",
            )

    def test_values_stay_inside_the_clamp_the_model_expects(self) -> None:
        # attackContext() in model.js clampa lineup_strength a [0.8, 1.15]. Un valore fuori
        # da lì verrebbe silenziosamente tagliato, e la sorgente e il modello direbbero due
        # cose diverse senza che nulla lo segnali.
        for name in ("team_context", "player_context"):
            for team, entry in (self.payload.get(name) or {}).items():
                if not isinstance(entry, dict) or entry.get("lineup_strength") is None:
                    continue
                value = float(entry["lineup_strength"])
                self.assertGreaterEqual(value, 0.8, f"{name}/{team}")
                self.assertLessEqual(value, 1.15, f"{name}/{team}")

    def test_covered_teams_are_not_systematically_favoured(self) -> None:
        """Il bias che il difetto produceva: le squadre coperte da player_context avevano un
        moltiplicatore >= 1 e le altre esattamente 1, quindi essere coperte valeva forza."""
        teams = self.payload.get("team_context") or {}
        covered = set(self.payload.get("player_context") or {})
        values = [
            float(entry["lineup_strength"])
            for team, entry in teams.items()
            if team in covered and isinstance(entry, dict) and entry.get("lineup_strength") is not None
        ]
        if not values:
            self.skipTest("nessuna squadra coperta")
        mean = sum(values) / len(values)
        self.assertAlmostEqual(
            mean, 1.0, delta=0.01,
            msg=f"Le {len(values)} squadre coperte da player_context hanno moltiplicatore "
                f"medio {mean:.4f}: essere coperte dalla pipeline non deve valere forza.",
        )


if __name__ == "__main__":
    unittest.main()


class LineupStrengthUnitTests(unittest.TestCase):
    """La funzione non deve dipendere dalla FORMA dei dizionari che riceve.

    Il difetto del 28/08/2026: build_player_context() chiama
    compute_lineup_strength(lineup, players, reliability) dove `lineup` è passato per
    rounded_player() — che aggiunge il campo `impact` — e `players` no. impact_of() aveva un
    ripiego sui minuti, motivato in un commento con "il rapporto li normalizza": non li
    normalizza, perché i due lati del rapporto arrivano da percorsi diversi. Il numeratore
    sommava impact (~10-20 a giocatore), il denominatore minuti (~180-270). Rapporto ~0.06 per
    OGNI squadra, schiacciato sul minimo del clamp: lineup_strength = 0.92 su tutte e 100 le
    squadre coperte, cioè una costante presentata come misura.

    I contratti sulla distribuzione l'hanno intercettato, ma solo dopo che il dato sbagliato
    era già nel dataset. Questo lo intercetta nella funzione.
    """

    @staticmethod
    def _player(minutes: int, goals: int = 0) -> dict:
        return {
            "id": "1", "name": "X", "position": "MID", "appearances": 3, "starts": 3,
            "minutes": minutes, "goals": goals, "assists": 0, "shots": 4,
            "shots_on_target": 2, "yellow_cards": 0, "red_cards": 0,
            "squad_appearances": 3, "last_seen": "2026-08-20",
        }

    def test_result_is_the_same_whether_inputs_are_rounded_or_not(self) -> None:
        raw_lineup = [self._player(270, goals=index % 2) for index in range(11)]
        raw_squad = [self._player(240, goals=index % 3) for index in range(18)]
        rounded_lineup = [rounded_player(dict(player), 3) for player in raw_lineup]
        rounded_squad = [rounded_player(dict(player), 3) for player in raw_squad]

        combinations = {
            "grezzo/grezzo": compute_lineup_strength(raw_lineup, raw_squad, 1.0),
            "arrotondato/arrotondato": compute_lineup_strength(rounded_lineup, rounded_squad, 1.0),
            "arrotondato/grezzo": compute_lineup_strength(rounded_lineup, raw_squad, 1.0),
            "grezzo/arrotondato": compute_lineup_strength(raw_lineup, rounded_squad, 1.0),
        }
        spread = max(combinations.values()) - min(combinations.values())
        # La tolleranza copre l'arrotondamento a 3 decimali che rounded_player applica a
        # `impact`, e nient'altro: il difetto che questo test intercetta valeva 0.08, cioe'
        # ottanta volte la soglia. Il valore memorizzato ha 4 decimali, quindi 1e-3 e' anche
        # il limite oltre il quale la differenza diventerebbe visibile nel dataset.
        self.assertLess(
            spread, 1e-3,
            "compute_lineup_strength deve dare lo stesso risultato comunque siano formati i "
            f"dizionari: {combinations}. Se differiscono, i due lati del rapporto stanno "
            "misurando grandezze diverse.",
        )

    def test_centering_removes_coverage_bias_without_flattening(self) -> None:
        context = {
            "A": {"lineup_strength": 0.94},
            "B": {"lineup_strength": 0.98},
            "C": {"lineup_strength": 1.01},
            "D": {"lineup_strength": 1.04},
        }
        before = [float(item["lineup_strength"]) for item in context.values()]
        center_lineup_strength_factors(context)
        after = [float(item["lineup_strength"]) for item in context.values()]

        self.assertAlmostEqual(sum(after) / len(after), 1.0, delta=0.0002)
        self.assertGreater(max(after) - min(after), 0.05, "il centraggio non deve appiattire il segnale")
        self.assertGreaterEqual(min(after), 0.92)
        self.assertLessEqual(max(after), 1.07)
        self.assertAlmostEqual(max(after) - min(after), max(before) - min(before), delta=0.002)

    def test_a_weaker_probable_lineup_lowers_the_factor(self) -> None:
        # Guardia di direzione: senza questa, la funzione potrebbe restituire una costante e
        # passare comunque il test di omogeneità sopra.
        squad = [self._player(270, goals=2) for _ in range(11)] + [self._player(30) for _ in range(7)]
        strong = [self._player(270, goals=2) for _ in range(11)]
        weak = [self._player(30) for _ in range(11)]
        self.assertGreater(
            compute_lineup_strength(strong, squad, 1.0),
            compute_lineup_strength(weak, squad, 1.0),
            "un undici probabile piu' debole del riferimento deve abbassare il fattore",
        )
