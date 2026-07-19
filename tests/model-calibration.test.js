import assert from "node:assert/strict";
import { predictFromMatches } from "../model.js";

const start = Date.UTC(2024, 0, 1);
const isoDate = (offset) => new Date(start + offset * 86400000).toISOString().slice(0, 10);

function balancedLeague(rounds = 36) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      matches.push({
        date: isoDate(round * 7),
        season: "2425",
        competition_id: "ita.1",
        competition_type: "domestic",
        home_team: home,
        away_team: away,
        home_goals: 2,
        away_goals: 1,
        home_xg: 1.72,
        away_xg: 1.02,
        home_shots: 14,
        away_shots: 9,
        home_sot: 5,
        away_sot: 3,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const balanced = balancedLeague();
const balancedFixtures = [
  ["Team-1", "Team-2"],
  ["Team-3", "Team-4"],
  ["Team-5", "Team-6"],
  ["Team-7", "Team-8"],
  ["Team-9", "Team-10"],
];
const balancedPredictions = balancedFixtures.map(([homeTeam, awayTeam]) => predictFromMatches(balanced, {
  homeTeam,
  awayTeam,
  date: isoDate(260),
  competitionId: "ita.1",
  windowDays: 730,
  halfLifeDays: 120,
}));
const balancedPrediction = balancedPredictions[0];
const meanHomeLambda = balancedPredictions.reduce((total, item) => total + item.lambdaHome, 0) / balancedPredictions.length;
const meanAwayLambda = balancedPredictions.reduce((total, item) => total + item.lambdaAway, 0) / balancedPredictions.length;

// Across a balanced round, equal-strength teams must preserve the competition's
// venue baseline. The previous venue-mismatched normalization flattened this signal.
assert.ok(Math.abs(meanHomeLambda - balancedPrediction.league.homeGoals) < 0.25);
assert.ok(Math.abs(meanAwayLambda - balancedPrediction.league.awayGoals) < 0.25);
assert.ok(meanHomeLambda > meanAwayLambda);
assert.equal(balancedPrediction.calibration.neutralGeneralBaseline, true);
assert.equal(balancedPrediction.calibration.xgEloBlend, 0.45);
assert.equal(balancedPrediction.modelVersion, "5.0-calibrated-recency-xg-elo");

function xgEloDataset(dominantXg) {
  const matches = balancedLeague(22);
  for (let index = 0; index < 18; index += 1) {
    const alphaHome = index % 2 === 0;
    matches.push({
      date: isoDate(155 + index),
      season: "2425",
      competition_id: "ita.1",
      competition_type: "domestic",
      home_team: alphaHome ? "Alpha" : "Beta",
      away_team: alphaHome ? "Beta" : "Alpha",
      home_goals: 1,
      away_goals: 1,
      home_xg: dominantXg ? (alphaHome ? 2.35 : 0.65) : 1.35,
      away_xg: dominantXg ? (alphaHome ? 0.65 : 2.35) : 1.35,
      home_shots: dominantXg ? (alphaHome ? 18 : 7) : 12,
      away_shots: dominantXg ? (alphaHome ? 7 : 18) : 12,
      home_sot: dominantXg ? (alphaHome ? 7 : 2) : 4,
      away_sot: dominantXg ? (alphaHome ? 2 : 7) : 4,
    });
  }
  return matches.sort((left, right) => left.date.localeCompare(right.date));
}

const dominant = predictFromMatches(xgEloDataset(true), {
  homeTeam: "Alpha",
  awayTeam: "Beta",
  date: isoDate(180),
  competitionId: "ita.1",
  windowDays: 730,
});
const neutral = predictFromMatches(xgEloDataset(false), {
  homeTeam: "Alpha",
  awayTeam: "Beta",
  date: isoDate(180),
  competitionId: "ita.1",
  windowDays: 730,
});

// Identical scorelines but consistently superior xG should improve Elo instead
// of being discarded as noise.
assert.ok(dominant.home.elo > neutral.home.elo + 4);
assert.ok(dominant.away.elo < neutral.away.elo - 4);

console.log("OK: calibrazione venue-neutral, recenza temporale ed Elo xG-aware");
