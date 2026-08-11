#!/usr/bin/env node
// Coordinate descent contro il backtest per gli iperparametri esposti in model.js
// (DEFAULT_HYPERPARAMETERS). Riusa lo stesso criterio di valutazione di
// backtest_model.mjs (log loss di default, oppure --metric rps).
//
// ATTENZIONE ALL'OVERFITTING: questo script minimizza l'errore sulla STESSA finestra di
// backtest che gli passi. Un valore trovato qui può semplicemente essersi adattato al
// rumore di quel campione specifico, esattamente come uno strategy-fitting su un singolo
// periodo di mercato senza validazione fuori campione. Prima di portare in produzione i
// valori suggeriti: (1) fai girare questo script su una finestra (es. --since una data
// meno recente, --max più piccolo), (2) valida il risultato con backtest_model.mjs e
// backtest_vs_market.mjs su una finestra SUCCESSIVA e non usata per il tuning, (3) tieni i
// nuovi iperparametri solo se il miglioramento regge anche lì. Se non hai tempo per farlo
// bene, meglio lasciare i default: sono quelli con cui il resto della suite di test è stata
// validata.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);

// Un'unica dimensione per esponente condivisa tra attacco e difesa (vedi model.js: prima di
// essere esposti come iperparametri, homeAttack/awayAttack usavano già gli stessi esponenti
// tra loro, così come awayDefense/homeDefense): dimezza lo spazio di ricerca rispetto a 20
// esponenti indipendenti senza perdere nulla di quello che il modello varia davvero.
const SEARCH_SPACE = [
  { path: ["rho"], min: -0.15, max: 0.0, step: 0.02 },
  { path: ["eloDivisor"], min: 700, max: 1600, step: 100 },
  { path: ["eloClamp"], min: 0.2, max: 0.5, step: 0.03 },
  { path: ["momentumShortWeight"], min: 0.3, max: 0.9, step: 0.05 },
  { path: ["momentumScale"], min: 0.02, max: 0.09, step: 0.01 },
  { path: ["momentumClamp"], min: 0.08, max: 0.25, step: 0.02 },
  { path: ["attackExponents", "goals"], min: 0.05, max: 0.4, step: 0.03 },
  { path: ["attackExponents", "xg"], min: 0.2, max: 0.6, step: 0.03 },
  { path: ["attackExponents", "sot"], min: 0.05, max: 0.3, step: 0.03 },
  { path: ["attackExponents", "shots"], min: 0.0, max: 0.2, step: 0.02 },
  { path: ["attackExponents", "venue"], min: 0.0, max: 0.2, step: 0.02 },
  { path: ["defenseExponents", "goals"], min: 0.1, max: 0.45, step: 0.03 },
  { path: ["defenseExponents", "xg"], min: 0.25, max: 0.65, step: 0.03 },
  { path: ["defenseExponents", "sot"], min: 0.05, max: 0.3, step: 0.03 },
  { path: ["defenseExponents", "shots"], min: 0.0, max: 0.15, step: 0.02 },
  { path: ["defenseExponents", "venue"], min: 0.0, max: 0.15, step: 0.02 },
];

function parseArguments(argv) {
  const options = { file: "data/matches.json", competition: "", since: "", max: 400, rounds: 3, metric: "logLoss" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(100, Number(argv[++index]) || 400);
    else if (argument === "--rounds") options.rounds = Math.max(1, Number(argv[++index]) || 3);
    else if (argument === "--metric") options.metric = String(argv[++index] || "logLoss");
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  if (options.competition && !SUPPORTED.has(options.competition)) {
    throw new Error(`Competizione non supportata: ${options.competition}`);
  }
  if (!["logLoss", "rps"].includes(options.metric)) {
    throw new Error("--metric deve essere logLoss o rps");
  }
  return options;
}

function unpackPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!Array.isArray(payload?.matches)) throw new Error("Il dataset non contiene un array matches.");
  if (Array.isArray(payload.columns) && payload.matches.length && Array.isArray(payload.matches[0])) {
    return payload.matches.map((row) => Object.fromEntries(payload.columns.map((column, index) => [column, row[index]])));
  }
  return payload.matches;
}

function resultIndex(match) {
  if (match.home_goals > match.away_goals) return 0;
  if (match.home_goals === match.away_goals) return 1;
  return 2;
}

function round(value, digits = 5) {
  return Number(value.toFixed(digits));
}

function prepare(matches, options) {
  const chronological = matches
    .filter((match) => SUPPORTED.has(String(match.competition_id)))
    .filter((match) => match.home_goals !== null && match.home_goals !== undefined)
    .filter((match) => match.away_goals !== null && match.away_goals !== undefined)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

  const position = new Map(chronological.map((match, index) => [match, index]));
  let candidates = chronological.filter((match) => !options.competition || match.competition_id === options.competition);
  if (options.since) candidates = candidates.filter((match) => String(match.date) >= options.since);
  candidates = candidates.filter((match) => (position.get(match) ?? 0) >= 100).slice(-options.max);
  if (!candidates.length) throw new Error("Nessuna partita valutabile con almeno 100 gare precedenti.");
  return { chronological, candidates };
}

