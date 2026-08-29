import assert from "node:assert/strict";
import { buildSlip, resolveConfidence, CONFIDENCE_LEVELS } from "../slip-builder.js";

// Generatore di candidati con quota EQUA (1/probabilità): è il caso senza chiave API, quello
// in cui la degenerazione tra quota e probabilità è massima ed è quindi il test più severo
// per l'obiettivo scelto.
function fairCandidate(fixtureIndex, key, probability, reliability = 0.95) {
  return {
    fixtureIndex,
    fixtureLabel: `Partita ${fixtureIndex}`,
    key,
    label: `${key} su partita ${fixtureIndex}`,
    probability,
    odds: 1 / probability,
    fairOdds: 1 / probability,
    reliability,
    source: "model",
  };
}

// Otto partite, quattro selezioni ciascuna su tutto lo spettro di probabilità.
const board = [];
for (let fixture = 0; fixture < 8; fixture += 1) {
  [0.92, 0.78, 0.62, 0.45].forEach((probability, index) => {
    board.push(fairCandidate(fixture, `M${index}`, probability - fixture * 0.005));
  });
}

// 1) Il numero di partite richiesto è un vincolo rigido, e ogni selezione viene da una partita
// diversa: due esiti della stessa gara sono fortemente correlati e moltiplicarne le
// probabilità come se fossero indipendenti sovrastimerebbe la schedina.
for (const legs of [1, 2, 3, 5, 8]) {
  const slip = buildSlip(board, { legs, confidence: "media" });
  assert.ok(slip, `nessuna schedina con ${legs} selezioni`);
  assert.equal(slip.legs.length, legs, `richieste ${legs} selezioni, ottenute ${slip.legs.length}`);
  const fixtures = new Set(slip.legs.map((leg) => leg.fixtureIndex));
  assert.equal(fixtures.size, legs, "due selezioni sulla stessa partita non devono coesistere");
}

// 2) Il cuore della funzione: chiedere più sicurezza deve produrre una schedina più probabile
// e che paga meno; chiedere meno sicurezza deve produrre il contrario. Se questo test cadesse,
// il parametro "sicurezza" sarebbe decorativo — che è esattamente il difetto della prima
// stesura, dove ln(quota) e ln(probabilità) si annullavano e tutti i livelli restituivano la
// stessa identica schedina.
const byConfidence = ["massima", "alta", "media", "bassa"]
  .map((confidence) => ({ confidence, slip: buildSlip(board, { legs: 4, confidence }) }));
for (const { confidence, slip } of byConfidence) assert.ok(slip, `nessuna schedina per sicurezza ${confidence}`);
for (let index = 1; index < byConfidence.length; index += 1) {
  const safer = byConfidence[index - 1];
  const riskier = byConfidence[index];
  assert.ok(
    riskier.slip.combinedProbability < safer.slip.combinedProbability,
    `${riskier.confidence} deve essere meno probabile di ${safer.confidence} `
    + `(${riskier.slip.combinedProbability} vs ${safer.slip.combinedProbability})`,
  );
  assert.ok(
    riskier.slip.combinedOdds > safer.slip.combinedOdds,
    `${riskier.confidence} deve pagare più di ${safer.confidence}`,
  );
}

// 3) La probabilità combinata dichiarata deve essere davvero il prodotto delle selezioni, e la
// quota il prodotto delle quote: sono i due numeri che l'utente legge per decidere.
for (const { slip } of byConfidence) {
  const product = slip.legs.reduce((total, leg) => total * leg.probability, 1);
  const odds = slip.legs.reduce((total, leg) => total * leg.odds, 1);
  assert.ok(Math.abs(slip.combinedProbability - product) < 1e-9, "probabilità combinata incoerente con le selezioni");
  assert.ok(Math.abs(slip.combinedOdds - odds) < 1e-9, "quota combinata incoerente con le selezioni");
  assert.ok(slip.combinedProbability > 0 && slip.combinedProbability <= 1);
}

// 4) Il vincolo di sicurezza va rispettato quando è raggiungibile, e la schedina deve stare
// vicino al target invece di superarlo di molto: superarlo di molto significa aver lasciato sul
// tavolo del guadagno che l'utente aveva accettato di rischiare.
for (const { confidence, slip } of byConfidence) {
  const level = CONFIDENCE_LEVELS[confidence];
  assert.ok(slip.targetMet, `sicurezza ${confidence} dichiarata non raggiunta`);
  assert.ok(
    slip.combinedProbability >= level.target - 1e-9,
    `sicurezza ${confidence}: ${slip.combinedProbability} sotto il target ${level.target}`,
  );
}

// 5) Ogni selezione deve rispettare la soglia minima del livello richiesto: una schedina che
// raggiunge il 50% combinato mettendo insieme una selezione al 95% e una al 53% non è "sicura"
// nel senso in cui l'utente la intende.
const strict = buildSlip(board, { legs: 3, confidence: "massima" });
for (const leg of strict.legs) {
  assert.ok(
    leg.probability >= CONFIDENCE_LEVELS.massima.minLeg,
    `selezione al ${leg.probability} sotto la soglia di sicurezza massima`,
  );
}

