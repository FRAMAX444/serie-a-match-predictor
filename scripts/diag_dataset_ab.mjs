#!/usr/bin/env node
// Confronto APPAIATO fra due VERSIONI DEI DATI: stesse partite, stesso modello, input diversi.
//
// diag_paired_ab.mjs confronta due configurazioni del modello su un dataset. Quando invece è
// il dataset a cambiare — Task 1 del brief: identità di club ricomposte e copertura xG da
// 34% a ~100% in Bundesliga e LaLiga — quel confronto non si applica, ma l'appaiamento resta
// possibile e resta necessario: la stessa partita reale esiste in entrambe le versioni.
//
// L'aggancio fra le due versioni si fa sul campo `id`, non su (data, squadra casa, squadra
// trasferta): la canonicalizzazione dei nomi ha cambiato proprio quelle chiavi (la partita
// che nel vecchio dataset è "Ath Madrid - Celta" nel nuovo è "Atletico Madrid - Celta Vigo").
// Agganciare per nome misurerebbe zero differenze su tutte le partite rinominate — cioè
// esattamente quelle su cui la modifica agisce.
//
// Uso:
//   node scripts/diag_dataset_ab.mjs vecchio.json nuovo.json [--competition ita.1]
//                                    [--since 2024-08-01] [--by phase|league|season]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";
import { BUCKETERS, mean, mulberry32, reportDifference, standardError } from "./paired_stats.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOM = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const EUROPE = new Set(["ucl", "uel", "uecl"]);

function parseArguments(argv) {
  const options = { before: "", after: "", competition: "", since: "2024-08-01", by: "league", boot: 2000, seed: 20260825, includeEurope: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--by") options.by = String(argv[++index] || "league");
    else if (argument === "--boot") options.boot = Math.max(0, Number(argv[++index]) || 0);
    else if (argument === "--seed") options.seed = Number(argv[++index]) || options.seed;
    // Estende le gare VALUTATE alle coppe UEFA. Serve per le correzioni che agiscono solo lì:
    // una previsione domestica filtra via le coppe, quindi un difetto confinato alle righe di
    // coppa e' invisibile su questo strumento senza il flag — ed e' esattamente il caso della
    // ricomposizione delle identita' spezzate fra coppe e campionato.
    else if (argument === "--include-europe") options.includeEurope = true;
    else if (!argument.startsWith("--")) positional.push(argument);
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  [options.before, options.after] = positional;
  if (!options.before || !options.after) throw new Error("Servono due dataset: vecchio e nuovo.");
  if (!BUCKETERS[options.by]) throw new Error(`--by non riconosciuto: ${options.by}`);
  return options;
}

function loadDataset(file) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), "utf8"));
  const matches = payload.matches
    .filter((match) => DOM.has(String(match.competition_id)) || (options.includeEurope && EUROPE.has(String(match.competition_id))))
    .filter((match) => match.home_goals !== null && match.away_goals !== null)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const counter = new Map();
  for (const match of matches) {
    const home = (counter.get(`${match.season}|${match.home_team}`) || 0) + 1;
    const away = (counter.get(`${match.season}|${match.away_team}`) || 0) + 1;
    counter.set(`${match.season}|${match.home_team}`, home);
    counter.set(`${match.season}|${match.away_team}`, away);
    match.__phase = Math.min(home, away);
  }
  return { matches, byId: new Map(matches.map((match) => [String(match.id), match])) };
}

const options = parseArguments(process.argv.slice(2));
const before = loadDataset(options.before);
const after = loadDataset(options.after);

const candidates = after.matches
  .filter((match) => !options.competition || String(match.competition_id) === options.competition)
  .filter((match) => String(match.date) >= options.since);

const loss = { before: [], after: [] };
const rows = [];
let unpaired = 0;
for (const match of candidates) {
  const twin = before.byId.get(String(match.id));
  if (!twin) { unpaired += 1; continue; }
  const actual = match.home_goals > match.away_goals ? 0 : match.home_goals === match.away_goals ? 1 : 2;
  let pair = null;
  try {
    const newResult = predictFromMatches(after.matches, {
      homeTeam: match.home_team, awayTeam: match.away_team, date: match.date,
      cutoffDate: match.date, competitionId: match.competition_id, season: match.season,
    });
    const oldResult = predictFromMatches(before.matches, {
      homeTeam: twin.home_team, awayTeam: twin.away_team, date: twin.date,
      cutoffDate: twin.date, competitionId: twin.competition_id, season: twin.season,
    });
    const newProbabilities = [newResult.probabilities.homeWin, newResult.probabilities.draw, newResult.probabilities.awayWin];
    const oldProbabilities = [oldResult.probabilities.homeWin, oldResult.probabilities.draw, oldResult.probabilities.awayWin];
    pair = {
      before: -Math.log(Math.max(1e-15, oldProbabilities[actual])),
      after: -Math.log(Math.max(1e-15, newProbabilities[actual])),
      xgCoverage: newResult.xgCoverage,
    };
  } catch { continue; }
  loss.before.push(pair.before);
  loss.after.push(pair.after);
  rows.push({
    phase: match.__phase,
    competition: String(match.competition_id),
    season: String(match.season),
    xgCoverage: pair.xgCoverage,
  });
}

const count = loss.before.length;
if (!count) throw new Error("Nessuna partita appaiata: i due dataset non condividono gli id?");
console.log(`${count} gare appaiate per id (${unpaired} presenti solo nel dataset nuovo), da ${options.since}`);
console.log(`  vecchio: ${options.before}`);
console.log(`  nuovo  : ${options.after}\n`);
console.log(`log loss VECCHIO     : ${mean(loss.before).toFixed(4)}`);
console.log(`log loss NUOVO       : ${mean(loss.after).toFixed(4)}`);
console.log(`errore std NON appaiato: ${standardError(loss.before).toFixed(4)}   <-- il metodo da NON usare (R3)\n`);

const differences = loss.before.map((value, index) => value - loss.after[index]);
reportDifference("dataset nuovo contro vecchio", differences, rows, BUCKETERS[options.by], options.by, options.boot, mulberry32(options.seed));
