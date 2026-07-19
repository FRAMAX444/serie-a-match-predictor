import assert from "node:assert/strict";

globalThis.document = {
  getElementById() {
    return null;
  },
};

const {
  displayedProbabilityFromCell,
  normalizedProbabilities,
  probabilityFromCell,
} = await import("../fixture-modal-enhancements.js");

const cells = [
  { dataset: {}, textContent: "1 60.0%" },
  { dataset: {}, textContent: "X 25.0%" },
  { dataset: {}, textContent: "2 14.9%" },
];

assert.deepEqual(
  cells.map((cell) => displayedProbabilityFromCell(cell)),
  ["60.0%", "25.0%", "14.9%"],
);

const normalized = normalizedProbabilities(cells);
assert.ok(Math.abs(normalized.reduce((sum, value) => sum + value, 0) - 100) < 1e-10);
assert.equal(normalized[0].toFixed(1), "60.1");
assert.equal(displayedProbabilityFromCell(cells[0], normalized[0]), "60.0%");

const dataCell = {
  dataset: { probability: "0.426", displayPercentage: "42.6%" },
  textContent: "valore non disponibile",
};
assert.equal(probabilityFromCell(dataCell), 42.6);
assert.equal(displayedProbabilityFromCell(dataCell), "42.6%");

console.log("OK: percentuali 1X2 del popup identiche alla card");
