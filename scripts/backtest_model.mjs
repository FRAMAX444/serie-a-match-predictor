#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);

function parseArguments(argv) {
  const options = { file: "data/matches.json", competition: "", since: "", max: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 1000);
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  if (options.competition && !SUPPORTED.has(options.competition)) {
    throw new Error(`Competizione non supportata: ${options.competition}`);
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

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function evaluate(matches, options) {
  const chronological = matches
    .filter((match) => SUPPORTED.has(String(match.competition_id)))
    .filter((match) => match.home_goals !== null && match.home_goals !== undefined)
    .filter((match) => match.away_goals !== null && match.away_goals !== undefined)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

  const position = new Map(chronological.map((match, index) => [match, index]));
  let candidates = chronological.filter((match) => !options.competition || match.competition_id === options.competition);
  if (options.since) candidates = candidates.filter((match) => String(match.date) >= options.since);
  candidates = candidates.slice(-options.max);

  const rows = [];
  for (const match of candidates) {
    if ((position.get(match) ?? 0) < 100) continue;
    try {
      const result = predictFromMatches(chronological, {
        homeTeam: match.home_team,
        awayTeam: match.away_team,
        date: match.date,
        cutoffDate: match.date,
        competitionId: match.competition_id,
      });
      rows.push({ match, result });
    } catch (error) {
      if (!/Dati recenti insufficienti/i.test(String(error?.message || error))) throw error;
    }
  }
  if (!rows.length) throw new Error("Nessuna partita valutabile con almeno 100 gare precedenti.");

  let logLoss = 0;
  let brier = 0;
  let rankedProbabilityScore = 0;
  let correct = 0;
  rows.forEach(({ match, result }) => {
    const probabilities = [result.probabilities.homeWin, result.probabilities.draw, result.probabilities.awayWin];
    const actual = resultIndex(match);
    logLoss -= Math.log(Math.max(1e-15, probabilities[actual]));
    probabilities.forEach((probability, index) => {
      brier += Math.pow(probability - (index === actual ? 1 : 0), 2);
    });
    const predictedCumulative = [probabilities[0], probabilities[0] + probabilities[1]];
    const actualCumulative = [actual === 0 ? 1 : 0, actual <= 1 ? 1 : 0];
    rankedProbabilityScore += (
      Math.pow(predictedCumulative[0] - actualCumulative[0], 2)
      + Math.pow(predictedCumulative[1] - actualCumulative[1], 2)
    ) / 2;
    const predicted = probabilities.indexOf(Math.max(...probabilities));
    if (predicted === actual) correct += 1;
  });

  const count = rows.length;
  return {
    modelVersion: rows.at(-1).result.modelVersion,
    matches: count,
    firstDate: rows[0].match.date,
    lastDate: rows.at(-1).match.date,
    competition: options.competition || "tutte",
    logLoss: round(logLoss / count),
    multiclassBrier: round(brier / count),
    rankedProbabilityScore: round(rankedProbabilityScore / count),
    accuracy: round(correct / count),
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const datasetPath = path.resolve(root, options.file);
  const payload = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const report = evaluate(unpackPayload(payload), options);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Backtest fallito: ${error.message}`);
  process.exitCode = 1;
}
