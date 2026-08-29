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

// --- Serie di schedine, e quota minima per selezione ------------------------------------------
const { buildSlipSeries, DEFAULT_MIN_LEG_ODDS } = await import("../slip-builder.js");

const series = buildSlipSeries(board, { legs: 4, confidence: "media", count: 10, minLegOdds: 1 });
// Il numero consegnato dipende da quante partite ha il turno: il vincolo di diversita' e' una
// promessa su cio' che si consegna, non un obiettivo da raggiungere consegnando copie.
assert.ok(series.length >= 5 && series.length <= 10, `schedine generate: ${series.length}`);
if (series.length < 10) {
  assert.ok(
    series[0].relaxations.some((note) => /partite diverse/i.test(note)),
    "se se ne generano meno di quante richieste, va detto quante e perché",
  );
}

// Tutte diverse: dieci volte la stessa combinazione non e' una serie.
const signatures = series.map((slip) => slip.legs.map((leg) => `${leg.fixtureIndex}|${leg.key}`).sort().join(","));
assert.equal(new Set(signatures).size, series.length, "le schedine devono essere combinazioni distinte");

// E diverse sulle PARTITE, non sui mercati: ogni schedina deve avere almeno la meta' delle gare
// diversa da OGNI altra, non solo dalla precedente. Due schedine sulle stesse quattro partite con
// mercati diversi non sono due alternative — se quel turno va male vanno male entrambe.
const fixturesOf = (slip) => new Set(slip.legs.map((leg) => leg.fixtureIndex));
for (let left = 0; left < series.length; left += 1) {
  for (let right = left + 1; right < series.length; right += 1) {
    const a = fixturesOf(series[left]);
    const b = fixturesOf(series[right]);
    const shared = [...a].filter((fixture) => b.has(fixture)).length;
    assert.ok(
      a.size - shared >= 2,
      `schedine ${left + 1} e ${right + 1}: condividono ${shared} partite su ${a.size}, `
      + "ne servono almeno 2 diverse (metà di quattro)",
    );
  }
}

// Con schedine da sei selezioni la soglia sale a tre partite diverse: e' "almeno la metà", non
// un numero fisso.
const sixLegs = buildSlipSeries(board, { legs: 6, confidence: "bassa", count: 4, minLegOdds: 1 });
for (let left = 0; left < sixLegs.length; left += 1) {
  for (let right = left + 1; right < sixLegs.length; right += 1) {
    const a = fixturesOf(sixLegs[left]);
    const b = fixturesOf(sixLegs[right]);
    const shared = [...a].filter((fixture) => b.has(fixture)).length;
    assert.ok(a.size - shared >= 3, `sei selezioni: condivise ${shared}, servono 3 partite diverse`);
  }
}

// Quando il turno non ha abbastanza partite il vincolo non e' soddisfacibile per tutte: si
// completa con le migliori rimaste, ma va DETTO. Cinque partite non bastano a comporre dieci
// schedine da quattro che condividano al più due gare l'una con l'altra.
const smallBoard = board.filter((candidate) => candidate.fixtureIndex < 5);
const cramped = buildSlipSeries(smallBoard, { legs: 4, confidence: "media", count: 10, minLegOdds: 1 });
assert.ok(cramped.length < 10, "con cinque partite non si compongono dieci schedine così distinte");
assert.ok(cramped.length >= 1, "almeno la migliore va sempre consegnata");
assert.ok(
  cramped[0].relaxations.some((note) => /partite diverse/i.test(note)),
  "il numero mancante va dichiarato, non colmato con schedine che violano il vincolo",
);
// E cio' che viene consegnato rispetta il vincolo, sempre: e' il senso della promessa.
for (let left = 0; left < cramped.length; left += 1) {
  for (let right = left + 1; right < cramped.length; right += 1) {
    const a = fixturesOf(cramped[left]);
    const b = fixturesOf(cramped[right]);
    assert.ok(a.size - [...a].filter((fixture) => b.has(fixture)).length >= 2);
  }
}

// Ordinate per punteggio: la prima e' l'ottimo, ed e' la stessa che buildSlip restituisce da
// solo. Se le due funzioni divergessero, la "prima della serie" non sarebbe piu' la schedina
// migliore e nessuno se ne accorgerebbe.
const single = buildSlip(board, { legs: 4, confidence: "media", minLegOdds: 1 });
assert.deepEqual(
  series[0].legs.map((leg) => `${leg.fixtureIndex}|${leg.key}`).sort(),
  single.legs.map((leg) => `${leg.fixtureIndex}|${leg.key}`).sort(),
  "la prima della serie deve coincidere con l'ottimo di buildSlip",
);
const objective = (slip) => slip.legs.reduce(
  (sum, leg) => sum + Math.log(leg.odds) + 0.25 * Math.log(leg.reliability), 0,
);
for (let index = 1; index < series.length; index += 1) {
  assert.ok(
    objective(series[index]) <= objective(series[index - 1]) + 1e-9,
    `la serie deve essere in ordine di punteggio: la ${index + 1} batte la ${index}`,
  );
}
// Ognuna rispetta il vincolo di sicurezza come la prima: sono alternative, non ripieghi.
for (const slip of series) {
  assert.equal(slip.legs.length, 4);
  assert.equal(new Set(slip.legs.map((leg) => leg.fixtureIndex)).size, 4);
  assert.ok(slip.combinedProbability >= slip.targetProbability - 1e-9 || !slip.targetMet);
}

// --- La quota minima tiene fuori le selezioni che non pagano ----------------------------------
// Con quote eque una selezione al 92% paga 1.087: sotto la soglia di default, e va esclusa.
const withFloor = buildSlipSeries(board, { legs: 4, confidence: "media", count: 5, minLegOdds: DEFAULT_MIN_LEG_ODDS });
for (const slip of withFloor) {
  for (const leg of slip.legs) {
    assert.ok(leg.odds >= DEFAULT_MIN_LEG_ODDS - 1e-9, `selezione a quota ${leg.odds.toFixed(3)}, sotto la soglia`);
  }
}
// Dove la soglia morde davvero e' alle sicurezze alte: li' il VINCOLO obbliga a selezioni quasi
// certe, che pagano 1.09, e l'obiettivo non puo' rifiutarle. A sicurezza media non servono
// nemmeno, perche' le meglio pagate bastano a stare dentro il target.
const senzaSoglia = buildSlipSeries(board, { legs: 4, confidence: "massima", count: 1, minLegOdds: 1 })[0];
assert.ok(
  Math.min(...senzaSoglia.legs.map((leg) => leg.odds)) < DEFAULT_MIN_LEG_ODDS,
  "a sicurezza massima senza soglia entrano selezioni sotto 1.20: e' il comportamento che la soglia corregge",
);

// La sicurezza resta la richiesta principale: se la quota minima la rende irraggiungibile, cede
// la quota minima — e lo dichiara, invece di consegnare in silenzio una schedina meno sicura.
const sicurezzaMassima = buildSlip(board, { legs: 4, confidence: "massima", minLegOdds: 1.6 });
assert.ok(sicurezzaMassima, "una quota minima incompatibile non deve impedire la generazione");
assert.ok(
  sicurezzaMassima.relaxations.some((note) => /quota minima/i.test(note)),
  "il rilassamento della quota minima va riportato, non applicato in silenzio",
);
assert.ok(sicurezzaMassima.confidence.appliedMinOdds < 1.6);

console.log("OK: serie di schedine con almeno metà partite diverse, ordinate per punteggio, con quota minima per selezione");