// Un'unica valutazione: log loss (o RPS) medio di predictFromMatches con gli iperparametri
// dati, sullo stesso insieme di partite per ogni trial (cosi' i punteggi sono confrontabili
// tra un set di iperparametri e l'altro).
function score(chronological, candidates, hyperparameters, metric) {
  let total = 0;
  let count = 0;
  for (const match of candidates) {
    let result;
    try {
      result = predictFromMatches(chronological, {
        homeTeam: match.home_team, awayTeam: match.away_team, date: match.date,
        cutoffDate: match.date, competitionId: match.competition_id, hyperparameters,
      });
    } catch (error) {
      if (/Dati recenti insufficienti/i.test(String(error?.message || error))) continue;
      throw error;
    }
    const probabilities = [result.probabilities.homeWin, result.probabilities.draw, result.probabilities.awayWin];
    const actual = resultIndex(match);
    if (metric === "rps") {
      const predictedCumulative = [probabilities[0], probabilities[0] + probabilities[1]];
      const actualCumulative = [actual === 0 ? 1 : 0, actual <= 1 ? 1 : 0];
      total += (
        Math.pow(predictedCumulative[0] - actualCumulative[0], 2)
        + Math.pow(predictedCumulative[1] - actualCumulative[1], 2)
      ) / 2;
    } else {
      total -= Math.log(Math.max(1e-15, probabilities[actual]));
    }
    count += 1;
  }
  if (!count) throw new Error("Nessuna partita valutata durante il tuning.");
  return total / count;
}

function getPath(object, keys) {
  return keys.reduce((accumulator, key) => accumulator?.[key], object);
}

function withPath(object, keys, value) {
  const clone = structuredClone(object);
  let cursor = clone;
  for (let index = 0; index < keys.length - 1; index += 1) cursor = cursor[keys[index]];
  cursor[keys.at(-1)] = value;
  return clone;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function coordinateDescent(chronological, candidates, options) {
  let current = structuredClone(DEFAULT_HYPERPARAMETERS);
  let currentScore = score(chronological, candidates, current, options.metric);
  const startingScore = currentScore;
  const history = [{ round: 0, score: round(currentScore) }];

  for (let iteration = 1; iteration <= options.rounds; iteration += 1) {
    let improved = false;
    for (const dimension of SEARCH_SPACE) {
      const value = getPath(current, dimension.path);
      const step = dimension.step / iteration; // passo più piccolo ad ogni round: affina invece di oscillare
      for (const delta of [step, -step]) {
        const candidateValue = round(clampNumber(value + delta, dimension.min, dimension.max), 6);
        if (candidateValue === value) continue;
        const candidateHyperparameters = withPath(current, dimension.path, candidateValue);
        const candidateScore = score(chronological, candidates, candidateHyperparameters, options.metric);
        if (candidateScore < currentScore) {
          current = candidateHyperparameters;
          currentScore = candidateScore;
          improved = true;
        }
      }
    }
    history.push({ round: iteration, score: round(currentScore) });
    console.error(`Round ${iteration}/${options.rounds}: ${options.metric}=${round(currentScore)}`);
    if (!improved) {
      console.error("Nessun miglioramento in questo round: convergenza locale, mi fermo qui.");
      break;
    }
  }

  return { hyperparameters: current, startingScore: round(startingScore), finalScore: round(currentScore), history };
}

function diffFromDefault(tuned) {
  const changes = {};
  for (const dimension of SEARCH_SPACE) {
    const before = getPath(DEFAULT_HYPERPARAMETERS, dimension.path);
    const after = getPath(tuned, dimension.path);
    if (before !== after) changes[dimension.path.join(".")] = { before, after };
  }
  return changes;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const datasetPath = path.resolve(root, options.file);
  const payload = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const { chronological, candidates } = prepare(unpackPayload(payload), options);
  console.error(`Tuning su ${candidates.length} partite (${options.competition || "tutte le competizioni"}), metrica=${options.metric}, ${options.rounds} round.`);

  const result = coordinateDescent(chronological, candidates, options);
  const improvementPct = round((1 - result.finalScore / result.startingScore) * 100, 2);

  console.log(JSON.stringify({
    matchesEvaluated: candidates.length,
    metric: options.metric,
    scoreBefore: result.startingScore,
    scoreAfter: result.finalScore,
    improvementPct,
    changedParameters: diffFromDefault(result.hyperparameters),
    hyperparameters: result.hyperparameters,
    history: result.history,
    warning: "Tuning fatto su una sola finestra: valida su un periodo successivo e non usato qui (backtest_model.mjs / backtest_vs_market.mjs) prima di fidarti di questi valori. Rischio di overfitting reale con 16 dimensioni e un solo campione.",
  }, null, 2));
} catch (error) {
  console.error(`Tuning fallito: ${error.message}`);
  process.exitCode = 1;
}
