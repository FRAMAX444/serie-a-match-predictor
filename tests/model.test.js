import assert from "node:assert/strict";
import { matrixProbabilities, predictFromMatches, scoreMatrix } from "../model.js";
import fs from "node:fs";

const probabilities = matrixProbabilities(scoreMatrix(1.55, 1.10));
assert.ok(Math.abs(probabilities.homeWin + probabilities.draw + probabilities.awayWin - 1) < 1e-10);
assert.ok(probabilities.scores[0].probability > 0);

const payload = JSON.parse(fs.readFileSync(new URL("../data/matches.json", import.meta.url)));
if (payload.columns && payload.matches.length && Array.isArray(payload.matches[0])) {
  payload.matches = payload.matches.map((row) => Object.fromEntries(payload.columns.map((column, index) => [column, row[index]])));
}
const dateAfterDataset = new Date(new Date(payload.matches.at(-1).date).getTime() + 30 * 86400000).toISOString().slice(0, 10);
const homeTeam = payload.teams.includes("Roma") ? "Roma" : payload.teams[0];
const awayTeam = payload.teams.find((team) => team !== homeTeam);
const prediction = predictFromMatches(payload.matches, {
  homeTeam, awayTeam, date: dateAfterDataset, windowDays: 540, halfLifeDays: 120,
  homeAttackAbsence: 0, homeDefenseAbsence: 0, awayAttackAbsence: 0, awayDefenseAbsence: 0,
  homeLineup: 1, awayLineup: 1,
});
assert.ok(prediction.lambdaHome > 0 && prediction.lambdaAway > 0);
assert.ok(Math.abs(prediction.probabilities.homeWin + prediction.probabilities.draw + prediction.probabilities.awayWin - 1) < 1e-9);
console.log(`OK: ${homeTeam}-${awayTeam} ${prediction.lambdaHome.toFixed(2)}-${prediction.lambdaAway.toFixed(2)}`);
