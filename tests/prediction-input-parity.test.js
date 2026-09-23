import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, marketOddsFrom } from "../model.js";
import { MODEL_INPUT_DEFAULTS, FIXTURE_IDENTITY_KEYS, PER_FIXTURE_INPUTS, modelInputs } from "../prediction-inputs.js";

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

// Le due sagome di chiamata, dichiarate perche' la regola e' diversa e la differenza dev'essere
// una scelta scritta e non un'omissione. Chi prevede un TURNO delega a
// predictMatchdayFromMatches gli input che cambiano da una gara all'altra: non li scrive, e non
// deve. Chi prevede una gara alla volta li scrive, ed e' l'unico posto in cui possono divergere —
// per questo sotto se ne controlla l'ESPRESSIONE e non solo la chiave.
const BATCH_SITES = new Set(["app.js", "schedina.js"]);
// Prevede i 380 accoppiamenti IPOTETICI del girone doppio: partite che nessun bookmaker ha mai
// prezzato, quindi nessuna linea da dichiarare. `null` esplicito, non chiave mancante.
const MARKETLESS_SITES = new Set(["fantacalcio_asta.mjs"]);

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

  const foreign = keys
    .filter((key) => !FIXTURE_IDENTITY_KEYS.includes(key))
    .filter((key) => !PER_FIXTURE_INPUTS.includes(key));
  assert.deepEqual(
    foreign,
    [],
    `${label}: ${foreign.join(", ")} è un input del modello scritto a mano nel chiamante. `
    + "Va dichiarato in prediction-inputs.js, dove raggiunge sia la produzione sia i backtest "
    + "(R13/R14), oppure non va passato affatto.",
  );

  // Gli input per-gara. L'esenzione da `foreign` non regala nulla: e' sostituita da una regola
  // piu' stretta, che vincola il VALORE e non solo la chiave. Chi prevede una gara alla volta li
  // passa TUTTI, e li passa costruiti dall'unica funzione che sa leggere una linea di quote e
  // dirne il nome; chi prevede un turno non li nomina affatto, perche' li ricava
  // predictMatchdayFromMatches dalla fixture, in un punto solo (verificato piu' sotto).
  const byKey = new Map(entries.filter((entry) => entry.key).map((entry) => [entry.key, entry.value]));
  for (const key of PER_FIXTURE_INPUTS) {
    if (BATCH_SITES.has(label)) {
      assert.ok(
        !byKey.has(key),
        `${label}: ${key} non va passato a predictMatchdayFromMatches. È un dato per GARA: lo `
        + "ricava model.js dalla fixture, con marketOddsFrom, una volta per tutte. Passarlo qui "
        + "significherebbe una linea sola per l'intero turno, o una linea che la pagina sceglie "
        + "e la misura no (R14).",
      );
      continue;
    }
    assert.ok(
      byKey.has(key),
      `${label}: manca l'input per-gara ${key}. O lo passano tutti i chiamanti che prevedono una `
      + "gara alla volta, o nessuno (R14): misurare il regime endogeno mentre la pagina mostra "
      + "quello ancorato è la terza opzione che R13 vieta.",
    );
    assert.match(
      byKey.get(key),
      MARKETLESS_SITES.has(label) ? /^null$/ : /^marketOddsFrom\(/,
      `${label}: ${key} deve venire da marketOddsFrom(riga, linea), l'unica funzione che legge `
      + "una linea di quote e ne dichiara il nome. Costruire le quote a mano restituisce al "
      + "chiamante la scelta del VALORE, che è la falla che MODEL_INPUT_DEFAULTS non chiude "
      + "(MISTAKES.md §25 per il nome della linea, §1 per la divergenza).",
    );
  }
  perSite.set(label, keys);
}

