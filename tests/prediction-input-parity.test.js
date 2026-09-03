import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";
import { MODEL_INPUT_DEFAULTS, FIXTURE_IDENTITY_KEYS, modelInputs } from "../prediction-inputs.js";

// Criterio di accettazione di Q1 (prompt sessione 3 §1): la divergenza fra ciò che app.js
// passa a predictFromMatches e ciò che i backtest passano deve diventare IMPOSSIBILE da
// reintrodurre in silenzio, non solo corretta una volta.
//
// La divergenza corretta il 27/08/2026 era `teamContext` (e con essa `refereeStats`): la
// pagina li passava, nessuno script di misura li ha mai passati, quindi ogni log loss
// prodotto in due sessioni descriveva un modello diverso da quello in produzione. Nulla nel
// codice impediva che domani se ne aggiungesse un'altra, perché i due chiamanti si
// costruivano le opzioni ciascuno per conto proprio.
//
// Questo test controlla la FORMA dei due chiamanti, non il loro comportamento: entrambi
// devono ottenere gli input del modello da modelInputs() e scrivere a mano solo l'identità
// della partita. È l'unica verifica che regge anche per un input che non esiste ancora.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// --- Estrazione: il corpo di `predictionOptions` dai due file --------------------------------
// Nessun parser: si scorre il sorgente carattere per carattere tenendo conto di stringhe,
// template literal e commenti, perché è esattamente dentro un commento che compare la parola
// `teamContext` in entrambi i file, e un regex ingenuo la scambierebbe per un input vivo.

function scan(source, start, onTopLevelComma) {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && next === "*") {
      index = source.indexOf("*/", index + 2) + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      while (index < source.length && source[index] !== character) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if ("{[(".includes(character)) depth += 1;
    if ("}])".includes(character)) {
      depth -= 1;
      if (depth === 0) return index;
    }
    if (character === "," && depth === 1 && onTopLevelComma) onTopLevelComma(index);
    index += 1;
  }
  throw new Error("Delimitatore non bilanciato: sorgente non analizzabile.");
}

