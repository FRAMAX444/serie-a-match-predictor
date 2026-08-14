import assert from "node:assert/strict";
import { analyzeSeasonCoverage, buildProjectedStandings, deriveSnapshotDate, projectSeasonSnapshot } from "../season-projection.js";

const calendar = {
  competition: { id: "ita.1" },
  teams: ["Inter", "Roma", "Milan", "Napoli"],
  matchdays: [
    { round: 1, fixtures: [
      { round: 1, date: "2026-08-22", home_team: "Inter", away_team: "Roma", home_goals: 2, away_goals: 1, completed: true },
      { round: 1, date: "2026-08-22", home_team: "Milan", away_team: "Napoli", home_goals: 0, away_goals: 0, completed: true },
    ] },
    { round: 2, fixtures: [
      { round: 2, date: "2026-08-29", home_team: "Roma", away_team: "Milan", home_goals: null, away_goals: null, completed: false },
      { round: 2, date: "2026-08-29", home_team: "Napoli", away_team: "Inter", home_goals: null, away_goals: null, completed: false },
    ] },
    { round: 3, fixtures: [
      { round: 3, date: "2026-09-05", home_team: "Inter", away_team: "Milan", home_goals: null, away_goals: null, completed: false },
      { round: 3, date: "2026-09-05", home_team: "Roma", away_team: "Napoli", home_goals: null, away_goals: null, completed: false },
    ] },
  ],
};

assert.equal(deriveSnapshotDate(calendar), "2026-08-23");
assert.equal(analyzeSeasonCoverage(calendar).complete, false, "un calendario ridotto non deve essere presentato come stagione completa");

const directStandings = buildProjectedStandings(calendar, [
  { fixture: calendar.matchdays[1].fixtures[0], homeGoals: 1, awayGoals: 0 },
  { fixture: calendar.matchdays[1].fixtures[1], homeGoals: 1, awayGoals: 1 },
  { fixture: calendar.matchdays[2].fixtures[0], homeGoals: 2, awayGoals: 0 },
  { fixture: calendar.matchdays[2].fixtures[1], homeGoals: 1, awayGoals: 1 },
]);
assert.equal(directStandings[0].team, "Inter");
assert.equal(directStandings[0].points, 7);
assert.equal(directStandings.find((row) => row.team === "Roma").currentPoints, 0);
assert.equal(directStandings.find((row) => row.team === "Roma").predictedPoints, 4);

const calls = [];
const fakePredictor = (matches, options) => {
  calls.push({ matches: matches.map((match) => ({ ...match })), options: { ...options } });
  return {
    lambdaHome: 1.35,
    lambdaAway: 0.95,
    probabilities: {
      homeWin: .5,
      draw: .3,
      awayWin: .2,
      scores: [{ home: 1, away: 0, probability: .18 }],
    },
  };
};
const historicalMatches = [{
  id: "real-history",
  date: "2026-08-20",
  competition_id: "ita.1",
  home_team: "Inter",
  away_team: "Milan",
  home_goals: 1,
  away_goals: 1,
}];
const projection = projectSeasonSnapshot(historicalMatches, calendar, {}, fakePredictor);
assert.equal(projection.predictions.length, 4);
assert.equal(projection.recursive, true);
assert.equal(calls[0].options.date, "2026-08-29");
assert.equal(calls[1].options.date, "2026-08-29");
assert.equal(calls[2].options.date, "2026-09-05");
assert.equal(calls[3].options.date, "2026-09-05");
assert.ok(calls.every((call) => call.options.cutoffDate === call.options.date));
assert.ok(calls.every((call) => call.options.competitionId === "ita.1"));
assert.equal(calls[0].matches.length, 1, "la prima data futura vede solo lo storico reale");
assert.equal(calls[1].matches.length, 1, "le partite dello stesso giorno non devono influenzarsi tra loro");
assert.equal(calls[2].matches.length, 3, "la giornata successiva deve vedere i due risultati simulati della data precedente");
assert.ok(calls[2].matches.slice(1).every((match) => match.simulated === true));
assert.deepEqual(historicalMatches, [{
  id: "real-history",
  date: "2026-08-20",
  competition_id: "ita.1",
  home_team: "Inter",
  away_team: "Milan",
  home_goals: 1,
  away_goals: 1,
}], "lo storico originale non deve essere mutato");

const fixedCalls = [];
projectSeasonSnapshot(historicalMatches, calendar, { recursive: false, snapshotDate: "2026-08-23" }, (matches, options) => {
  fixedCalls.push({ matches, options });
  return fakePredictor(matches, options);
});
assert.ok(fixedCalls.every((call) => call.matches === historicalMatches));
assert.ok(fixedCalls.every((call) => call.options.date === "2026-08-23"));
assert.ok(fixedCalls.every((call) => call.options.cutoffDate === "2026-08-23"));

console.log("OK: simulazione Serie A completa, ricorsiva per data e senza leakage");
