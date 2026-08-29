#!/usr/bin/env node
// Q2 — audit leakage sistematico (R13), per misura invece che per lettura del codice.
//
// R13 chiede che ogni campo usato dal modello sia ricostruibile in avanti alla data della
// previsione. La verifica decisiva non è ispezionare i campi uno per uno — è già stato fatto
// e ha mancato `referee_stats` per due sessioni — ma chiedere al modello la stessa cosa due
// volte:
//
//   A) con il dataset INTERO, come lo riceve oggi (contiene gare successive alla previsione);
//   B) con il dataset TRONCATO alla data della previsione, cioè con tutto ciò che non poteva
//      essere noto rimosso.
//
// Se A e B divergono anche di un bit, qualcosa nel modello legge il futuro. È un test
// esaustivo per costruzione: non dipende da quali campi si pensa siano a rischio, e copre
// anche gli aggregati calcolati dentro model.js, non solo quelli precalcolati nel payload.
//
// Il troncamento è a `date < cutoff`, esattamente il filtro che predictFromMatches applica da
// sé a `chronological`: ciò che resta esposto sono le tre funzioni che leggono l'array NON
// filtrato — newcomerIndex(), resolveCurrentSeason() e teamCalendar()/recentLoad().
//
//   node scripts/diag_leakage_truncation.mjs [--competition ita.1] [--max 200] [--since 2024-08-01]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);
const DOMESTIC = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);

