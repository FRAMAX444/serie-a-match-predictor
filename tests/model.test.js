import assert from "node:assert/strict";
import { matrixProbabilities, predictFromMatches, predictMatchdayFromMatches, scoreMatrix } from "../model.js";
import { buildCompetitionCatalog, buildMatchdays } from "../matchdays.js";

const probabilities = matrixProbabilities(scoreMatrix(1.55, 1.10));
assert.ok(Math.abs(probabilities.homeWin + probabilities.draw + probabilities.awayWin - 1) < 1e-10);
assert.ok(probabilities.scores.some((score) => score.home === 0 && score.away === 0));

const leagueDefinitions = [
  ["eng.1", "ENG"], ["esp.1", "ESP"], ["ita.1", "ITA"], ["ger.1", "GER"], ["fra.1", "FRA"],
];

function isoDate(dayOffset) {
  return new Date(Date.UTC(2024, 6, 1 + dayOffset)).toISOString().slice(0, 10);
}

function makeLeagueMatches(competitionId, prefix, offset, rounds = 22) {
  const teams = Array.from({ length: 10 }, (_, index) => `${prefix}-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const homeTeam = (round + index) % 2 === 0 ? first : second;
      const awayTeam = homeTeam === first ? second : first;
      const seed = (round * 7 + index * 5 + offset) % 13;
      matches.push({
        date: isoDate(offset + round * 7),
        season: "2425",
        competition_id: competitionId,
        competition_type: "domestic",
        home_team: homeTeam,
        away_team: awayTeam,
        home_goals: seed % 4,
        away_goals: (seed * 2 + 1) % 3,
        home_shots: 9 + seed % 9,
        away_shots: 8 + (seed + 4) % 8,
        home_sot: 2 + seed % 6,
        away_sot: 2 + (seed + 2) % 5,
        home_xg: 0.55 + seed % 6 * 0.28,
        away_xg: 0.45 + (seed + 2) % 5 * 0.25,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const matches = leagueDefinitions
  .flatMap(([id, prefix], index) => makeLeagueMatches(id, prefix, index * 3))
  .sort((left, right) => left.date.localeCompare(right.date));
const predictionDate = isoDate(230);

const prediction = predictFromMatches(matches, {
  homeTeam: "ITA-1",
  awayTeam: "ITA-2",
  date: predictionDate,
  competitionId: "ita.1",
  windowDays: 730,
  halfLifeDays: 120,
});
assert.ok(prediction.lambdaHome > 0 && prediction.lambdaAway > 0);
assert.equal(prediction.competitionId, "ita.1");
assert.equal(prediction.modelVersion, "4.0-top5-core");
assert.equal(prediction.baselineSource, "competition");
assert.ok(prediction.baselineMatches >= 60);
assert.ok(Math.abs(prediction.probabilities.homeWin + prediction.probabilities.draw + prediction.probabilities.awayWin - 1) < 1e-9);
assert.throws(() => predictFromMatches(matches, {
  homeTeam: "ITA-1", awayTeam: "ITA-2", date: predictionDate, competitionId: "ucl",
}), /non supportata/i);

const serieAFixtures = [
  { id: "ita-1", competition_id: "ita.1", competition_name: "Serie A", season: "2627", round: 1, date: predictionDate, home_team: "ITA-1", away_team: "ITA-2", completed: false },
  { id: "ita-2", competition_id: "ita.1", competition_name: "Serie A", season: "2627", round: 1, date: isoDate(231), home_team: "ITA-3", away_team: "ITA-4", completed: false },
];
const payload = {
  target_season: "2627",
  default_competition: "ita.1",
  competitions: [
    { id: "ucl", name: "UEFA Champions League", fixtures: [{ id: "u1", round: 1, date: predictionDate, home_team: "ITA-1", away_team: "ENG-1" }] },
    { id: "ita.1", name: "Serie A", season: "2627", default_round: 1, fixtures: serieAFixtures },
  ],
};
const catalog = buildCompetitionCatalog(payload);
assert.deepEqual(catalog.map((competition) => competition.id), ["ita.1"]);
const calendar = buildMatchdays(payload, "ita.1");
assert.equal(calendar.matchdays.length, 1);
assert.equal(calendar.matchdays[0].fixtures.length, 2);

const batch = predictMatchdayFromMatches(matches, serieAFixtures, {
  competitionId: "ita.1", windowDays: 730, halfLifeDays: 120,
});
assert.equal(batch.predictions.length, 2);
assert.ok(batch.predictions.every(({ result }) => result.cutoffDate === batch.cutoffDate));
assert.ok(batch.predictions.every(({ result }) => result.competitionId === "ita.1"));

console.log(`OK: modello Top Five · ${catalog.length} campionato selezionabile · ${matches.length} gare training`);
