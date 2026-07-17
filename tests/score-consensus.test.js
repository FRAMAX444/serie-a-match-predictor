import assert from "node:assert/strict";
import { matrixProbabilities, scoreConsensusChecks, scoreMatrix } from "../model.js";
import { selectRepresentativeScore } from "../prediction-presentation.js";

const strongAwayContext = {
  lambdaHome: 1.00,
  lambdaAway: 1.99,
  home: {
    elo: 1470,
    ppg3: 0.8,
    ppg5: 1.0,
    xgFor5: 1.0,
    xgAgainst5: 1.7,
    sot5: 3.0,
    venueGf5: 1.0,
    venueGa5: 1.6,
    restDays: 5,
    sampleReliability: 1,
  },
  away: {
    elo: 1580,
    ppg3: 2.1,
    ppg5: 1.9,
    xgFor5: 1.9,
    xgAgainst5: 0.9,
    sot5: 5.2,
    venueGf5: 1.8,
    venueGa5: 0.9,
    restDays: 7,
    sampleReliability: 1,
  },
};

const awayProbabilities = matrixProbabilities(scoreMatrix(1.00, 1.99));
const awayChecks = scoreConsensusChecks(
  strongAwayContext.lambdaHome,
  strongAwayContext.lambdaAway,
  strongAwayContext.home,
  strongAwayContext.away,
);
assert.equal(awayProbabilities.scores[0].home, awayProbabilities.scores[0].away);
assert.ok(awayProbabilities.awayWin > awayProbabilities.draw);
assert.ok(awayChecks.direction < -0.5);

const awayScore = selectRepresentativeScore({
  probabilities: awayProbabilities,
  mostLikelyOutcome: { key: "2", probability: awayProbabilities.awayWin },
});
const bestAwayScore = awayProbabilities.scores.find((score) => score.away > score.home);
assert.deepEqual(
  { home: awayScore.home, away: awayScore.away, probability: awayScore.probability },
  { home: bestAwayScore.home, away: bestAwayScore.away, probability: bestAwayScore.probability },
);
assert.ok(awayScore.away > awayScore.home);

const balancedHome = {
  elo: 1500,
  ppg3: 1.4,
  ppg5: 1.4,
  xgFor5: 1.2,
  xgAgainst5: 1.2,
  sot5: 3.7,
  venueGf5: 1.2,
  venueGa5: 1.2,
  restDays: 7,
  sampleReliability: 1,
};
const balancedAway = { ...balancedHome };
const balancedProbabilities = matrixProbabilities(scoreMatrix(0.80, 0.80));
const balancedChecks = scoreConsensusChecks(0.80, 0.80, balancedHome, balancedAway);
assert.ok(balancedProbabilities.draw > balancedProbabilities.homeWin);
assert.ok(balancedProbabilities.draw > balancedProbabilities.awayWin);
assert.ok(balancedChecks.balance > 0.99);

const drawScore = selectRepresentativeScore({
  probabilities: balancedProbabilities,
  mostLikelyOutcome: { key: "X", probability: balancedProbabilities.draw },
});
assert.equal(drawScore.home, drawScore.away);

const total = scoreMatrix(1.00, 1.99).flat().reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(total - 1) < 1e-12);

console.log("OK: consensus diagnostico e punteggio MAP condizionale coerente");
