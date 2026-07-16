import assert from "node:assert/strict";
import { buildCompetitionCatalog, buildMatchdays, nextFixtureForTeam } from "../matchdays.js";

const payload = {
  target_season: "2627",
  default_competition: "ucl",
  competitions: [
    {
      id: "ucl", name: "UEFA Champions League", type: "europe", logo: "https://example.test/ucl.png",
      fixtures: [{ id: "u1", round: 1, date: "2026-09-10", home_team: "Roma", away_team: "Arsenal", completed: false }],
    },
    {
      id: "ita.1", name: "Serie A", type: "domestic", country: "Italy",
      fixtures: [
        { id: "i1", round: 1, date: "2026-08-22", home_team: "Inter", away_team: "Roma", completed: false },
        { id: "i2", round: 2, date: "2026-08-29", home_team: "Roma", away_team: "Milan", completed: false },
      ],
    },
  ],
};

const catalog = buildCompetitionCatalog(payload);
assert.deepEqual(catalog.map((competition) => competition.id), ["ucl", "ita.1"]);
assert.equal(catalog[1].type, "domestic");
assert.equal(catalog[0].logo, "https://example.test/ucl.png");

const calendar = buildMatchdays(payload, "ita.1");
assert.equal(calendar.matchdays.length, 2);
const next = nextFixtureForTeam(calendar, "Roma", new Date("2026-08-20T00:00:00Z"));
assert.equal(next.fixture.id, "i1");
assert.equal(next.matchday.round, 1);

console.log("OK: catalogo multi-lega e prossima partita preferita");
