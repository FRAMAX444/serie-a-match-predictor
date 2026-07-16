import assert from "node:assert/strict";
import { matrixProbabilities, predictFromMatches, predictMatchdayFromMatches, scoreMatrix } from "../model.js";
import { buildCompetitionCatalog, buildMatchdays } from "../matchdays.js";

const probabilities = matrixProbabilities(scoreMatrix(1.55, 1.10));
assert.ok(Math.abs(probabilities.homeWin + probabilities.draw + probabilities.awayWin - 1) < 1e-10);
assert.ok(probabilities.scores.some((score) => score.home === 0 && score.away === 0));

const teams = [
  "Roma", "Inter", "Milan", "Juventus", "Napoli", "Atalanta", "Real Madrid", "Barcelona", "Arsenal", "Liverpool",
  "Man City", "Bayern Monaco", "Dortmund", "PSG", "Marsiglia", "Benfica", "Porto", "Ajax", "PSV", "Sporting Lisbona",
];

function isoDate(dayOffset) {
  return new Date(Date.UTC(2024, 6, 1 + dayOffset)).toISOString().slice(0, 10);
}

function makeDomesticMatches(rounds = 18) {
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const homeTeam = (round + index) % 2 === 0 ? first : second;
      const awayTeam = homeTeam === first ? second : first;
      const seed = (round * 9 + index * 5) % 13;
      matches.push({
        date: isoDate(round * 7), season: "2425", competition_id: `domestic-${index % 5}`,
        competition_type: "domestic", importance: 1,
        home_team: homeTeam, away_team: awayTeam,
        home_goals: seed % 4, away_goals: (seed * 2 + 1) % 3,
        home_shots: 9 + seed % 9, away_shots: 8 + (seed + 4) % 8,
        home_sot: 2 + seed % 6, away_sot: 2 + (seed + 2) % 5,
        home_xg: .55 + seed % 6 * .28, away_xg: .45 + (seed + 2) % 5 * .25,
        home_possession: 46 + seed % 9, away_possession: 54 - seed % 9,
        league_strength: 1480 + index % 5 * 20,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

function makeEuropeanMatches(startOffset = 3, rounds = 10) {
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < 9; index += 1) {
      const home = teams[(round + index * 2) % teams.length];
      const away = teams[(round + index * 2 + 7) % teams.length];
      const seed = (round * 4 + index * 7) % 11;
      matches.push({
        date: isoDate(startOffset + round * 21), season: "2425", competition_id: "ucl",
        competition_type: "europe", importance: 1.18, league_strength: 1500,
        home_team: home, away_team: away,
        home_goals: seed % 3, away_goals: (seed + 2) % 3,
        home_xg: .65 + seed % 5 * .3, away_xg: .55 + (seed + 1) % 5 * .27,
        home_shots: 10 + seed, away_shots: 8 + seed % 7,
        home_sot: 3 + seed % 5, away_sot: 2 + seed % 5,
      });
    }
  }
  return matches;
}

const matches = [...makeDomesticMatches(), ...makeEuropeanMatches()].sort((a, b) => a.date.localeCompare(b.date));
const predictionDate = isoDate(18 * 7 + 120);
const teamContext = {
  Roma: { as_of: isoDate(100), reliability: .9, elo: 1640, squad_attack: 1.08, squad_creativity: 1.05 },
  "Real Madrid": { as_of: isoDate(100), reliability: .95, elo: 1690, squad_attack: 1.12, squad_creativity: 1.1 },
};
const prediction = predictFromMatches(matches, {
  homeTeam: "Roma", awayTeam: "Real Madrid", date: predictionDate,
  competitionId: "ucl", windowDays: 730, halfLifeDays: 120, teamContext,
});
assert.ok(prediction.lambdaHome > 0 && prediction.lambdaAway > 0);
assert.equal(prediction.competitionId, "ucl");
assert.equal(prediction.modelVersion, "3.0-europe-context");
assert.equal(prediction.baselineSource, "competition");
assert.ok(prediction.baselineMatches >= 55);
assert.ok(Math.abs(prediction.probabilities.homeWin + prediction.probabilities.draw + prediction.probabilities.awayWin - 1) < 1e-9);

const uclFixtures = [
  { id: "ucl-1", competition_id: "ucl", competition_name: "UEFA Champions League", season: "2627", round: 1, round_label: "League phase 1", date: predictionDate, home_team: "Roma", away_team: "Real Madrid", completed: false },
  { id: "ucl-2", competition_id: "ucl", competition_name: "UEFA Champions League", season: "2627", round: 1, round_label: "League phase 1", date: isoDate(18 * 7 + 121), home_team: "Inter", away_team: "Arsenal", completed: false },
];
const uelFixtures = [
  { id: "uel-1", competition_id: "uel", competition_name: "UEFA Europa League", season: "2627", round: 1, round_label: "League phase 1", date: isoDate(18 * 7 + 128), home_team: "Milan", away_team: "Porto", completed: false },
];
const payload = {
  target_season: "2627", default_competition: "ucl", teams,
  competitions: [
    { id: "ucl", name: "UEFA Champions League", season: "2627", default_round: 1, fixtures: uclFixtures },
    { id: "uel", name: "UEFA Europa League", season: "2627", default_round: 1, fixtures: uelFixtures },
  ],
};
const catalog = buildCompetitionCatalog(payload);
assert.equal(catalog.length, 2);
assert.equal(catalog[0].id, "ucl");
const uclCalendar = buildMatchdays(payload, "ucl");
const uelCalendar = buildMatchdays(payload, "uel");
assert.equal(uclCalendar.matchdays.length, 1);
assert.equal(uclCalendar.matchdays[0].fixtures.length, 2);
assert.equal(uclCalendar.matchdays[0].label, "League phase 1");
assert.equal(uelCalendar.competition.id, "uel");
assert.deepEqual(uelCalendar.teams.sort(), ["Milan", "Porto"]);

const batch = predictMatchdayFromMatches(matches, uclFixtures, {
  competitionId: "ucl", windowDays: 730, halfLifeDays: 120, teamContext,
});
assert.equal(batch.predictions.length, 2);
assert.ok(batch.predictions.every(({ result }) => result.cutoffDate === batch.cutoffDate));
assert.ok(batch.predictions.every(({ result }) => result.competitionId === "ucl"));

console.log(`OK: Europa multi-competizione · ${catalog.length} coppe · ${matches.length} gare training`);
