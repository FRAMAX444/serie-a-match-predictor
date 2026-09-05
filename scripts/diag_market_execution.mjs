#!/usr/bin/env node
// Il divario dal mercato misura l'ACCURATEZZA. Questo script misura l'ESECUZIONE: quanto costa
// il prezzo che si paga, quanto vale il prezzo migliore, e se il modello aggiunge qualcosa a una
// linea di mercato invece di essere confrontato con essa.
//
// Perche' serve uno script separato da diag_market_dimensions.mjs: quello risponde a "dove siamo
// indietro", questo a "cosa si puo' incassare comunque". Sono domande diverse e la seconda non e'
// mai stata posta: due sessioni di lavoro hanno confrontato il modello con il mercato senza mai
// misurare quanto vale il margine del banco, che e' l'unica voce di costo certa di ogni giocata.
//
//   node scripts/diag_market_execution.mjs                    # tutte le sezioni
//   node scripts/diag_market_execution.mjs --only prezzo      # solo cio' che non richiede il modello
//   node scripts/diag_market_execution.mjs --since 2024-08-01
//
// Sezioni: prezzo, miscela, clv, combo, dipendenza, multipla.
// Le prime e le ultime due non richiedono il modello e costano un secondo; miscela, clv e combo
// devono prevedere ogni gara e costano ~70s su 5000 gare.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, scoreMatrix } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);
const SECTIONS = ["prezzo", "miscela", "clv", "combo", "dipendenza", "multipla"];

// Finestre di R7: la stima sta fino al 2025-05-31, l'holdout parte dal 2025-07-08 e non e' mai
// stato usato per stimare nulla. Un peso di miscela scelto sul primo e letto sul secondo e' la
// sola forma in cui la domanda "il modello aggiunge?" ha una risposta credibile.
const TRAIN_END = "2025-05-31";
const HOLDOUT_START = "2025-07-08";

function parseArguments(argv) {
  const options = { file: "data/matches.json", since: "2023-08-01", only: "", max: 20000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--only") options.only = String(argv[++index] || "");
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 20000);
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  if (options.only && !SECTIONS.includes(options.only)) {
    throw new Error(`--only non riconosciuto: ${options.only} (usa ${SECTIONS.join(", ")})`);
  }
  return options;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const standardError = (values) => {
  if (values.length < 2) return NaN;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) / values.length);
};
const quantile = (values, p) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(p * (sorted.length - 1))];
};
const logLoss = (probabilities, index) => -Math.log(Math.max(1e-15, probabilities[index]));
const outcomeIndex = (match) => (match.home_goals > match.away_goals ? 0 : match.home_goals === match.away_goals ? 1 : 2);
const overround = (odds) => odds.reduce((sum, value) => sum + 1 / value, 0);

// De-vig proporzionale: e' quello usato ovunque nel progetto, e resta il riferimento qui perche'
// cambiare due cose insieme renderebbe i confronti non interpretabili. La sezione "prezzo" misura
// pero' anche quanto costa questa scelta.
const devig = (odds) => {
  const raw = odds.map((value) => 1 / value);
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
};

// Shin: assume che una frazione z del volume venga da scommettitori informati e corregge il
// margine in modo NON proporzionale, restituendo piu' probabilita' al favorito. E' il metodo
// standard quando il favourite-longshot bias conta, cioe' quando si scommette e non si misura.
function shinDevig(odds) {
  const q = odds.map((value) => 1 / value);
  const Q = q.reduce((sum, value) => sum + value, 0);
  const implied = (z) => q.map((qi) => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / Q) - z) / (2 * (1 - z)));
  const f = (z) => implied(z).reduce((sum, value) => sum + value, 0) - 1;
  let low = 1e-9;
  let high = 0.5;
  if (f(low) * f(high) > 0) return devig(odds);
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (f(low) * f(middle) <= 0) high = middle; else low = middle;
  }
  const p = implied((low + high) / 2);
  const total = p.reduce((sum, value) => sum + value, 0);
  return p.map((value) => value / total);
}

// Righe con quote massime incoerenti: Football-Data pubblica MaxC come massimo fra i book
// tracciati, e una manciata di righe contiene un prezzo palesemente errato (overround 0.42).
// Vanno tolte prima di qualunque media, perche' entrano come vantaggio inesistente.
const plausible = (match) => {
  const o = overround([match.home_odds_max_close, match.draw_odds_max_close, match.away_odds_max_close]);
  return o > 0.90 && o < 1.15;
};

const hasClosing = (match) => [
  "home_odds_close", "draw_odds_close", "away_odds_close",
  "home_odds_max_close", "draw_odds_max_close", "away_odds_max_close",
].every((field) => Number(match[field]) > 1);

