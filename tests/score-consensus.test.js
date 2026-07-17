import assert from "node:assert/strict";
import { calibrateScoreMatrix, matrixProbabilities, scoreMatrix } from "../model.js";

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

const awayConsensus = calibrateScoreMatrix(scoreMatrix(1.00, 1.99), strongAwayContext);
const awayProbabilities = matrixProbabilities(awayConsensus.matrix);
assert.ok(awayProbabilities.awayWin > awayProbabilities.draw);
assert.ok(awayProbabilities.scores[0].away > awayProbabilities.scores[0].home);
assert.notEqual(awayProbabilities.scores[0].home, awayProbabilities.scores[0].away);

const balancedContext = {
  lambdaHome: 1.18,
  lambdaAway: 1.16,
  home: {
    elo: 1502,
    ppg3: 1.4,
    ppg5: 1.42,
    xgFor5: 1.28,
    xgAgainst5: 1.25,
    sot5: 3.8,
    venueGf5: 1.3,
    venueGa5: 1.25,
    restDays: 7,
    sampleReliability: 1,
  },
  away: {
    elo: 1498,
    ppg3: 1.38,
    ppg5: 1.4,
    xgFor5: 1.27,
    xgAgainst5: 1.26,
    sot5: 3.75,
    venueGf5: 1.29,
    venueGa5: 1.26,
    restDays: 7,
    sampleReliability: 1,
  },
};

const balancedConsensus = calibrateScoreMatrix(scoreMatrix(1.18, 1.16), balancedContext);
const balancedProbabilities = matrixProbabilities(balancedConsensus.matrix);
assert.equal(balancedProbabilities.scores[0].home, balancedProbabilities.scores[0].away);
assert.ok(balancedConsensus.checks.balance > 0.9);

const total = awayConsensus.matrix.flat().reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(total - 1) < 1e-12);

console.log("OK: calibrazione consensus del risultato esatto");
