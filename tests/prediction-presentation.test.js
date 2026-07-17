import assert from "node:assert/strict";
import {
  formatProbability,
  normalizePercentageWidths,
  outcomeProbabilityEntries,
  selectRepresentativeScore,
} from "../prediction-presentation.js";

const probabilities = {
  homeWin: 0.2814,
  draw: 0.3017,
  awayWin: 0.4169,
  scores: [
    { home: 1, away: 1, probability: 0.121 },
    { home: 0, away: 1, probability: 0.116 },
    { home: 1, away: 2, probability: 0.109 },
    { home: 0, away: 0, probability: 0.083 },
    { home: 1, away: 0, probability: 0.079 },
  ],
};

const awayResult = {
  probabilities,
  mostLikelyOutcome: { key: "2", name: "Ospite", probability: probabilities.awayWin },
};
const awayScore = selectRepresentativeScore(awayResult);
assert.deepEqual(
  { home: awayScore.home, away: awayScore.away },
  { home: 0, away: 1 },
  "il punteggio mostrato deve essere il MAP condizionale all'esito 2",
);
assert.ok(awayScore.away > awayScore.home);
assert.equal(awayScore.selectionMethod, "conditional-map");
assert.ok(Math.abs(awayScore.conditionalProbability - awayScore.probability / probabilities.awayWin) < 1e-12);

const drawResult = {
  probabilities,
  mostLikelyOutcome: { key: "X", name: "Pareggio", probability: probabilities.draw },
};
const drawScore = selectRepresentativeScore(drawResult);
assert.deepEqual({ home: drawScore.home, away: drawScore.away }, { home: 1, away: 1 });

const entries = outcomeProbabilityEntries(probabilities);
assert.deepEqual(entries.map((entry) => entry.key), ["1", "X", "2"]);
assert.deepEqual(entries.map((entry) => formatProbability(entry.probability)), ["28.1%", "30.2%", "41.7%"]);

const displayedPercentages = entries.map((entry) => Number((100 * entry.probability).toFixed(1)));
const widths = normalizePercentageWidths(displayedPercentages);
assert.ok(Math.abs(widths.reduce((sum, value) => sum + value, 0) - 100) < 1e-10);
assert.deepEqual(
  displayedPercentages,
  [28.1, 30.2, 41.7],
  "la normalizzazione grafica non deve cambiare i numeri mostrati",
);

console.log("OK: 1X2 condiviso e punteggio MAP condizionale coerente");