function loadMatches(options) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const payload = JSON.parse(fs.readFileSync(path.resolve(root, options.file), "utf8"));
  const matches = Array.isArray(payload) ? payload : payload.matches;
  if (!Array.isArray(matches)) throw new Error("Il dataset non contiene un array matches.");
  return matches;
}

// ---------------------------------------------------------------- sezione: prezzo
function sectionPrezzo(rows) {
  console.log("\n=== PREZZO — quanto costa il margine, e quanto ne toglie il prezzo migliore ===\n");
  const closing = rows.map((m) => overround([m.home_odds_close, m.draw_odds_close, m.away_odds_close]));
  const best = rows.map((m) => overround([m.home_odds_max_close, m.draw_odds_max_close, m.away_odds_max_close]));
  const report = (label, values) => console.log(
    `${label.padEnd(30)} n=${String(values.length).padStart(5)}  media=${mean(values).toFixed(5)}`
    + `  p05=${quantile(values, 0.05).toFixed(4)}  mediana=${quantile(values, 0.5).toFixed(4)}`
    + `  p95=${quantile(values, 0.95).toFixed(4)}  sotto 1.000: ${(100 * values.filter((v) => v < 1).length / values.length).toFixed(2)}%`,
  );
  report("1X2 chiusura, quota media", closing);
  report("1X2 chiusura, miglior quota", best);
  console.log(`\ndivario medio: ${(100 * (mean(closing) - mean(best))).toFixed(2)} punti percentuali di margine per gamba.`);
  console.log("La quota massima NON e' un prezzo che si puo' prendere ovunque: e' il massimo fra i book");
  console.log("tracciati da Football-Data, rilevati alla chiusura ma non necessariamente nello stesso");
  console.log("istante. Va letta come LIMITE SUPERIORE dell'esecuzione, non come esecuzione.\n");

  console.log("per stagione (la tendenza conta piu' della media: i book stanno stringendo)");
  const bySeason = new Map();
  for (const m of rows) {
    if (!bySeason.has(m.season)) bySeason.set(m.season, []);
    bySeason.get(m.season).push(m);
  }
  for (const [season, group] of [...bySeason].sort()) {
    const a = mean(group.map((m) => overround([m.home_odds_close, m.draw_odds_close, m.away_odds_close])));
    const b = mean(group.map((m) => overround([m.home_odds_max_close, m.draw_odds_max_close, m.away_odds_max_close])));
    console.log(`  ${season}  n=${String(group.length).padStart(5)}  media=${a.toFixed(4)}  migliore=${b.toFixed(4)}  divario=${(100 * (a - b)).toFixed(2)}pp`);
  }

  console.log("\nla traduzione in denaro: puntare senza alcun modello, ai due regimi di prezzo");
  console.log("(nessuna selezione, nessuna previsione: cambia solo DOVE si compra lo stesso esito)");
  const strategy = (label, pick, field) => {
    const pnl = rows.map((m) => {
      const index = pick(m);
      const odds = [
        [m.home_odds_close, m.draw_odds_close, m.away_odds_close],
        [m.home_odds_max_close, m.draw_odds_max_close, m.away_odds_max_close],
      ][field][index];
      return (index === outcomeIndex(m) ? odds : 0) - 1;
    });
    console.log(
      `  ${label.padEnd(38)} n=${String(pnl.length).padStart(5)}  ROI=${(100 * mean(pnl)).toFixed(2).padStart(7)}%`
      + ` ± ${(100 * standardError(pnl)).toFixed(2)}%  (${(mean(pnl) / standardError(pnl)).toFixed(2)}σ)`,
    );
  };
  const favourite = (m) => {
    const p = devig([m.home_odds_close, m.draw_odds_close, m.away_odds_close]);
    return p.indexOf(Math.max(...p));
  };
  strategy("favorito di mercato @ quota media", favourite, 0);
  strategy("favorito di mercato @ miglior quota", favourite, 1);
  strategy("sfavorito piu' lungo @ miglior quota", (m) => {
    const p = devig([m.home_odds_close, m.draw_odds_close, m.away_odds_close]);
    return p.indexOf(Math.min(...p));
  }, 1);
  console.log("\n  lo stesso, per stagione (il vantaggio segue il divario di prezzo, e il divario si stringe)");
  for (const [season, group] of [...bySeason].sort()) {
    if (group.length < 200) continue;
    const pnl = group.map((m) => {
      const index = favourite(m);
      const odds = [m.home_odds_max_close, m.draw_odds_max_close, m.away_odds_max_close][index];
      return (index === outcomeIndex(m) ? odds : 0) - 1;
    });
    console.log(`    ${season}  n=${String(group.length).padStart(5)}  ROI=${(100 * mean(pnl)).toFixed(2).padStart(7)}% ± ${(100 * standardError(pnl)).toFixed(2)}%  (${(mean(pnl) / standardError(pnl)).toFixed(2)}σ)`);
  }
  console.log("\n  lo stesso, in funzione di quanto del divario di prezzo si riesce a catturare");
  console.log("  (e' la riga che serve per il conto finale: al 100% sta il tetto, non l'esecuzione)");
  for (const capture of [0, 0.4, 0.6, 0.8, 1.0]) {
    const pnl = rows.map((m) => {
      const index = favourite(m);
      const consensus = [m.home_odds_close, m.draw_odds_close, m.away_odds_close][index];
      const top = [m.home_odds_max_close, m.draw_odds_max_close, m.away_odds_max_close][index];
      const price = consensus + capture * (top - consensus);
      return (index === outcomeIndex(m) ? price : 0) - 1;
    });
    console.log(`    cattura ${(100 * capture).toFixed(0).padStart(3)}%  ROI=${(100 * mean(pnl)).toFixed(2).padStart(7)}% ± ${(100 * standardError(pnl)).toFixed(2)}%  (${(mean(pnl) / standardError(pnl)).toFixed(2)}σ)`);
  }

  console.log("\n  DUE SIGMA SU TRE STAGIONI NON SONO UNA PROVA, e la tendenza per stagione e' discendente.");
  console.log("  La lettura difendibile e' che l'esecuzione porta la giocata dal -5% strutturale a circa");
  console.log("  zero, non che la porti in positivo. Il resto dipende dal favourite-longshot bias, che il");
  console.log("  de-vig proporzionale misura male (riga sotto).");

  console.log("\nquale de-vig e' piu' vicino agli esiti? (il proporzionale e' quello usato nel progetto)");
  const methods = { proporzionale: devig, Shin: shinDevig };
  const reference = rows.map((m) => logLoss(devig([m.home_odds_close, m.draw_odds_close, m.away_odds_close]), outcomeIndex(m)));
  for (const [name, fn] of Object.entries(methods)) {
    const losses = rows.map((m) => logLoss(fn([m.home_odds_close, m.draw_odds_close, m.away_odds_close]), outcomeIndex(m)));
    const gaps = losses.map((value, index) => reference[index] - value);
    let declared = 0;
    let observed = 0;
    for (const m of rows) {
      const p = fn([m.home_odds_close, m.draw_odds_close, m.away_odds_close]);
      const favourite = p.indexOf(Math.max(...p));
      declared += p[favourite];
      observed += favourite === outcomeIndex(m) ? 1 : 0;
    }
    console.log(
      `  ${name.padEnd(14)} logLoss ${mean(losses).toFixed(4)}  guadagno ${mean(gaps).toFixed(5)} ± ${standardError(gaps).toFixed(5)}`
      + `  |  favorito dichiarato ${(declared / rows.length).toFixed(4)} contro osservato ${(observed / rows.length).toFixed(4)}`
      + ` (${(100 * (observed - declared) / rows.length).toFixed(2)}pp)`,
    );
  }
}

