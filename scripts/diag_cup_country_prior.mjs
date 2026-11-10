#!/usr/bin/env node
// Misura pre-registrata del prior Elo per nazione dei club di coppa
// (docs/pre-registrazione-cup-country-prior.md). Log loss 1X2 appaiato sulle stesse gare di
// coppa: `cupCountryPriorWeight` 1 contro 0. Nessuna rete.
//
//   node scripts/diag_cup_country_prior.mjs                 # data/matches.json
//   node scripts/diag_cup_country_prior.mjs altro.json      # un dataset annotato a mano
import fs from "node:fs";
import { predictFromMatches } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";

const CUPS = new Set(["ucl", "uel", "uecl"]);
const TRAINING_UNTIL = "2025-05-31";
const HOLDOUT_FROM = "2025-07-08";
const file = process.argv[2] || "data/matches.json";
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const chronological = payload.matches
  .filter((m) => m.home_goals !== null && m.home_goals !== undefined && m.away_goals !== null && m.away_goals !== undefined)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const position = new Map(chronological.map((m, i) => [m, i]));
const annotated = chronological.filter((m) => CUPS.has(m.competition_id) && (Number.isFinite(m.home_league_strength) || Number.isFinite(m.away_league_strength))).length;
const targets = chronological.filter((m) => CUPS.has(m.competition_id) && m.date >= "2023-08-01" && (position.get(m) ?? 0) >= 100);

console.log(`dataset: ${file}`);
console.log(`gare di coppa con almeno una forza di lega: ${annotated} · gare valutate: ${targets.length}`);
if (!annotated) {
  console.log("Nessuna gara annotata: il meccanismo e' inerte su questo dataset e la misura non dice nulla.");
  process.exit(0);
}

const outcome = (m) => (m.home_goals > m.away_goals ? "homeWin" : m.home_goals === m.away_goals ? "draw" : "awayWin");
const rows = [];
const started = Date.now();
for (const match of targets) {
  const options = (weight) => ({
    ...modelInputs(),
    homeTeam: match.home_team, awayTeam: match.away_team, date: match.date, cutoffDate: match.date,
    competitionId: match.competition_id, season: match.season,
    hyperparameters: { cupCountryPriorWeight: weight },
  });
  try {
    const off = predictFromMatches(chronological, options(0)).probabilities;
    const on = predictFromMatches(chronological, options(1)).probabilities;
    const key = outcome(match);
    rows.push({ match, gain: Math.log(on[key]) - Math.log(off[key]), offLoss: -Math.log(off[key]) });
  } catch (error) {
    if (!/Dati recenti insufficienti/i.test(String(error?.message || error))) throw error;
  }
  if (rows.length % 500 === 0 && rows.length) console.error(`  ... ${rows.length} gare (${Math.round((Date.now() - started) / 1000)}s)`);
}

function report(label, list) {
  if (list.length < 2) return console.log(`${label.padEnd(26)} | n=${list.length}`);
  const gains = list.map((row) => row.gain);
  const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
  const sd = Math.sqrt(gains.reduce((a, b) => a + (b - mean) ** 2, 0) / (gains.length - 1));
  const se = sd / Math.sqrt(gains.length);
  const base = list.reduce((a, row) => a + row.offLoss, 0) / list.length;
  console.log(`${label.padEnd(26)} | n=${String(list.length).padStart(4)} | logLoss peso 0 ${base.toFixed(4)} | guadagno ${mean >= 0 ? "+" : ""}${mean.toFixed(4)} ± ${se.toFixed(4)} | ${(mean / se).toFixed(2)}σ`);
}

console.log("\nguadagno = logLoss(peso 0) − logLoss(peso 1): positivo = il prior migliora\n");
for (const [label, filter] of [
  ["training (fino 2025-05-31)", (row) => row.match.date <= TRAINING_UNTIL],
  ["HOLDOUT (dal 2025-07-08)", (row) => row.match.date >= HOLDOUT_FROM],
  ["  holdout ucl", (row) => row.match.date >= HOLDOUT_FROM && row.match.competition_id === "ucl"],
  ["  holdout uel", (row) => row.match.date >= HOLDOUT_FROM && row.match.competition_id === "uel"],
  ["  holdout uecl", (row) => row.match.date >= HOLDOUT_FROM && row.match.competition_id === "uecl"],
  ["tutto", () => true],
]) report(label, rows.filter(filter));
console.log("\nSoglie pre-registrate: C1 holdout >= +0.0020 a >= 2σ; C2 holdout uecl non negativo oltre 1σ.");
