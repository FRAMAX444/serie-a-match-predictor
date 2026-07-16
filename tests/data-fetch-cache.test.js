import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
let calls = 0;
const payload = {
  competitions: [{ id: "ita.1", name: "Serie A", fixtures: [] }],
  matches: [{ date: "2026-07-16", home_team: "Roma", away_team: "Milan" }],
};

globalThis.fetch = async () => {
  calls += 1;
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
};

await import(`../data-fetch-cache.js?test=${Date.now()}`);
const [firstResponse, secondResponse] = await Promise.all([
  globalThis.fetch("data/matches.json", { cache: "no-store" }),
  globalThis.fetch("data/matches.json", { cache: "no-store" }),
]);
const [first, second] = await Promise.all([firstResponse.json(), secondResponse.json()]);

assert.equal(calls, 1);
assert.equal(first, payload);
assert.equal(second, payload);
assert.equal(first, second);

globalThis.fetch = originalFetch;
console.log("OK: dataset scaricato e decodificato una sola volta");
