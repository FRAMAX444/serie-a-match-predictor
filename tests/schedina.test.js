import assert from "node:assert/strict";
import { buildCandidates, bestAccumulator, matchOddsToFixtures } from "../schedina.js";

const entries = [
  {
    matched: true,
    fixture: { home_team: "Inter", away_team: "Milan" },
    odds: { home: 1.8, draw: 3.6, away: 4.5 },
    result: { probabilities: { homeWin: 0.55, draw: 0.25, awayWin: 0.20 } },
  },
  {
    matched: true,
    fixture: { home_team: "Napoli", away_team: "Roma" },
    odds: { home: 2.1, draw: 3.3, away: 3.4 },
    result: { probabilities: { homeWin: 0.42, draw: 0.28, awayWin: 0.30 } },
  },
  {
    matched: false,
    fixture: { home_team: "Lazio", away_team: "Fiorentina" },
    odds: { home: null, draw: null, away: null },
    result: { probabilities: { homeWin: 0.4, draw: 0.3, awayWin: 0.3 } },
  },
];

const candidates = buildCandidates(entries, 0.35);
assert.equal(candidates.length, 2, "solo Inter(1) e Napoli(1) superano la soglia 0.35");
assert.ok(candidates.every((candidate) => candidate.probability >= 0.35));
assert.ok(!candidates.some((candidate) => candidate.fixtureLabel.includes("Lazio")));

const twoLegCandidates = [
  { fixtureIndex: 0, key: "1", label: "A", odds: 1.5, probability: 0.7 },
  { fixtureIndex: 0, key: "X", label: "B", odds: 3.2, probability: 0.25 },
  { fixtureIndex: 1, key: "1", label: "C", odds: 1.5, probability: 0.68 },
  { fixtureIndex: 1, key: "2", label: "D", odds: 2.9, probability: 0.28 },
];
const result = bestAccumulator(twoLegCandidates, 2.25, 0.1);
assert.ok(result);
assert.equal(result.legs.length, 2);
assert.ok(Math.abs(result.combinedOdds - 2.25) < 1e-9);
assert.ok(Math.abs(result.combinedProbability - 0.7 * 0.68) < 1e-9);
assert.ok(Math.abs(result.combinedExpectedValue - (0.7 * 0.68 * 2.25 - 1)) < 1e-9);

const impossible = bestAccumulator(twoLegCandidates, 1000, 0.05);
assert.equal(impossible, null);

const sameFixtureOnly = [
  { fixtureIndex: 0, key: "1", label: "A", odds: 1.4, probability: 0.65 },
  { fixtureIndex: 0, key: "X", label: "B", odds: 3.0, probability: 0.30 },
];
const single = bestAccumulator(sameFixtureOnly, 1.4, 0.05);
assert.equal(single.legs.length, 1);

// Strategie: nella stessa banda la modalità probabilità sceglie l'esito più probabile,
// mentre expectedValue può preferire una quota più alta con rendimento atteso maggiore.
const strategyCandidates = [
  { fixtureIndex: 0, key: "1", label: "Alta probabilità", odds: 1.9, probability: 0.60 },
  { fixtureIndex: 1, key: "1", label: "Più valore", odds: 2.4, probability: 0.52 },
];
const probabilityPick = bestAccumulator(strategyCandidates, 2.15, 0.15, 1, { objective: "probability" });
const valuePick = bestAccumulator(strategyCandidates, 2.15, 0.15, 1, { objective: "expectedValue" });
assert.equal(probabilityPick.legs[0].label, "Alta probabilità");
assert.equal(valuePick.legs[0].label, "Più valore");

const predictions = [
  { fixture: { home_team: "Bayern Monaco", away_team: "Dortmund", date: "2026-08-16" }, result: {} },
  { fixture: { home_team: "Squadra Senza Quote", away_team: "Altra Squadra", date: "2026-08-16" }, result: {} },
];
const oddsEvents = [
  {
    home_team: "Bayern Munich", away_team: "Borussia Dortmund", commence_time: "2026-08-16T18:30:00Z",
    bookmakers: [
      { key: "bet365", title: "Bet365", markets: [{ key: "h2h", outcomes: [
        { name: "Bayern Munich", price: 1.4 }, { name: "Draw", price: 5.0 }, { name: "Borussia Dortmund", price: 7.5 },
      ] }] },
      { key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [
        { name: "Bayern Munich", price: 1.5 }, { name: "Draw", price: 4.8 }, { name: "Borussia Dortmund", price: 7.8 },
      ] }] },
    ],
  },
];
const matched = matchOddsToFixtures(predictions, oddsEvents);
assert.equal(matched[0].matched, true);
assert.equal(matched[0].odds.home, 1.5, "deve usare la miglior quota disponibile");
assert.equal(matched[0].bookmakers.home, "Pinnacle");
assert.ok(Math.abs(matched[0].consensusOdds.home - 1.45) < 1e-9, "la quota consenso con due bookmaker è la mediana dei due valori");
assert.equal(matched[1].matched, false);

// De-vig + edge: il filtro deve lavorare sulla probabilità di mercato normalizzata,
// non sul semplice reciproco della miglior quota.
const edgeEntries = [{
  matched: true,
  fixture: { home_team: "Inter", away_team: "Roma" },
  odds: { home: 2.0, draw: 3.7, away: 4.2 },
  consensusOdds: { home: 1.9, draw: 3.5, away: 4.0 },
  bookmakers: { home: "A", draw: "B", away: "C" },
  result: { probabilities: { homeWin: 0.60, draw: 0.22, awayWin: 0.18 } },
}];
const valueCandidates = buildCandidates(edgeEntries, 0.20, { minEdge: 0.02 });
assert.equal(valueCandidates.length, 1, "solo l'1 ha edge almeno +2pp");
assert.equal(valueCandidates[0].key, "1");
assert.ok(valueCandidates[0].edge > 0.02);
assert.ok(valueCandidates[0].expectedValue > 0);

console.log("OK: schedina con best odds, de-vig, edge, strategie e ricerca combinazione");
