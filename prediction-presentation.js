const OUTCOME_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "1", probabilityKey: "homeWin" }),
  Object.freeze({ key: "X", probabilityKey: "draw" }),
  Object.freeze({ key: "2", probabilityKey: "awayWin" }),
]);

const finiteProbability = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

function scoreMatchesOutcome(score, outcomeKey) {
  if (outcomeKey === "1") return score.home > score.away;
  if (outcomeKey === "X") return score.home === score.away;
  if (outcomeKey === "2") return score.home < score.away;
  return false;
}

export function formatProbability(value) {
  return `${(100 * finiteProbability(value)).toFixed(1)}%`;
}

export function outcomeProbabilityEntries(probabilities = {}) {
  return OUTCOME_DEFINITIONS.map(({ key, probabilityKey }) => ({
    key,
    probability: finiteProbability(probabilities[probabilityKey]),
  }));
}

export function normalizePercentageWidths(values = []) {
  const safeValues = values.map(finiteProbability);
  const total = safeValues.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return safeValues.map(() => 100 / Math.max(safeValues.length, 1));
  return safeValues.map((value) => (value / total) * 100);
}

export function selectRepresentativeScore(result = {}) {
  const scores = Array.isArray(result.probabilities?.scores) ? result.probabilities.scores : [];
  const outcomeKey = result.mostLikelyOutcome?.key;
  const selected = scores.find((score) => scoreMatchesOutcome(score, outcomeKey)) || scores[0];
  if (!selected) return { home: 0, away: 0, probability: 0, conditionalProbability: 0, outcomeKey: null };

  const outcomeProbability = outcomeProbabilityEntries(result.probabilities)
    .find((entry) => entry.key === outcomeKey)?.probability || selected.probability;

  return {
    ...selected,
    outcomeKey: outcomeKey || null,
    conditionalProbability: outcomeProbability > 0 ? selected.probability / outcomeProbability : 0,
    selectionMethod: "conditional-map",
  };
}
