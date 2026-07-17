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
        league_strength: 1500,
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

function makeEuropeanMatches(competitionId = "ucl", rounds = 14) {
  const teams = [
    "ITA-1", "ITA-2", "ENG-1", "ENG-2", "ESP-1", "ESP-2", "GER-1", "GER-2",
    "FRA-1", "FRA-2", "ITA-3", "ENG-3", "ESP-3", "GER-3", "FRA-3", "ITA-4",
  ];
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < teams.length / 2; index += 1) {
      const homeTeam = teams[(index * 2 + round) % teams.length];
      const awayTeam = teams[(index * 2 + round + 7) % teams.length];
      const seed = (round * 5 + index * 3) % 12;
      matches.push({
        date: isoDate(2 + round * 12),
        season: "2425",
        competition_id: competitionId,
        competition_type: "europe",
        league_strength: 1510,
        importance: 1.16,
        home_team: homeTeam,
        away_team: awayTeam,
        home_goals: seed % 4,
        away_goals: (seed + 2) % 3,
        home_shots: 10 + seed % 8,
        away_shots: 9 + (seed + 3) % 7,
        home_sot: 3 + seed % 5,
        away_sot: 2 + (seed + 2) % 5,
        home_xg: 0.65 + seed % 6 * 0.25,
        away_xg: 0.52 + (seed + 1) % 5 * 0.24,
      });
    }
  }
  return matches;
}

const domesticMatches = leagueDefinitions
  .flatMap(([id, prefix], index) => makeLeagueMatches(id, prefix, index * 3))
  .sort((left, right) => left.date.localeCompare(right.date));
const europeanMatches = makeEuropeanMatches();
const matches = [...domesticMatches, ...europeanMatches].sort((left, right) => left.date.localeCompare(right.date));
const predictionDate = isoDate(230);

const domesticPrediction = predictFromMatches(domesticMatches, {
  homeTeam: "ITA-1",
  awayTeam: "ITA-2",
  date: predictionDate,
  competitionId: "ita.1",
  windowDays: 730,
  halfLifeDays: 120,
});
const domesticWithEurope = predictFromMatches(matches, {
  homeTeam: "ITA-1",
  awayTeam: "ITA-2",
  date: predictionDate,
  competitionId: "ita.1",
  windowDays: 730,
  halfLifeDays: 120,
});
assert.equal(domesticPrediction.lambdaHome, domesticWithEurope.lambdaHome);
assert.equal(domesticPrediction.lambdaAway, domesticWithEurope.lambdaAway);
assert.deepEqual(domesticPrediction.probabilities, domesticWithEurope.probabilities);
assert.equal(domesticPrediction.competitionId, "ita.1");
assert.equal(domesticPrediction.modelVersion, "4.2-consensus-score");
assert.ok(Number.isFinite(domesticPrediction.scoreChecks.direction));
assert.equal(domesticPrediction.baselineSource, "competition");
assert.ok(domesticPrediction.baselineMatches >= 60);

const europeanPrediction = predictFromMatches(matches, {
  homeTeam: "ITA-1",
  awayTeam: "ENG-1",
  date: predictionDate,
  competitionId: "ucl",
  windowDays: 730,
  halfLifeDays: 120,
});
assert.ok(europeanPrediction.lambdaHome > 0 && europeanPrediction.lambdaAway > 0);
assert.equal(europeanPrediction.competitionId, "ucl");
assert.equal(europeanPrediction.baselineSource, "competition");
assert.ok(europeanPrediction.baselineMatches >= 60);
assert.ok(Math.abs(europeanPrediction.probabilities.homeWin + europeanPrediction.probabilities.draw + europeanPrediction.probabilities.awayWin - 1) < 1e-9);
assert.throws(() => predictFromMatches(matches, {
  homeTeam: "ITA-1", awayTeam: "ITA-2", date: predictionDate, competitionId: "ned.1",
}), /non supportata/i);

const serieAFixtures = [
  { id: "ita-1", competition_id: "ita.1", competition_name: "Serie A", season: "2627", round: 1, date: predictionDate, home_team: "ITA-1", away_team: "ITA-2", completed: false },
  { id: "ita-2", competition_id: "ita.1", competition_name: "Serie A", season: "2627", round: 1, date: isoDate(231), home_team: "ITA-3", away_team: "ITA-4", completed: false },
];
const uclFixtures = [
  { id: "ucl-1", competition_id: "ucl", competition_name: "UEFA Champions League", season: "2627", round: 1, round_label: "League phase 1", date: predictionDate, home_team: "ITA-1", away_team: "ENG-1", completed: false },
  { id: "ucl-2", competition_id: "ucl", competition_name: "UEFA Champions League", season: "2627", round: 1, round_label: "League phase 1", date: isoDate(231), home_team: "ESP-1", away_team: "GER-1", completed: false },
];
const payload = {
  target_season: "2627",
  default_competition: "ita.1",
  competitions: [
    { id: "ucl", name: "UEFA Champions League", type: "europe", logo: "https://example.test/ucl.png", default_round: 1, fixtures: uclFixtures },
    { id: "uel", name: "UEFA Europa League", type: "europe", fixtures: [{ ...uclFixtures[0], id: "uel-1", competition_id: "uel" }] },
    { id: "ita.1", name: "Serie A", season: "2627", default_round: 1, fixtures: serieAFixtures },
  ],
};
const catalog = buildCompetitionCatalog(payload);
assert.deepEqual(catalog.map((competition) => competition.id), ["ucl", "uel", "ita.1"]);
assert.equal(catalog[0].logo, "https://example.test/ucl.png");
const calendar = buildMatchdays(payload, "ucl");
assert.equal(calendar.matchdays.length, 1);
assert.equal(calendar.matchdays[0].fixtures.length, 2);

const batch = predictMatchdayFromMatches(matches, uclFixtures, {
  competitionId: "ucl", windowDays: 730, halfLifeDays: 120,
});
assert.equal(batch.predictions.length, 2);
assert.ok(batch.predictions.every(({ result }) => result.cutoffDate === batch.cutoffDate));
assert.ok(batch.predictions.every(({ result }) => result.competitionId === "ucl"));

console.log(`OK: modello Big Five + UEFA · ${catalog.length} competizioni nel catalogo · ${matches.length} gare training`);