function parseArguments(argv) {
  const options = { competition: "", max: 200, since: "2024-08-01", maxDay: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 200);
    else if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    // Limita il campione alle gare entro N giorni dall'inizio della loro stagione: è la fase
    // in cui il dataset troncato ha meno storia da mostrare, quindi quella con l'esposizione
    // teorica più alta a resolveCurrentSeason().
    else if (argument === "--max-day") options.maxDay = Math.max(0, Number(argv[++index]) || 0);
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payload = JSON.parse(fs.readFileSync(path.join(root, "data/matches.json"), "utf8"));

const all = payload.matches
  .filter((match) => SUPPORTED.has(String(match.competition_id)))
  .filter((match) => match.home_goals !== null && match.home_goals !== undefined)
  .filter((match) => match.away_goals !== null && match.away_goals !== undefined)
  .sort((left, right) => String(left.date).localeCompare(String(right.date)));

// Prima data di ciascuna coppia (competizione, stagione): serve per dire a che punto della
// stagione cade una gara, che è dove si sospetta si concentri l'esposizione — è lì che il
// dataset troncato ha meno storia della stagione in corso da mostrare.
const seasonStart = new Map();
for (const match of all) {
  const key = `${match.competition_id}|${match.season}`;
  const current = seasonStart.get(key);
  if (!current || String(match.date) < current) seasonStart.set(key, String(match.date));
}
const dayOfSeason = (match) => Math.round(
  (Date.parse(`${match.date}T12:00:00Z`) - Date.parse(`${seasonStart.get(`${match.competition_id}|${match.season}`)}T12:00:00Z`)) / 86400000,
);

let candidates = all.filter((match) => String(match.date) >= options.since);
if (options.competition) candidates = candidates.filter((match) => match.competition_id === options.competition);
if (Number.isFinite(options.maxDay)) candidates = candidates.filter((match) => dayOfSeason(match) <= options.maxDay);

// Campionamento uniforme invece delle ultime N: le ultime N cadono tutte nella stessa fase di
// stagione, ed è la fase il sospetto principale.
const step = Math.max(1, Math.floor(candidates.length / options.max));
const sample = candidates.filter((_, index) => index % step === 0).slice(0, options.max);

const BUCKETS = [
  ["giorni 0-20  (giornate 1-3)", (day) => day <= 20],
  ["giorni 21-60", (day) => day > 20 && day <= 60],
  ["giorni 61-150", (day) => day > 60 && day <= 150],
  ["giorni 151+", (day) => day > 150],
];
const stats = new Map(BUCKETS.map(([label]) => [label, { n: 0, differing: 0, maxDelta: 0 }]));
const perCompetition = new Map();
const examples = [];

let evaluated = 0;
let differing = 0;
let maxDelta = 0;

for (const match of sample) {
  const identity = {
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    date: match.date,
    cutoffDate: match.date,
    competitionId: match.competition_id,
  };
  // Una previsione domestica vede solo le competizioni domestiche dentro predictFromMatches,
  // ma l'array va passato intero: è da lì che si leggono calendario e carico (le gare di
  // coppa contano per il riposo anche quando non contano per l'Elo).
  const truncated = all.filter((other) => String(other.date) < String(match.date));

  let full;
  let cut;
  try {
    full = predictFromMatches(all, { ...modelInputs(), ...identity });
    cut = predictFromMatches(truncated, { ...modelInputs(), ...identity });
  } catch (error) {
    if (/Dati recenti insufficienti/i.test(String(error?.message || error))) continue;
    throw error;
  }

  evaluated += 1;
  const delta = Math.max(
    Math.abs(full.probabilities.homeWin - cut.probabilities.homeWin),
    Math.abs(full.probabilities.draw - cut.probabilities.draw),
    Math.abs(full.probabilities.awayWin - cut.probabilities.awayWin),
  );
  maxDelta = Math.max(maxDelta, delta);

  const day = dayOfSeason(match);
  const bucket = BUCKETS.find(([, test]) => test(day))?.[0];
  const bucketStats = stats.get(bucket);
  bucketStats.n += 1;
  bucketStats.maxDelta = Math.max(bucketStats.maxDelta, delta);

  const competitionStats = perCompetition.get(match.competition_id)
    || perCompetition.set(match.competition_id, { n: 0, differing: 0, maxDelta: 0 }).get(match.competition_id);
  competitionStats.n += 1;
  competitionStats.maxDelta = Math.max(competitionStats.maxDelta, delta);

  if (delta > 0) {
    differing += 1;
    bucketStats.differing += 1;
    competitionStats.differing += 1;
    if (examples.length < 8) {
      examples.push({
        match, day, delta,
        seasonFull: full.currentSeason, seasonCut: cut.currentSeason,
        trainingFull: full.trainingMatches, trainingCut: cut.trainingMatches,
      });
    }
  }
}

const pct = (part, total) => (total ? `${(100 * part / total).toFixed(1)}%` : "—");

console.log(`campione: ${evaluated} gare da ${options.since}${options.competition ? ` (${options.competition})` : ""}${Number.isFinite(options.maxDay) ? `, entro il giorno ${options.maxDay} di stagione` : ""}, una ogni ${step}`);
console.log(`previsioni che CAMBIANO troncando il dataset alla data della previsione: ${differing}/${evaluated} (${pct(differing, evaluated)})`);
console.log(`scostamento massimo su una probabilità 1X2: ${maxDelta.toExponential(2)}`);

console.log("\nper fase di stagione:");
for (const [label] of BUCKETS) {
  const value = stats.get(label);
  if (!value.n) continue;
  console.log(`  ${label.padEnd(28)} ${String(value.differing).padStart(4)}/${String(value.n).padEnd(4)} ${pct(value.differing, value.n).padStart(6)}   max Δ ${value.maxDelta.toExponential(2)}`);
}

console.log("\nper competizione:");
for (const [competition, value] of [...perCompetition.entries()].sort()) {
  console.log(`  ${competition.padEnd(8)} ${String(value.differing).padStart(4)}/${String(value.n).padEnd(4)} ${pct(value.differing, value.n).padStart(6)}   max Δ ${value.maxDelta.toExponential(2)}`);
}

if (examples.length) {
  console.log("\nprimi casi divergenti:");
  for (const example of examples) {
    console.log(
      `  ${example.match.date} ${example.match.competition_id} ${example.match.home_team} - ${example.match.away_team}`
      + ` | giorno ${example.day} | Δ ${example.delta.toExponential(2)}`
      + ` | stagione ${example.seasonFull || "''"} -> ${example.seasonCut || "''"}`
      + ` | training ${example.trainingFull} -> ${example.trainingCut}`,
    );
  }
} else {
  console.log("\nNessuna divergenza: il modello non legge nulla che stia dopo il cutoff (R13 soddisfatta sul percorso misurato).");
}

console.log(`\nnota: ${DOMESTIC.has(options.competition) || !options.competition ? "il troncamento è a date < cutoff, lo stesso filtro che predictFromMatches applica a chronological" : ""}`);
