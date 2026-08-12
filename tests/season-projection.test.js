import assert from "node:assert/strict";
import { buildProjectedStandings, deriveSnapshotDate, projectSeasonSnapshot } from "../season-projection.js";

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
  ],
};

assert.equal(deriveSnapshotDate(calendar), "2026-08-23");

const directStandings = buildProjectedStandings(calendar, [
  { fixture: calendar.matchdays[1].fixtures[0], homeGoals: 1, awayGoals: 0 },
  { fixture: calendar.matchdays[1].fixtures[1], homeGoals: 1, awayGoals: 1 },
]);
assert.equal(directStandings[0].team, "Inter");
assert.equal(directStandings[0].points, 4);
assert.equal(directStandings.find((row) => row.team === "Roma").currentPoints, 0);
assert.equal(directStandings.find((row) => row.team === "Roma").predictedPoints, 3);

const calls = [];
const fakePredictor = (matches, options) => {
  calls.push({ matches, options });
  return {
    probabilities: {
      homeWin: .5,
      draw: .3,
      awayWin: .2,
      scores: [{ home: 1, away: 0, probability: .18 }],
    },
  };
};
const historicalMatches = [{ id: "real-history" }];
const projection = projectSeasonSnapshot(historicalMatches, calendar, {}, fakePredictor);
assert.equal(projection.predictions.length, 2);
assert.ok(calls.every((call) => call.matches === historicalMatches));
assert.ok(calls.every((call) => call.options.date === "2026-08-23"));
assert.ok(calls.every((call) => call.options.cutoffDate === "2026-08-23"));
assert.ok(calls.every((call) => call.options.competitionId === "ita.1"));
assert.deepEqual(historicalMatches, [{ id: "real-history" }]);

console.log("OK: proiezione Serie A usa uno snapshot unico e non ricorsivo");