// ---------------------------------------------------------------- sezione: multipla
function sectionMultipla(rows) {
  console.log("\n=== MULTIPLA — il margine si compone, il vantaggio no ===\n");
  const recent = rows.filter((m) => m.season >= "2526");
  const base = recent.length > 300 ? recent : rows;
  console.log(`campione: ${base.length} gare${base === recent ? " (stagione corrente: e' il regime di prezzo attuale)" : ""}\n`);
  const captures = [0, 0.4, 0.6, 0.8, 1.0];
  const effective = captures.map((c) => mean(base.map((m) => overround([
    m.home_odds_close + c * (m.home_odds_max_close - m.home_odds_close),
    m.draw_odds_close + c * (m.draw_odds_max_close - m.draw_odds_close),
    m.away_odds_close + c * (m.away_odds_max_close - m.away_odds_close),
  ]))));
  console.log("quota di divario catturata:  " + captures.map((c) => `${(100 * c).toFixed(0)}%`.padStart(9)).join(""));
  console.log("overround effettivo:         " + effective.map((e) => e.toFixed(4).padStart(9)).join(""));
  console.log("");
  for (const legs of [1, 2, 3, 5, 8, 10, 15]) {
    console.log(`EV con ${String(legs).padStart(2)} gambe:              `
      + effective.map((e) => `${(100 * (Math.pow(1 / e, legs) - 1)).toFixed(1)}%`.padStart(9)).join(""));
  }
  console.log("\nbonus minimo sulla vincita perche' l'EV torni a zero:");
  for (const legs of [3, 5, 8, 10, 15]) {
    console.log(`  ${String(legs).padStart(2)} gambe:                   `
      + effective.map((e) => `${(100 * (Math.pow(e, legs) - 1)).toFixed(1)}%`.padStart(9)).join(""));
  }
  console.log("\n(un bonus applicato alla vincita NETTA invece che lorda alza la soglia di Q/(Q-1),");
  console.log(" con Q la quota totale: su una multipla da 8.00 e' +14%, su una da 60.00 e' +1.7%.)");
}

