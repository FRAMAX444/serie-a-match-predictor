import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCandidates, bestAccumulator, matchOddsToFixtures } from "../schedina.js";

// 1) buildCandidates: filtra per quota nota E probabilità minima, esclude fixture senza match.
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
    matched: false, // nessuna corrispondenza nelle quote live: deve essere esclusa a monte
    fixture: { home_team: "Lazio", away_team: "Fiorentina" },
    odds: { home: null, draw: null, away: null },
    result: { probabilities: { homeWin: 0.4, draw: 0.3, awayWin: 0.3 } },
  },
];

const candidates = buildCandidates(entries, 0.35);
assert.equal(candidates.length, 2, "solo Inter(1)=0.55 e Napoli(1)=0.42 superano la soglia 0.35: tutti gli altri esiti sono sotto");
assert.ok(candidates.every((candidate) => candidate.probability >= 0.35));
assert.ok(!candidates.some((candidate) => candidate.fixtureLabel.includes("Lazio")), "fixture non abbinata a quote non deve generare candidati");

// 2) bestAccumulator: con un target ovvio, deve trovare la combinazione a probabilità
// massima dentro la banda di tolleranza, non una qualunque che tocca il target.
const twoLegCandidates = [
  { fixtureIndex: 0, key: "1", label: "A", odds: 1.5, probability: 0.7 },
  { fixtureIndex: 0, key: "X", label: "B", odds: 3.2, probability: 0.25 },
  { fixtureIndex: 1, key: "1", label: "C", odds: 1.5, probability: 0.68 },
  { fixtureIndex: 1, key: "2", label: "D", odds: 2.9, probability: 0.28 },
];
// target ~2.25: 1.5x1.5=2.25 esatto (probabilità 0.7*0.68=0.476) è nettamente meglio di
// qualunque alternativa che tocchi la stessa banda (es. una singola gamba a quota vicina).
const result = bestAccumulator(twoLegCandidates, 2.25, 0.1);
assert.ok(result, "deve trovare una combinazione valida");
assert.equal(result.legs.length, 2);
assert.ok(Math.abs(result.combinedOdds - 2.25) < 1e-9);
assert.ok(Math.abs(result.combinedProbability - 0.7 * 0.68) < 1e-9);

// 3) bestAccumulator: nessuna combinazione possibile nella banda -> null, non un errore
const impossible = bestAccumulator(twoLegCandidates, 1000, 0.05);
assert.equal(impossible, null);

// 4) bestAccumulator: al più UNA selezione per partita (mai due esiti della stessa gara)
const sameFixtureOnly = [
  { fixtureIndex: 0, key: "1", label: "A", odds: 1.4, probability: 0.65 },
  { fixtureIndex: 0, key: "X", label: "B", odds: 3.0, probability: 0.30 },
];
const single = bestAccumulator(sameFixtureOnly, 1.4, 0.05);
assert.equal(single.legs.length, 1, "non deve mai combinare due esiti della stessa partita");

// 5) matchOddsToFixtures: abbina per nome (tollerante a forme diverse) e data, marca
// come non abbinate le fixture senza riscontro invece di fallire.
const predictions = [
  { fixture: { home_team: "Bayern Monaco", away_team: "Dortmund", date: "2026-08-16" }, result: {} },
  { fixture: { home_team: "Squadra Senza Quote", away_team: "Altra Squadra", date: "2026-08-16" }, result: {} },
];
const oddsEvents = [
  {
    home_team: "Bayern Munich", away_team: "Borussia Dortmund", commence_time: "2026-08-16T18:30:00Z",
    bookmakers: [{ key: "bet365", markets: [{ key: "h2h", outcomes: [
      { name: "Bayern Munich", price: 1.4 }, { name: "Draw", price: 5.0 }, { name: "Borussia Dortmund", price: 7.5 },
    ] }] }],
  },
];
const matched = matchOddsToFixtures(predictions, oddsEvents);
assert.equal(matched[0].matched, true, "Bayern Monaco/Dortmund deve abbinarsi a Bayern Munich/Borussia Dortmund");
assert.equal(matched[0].odds.home, 1.4);
assert.equal(matched[0].odds.draw, 5.0);
assert.equal(matched[1].matched, false, "fixture senza riscontro nelle quote live deve restare non abbinata, non causare un abbinamento errato");

console.log("OK: algoritmo schedina (candidati, ricerca combinazione ottimale, abbinamento nomi/quote)");

// --- Le due strade devono abbinare le partite allo stesso modo -------------------------------
// Difetto del 28/08/2026: matchOddsToFixtures e collectEventOdds (allora collectPlayerOdds)
// abbinavano le stesse partite
// con due criteri diversi. Sulle STESSE fixture le quote 1X2 risultavano abbinate 10 su 10 e
// quelle sui marcatori 7 su 10, e la differenza sembrava una lacuna del bookmaker invece che
// un'incoerenza interna. Dal 28/08/2026 l'abbinamento è uno solo, assignEventsToFixtures().
//
// Il test controlla il sorgente: il comportamento richiederebbe la rete, e ciò che è andato
// storto è proprio che due funzioni facessero la stessa cosa in due modi.
const schedinaSource = readFileSync(new URL("../schedina.js", import.meta.url), "utf8");
const collect = schedinaSource.slice(schedinaSource.indexOf("async function collectEventOdds"));
const collectBody = collect.slice(0, collect.indexOf("\n}\n"));
assert.match(
  collectBody, /assignEventsToFixtures\(/,
  "collectEventOdds deve usare assignEventsToFixtures(), lo stesso abbinamento di matchOddsToFixtures",
);
assert.doesNotMatch(
  collectBody, /events\.find\(|normalizeTeamName\(fixture\.home_team\)\s*===/,
  "un secondo criterio di abbinamento dentro collectEventOdds è esattamente il difetto",
);

console.log("OK: quote 1X2 e quote sui marcatori abbinano le partite con lo stesso criterio");
