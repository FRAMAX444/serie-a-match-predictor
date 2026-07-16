import assert from "node:assert/strict";
import { buildCompetitionCatalog, buildMatchdays, nextFixtureForTeam } from "../matchdays.js";

const payload = {
  target_season: "2627",
  default_competition: "ucl",
  competitions: [
    { id: "ucl", name: "UEFA Champions League", type: "europe", logo: "https://example.test/ucl.png", fixtures: [{ id: "u1", round: 1, date: "2026-09-10", home_team: "Roma", away_team: "Arsenal", completed: false }] },
    { id: "uel", name: "UEFA Europa League", type: "europe", fixtures: [{ id: "u2", round: 1, date: "2026-09-17", home_team: "Milan", away_team: "Porto", completed: false }] },
    { id: "uecl", name: "UEFA Conference League", type: "europe", fixtures: [{ id: "u3", round: 1, date: "2026-09-18", home_team: "Fiorentina", away_team: "AZ", completed: false }] },
    { id: "ned.1", name: "Eredivisie", type: "domestic", fixtures: [{ id: "n1", round: 1, date: "2026-08-20", home_team: "Ajax", away_team: "PSV", completed: false }] },
    { id: "fra.1", name: "Ligue 1", type: "domestic", fixtures: [{ id: "f1", round: 1, date: "2026-08-21", home_team: "PSG", away_team: "Lione", completed: false }] },
    { id: "ita.1", name: "Serie A", type: "domestic", country: "Italy", fixtures: [
      { id: "i1", round: 1, date: "2026-08-22", home_team: "Inter", away_team: "Roma", completed: false },
      { id: "i2", round: 2, date: "2026-08-29", home_team: "Roma", away_team: "Milan", completed: false },
    ] },
    { id: "eng.1", name: "Premier League", type: "domestic", fixtures: [{ id: "e1", round: 1, date: "2026-08-15", home_team: "Arsenal", away_team: "Liverpool", completed: false }] },
  ],
};

const catalog = buildCompetitionCatalog(payload);
assert.deepEqual(catalog.map((competition) => competition.id), ["ucl", "uel", "uecl", "eng.1", "ita.1", "fra.1"]);
assert.deepEqual(catalog.slice(0, 3).map((competition) => competition.type), ["europe", "europe", "europe"]);
assert.ok(catalog.slice(3).every((competition) => competition.type === "domestic"));
assert.equal(catalog[0].logo, "https://example.test/ucl.png");
assert.ok(!catalog.some((competition) => competition.id === "ned.1"));

const calendar = buildMatchdays(payload, "ita.1");
assert.equal(calendar.matchdays.length, 2);
const next = nextFixtureForTeam(calendar, "Roma", new Date("2026-08-20T00:00:00Z"));
assert.equal(next.fixture.id, "i1");
assert.equal(next.matchday.round, 1);

console.log("OK: catalogo Big Five e tre coppe UEFA");