// Voci di primo livello dell'oggetto letterale che comincia alla graffa `start`.
function objectEntries(source, start) {
  const boundaries = [start];
  const end = scan(source, start, (position) => boundaries.push(position));
  boundaries.push(end);

  return boundaries
    .slice(0, -1)
    .map((from, position) => source.slice(from + 1, boundaries[position + 1]))
    .map((fragment) => fragment.replace(/\/\/[^\n]*\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter(Boolean)
    .map((fragment) => {
      if (fragment.startsWith("...")) return { spread: fragment.slice(3).trim() };
      // `{ competitionId }` è la stessa cosa di `{ competitionId: competitionId }`: la forma
      // abbreviata non ha i due punti, e leggerla come se li avesse tronca l'ultima lettera
      // del nome — che è esattamente ciò che questo test ha fatto al primo giro.
      const colon = fragment.indexOf(":");
      return colon === -1
        ? { key: fragment.trim(), value: fragment.trim() }
        : {
          key: fragment.slice(0, colon).trim().replace(/^["']|["']$/g, ""),
          value: fragment.slice(colon + 1).trim(),
        };
    });
}

function functionBody(source, name, file) {
  const signature = source.indexOf(`function ${name}(`);
  assert.notEqual(signature, -1, `${file}: manca function ${name}(...)`);
  const start = source.indexOf("{", signature);
  return source.slice(start, scan(source, start) + 1);
}

// Chiavi e spread di primo livello dell'oggetto restituito da `predictionOptions`.
function returnedOptionEntries(source, file) {
  const body = functionBody(source, "predictionOptions", file);
  const returnStart = body.indexOf("{", body.indexOf("return "));
  assert.notEqual(returnStart, -1, `${file}: predictionOptions non restituisce un oggetto letterale`);
  return objectEntries(body, returnStart);
}

// Ogni chiamante che PREVEDE. Restano fuori tune_hyperparameters.mjs e fit_calibration.mjs,
// che stimano: passano `hyperparameters` per costruzione, ed è il loro oggetto di ricerca,
// non un input della previsione.
// schedina-page.js non compare: dal 28/08/2026 non prevede piu' da sola, delega a generateSlip()
// anche il percorso di scelta manuale del campionato. Un secondo chiamante che rifaceva lo
// stesso lavoro e' la forma esatta del difetto che questo file esiste per impedire.
const SITES = [
  ["app.js", "app.js"],
  ["schedina.js", "schedina.js"],
  ["scripts/backtest_model.mjs", "backtest_model.mjs"],
  ["scripts/backtest_vs_market.mjs", "backtest_vs_market.mjs"],
  // Il foglio per l'asta del fantacalcio prevede i 380 accoppiamenti del girone doppio: non e'
  // una misura, ma passa da predictFromMatches come tutti gli altri e vale la stessa regola.
  ["scripts/fantacalcio_asta.mjs", "fantacalcio_asta.mjs"],
];

// Le opzioni di un chiamante stanno o in `predictionOptions()`, o direttamente nella chiamata.
// Entrambe le forme vanno controllate: scriverle sul posto è come è nato il difetto.
function optionEntriesOf(source, label) {
  if (source.includes("function predictionOptions(")) return returnedOptionEntries(source, label);

  const call = /predict(?:Matchday)?FromMatches\s*\(/.exec(source);
  assert.ok(call, `${label}: nessuna chiamata a predictFromMatches/predictMatchdayFromMatches`);
  const open = call.index + call[0].length - 1;
  const boundaries = [open];
  const close = scan(source, open, (position) => boundaries.push(position));
  boundaries.push(close);
  const args = boundaries
    .slice(0, -1)
    .map((from, position) => [from + 1, boundaries[position + 1]]);
  const [from, to] = args.at(-1);
  const argument = source.slice(from, to).trim();
  assert.ok(
    argument.startsWith("{"),
    `${label}: le opzioni vanno passate come oggetto letterale o da predictionOptions()`,
  );
  return objectEntries(source, from + source.slice(from, to).indexOf("{"));
}

const perSite = new Map();
for (const [relative, label] of SITES) {
  const entries = optionEntriesOf(read(relative), label);
  const spreads = entries.filter((entry) => entry.spread).map((entry) => entry.spread);
  const keys = entries.filter((entry) => entry.key).map((entry) => entry.key);

  assert.deepEqual(
    spreads.map((spread) => spread.replace(/\(.*$/s, "")),
    ["modelInputs"],
    `${label}: le opzioni devono venire da un solo spread, e deve essere modelInputs(...). `
    + "Costruirle a mano è ciò che ha fatto divergere produzione e misura.",
  );

  const foreign = keys.filter((key) => !FIXTURE_IDENTITY_KEYS.includes(key));
  assert.deepEqual(
    foreign,
    [],
    `${label}: ${foreign.join(", ")} è un input del modello scritto a mano nel chiamante. `
    + "Va dichiarato in prediction-inputs.js, dove raggiunge sia la produzione sia i backtest "
    + "(R13/R14), oppure non va passato affatto.",
  );
  perSite.set(label, keys);
}

// Il confronto che dà il nome al test: al netto dell'identità della partita, ogni chiamante
// passa lo stesso insieme di opzioni di app.js — cioè nessuno, perché tutto passa da
// modelInputs(). Scritto come confronto e non come "deve essere vuoto" perché è la proprietà
// che serve davvero: se un giorno un input dovesse essere dichiarato fuori da modelInputs(),
// dovrebbe comunque comparire da entrambe le parti.
const nonIdentity = (label) => perSite.get(label).filter((key) => !FIXTURE_IDENTITY_KEYS.includes(key));
for (const [, label] of SITES) {
  assert.deepEqual(
    nonIdentity(label),
    nonIdentity("app.js"),
    `${label} e app.js passano insiemi di opzioni diversi a predictFromMatches`,
  );
}

// --- Il contratto rifiuta ciò che non è dichiarato -------------------------------------------
// È la seconda metà della garanzia: la forma dei chiamanti impedisce di scrivere un input a
// mano, questo impedisce di infilarlo dentro modelInputs() senza dichiararlo.
assert.deepEqual(Object.keys(modelInputs()).sort(), Object.keys(MODEL_INPUT_DEFAULTS).sort());
assert.throws(
  () => modelInputs({ teamContext: {} }),
  /input non dichiarato \(teamContext\)/,
  "modelInputs deve rifiutare un input non presente in MODEL_INPUT_DEFAULTS",
);
assert.throws(() => modelInputs({ refereeStats: {} }), /input non dichiarato/);
assert.deepEqual(modelInputs({ windowDays: 730 }), { windowDays: 730, halfLifeDays: 120 });
// Preferenze illeggibili (localStorage, Firestore) ricadono sul default invece di propagare NaN.
assert.deepEqual(modelInputs({ windowDays: "non-numerico" }), { ...MODEL_INPUT_DEFAULTS });
assert.deepEqual(modelInputs({ halfLifeDays: 0 }), { ...MODEL_INPUT_DEFAULTS });

// --- I default del contratto sono davvero i default del modello ------------------------------
// Se model.js cambiasse i suoi default interni senza che MODEL_INPUT_DEFAULTS li segua, i due
// chiamanti resterebbero d'accordo fra loro ma il contratto mentirebbe sul modello: la pagina
// e i backtest userebbero 540 credendo di usare ciò che model.js dichiara.
const modelSource = read("model.js");
const predictBody = functionBody(modelSource, "predictFromMatches", "model.js");
const declared = objectEntries(predictBody, predictBody.indexOf("{", predictBody.indexOf("const options =")));
const declaredValues = Object.fromEntries(declared.filter((entry) => entry.key).map((entry) => [entry.key, entry.value]));

for (const [key, value] of Object.entries(MODEL_INPUT_DEFAULTS)) {
  assert.equal(
    declaredValues[key],
    String(value),
    `MODEL_INPUT_DEFAULTS.${key} = ${value} ma predictFromMatches dichiara ${declaredValues[key]}`,
  );
}

// Ogni opzione che predictFromMatches accetta deve essere classificata: o è un input del
// modello che entrambi i chiamanti ricevono (MODEL_INPUT_DEFAULTS), o identifica la partita,
// o è deliberatamente non cablata. Aggiungerne una nuova a model.js senza decidere quale sia
// fa fallire questo test — che è il punto: R13 non ammette la terza opzione «usata in
// produzione e ignorata in misura», e ci si arriva sempre per omissione, mai per scelta.
const DELIBERATELY_UNWIRED = [
  // Spento il 27/08/2026, misurato a zero: vedi prediction-inputs.js.
  "teamContext",
  // Spento il 27/08/2026: il segnale era leakage, e in produzione era inerte comunque.
  "refereeHomeBias",
  // Non è un input della previsione ma l'oggetto della ricerca: lo passano solo
  // tune_hyperparameters.mjs e fit_calibration.mjs, che stimano, non prevedono.
  "hyperparameters",
];
const unclassified = declared
  .filter((entry) => entry.key)
  .map((entry) => entry.key)
  .filter((key) => !(key in MODEL_INPUT_DEFAULTS))
  .filter((key) => !FIXTURE_IDENTITY_KEYS.includes(key))
  .filter((key) => !DELIBERATELY_UNWIRED.includes(key));
assert.deepEqual(
  unclassified,
  [],
  `Opzioni di predictFromMatches non classificate: ${unclassified.join(", ")}. `
  + "Dichiararle in MODEL_INPUT_DEFAULTS (arrivano a produzione e misura) o in "
  + "DELIBERATELY_UNWIRED con la ragione, ma non lasciarle indecise.",
);

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

function league(rounds) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      matches.push({
        date: iso(START + round * 7 * DAY), season: "2526", competition_id: "ita.1",
        competition_type: "domestic", league_strength: 1550,
        home_team: home, away_team: away, home_goals: 2, away_goals: 1,
        home_xg: 1.7, away_xg: 1.0, home_shots: 13, away_shots: 10, home_sot: 5, away_sot: 4,
        home_red: 0, away_red: 0,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const matches = league(30);
const identity = {
  homeTeam: "Team-1", awayTeam: "Team-2",
  date: iso(START + 30 * 7 * DAY), cutoffDate: iso(START + 30 * 7 * DAY),
  competitionId: "ita.1",
};
const implicit = predictFromMatches(matches, identity);
const explicit = predictFromMatches(matches, { ...modelInputs(), ...identity });
assert.equal(explicit.lambdaHome, implicit.lambdaHome, "MODEL_INPUT_DEFAULTS diverge dai default di predictFromMatches");
assert.equal(explicit.lambdaAway, implicit.lambdaAway, "MODEL_INPUT_DEFAULTS diverge dai default di predictFromMatches");

// --- Nessun contesto squadra e nessun bias arbitro raggiungono più il modello ----------------
// La conseguenza osservabile di Q1: la previsione che la pagina produce è quella che il
// backtest misura, senza perturbatori che la misura non vede.
assert.equal(explicit.context.applied, false, "teamContext non deve più raggiungere il modello dai chiamanti");
assert.equal(explicit.refereeBias, 0, "refereeStats non deve più raggiungere il modello dai chiamanti");

console.log("OK: produzione e misura passano gli stessi input a predictFromMatches (R14) — divergenza non reintroducibile in silenzio");