// Il confronto che dà il nome al test: al netto dell'identità della partita, ogni chiamante
// passa lo stesso insieme di opzioni di app.js — cioè nessuno, perché tutto passa da
// modelInputs(). Scritto come confronto e non come "deve essere vuoto" perché è la proprietà
// che serve davvero: se un giorno un input dovesse essere dichiarato fuori da modelInputs(),
// dovrebbe comunque comparire da entrambe le parti.
const nonIdentity = (label) => perSite.get(label).filter((key) => !FIXTURE_IDENTITY_KEYS.includes(key));
// Chi prevede un turno non SCRIVE gli input per-gara perche' glieli da' predictMatchdayFromMatches:
// l'insieme che conta e' quello che ARRIVA al modello, ed e' quello che va confrontato. Senza
// questo, la proprieta' «ogni chiamante manda al modello le stesse cose di app.js» sarebbe vera
// per omissione invece che per costruzione.
const effective = (label) => [
  ...nonIdentity(label),
  ...(BATCH_SITES.has(label) ? PER_FIXTURE_INPUTS : []),
].sort();
for (const [, label] of SITES) {
  assert.deepEqual(
    effective(label),
    effective("app.js"),
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
// La linea di mercato non può entrare da qui, e il rifiuto dev'essere RUMOROSO. Se fosse
// dichiarata in MODEL_INPUT_DEFAULTS, la coercizione `Number(value)` poche righe sotto
// scarterebbe l'oggetto quote e lascerebbe il default: la produzione crederebbe di ancorare
// e non ancorerebbe, con ogni asserzione di questo file ancora verde. È MISTAKES.md §1 parola
// per parola, dentro il contratto nato per impedirlo.
assert.throws(
  () => modelInputs({ marketOdds: { home: 2.1, draw: 3.4, away: 3.6 } }),
  /input non dichiarato \(marketOdds\)/,
  "modelInputs deve RIFIUTARE le quote, non coercerle silenziosamente a null",
);
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
  .filter((key) => !PER_FIXTURE_INPUTS.includes(key))
  .filter((key) => !DELIBERATELY_UNWIRED.includes(key));
assert.deepEqual(
  unclassified,
  [],
  `Opzioni di predictFromMatches non classificate: ${unclassified.join(", ")}. `
  + "Dichiararle in MODEL_INPUT_DEFAULTS (arrivano a produzione e misura) o in "
  + "DELIBERATELY_UNWIRED con la ragione, ma non lasciarle indecise.",
);

// L'altra meta' della garanzia sugli input per-gara: il chiamante che prevede un TURNO non li
// scrive perche' li ricava predictMatchdayFromMatches, in UN punto solo. Se quel punto sparisse,
// app.js e schedina.js smetterebbero di ancorare e il test qui sopra resterebbe verde — la
// produzione tornerebbe endogena mentre la misura ancora, che e' la stessa divergenza di §1 col
// segno invertito.
// functionBody() non serve qui: `options = {}` nella lista dei parametri e' la prima graffa dopo
// la firma, e la lettura ingenua restituirebbe un corpo vuoto — cioe' un assert sempre verde.
const matchdaySignature = modelSource.indexOf("function predictMatchdayFromMatches(");
assert.notEqual(matchdaySignature, -1, "model.js: manca function predictMatchdayFromMatches(...)");
const matchdayParameters = scan(modelSource, modelSource.indexOf("(", matchdaySignature));
const matchdayOpen = modelSource.indexOf("{", matchdayParameters);
const matchdayBody = modelSource.slice(matchdayOpen, scan(modelSource, matchdayOpen) + 1);
assert.ok(matchdayBody.length > 100, "model.js: corpo di predictMatchdayFromMatches non estratto");
for (const key of PER_FIXTURE_INPUTS) {
  assert.match(
    matchdayBody,
    new RegExp(`${key}:\\s*marketOddsFrom\\(fixture`),
    `model.js: predictMatchdayFromMatches deve ricavare ${key} dalla fixture con marketOddsFrom, `
    + "come gia' fa con refereeHomeBias. È l'unico punto da cui la pagina e la schedina lo "
    + "ottengono, quindi l'unico che garantisce che lo ottengano uguale.",
  );
}

// Nessuna seconda copia del de-vig o del riancoraggio. shinDevig era duplicata in tre script di
// misura con tre bisezioni diverse, e anchorToMarket in due: due copie della stessa formula non
// sollevano un'eccezione quando divergono, producono numeri plausibili — la famiglia di difetti
// che e' costata di piu' a questo progetto (MISTAKES.md §3, §7, §27).
for (const file of fs.readdirSync(path.join(root, "scripts")).filter((name) => name.endsWith(".mjs"))) {
  const source = read(`scripts/${file}`);
  // `anchorToMarket` non e' ancora in lista: scripts/diag_market_execution.mjs ne tiene una copia
  // che de-viga in modo PROPORZIONALE, ed e' la copia con cui e' stato pubblicato il baseline su
  // rho (media -0.0819, mediana -0.0847). Quella copia va cancellata insieme alla ri-registrazione
  // del baseline con Shin (misurato: -0.0782 / -0.0786) — una cosa sola, in un commit suo, non
  // due mescolate qui.
  for (const name of ["shinDevig", "marketOddsFrom"]) {
    assert.ok(
      !new RegExp(`function\\s+${name}\\s*\\(`).test(source),
      `scripts/${file}: ${name} vive in model.js. Importala, non ricopiarla.`,
    );
  }
}

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

// --- Senza linea, la previsione di oggi: R1 come proprietà, non come promessa ------------------
assert.equal(explicit.marketAnchor, null, "senza quote non esiste una seconda previsione");
assert.deepEqual(
  explicit.probabilities, implicit.probabilities,
  "`probabilities` resta endogena: è quella su cui schedina.js calcola l'EV, e un EV contro una "
  + "probabilità ancorata al mercato vale zero per costruzione (MISTAKES.md §21)",
);

// --- marketOddsFrom proietta cinque prezzi e la linea, e nient'altro (R13) --------------------
// La riga da cui legge contiene anche il risultato. Che non possa viaggiare con le quote è una
// proprietà da verificare, non da promettere in un commento.
const row = {
  home_odds_close: 2.10, draw_odds_close: 3.40, away_odds_close: 3.60,
  over25_odds_close: 1.85, under25_odds_close: 1.95,
  home_odds: 2.05, draw_odds: 3.45, away_odds: 3.70,
  over25_odds: 1.83, under25_odds: 1.97,
  home_goals: 3, away_goals: 0, referee: "X",
};
const line = marketOddsFrom(row, "chiusura");
assert.deepEqual(Object.keys(line).sort(), ["away", "draw", "home", "line", "over25", "under25"]);
assert.equal(line.line, "chiusura");
assert.equal(marketOddsFrom(row, "apertura").home, 2.05);
assert.equal(marketOddsFrom(row, "nessuna"), null, "il regime endogeno è un valore dichiarato, non l'assenza dell'argomento");
assert.equal(marketOddsFrom({ market_odds: { home: 2, draw: 3.4, away: 3.6, over25: 1.85, under25: 1.95 } }, "live").line, "live");
assert.throws(
  () => marketOddsFrom(row, "chiusura_max"),
  /Linea di mercato non dichiarata/,
  "una linea senza nome è un numero senza benchmark (MISTAKES.md §25)",
);
assert.equal(
  marketOddsFrom({ home_odds_close: 2.10, draw_odds_close: 3.40, away_odds_close: 3.60 }, "chiusura"), null,
  "una linea incompleta non si ancora a metà: l'ancoraggio ha tre vincoli, o ci sono tutti o non c'è",
);

// --- Con la linea: la previsione endogena non si muove, e l'ancoraggio è esatto ----------------
const anchored = predictFromMatches(matches, { ...modelInputs(), ...identity, marketOdds: line });
assert.equal(anchored.lambdaHome, implicit.lambdaHome, "la linea non deve toccare i lambda endogeni (R1)");
assert.deepEqual(anchored.probabilities, implicit.probabilities, "`probabilities` resta endogena anche con la linea");
assert.equal(anchored.marketAnchor.status, "anchored");
assert.equal(anchored.marketAnchor.line, "chiusura", "il regime dichiara SEMPRE quale linea l'ha prodotto");
assert.ok(anchored.marketAnchor.residual <= 1e-5, `residuo ${anchored.marketAnchor.residual} sopra 1e-5`);
for (const key of ["home", "draw", "over25"]) {
  const got = key === "over25" ? anchored.marketAnchor.probabilities.over25
    : key === "home" ? anchored.marketAnchor.probabilities.homeWin
      : anchored.marketAnchor.probabilities.draw;
  assert.ok(Math.abs(got - anchored.marketAnchor.targets[key]) <= 1e-5, `marginale ${key} fuori da 1e-5`);
}

// --- Quando non si può ancorare, lo dice --------------------------------------------------------
const implausible = predictFromMatches(matches, {
  ...modelInputs(), ...identity,
  marketOdds: { line: "live", home: 1.10, draw: 1.10, away: 1.10, over25: 1.10, under25: 1.10 },
});
assert.equal(implausible.marketAnchor.status, "unavailable");
assert.equal(implausible.marketAnchor.reason, "margine-implausibile");
assert.equal(implausible.marketAnchor.line, "live");
assert.deepEqual(
  implausible.probabilities, implicit.probabilities,
  "un ancoraggio rifiutato ricade sulla previsione endogena invariata, non su una via di mezzo",
);

console.log("OK: produzione e misura passano gli stessi input a predictFromMatches (R14) — divergenza non reintroducibile in silenzio");