// ---------------------------------------------------------------- previsioni del modello
function predictAll(matches, rows) {
  const chronological = matches
    .filter((m) => SUPPORTED.has(String(m.competition_id)))
    .filter((m) => m.home_goals !== null && m.home_goals !== undefined)
    .filter((m) => m.away_goals !== null && m.away_goals !== undefined)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const position = new Map(chronological.map((m, index) => [m, index]));
  const wanted = new Set(rows.map((m) => m.id));
  const out = [];
  for (const match of chronological) {
    if (!wanted.has(match.id) || (position.get(match) ?? 0) < 100) continue;
    try {
      // R14: le stesse opzioni della pagina e dei backtest, dalla stessa funzione.
      const result = predictFromMatches(chronological, {
        ...modelInputs(),
        homeTeam: match.home_team,
        awayTeam: match.away_team,
        date: match.date,
        cutoffDate: match.date,
        competitionId: match.competition_id,
        season: match.season,
      });
      out.push({ match, model: [result.probabilities.homeWin, result.probabilities.draw, result.probabilities.awayWin] });
    } catch (error) {
      if (!/Dati recenti insufficienti/i.test(String(error?.message || error))) throw error;
    }
  }
  return out;
}

// ---------------------------------------------------------------- sezione: miscela
function sectionMiscela(predicted) {
  console.log("\n=== MISCELA — il modello aggiunge qualcosa a una linea di mercato? ===\n");
  console.log("Pool logaritmico: p ∝ p_mercato^w · p_modello^(1−w). Il peso w si stima sul training e");
  console.log("si legge sull'holdout. Se l'ottimo e' w = 1 il modello non contiene informazione che il");
  console.log("mercato non abbia gia': ogni selezione fatta guardando il loro disaccordo sceglie rumore.\n");
  const pool = (row, w) => {
    const market = devig([row.match.home_odds_close, row.match.draw_odds_close, row.match.away_odds_close]);
    const raw = [0, 1, 2].map((i) => Math.pow(Math.max(1e-12, market[i]), w) * Math.pow(Math.max(1e-12, row.model[i]), 1 - w));
    const total = raw[0] + raw[1] + raw[2];
    return raw.map((value) => value / total);
  };
  const train = predicted.filter((row) => row.match.date <= TRAIN_END);
  const holdout = predicted.filter((row) => row.match.date >= HOLDOUT_START);
  console.log(`training ${train.length} gare (fino al ${TRAIN_END}) · holdout ${holdout.length} gare (dal ${HOLDOUT_START})\n`);
  const loss = (rows, w) => mean(rows.map((row) => logLoss(pool(row, w), outcomeIndex(row.match))));
  console.log("  w sul mercato | logLoss training | logLoss holdout");
  for (let w = 0.5; w <= 1.0001; w += 0.1) {
    console.log(`      ${w.toFixed(2)}      |      ${loss(train, w).toFixed(4)}      |     ${loss(holdout, w).toFixed(4)}`);
  }
  let bestWeight = 1;
  let bestLoss = Infinity;
  for (let w = 0.4; w <= 1.0001; w += 0.005) {
    const value = loss(train, w);
    if (value < bestLoss) { bestLoss = value; bestWeight = w; }
  }
  const gaps = holdout.map((row) => logLoss(pool(row, 1), outcomeIndex(row.match)) - logLoss(pool(row, bestWeight), outcomeIndex(row.match)));
  console.log(`\n  w ottimo sul training: ${bestWeight.toFixed(3)}`);
  console.log(`  guadagno sull'holdout rispetto al solo mercato: ${mean(gaps).toFixed(5)} ± ${standardError(gaps).toFixed(5)}`);
  console.log(bestWeight > 0.995
    ? "\n  ESITO: w = 1. Il modello non aggiunge nulla alla linea di chiusura."
    : `\n  ESITO: w = ${bestWeight.toFixed(3)} < 1, il modello aggiunge. Verificare il guadagno sull'holdout.`);
}

