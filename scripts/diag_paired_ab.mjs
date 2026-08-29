#!/usr/bin/env node
// Confronto APPAIATO fra configurazioni: stessa partita, N modelli.
//
// R3 del brief: mai confrontare due configurazioni con due `npm run backtest` separati.
// Misurato su 768 gare di Serie A, errore std appaiato 0.0002 contro 0.0154 non appaiato —
// 77 volte più grande. I miglioramenti veri qui valgono 0.002-0.005 di log loss: con il
// metodo non appaiato sono sotto il rumore e il rumore viene scambiato per segnale.
//
// Uso:
//   node scripts/diag_paired_ab.mjs [comp] [since] [--variants file.json|'{"nome":{...}}']
//                                   [--boot 2000] [--by phase|league|xgcoverage]
// Senza --variants confronta la base con newcomerEloDiscount:-65 (il caso di §2.4).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";
import { BUCKETERS, mean, mulberry32, reportDifference, standardError } from "./paired_stats.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOM = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const EUROPE = new Set(["ucl", "uel", "uecl"]);

function parseArguments(argv) {
  const options = { comp: "ita.1", since: "2024-08-01", until: "9999-12-31", includeEurope: false, variants: null, boot: 2000, by: "phase", file: "data/matches.json", seed: 20260825 };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--until") options.until = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--variants") options.variants = String(argv[++index] || "");
    else if (argument === "--boot") options.boot = Math.max(0, Number(argv[++index]) || 0);
    else if (argument === "--by") options.by = String(argv[++index] || "phase");
    else if (argument === "--file") options.file = String(argv[++index] || options.file);
    else if (argument === "--seed") options.seed = Number(argv[++index]) || options.seed;
    // Estende le gare VALUTATE alle coppe UEFA. Serve perché fit_calibration.mjs stima i
    // parametri su tutte le competizioni supportate, coppe incluse: validare solo sui Big
    // Five significherebbe misurare su un sottoinsieme diverso da quello su cui la stima è
    // stata fatta, e non è la stessa domanda.
    else if (argument === "--include-europe") options.includeEurope = true;
    else if (!argument.startsWith("--")) positional.push(argument);
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  if (positional[0]) options.comp = positional[0] === "all" ? "" : positional[0];
  if (positional[1]) options.since = String(positional[1]).slice(0, 10);
  return options;
}

// --variants accetta sia un percorso a un file JSON sia il JSON inline. La chiave "base"
// è obbligatoria e fa da riferimento per tutte le differenze appaiate: senza un riferimento
// esplicito una tabella di varianti non dice quale sia il confronto.
function loadVariants(spec) {
  if (!spec) return { base: null, newcomer65: { newcomerEloDiscount: -65 } };
  const raw = fs.existsSync(spec) ? fs.readFileSync(spec, "utf8") : spec;
  const parsed = JSON.parse(raw);
  if (!Object.prototype.hasOwnProperty.call(parsed, "base")) {
    throw new Error('Le varianti devono includere la chiave "base" (usa null per il modello attuale).');
  }
  return parsed;
}

const options = parseArguments(process.argv.slice(2));
const VARIANTS = loadVariants(options.variants);
const names = Object.keys(VARIANTS);
const bucketer = BUCKETERS[options.by];
if (!bucketer) throw new Error(`--by non riconosciuto: ${options.by}`);

const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, options.file), "utf8"));
// L'array passato a predictFromMatches deve contenere ANCHE le coppe, anche quando si
// valuta un campionato. predictFromMatches filtra da sé le competizioni per costruire Elo e
// medie (competitionAllowed), quindi includerle non cambia nulla di quel calcolo — ma
// recentLoad(), resolveCurrentSeason() e newcomerIndex() leggono l'array COMPLETO, e con un
// array filtrato non vedrebbero mai una partita di Champions.
//
// Non è teoria: la prima esecuzione di questo confronto dava "0/2779 gare cambiate" per la
// variante sull'impegno europeo. Il meccanismo funzionava, la misura era cieca — lo stesso
// modo in cui newcomerEloDiscount è rimasto inerte per mesi.
const universe = payload.matches
  .filter((m) => m.home_goals !== null && m.away_goals !== null)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const evaluated = new Set(options.includeEurope || options.comp === "europe" ? [...DOM, ...EUROPE] : DOM);
