import assert from "node:assert/strict";
import { datasetFreshness, freshnessMessage, STALE_AFTER_HOURS } from "../data-freshness.js";

const now = new Date("2026-11-09T12:00:00Z");

// Il caso reale che ha motivato il modulo: dataset del 1 novembre letto il 9.
const frozen = datasetFreshness({ generated_at: "2026-11-01T19:11:49+00:00" }, now);
assert.equal(frozen.stale, true);
assert.match(freshnessMessage(frozen), /2026-11-01.*7 giorni/);

// Un dataset di poche ore non mostra nulla: l'avviso deve restare raro per essere letto.
const fresh = datasetFreshness({ generated_at: "2026-11-09T08:23:00+00:00" }, now);
assert.equal(fresh.stale, false);
assert.equal(freshnessMessage(fresh), "");

// Il confine: sei esecuzioni mancate, non una.
const edge = new Date(now.getTime() - (STALE_AFTER_HOURS - 0.5) * 3_600_000).toISOString();
assert.equal(datasetFreshness({ generated_at: edge }, now).stale, false);
const over = new Date(now.getTime() - (STALE_AFTER_HOURS + 0.5) * 3_600_000).toISOString();
assert.equal(datasetFreshness({ generated_at: over }, now).stale, true);

// Una data assente o illeggibile e' dichiarata, non presunta fresca: un campo mancante che
// diventa "tutto a posto" e' esattamente la forma dei difetti di MISTAKES.md.
for (const payload of [{}, null, { generated_at: "ieri" }]) {
  const unknown = datasetFreshness(payload, now);
  assert.equal(unknown.stale, true);
  assert.match(freshnessMessage(unknown), /sconosciuta/);
}

console.log("OK: freschezza del dataset — avviso oltre 36 ore, silenzio sotto, data mancante dichiarata e non presunta fresca");