// ---------------------------------------------------------------- sezione: clv
function sectionClv(predicted) {
  console.log("\n=== CLV — il disaccordo del modello anticipa il movimento della linea? ===\n");
  console.log("E' il solo test che conta prima di scommettere: si punta all'apertura, e la chiusura dice");
  console.log("se si aveva ragione. Un vantaggio reale ha CLV positivo; un ROI positivo senza CLV e' fortuna.\n");
  const rows = predicted.filter((row) => [row.match.home_odds, row.match.draw_odds, row.match.away_odds].every((v) => Number(v) > 1));
  const baseline = [];
  for (const row of rows) {
    const open = devig([row.match.home_odds, row.match.draw_odds, row.match.away_odds]);
    const close = devig([row.match.home_odds_close, row.match.draw_odds_close, row.match.away_odds_close]);
    for (let i = 0; i < 3; i += 1) baseline.push(close[i] / open[i] - 1);
  }
  console.log(`riferimento — CLV di una selezione presa a caso: ${(100 * mean(baseline)).toFixed(3)}% ± ${(100 * standardError(baseline)).toFixed(3)}%\n`);
  console.log("soglia |     n | CLV medio            | sigma | ROI a quota d'apertura");
  for (const threshold of [0, 0.02, 0.05, 0.10]) {
    const clv = [];
    const pnl = [];
    for (const row of rows) {
      const open = devig([row.match.home_odds, row.match.draw_odds, row.match.away_odds]);
      const close = devig([row.match.home_odds_close, row.match.draw_odds_close, row.match.away_odds_close]);
      const odds = [row.match.home_odds, row.match.draw_odds, row.match.away_odds];
      const actual = outcomeIndex(row.match);
      for (let i = 0; i < 3; i += 1) {
        if (row.model[i] * odds[i] > 1 + threshold) {
          clv.push(close[i] / open[i] - 1);
          pnl.push((i === actual ? odds[i] : 0) - 1);
        }
      }
    }
    if (!clv.length) continue;
    console.log(
      ` ${(100 * threshold).toFixed(0).padStart(3)}%  | ${String(clv.length).padStart(5)} |`
      + ` ${(100 * mean(clv)).toFixed(2).padStart(6)}% ± ${(100 * standardError(clv)).toFixed(2)}%  |`
      + ` ${(mean(clv) / standardError(clv)).toFixed(2).padStart(5)} | ${(100 * mean(pnl)).toFixed(2).padStart(7)}% ± ${(100 * standardError(pnl)).toFixed(2)}%`,
    );
  }
}

// ---------------------------------------------------------------- sezioni: combo e dipendenza
// Gli esiti che il dataset PREZZA: solo questi cinque possono entrare nella sezione combo, che
// misura un ROI e quindi ha bisogno di una quota vera.
const JOINT_LEGS = {
  "1": { hit: (m) => m.home_goals > m.away_goals, avg: (m) => m.home_odds_close, best: (m) => m.home_odds_max_close, cell: (h, a) => h > a },
  X: { hit: (m) => m.home_goals === m.away_goals, avg: (m) => m.draw_odds_close, best: (m) => m.draw_odds_max_close, cell: (h, a) => h === a },
  "2": { hit: (m) => m.home_goals < m.away_goals, avg: (m) => m.away_odds_close, best: (m) => m.away_odds_max_close, cell: (h, a) => h < a },
  OVER25: { hit: (m) => m.home_goals + m.away_goals >= 3, avg: (m) => m.over25_odds_close, best: (m) => m.over25_odds_max_close, cell: (h, a) => h + a >= 3 },
  UNDER25: { hit: (m) => m.home_goals + m.away_goals <= 2, avg: (m) => m.under25_odds_close, best: (m) => m.under25_odds_max_close, cell: (h, a) => h + a <= 2 },
};

// Gli esiti che il MODELLO produce (deriveMarkets) e di cui si conosce l'esito dal punteggio: non
// serve una quota per misurare se la dipendenza e' calibrata, serve solo il risultato. Il paniere
// va tenuto largo di proposito — su sei sole coppie il coefficiente di regressione e' dominato da
// una singola casella e non descrive piu' il modello.
const DEPENDENCE_EVENTS = {
  "1": (h, a) => h > a,
  X: (h, a) => h === a,
  "2": (h, a) => h < a,
  "1X": (h, a) => h >= a,
  12: (h, a) => h !== a,
  X2: (h, a) => h <= a,
  OVER15: (h, a) => h + a >= 2,
  OVER25: (h, a) => h + a >= 3,
  UNDER25: (h, a) => h + a <= 2,
  UNDER35: (h, a) => h + a <= 3,
  GG: (h, a) => h > 0 && a > 0,
  NG: (h, a) => !(h > 0 && a > 0),
  HOME_SCORES: (h, a) => h > 0,
  AWAY_SCORES: (h, a) => a > 0,
};