const all = universe.filter((m) => evaluated.has(String(m.competition_id)));

const counter = new Map();
for (const m of all) {
  const ch = (counter.get(`${m.season}|${m.home_team}`) || 0) + 1;
  const ca = (counter.get(`${m.season}|${m.away_team}`) || 0) + 1;
  counter.set(`${m.season}|${m.home_team}`, ch);
  counter.set(`${m.season}|${m.away_team}`, ca);
  m.__phase = Math.min(ch, ca);
}

// "europe" e "domestic" selezionano un REGIME intero, non una competizione: servono da
// quando si è misurato che i due hanno ottimi di calibrazione distinguibili.
const compMatches = (match) => {
  if (!options.comp) return true;
  if (options.comp === "europe") return EUROPE.has(String(match.competition_id));
  if (options.comp === "domestic") return DOM.has(String(match.competition_id));
  return match.competition_id === options.comp;
};
const cand = all
  .filter(compMatches)
  .filter((m) => String(m.date) >= options.since && String(m.date) <= options.until);

const ll = Object.fromEntries(names.map((name) => [name, []]));
const rows = [];
for (const m of cand) {
  const row = {};
  let ok = true;
  let xgCoverage = 0;
  for (const name of names) {
    try {
      const r = predictFromMatches(universe, {
        homeTeam: m.home_team, awayTeam: m.away_team, date: m.date,
        cutoffDate: m.date, competitionId: m.competition_id, season: m.season, hyperparameters: VARIANTS[name],
      });
      const p = [r.probabilities.homeWin, r.probabilities.draw, r.probabilities.awayWin];
      const a = m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2;
      row[name] = -Math.log(Math.max(1e-15, p[a]));
      if (name === "base") xgCoverage = r.xgCoverage;
    } catch { ok = false; }
  }
  if (!ok) continue;
  for (const name of names) ll[name].push(row[name]);
  rows.push({ phase: m.__phase, competition: String(m.competition_id), xgCoverage, season: String(m.season) });
}

const n = ll.base.length;
if (!n) throw new Error("Nessuna gara valutabile con questi filtri.");
console.log(`competizione ${options.comp || "tutte"}, ${n} gare da ${options.since} a ${options.until}, ${names.length} varianti, bootstrap ${options.boot}\n`);

console.log(`log loss base        : ${mean(ll.base).toFixed(4)}`);
console.log(`errore std NON appaiato: ${standardError(ll.base).toFixed(4)}   <-- il metodo da NON usare (R3)\n`);

const rng = mulberry32(options.seed);
const inert = [];
for (const name of names) {
  if (name === "base") continue;
  const diff = ll.base.map((value, index) => value - ll[name][index]);
  console.log(`  log loss "${name}"    : ${mean(ll[name]).toFixed(4)}`);
  reportDifference(`variante "${name}"`, diff, rows, bucketer, options.by, options.boot, rng, (label) => {
    inert.push(label);
  });
}

// R11: uscita con errore se una variante non ha toccato nessuna gara. Senza questo controllo
// un difetto dello strumento si legge come "il meccanismo non serve", che è la conclusione
// opposta e altrettanto plausibile.
if (inert.length) {
  console.error(
    `\nSTRUMENTO SOSPETTO: ${inert.length} variante/i non hanno toccato nessuna gara `
    + `(${inert.join(", ")}). Un meccanismo che non cambia niente non è stato misurato: `
    + "controllare che l'array passato a predictFromMatches contenga le competizioni giuste "
    + "e che i parametri della variante siano quelli attesi.",
  );
  process.exitCode = 2;
}