// 6) A parità di quota vince l'affidabilità. Due partite con le stesse probabilità e le stesse
// quote, ma una con dati molto più solidi: la schedina deve scegliere quella. È il criterio che
// tiene fuori i mercati su giocatori con pochi minuti campionati.
const tie = [
  fairCandidate(0, "SOLIDA", 0.7, 0.95),
  fairCandidate(1, "FRAGILE", 0.7, 0.2),
  fairCandidate(2, "ALTRA", 0.8, 0.95),
];
const reliable = buildSlip(tie, { legs: 2, confidence: "bassa" });
assert.ok(reliable.legs.some((leg) => leg.key === "SOLIDA"), "deve preferire la selezione con dati solidi");
assert.ok(!reliable.legs.some((leg) => leg.key === "FRAGILE"), "non deve scegliere la selezione fragile a parità di quota");

// 7) Sicurezza irraggiungibile: la funzione non deve mentire. Con sei selezioni che al massimo
// arrivano al 75% ciascuna il combinato non può superare il 18%, ben sotto il 50% richiesto
// dalla sicurezza massima; deve quindi restituire la schedina migliore possibile MA dichiarare
// targetMet falso e spiegare cosa ha rilassato, invece di consegnare una schedina qualsiasi
// facendola passare per "massima sicurezza".
const modest = [];
for (let fixture = 0; fixture < 6; fixture += 1) {
  [0.75, 0.73].forEach((probability, index) => modest.push(fairCandidate(fixture, `M${index}`, probability)));
}
const unreachable = buildSlip(modest, { legs: 6, confidence: "massima" });
assert.ok(unreachable, "deve comunque restituire una schedina");
assert.equal(unreachable.legs.length, 6);
assert.equal(unreachable.targetMet, false, "non deve dichiarare raggiunta una sicurezza irraggiungibile");
assert.ok(unreachable.relaxations.length > 0, "deve spiegare cosa è stato rilassato");
// ...e quella schedina deve essere la PIÙ probabile possibile: se il target non si può
// rispettare, il ripiego sensato è massimizzare la sicurezza, non sceglierne una a caso.
assert.ok(
  Math.abs(unreachable.combinedProbability - 0.75 ** 6) < 1e-9,
  `ripiego non ottimale: ${unreachable.combinedProbability} invece di ${0.75 ** 6}`,
);

// 8) Meno partite disponibili di quante richieste: null, non una schedina più corta spacciata
// per completa.
assert.equal(buildSlip(board.filter((candidate) => candidate.fixtureIndex < 2), { legs: 5 }), null);
assert.equal(buildSlip([], { legs: 2 }), null);

// 9) Sicurezza numerica esplicita: viene interpretata come probabilità combinata bersaglio.
const numeric = buildSlip(board, { legs: 3, confidence: 0.3 });
assert.ok(numeric.combinedProbability >= 0.3 - 1e-9, `sicurezza numerica non rispettata: ${numeric.combinedProbability}`);
assert.ok(numeric.combinedProbability < 0.45, `sicurezza numerica troppo superata: ${numeric.combinedProbability}`);
assert.equal(resolveConfidence(0.42).target, 0.42);
assert.equal(resolveConfidence("ALTA").target, CONFIDENCE_LEVELS.alta.target);
assert.equal(resolveConfidence("inesistente").target, CONFIDENCE_LEVELS.media.target);

// 10) Con quote di MERCATO l'obiettivo diventa ricerca di valore: a parità di probabilità, la
// selezione pagata meglio dal banco deve vincere. È il comportamento che rende utile inserire
// una chiave API invece di restare sulle quote eque.
const withMarket = [
  { ...fairCandidate(0, "EQUA", 0.6), odds: 1 / 0.6, source: "model" },
  { ...fairCandidate(1, "GENEROSA", 0.6), odds: 2.4, source: "market" },
  { ...fairCandidate(1, "AVARA", 0.6), odds: 1.5, source: "market" },
];
const valueSlip = buildSlip(withMarket, { legs: 2, confidence: "bassa" });
assert.ok(valueSlip.legs.some((leg) => leg.key === "GENEROSA"), "deve scegliere la quota di mercato più generosa");
assert.ok(valueSlip.expectedReturn > 1, `con una quota sopra il valore equo il ritorno atteso deve superare 1: ${valueSlip.expectedReturn}`);
assert.equal(valueSlip.usesMarketOdds, true);

// ...mentre con sole quote eque il ritorno atteso è esattamente 1, e va letto come "nessun
// vantaggio dimostrabile", non come scommessa conveniente.
assert.ok(Math.abs(byConfidence[0].slip.expectedReturn - 1) < 1e-9, "con quote eque il ritorno atteso deve essere 1");
assert.equal(byConfidence[0].slip.usesMarketOdds, false);

console.log("OK: costruttore schedina — numero di selezioni vincolante, sicurezza monotona su probabilità e quota, coerenza dei totali, preferenza per le stime affidabili, ripiego dichiarato e ricerca di valore sulle quote di mercato");