function sectionCombo(rows) {
  console.log("\n=== COMBO — due esiti della STESSA partita, prezzati come prodotto delle due quote ===\n");
  console.log("Il prodotto e' cio' che fa un banco che tratta le due gambe come indipendenti. Non lo sono:");
  console.log("il pareggio e' quasi sempre 0-0 o 1-1, quindi 'X e Under 2.5' e' molto piu' probabile di");
  console.log("P(X)·P(U2.5). Il segno negativo sulle coppie anticorrelate e' la controprova del meccanismo.\n");
  const usable = rows.filter((m) => Object.values(JOINT_LEGS).every((leg) => Number(leg.avg(m)) > 1 && Number(leg.best(m)) > 1));
  const keys = Object.keys(JOINT_LEGS);
  console.log(`n = ${usable.length}\n`);
  console.log("combo              | @quota media                | @miglior quota              | R osservato");
  console.log("-".repeat(100));
  const results = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const [A, B] = [keys[i], keys[j]];
      const both = usable.filter((m) => JOINT_LEGS[A].hit(m) && JOINT_LEGS[B].hit(m)).length;
      if (!both || both === usable.length) continue;
      const pA = usable.filter((m) => JOINT_LEGS[A].hit(m)).length / usable.length;
      const pB = usable.filter((m) => JOINT_LEGS[B].hit(m)).length / usable.length;
      const roi = (field) => {
        const values = usable.map((m) => ((JOINT_LEGS[A].hit(m) && JOINT_LEGS[B].hit(m)) ? JOINT_LEGS[A][field](m) * JOINT_LEGS[B][field](m) : 0) - 1);
        return { mean: mean(values), error: standardError(values) };
      };
      results.push({ key: `${A}+${B}`, avg: roi("avg"), best: roi("best"), R: (both / usable.length) / (pA * pB) });
    }
  }
  results.sort((left, right) => right.best.mean - left.best.mean);
  for (const r of results) {
    console.log(
      `${r.key.padEnd(18)} | ${(100 * r.avg.mean).toFixed(2).padStart(7)}% ± ${(100 * r.avg.error).toFixed(2).padStart(5)}%`
      + ` (${(r.avg.mean / r.avg.error).toFixed(1).padStart(6)}σ) | ${(100 * r.best.mean).toFixed(2).padStart(7)}% ± ${(100 * r.best.error).toFixed(2).padStart(5)}%`
      + ` (${(r.best.mean / r.best.error).toFixed(1).padStart(6)}σ) |  ${r.R.toFixed(3)}`,
    );
  }
  console.log("\nNessun banco maggiore prezza 'X + Under 2.5' come prodotto: e' la coppia da manuale. Il");
  console.log("numero serve a dimensionare quanto vale il termine di dipendenza — e resta positivo anche");
  console.log("se il banco ne recupera i tre quarti (vedi sezione dipendenza).");
}

// Riancoraggio: si risolvono lambda casa, lambda trasferta e rho perche' la matrice riproduca
// ESATTAMENTE P(1), P(X) e P(Over 2.5) del mercato. Tre incognite, tre vincoli: sistema
// esattamente determinato. Le marginali diventano quelle del mercato — che batte il modello — e
// resta del modello la sola struttura di dipendenza, che e' cio' che si vuole misurare.
function anchorToMarket(targets) {
  const margins = (matrix) => {
    let home = 0;
    let draw = 0;
    let over = 0;
    matrix.forEach((row, h) => row.forEach((p, a) => {
      if (h > a) home += p; else if (h === a) draw += p;
      if (h + a >= 3) over += p;
    }));
    return [home, draw, over];
  };
  const build = (v) => scoreMatrix(Math.max(0.05, v[0]), Math.max(0.05, v[1]), 10, Math.max(-0.6, Math.min(0.6, v[2])), 0);
  const residual = (v) => margins(build(v)).map((value, index) => value - targets[index]);
  let x = [1.5, 1.2, -0.05];
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const F = residual(x);
    if (Math.max(...F.map(Math.abs)) < 1e-8) break;
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < 3; k += 1) {
      const shifted = [...x];
      shifted[k] += 1e-5;
      const Fp = residual(shifted);
      for (let r = 0; r < 3; r += 1) J[r][k] = (Fp[r] - F[r]) / 1e-5;
    }
    const A = J.map((row, i) => [...row, -F[i]]);
    for (let i = 0; i < 3; i += 1) {
      let pivot = i;
      for (let r = i + 1; r < 3; r += 1) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
      [A[i], A[pivot]] = [A[pivot], A[i]];
      if (Math.abs(A[i][i]) < 1e-14) return null;
      for (let r = 0; r < 3; r += 1) {
        if (r === i) continue;
        const factor = A[r][i] / A[i][i];
        for (let c = i; c < 4; c += 1) A[r][c] -= factor * A[i][c];
      }
    }
    const delta = [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
    const step = Math.min(1, 0.5 / Math.max(1e-9, Math.max(...delta.map(Math.abs))));
    x = [x[0] + delta[0] * step, x[1] + delta[1] * step, Math.max(-0.6, Math.min(0.6, x[2] + delta[2] * step))];
  }
  if (Math.max(...residual(x).map(Math.abs)) > 1e-5) return null;
  return { matrix: build(x), lambdaHome: x[0], lambdaAway: x[1], rho: x[2] };
}

