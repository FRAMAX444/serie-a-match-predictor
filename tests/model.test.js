import assert from "node:assert/strict";
import { matrixProbabilities, predictFromMatches, predictMatchdayFromMatches, scoreMatrix } from "../model.js";
import { buildMatchdays } from "../matchdays.js";

const probabilities = matrixProbabilities(scoreMatrix(1.55, 1.10));
assert.ok(Math.abs(probabilities.homeWin + probabilities.draw + probabilities.awayWin - 1) < 1e-10);
assert.ok(probabilities.scores[0].probability > 0);
assert.ok(probabilities.scores.some((score) => score.home === 0 && score.away === 0));

const teams = [
  "Roma", "Inter", "Milan", "Juventus", "Napoli", "Lazio", "Atalanta", "Fiorentina", "Bologna", "Torino",
  "Genoa", "Udinese", "Cagliari", "Verona", "Lecce", "Parma", "Como", "Pisa", "Sassuolo", "Cremonese",
];

function isoDate(dayOffset) {
  return new Date(Date.UTC(2025, 0, 1 + dayOffset)).toISOString().slice(0, 10);
}

function makeRoundRobin(rounds = 14) {
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const homeTeam = (round + index) % 2 === 0 ? first : second;
      const awayTeam = homeTeam === first ? second : first;
      const seed = (round * 7 + index * 3) % 11;
      const homeGoals = seed % 4;
      const awayGoals = (seed * 2 + 1) % 3;
      matches.push({
        date: isoDate(round * 7), season: "2526", home_team: homeTeam, away_team: awayTeam,
        home_goals: homeGoals, away_goals: awayGoals,
        home_shots: 9 + (seed % 9), away_shots: 8 + ((seed + 4) % 8),
        home_sot: 2 + (seed % 6), away_sot: 2 + ((seed + 2) % 5),
        home_corners: 3 + (seed % 6), away_corners: 2 + ((seed + 1) % 6),
        home_yellow: 1 + (seed % 4), away_yellow: 1 + ((seed + 2) % 4),
        home_red: seed === 10 ? 1 : 0, away_red: seed === 9 ? 1 : 0,
        home_xg: 0.55 + (seed % 6) * 0.28, away_xg: 0.45 + ((seed + 2) % 5) * 0.25,
        home_possession: 46 + (seed % 9), away_possession: 54 - (seed % 9),
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const matches = makeRoundRobin();
const predictionDate = isoDate(14 * 7 + 7);
const neutralPrediction = predictFromMatches(matches, {
  homeTeam: "Roma", awayTeam: "Inter", date: predictionDate, windowDays: 540, halfLifeDays: 120,
});
assert.ok(neutralPrediction.lambdaHome > 0 && neutralPrediction.lambdaAway > 0);
assert.ok(Math.abs(neutralPrediction.probabilities.homeWin + neutralPrediction.probabilities.draw + neutralPrediction.probabilities.awayWin - 1) < 1e-9);
assert.ok(["Alta", "Media", "Bassa"].includes(neutralPrediction.quality.label));

const teamContext = {
  Roma: {
    as_of: isoDate(60), reliability: 0.9, elo: 1620,
    squad_attack: 1.18, squad_creativity: 1.13, squad_continuity: 0.92,
    newcomer_impact: 0.12, departure_impact: 0.01,
    availability_attack: 1.03, availability_defense: 1.02, lineup_strength: 1.02,
    top_players: [{ name: "Attaccante Test" }], new_players: [{ name: "Nuovo Test" }],
  },
  Inter: {
    as_of: isoDate(60), reliability: 0.8, elo: 1510,
    squad_attack: 0.94, squad_creativity: 0.96, squad_continuity: 0.78,
    availability_attack: 0.96, availability_defense: 0.97, lineup_strength: 0.98,
  },
};
const contextualPrediction = predictFromMatches(matches, {
  homeTeam: "Roma", awayTeam: "Inter", date: predictionDate,
  windowDays: 540, halfLifeDays: 120, teamContext,
});
assert.equal(contextualPrediction.modelVersion, "2.0-context-elo");
assert.equal(contextualPrediction.homeContext.used, true);
assert.equal(contextualPrediction.homeContext.topPlayers[0].name, "Attaccante Test");
assert.ok(contextualPrediction.lambdaHome > neutralPrediction.lambdaHome, "Positive squad and Elo context should raise Roma's expected goals");

const futureContext = {
  Roma: { as_of: isoDate(500), reliability: 1, elo: 1900, squad_attack: 1.3 },
};
const noLeakage = predictFromMatches(matches, {
  homeTeam: "Roma", awayTeam: "Inter", date: predictionDate,
  windowDays: 540, halfLifeDays: 120, teamContext: futureContext,
});
assert.equal(noLeakage.homeContext.used, false, "Context dated after the match cutoff must not be used");

const promotedFallback = predictFromMatches(matches.filter((match) => match.home_team !== "Pisa" && match.away_team !== "Pisa"), {
  homeTeam: "Roma", awayTeam: "Pisa", date: predictionDate,
  windowDays: 540, halfLifeDays: 120,
  teamContext: { Pisa: { as_of: isoDate(60), reliability: 0.7, promotion_attack: 0.82, promotion_defense: 1.18, elo: 1410 } },
});
assert.ok(promotedFallback.lambdaAway > 0, "A promoted/new team should receive a conservative prior");
assert.equal(promotedFallback.awayContext.promotionAttack, 0.82);

const fixtures = teams.slice(0, 10).map((homeTeam, index) => ({
  id: `future-${index}`, season: "2627", round: 1,
  date: isoDate(14 * 7 + (index < 5 ? 7 : 9)),
  home_team: homeTeam, away_team: teams.at(-(index + 1)), completed: false,
}));
const batch = predictMatchdayFromMatches(matches, fixtures, { windowDays: 540, halfLifeDays: 120, teamContext });
assert.equal(batch.predictions.length, 10);
assert.ok(batch.predictions.every(({ result }) => result.cutoffDate === batch.cutoffDate));
assert.ok(batch.predictions.every(({ result }) => result.trainingMatches === batch.predictions[0].result.trainingMatches));

const calendar = buildMatchdays({
  target_season: "2627", latest_season: "2526", teams, fixtures, matches, default_round: 1,
});
assert.equal(calendar.season, "2627");
assert.equal(calendar.matchdays.length, 1);
assert.equal(calendar.matchdays[0].round, 1);
assert.equal(calendar.defaultRound, 1);
assert.equal(calendar.inferred, false);

console.log(`OK: Roma-Inter ${contextualPrediction.lambdaHome.toFixed(2)}-${contextualPrediction.lambdaAway.toFixed(2)} · ${batch.predictions.length} partite · stagione ${calendar.season}`);