function sectionDipendenza(rows) {
  console.log("\n=== DIPENDENZA — quanto e' esatta la struttura di dipendenza del modello? ===\n");
  console.log("La matrice viene riancorata alle marginali di mercato: P(1), P(X) e P(Over 2.5) diventano");
  console.log("identiche a quelle della linea di chiusura. Cio' che resta del modello e' solo la");
  console.log("dipendenza fra i due punteggi. Se predice la congiunta meglio del prodotto, quella");
  console.log("dipendenza e' informazione — su una dimensione dove il modello non e' indietro.\n");
  const usable = rows.filter((m) => Number(m.over25_odds_close) > 1 && Number(m.under25_odds_close) > 1);
  const names = Object.keys(DEPENDENCE_EVENTS);
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [A, B] = [names[i], names[j]];
      // Si scartano le coppie logicamente annidate o incompatibili (1 e 1X, X e 12): il loro R
      // vale 1/p per costruzione e non dice nulla sulla dipendenza.
      const both = usable.filter((m) => DEPENDENCE_EVENTS[A](m.home_goals, m.away_goals) && DEPENDENCE_EVENTS[B](m.home_goals, m.away_goals)).length;
      const onlyA = usable.filter((m) => DEPENDENCE_EVENTS[A](m.home_goals, m.away_goals)).length;
      const onlyB = usable.filter((m) => DEPENDENCE_EVENTS[B](m.home_goals, m.away_goals)).length;
      if (!both || both === onlyA || both === onlyB) continue;
      pairs.push([A, B]);
    }
  }
  const accumulator = new Map(pairs.map((p) => [p.join("+"), { n: 0, observed: 0, joint: 0, product: 0, lossJoint: 0, lossProduct: 0 }]));
  const rhos = [];
  let solved = 0;
  for (const match of usable) {
    const [pHome, pDraw] = devig([match.home_odds_close, match.draw_odds_close, match.away_odds_close]);
    const raw = [1 / match.over25_odds_close, 1 / match.under25_odds_close];
    const pOver = raw[0] / (raw[0] + raw[1]);
    const anchored = anchorToMarket([pHome, pDraw, pOver]);
    if (!anchored) continue;
    solved += 1;
    rhos.push(anchored.rho);
    const cellSum = (predicate) => {
      let total = 0;
      anchored.matrix.forEach((row, h) => row.forEach((p, a) => { if (predicate(h, a)) total += p; }));
      return total;
    };
    for (const [A, B] of pairs) {
      const entry = accumulator.get(`${A}+${B}`);
      const pA = cellSum(DEPENDENCE_EVENTS[A]);
      const pB = cellSum(DEPENDENCE_EVENTS[B]);
      const pAB = cellSum((h, a) => DEPENDENCE_EVENTS[A](h, a) && DEPENDENCE_EVENTS[B](h, a));
      const hit = DEPENDENCE_EVENTS[A](match.home_goals, match.away_goals) && DEPENDENCE_EVENTS[B](match.home_goals, match.away_goals) ? 1 : 0;
      entry.n += 1;
      entry.observed += hit;
      entry.joint += pAB;
      entry.product += pA * pB;
      entry.lossJoint += hit ? -Math.log(Math.max(1e-12, pAB)) : -Math.log(Math.max(1e-12, 1 - pAB));
      entry.lossProduct += hit ? -Math.log(Math.max(1e-12, pA * pB)) : -Math.log(Math.max(1e-12, 1 - pA * pB));
    }
  }
  console.log(`gare riancorate: ${solved}/${usable.length}`);
  console.log(`rho implicito nella linea di mercato: media ${mean(rhos).toFixed(4)}, mediana ${quantile(rhos, 0.5).toFixed(4)}`);
  console.log(`rho del modello in produzione: -0.04 — il mercato ne prezza circa il doppio.\n`);
  console.log(`coppie valutate: ${pairs.length}\n`);
  console.log("le dieci con lo scostamento piu' grande fra congiunta e prodotto");
  console.log("coppia                   |    n | osservato | matrice | prodotto | R matr | R oss | err.rel | logLoss matr | logLoss prod");
  console.log("-".repeat(122));
  const logs = [];
  const table = [];
  for (const [key, e] of accumulator) {
    const observed = e.observed / e.n;
    const joint = e.joint / e.n;
    const product = e.product / e.n;
    logs.push({ x: Math.log(joint / product), y: Math.log(observed / product) });
    table.push({
      key, n: e.n, observed, joint, product,
      rMatrix: joint / product, rObserved: observed / product,
      relative: Math.abs(joint / observed - 1),
      lossJoint: e.lossJoint / e.n, lossProduct: e.lossProduct / e.n,
    });
  }
  for (const r of [...table].sort((left, right) => Math.abs(Math.log(right.rObserved)) - Math.abs(Math.log(left.rObserved))).slice(0, 10)) {
    console.log(
      `${r.key.padEnd(24)} | ${String(r.n).padStart(4)} |   ${r.observed.toFixed(3)}   |  ${r.joint.toFixed(3)}  |  ${r.product.toFixed(3)}   |`
      + ` ${r.rMatrix.toFixed(3)}  | ${r.rObserved.toFixed(3)} |  ${(100 * r.relative).toFixed(1).padStart(4)}%  |    ${r.lossJoint.toFixed(4)}    |   ${r.lossProduct.toFixed(4)}`,
    );
  }
  const sxy = logs.reduce((sum, p) => sum + p.x * p.y, 0);
  const sxx = logs.reduce((sum, p) => sum + p.x * p.x, 0);
  const beta = sxy / sxx;
  const residuals = logs.map((p) => p.y - beta * p.x);
  const error = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / Math.max(1, logs.length - 1) / sxx);
  const errors = table.map((r) => r.relative).sort((left, right) => left - right);
  console.log(`\nregressione senza intercetta su tutte e ${pairs.length} le coppie:`);
  console.log(`  log R_osservato = ${beta.toFixed(4)} · log R_matrice   (e.s. ${error.toFixed(4)})`);
  console.log(`  la matrice cattura il ${(100 * beta).toFixed(1)}% della dipendenza in scala logaritmica.`);
  console.log(`  errore relativo sulla congiunta: mediano ${(100 * errors[Math.floor(errors.length / 2)]).toFixed(1)}%, massimo ${(100 * errors[errors.length - 1]).toFixed(1)}%`);
  console.log(`  logLoss medio sulla congiunta: matrice ${mean(table.map((r) => r.lossJoint)).toFixed(4)} contro prodotto ${mean(table.map((r) => r.lossProduct)).toFixed(4)}`);
  console.log("\nUn coefficiente indistinguibile da 1 significa che la dipendenza del modello e' calibrata.");
  console.log("ATTENZIONE: il coefficiente dipende dal paniere. Su un paniere ristretto e' dominato da");
  console.log("una singola coppia; le colonne 'err.rel' per coppia dicono dove la matrice sbaglia davvero.");
}

// ---------------------------------------------------------------- main
try {
  const options = parseArguments(process.argv.slice(2));
  const matches = loadMatches(options);
  const rows = matches
    .filter((m) => SUPPORTED.has(String(m.competition_id)))
    .filter((m) => m.home_goals !== null && m.home_goals !== undefined)
    .filter((m) => String(m.date) >= options.since)
    .filter(hasClosing)
    .filter(plausible)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .slice(-options.max);
  if (!rows.length) throw new Error("Nessuna gara con quote di chiusura e miglior prezzo nella finestra richiesta.");

  const wants = (section) => !options.only || options.only === section;
  console.log(`dataset: ${options.file} · ${rows.length} gare con quote di chiusura complete dal ${options.since}`);
  const excluded = matches.filter((m) => SUPPORTED.has(String(m.competition_id)) && hasClosing(m) && !plausible(m)).length;
  if (excluded) console.log(`escluse ${excluded} righe con miglior prezzo incoerente (overround fuori da [0.90, 1.15]).`);

  if (wants("prezzo")) sectionPrezzo(rows);
  if (wants("multipla")) sectionMultipla(rows);
  if (wants("combo")) sectionCombo(rows);
  if (wants("dipendenza")) sectionDipendenza(rows);

  if (wants("miscela") || wants("clv")) {
    if (options.only) console.error("(previsione del modello su ogni gara: qualche decina di secondi)");
    const predicted = predictAll(matches, rows);
    console.log(`\nprevisioni del modello disponibili su ${predicted.length}/${rows.length} gare (le prime 100 del dataset non sono prevedibili).`);
    if (wants("miscela")) sectionMiscela(predicted);
    if (wants("clv")) sectionClv(predicted);
  }
} catch (error) {
  console.error(`diag_market_execution fallito: ${error.message}`);
  process.exitCode = 1;
}
