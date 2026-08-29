#!/usr/bin/env node
// Diagnostica di calibrazione: NON è un altro backtest riassuntivo (per quello c'è
// backtest_model.mjs), ma la scomposizione che serve per capire *dove* il modello sbaglia.
//
// Tre livelli, dal più aggregato al più fine:
//   1. calibrazione dei lambda   -> il modello prevede in media il numero giusto di gol?
//   2. calibrazione marginale    -> la somma delle probabilità 1/X/2 previste corrisponde
//                                   alla frequenza osservata di 1/X/2?
//   3. reliability per fascia    -> quando dice "35-40%", succede davvero nel 35-40% dei casi?
//
// Un modello può avere log loss accettabile e comunque avere un bias sistematico su un solo
// esito (tipicamente il pareggio, che i modelli Poisson indipendenti sotto-stimano): il log
// loss aggregato lo nasconde, la calibrazione marginale no.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);
const OUTCOMES = ["home", "draw", "away"];

function parseArguments(argv) {
  const options = { file: "data/matches.json", competition: "", since: "", until: "", max: 3000, bins: 10, json: "", by: "", hyperparameters: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--until") options.until = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 3000);
    else if (argument === "--bins") options.bins = Math.max(2, Number(argv[++index]) || 10);
    else if (argument === "--json") options.json = String(argv[++index] || "");
    else if (argument === "--by") options.by = String(argv[++index] || "");
    else if (argument === "--hyperparameters") options.hyperparameters = JSON.parse(String(argv[++index] || "null"));
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
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

const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

export function collectRows(matches, options) {
  const chronological = matches
    .filter((match) => SUPPORTED.has(String(match.competition_id)))
    .filter((match) => match.home_goals !== null && match.home_goals !== undefined)
    .filter((match) => match.away_goals !== null && match.away_goals !== undefined)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

  const position = new Map(chronological.map((match, index) => [match, index]));
  // "europe" e "domestic" sono gruppi, non competizioni: servono a stimare o valutare la
  // calibrazione su un regime intero. La misura che li ha resi necessari: i parametri
  // ricalibrati peggiorano tutte e cinque le leghe (-0.0018 ... -0.0030) e migliorano tutte
  // e tre le coppe (+0.0021 ... +0.0035), quindi una calibrazione unica è un compromesso fra
  // due regimi e il numero aggregato (+0.0001) non descrive nessuno dei due.
  const EUROPE_GROUP = new Set(["ucl", "uel", "uecl"]);
  const DOMESTIC_GROUP = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
  const inScope = (match) => {
    if (!options.competition) return true;
    if (options.competition === "europe") return EUROPE_GROUP.has(String(match.competition_id));
    if (options.competition === "domestic") return DOMESTIC_GROUP.has(String(match.competition_id));
    return match.competition_id === options.competition;
  };
  let candidates = chronological.filter(inScope);
  if (options.since) candidates = candidates.filter((match) => String(match.date) >= options.since);
  if (options.until) candidates = candidates.filter((match) => String(match.date) <= options.until);
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
        // R4/R12: la calibrazione va ristimata sui lambda che il modello produce DAVVERO,
        // quindi con gli stessi iperparametri con cui girerà. Senza questo, attivare un
        // parametro e poi ricalibrare significherebbe calibrare un modello diverso da
        // quello che si vuole spedire.
        hyperparameters: options.hyperparameters || null,
      });
      rows.push({ match, result });
    } catch (error) {
      if (!/Dati recenti insufficienti/i.test(String(error?.message || error))) throw error;
    }
  }
  return rows;
}

// R5 del brief: un guadagno aggregato che nasconde un peggioramento su un segmento non è un
// guadagno, e la calibrazione marginale aggregata è proprio la misura che lo nasconde meglio.
// Il caso concreto che ha motivato questa aggiunta: la copertura xG va dal 90% della Serie A
// al 23% della Bundesliga, quindi il modello che il numero aggregato descrive è la media di
// due modelli diversi — uno con gli xG e uno che, sotto la stessa etichetta, pesa i tiri 0.68.
//
// analyse() è già una funzione pura delle righe, quindi segmentare significa raggrupparle e
// richiamarla: nessuna seconda implementazione della calibrazione da tenere allineata.
const SEGMENTERS = {
  league: {
    order: ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "ucl", "uel", "uecl"],
    of: ({ match }) => String(match.competition_id),
  },
  xgcoverage: {
    order: ["0-25%", "25-50%", "50-75%", "75-100%"],
    of: ({ result }) => (result.xgCoverage < 0.25 ? "0-25%" : result.xgCoverage < 0.5 ? "25-50%" : result.xgCoverage < 0.75 ? "50-75%" : "75-100%"),
  },
  phase: {
    order: ["01-03", "04-06", "07-10", "11-19", "20+"],
    of: ({ match }) => {
      const phase = match.__phase || 99;
      return phase <= 3 ? "01-03" : phase <= 6 ? "04-06" : phase <= 10 ? "07-10" : phase <= 19 ? "11-19" : "20+";
    },
  },
};

// La "giornata effettiva" è la n-esima partita stagionale della squadra meno esperta delle
// due, non il numero di turno del calendario: è la quantità che conta per il modello, che
// non sa nulla dei turni e sa solo quante partite ha visto di quella squadra.
export function annotateSeasonPhase(matches) {
  const counter = new Map();
  for (const match of matches) {
    const homeKey = `${match.season}|${match.home_team}`;
    const awayKey = `${match.season}|${match.away_team}`;
    const home = (counter.get(homeKey) || 0) + 1;
    const away = (counter.get(awayKey) || 0) + 1;
    counter.set(homeKey, home);
    counter.set(awayKey, away);
    match.__phase = Math.min(home, away);
  }
  return matches;
}

function reliability(pairs, bins) {
  // pairs: [{ probability, hit }]. Bin a larghezza fissa su [0,1].
  const table = Array.from({ length: bins }, () => ({ count: 0, predicted: 0, observed: 0 }));
  pairs.forEach(({ probability, hit }) => {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(probability * bins)));
    table[index].count += 1;
    table[index].predicted += probability;
    table[index].observed += hit ? 1 : 0;
  });
  let expectedCalibrationError = 0;
  const total = pairs.length || 1;
  const rows = table.map((bucket, index) => {
    const predicted = bucket.count ? bucket.predicted / bucket.count : null;
    const observed = bucket.count ? bucket.observed / bucket.count : null;
    if (bucket.count) expectedCalibrationError += (bucket.count / total) * Math.abs(predicted - observed);
    return {
      range: `${round(index / bins, 2)}-${round((index + 1) / bins, 2)}`,
      count: bucket.count,
      predicted: round(predicted, 4),
      observed: round(observed, 4),
      gap: predicted === null ? null : round(observed - predicted, 4),
    };
  }).filter((bucket) => bucket.count > 0);
  return { expectedCalibrationError: round(expectedCalibrationError, 4), bins: rows };
}

export function analyse(rows, bins = 10) {
  if (!rows.length) throw new Error("Nessuna partita valutabile.");
  const totals = {
    lambdaHome: 0, lambdaAway: 0, goalsHome: 0, goalsAway: 0,
    predicted: { home: 0, draw: 0, away: 0 },
    observed: { home: 0, draw: 0, away: 0 },
    over25Predicted: 0, over25Observed: 0,
    bttsPredicted: 0, bttsObserved: 0,
  };
  const pairs = { home: [], draw: [], away: [] };

  rows.forEach(({ match, result }) => {
    const homeGoals = Number(match.home_goals);
    const awayGoals = Number(match.away_goals);
    const outcome = homeGoals > awayGoals ? "home" : homeGoals === awayGoals ? "draw" : "away";
    const probability = {
      home: result.probabilities.homeWin,
      draw: result.probabilities.draw,
      away: result.probabilities.awayWin,
    };
    totals.lambdaHome += result.lambdaHome;
    totals.lambdaAway += result.lambdaAway;
    totals.goalsHome += homeGoals;
    totals.goalsAway += awayGoals;
    totals.over25Predicted += result.probabilities.over25;
    totals.over25Observed += homeGoals + awayGoals >= 3 ? 1 : 0;
    totals.bttsPredicted += result.probabilities.bothScore;
    totals.bttsObserved += homeGoals > 0 && awayGoals > 0 ? 1 : 0;
    OUTCOMES.forEach((key) => {
      totals.predicted[key] += probability[key];
      totals.observed[key] += outcome === key ? 1 : 0;
      pairs[key].push({ probability: probability[key], hit: outcome === key });
    });
  });

  const count = rows.length;
  const marginal = Object.fromEntries(OUTCOMES.map((key) => [key, {
    predicted: round(totals.predicted[key] / count),
    observed: round(totals.observed[key] / count),
    bias: round((totals.predicted[key] - totals.observed[key]) / count),
  }]));

  return {
    matches: count,
    firstDate: rows[0].match.date,
    lastDate: rows.at(-1).match.date,
    goals: {
      lambdaHome: round(totals.lambdaHome / count, 3),
      actualHome: round(totals.goalsHome / count, 3),
      lambdaAway: round(totals.lambdaAway / count, 3),
      actualAway: round(totals.goalsAway / count, 3),
      // Un bias positivo = il modello si aspetta più gol di quanti se ne segnino davvero.
      biasHome: round((totals.lambdaHome - totals.goalsHome) / count, 3),
      biasAway: round((totals.lambdaAway - totals.goalsAway) / count, 3),
    },
    marginal,
    derivedMarkets: {
      over25: { predicted: round(totals.over25Predicted / count), observed: round(totals.over25Observed / count), bias: round((totals.over25Predicted - totals.over25Observed) / count) },
      btts: { predicted: round(totals.bttsPredicted / count), observed: round(totals.bttsObserved / count), bias: round((totals.bttsPredicted - totals.bttsObserved) / count) },
    },
    reliability: Object.fromEntries(OUTCOMES.map((key) => [key, reliability(pairs[key], bins)])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const payload = JSON.parse(fs.readFileSync(path.resolve(root, options.file), "utf8"));
    const matches = unpackPayload(payload);
    if (options.by === "phase") {
      annotateSeasonPhase(matches.slice().sort((left, right) => String(left.date).localeCompare(String(right.date))));
    }
    const rows = collectRows(matches, options);
    const report = analyse(rows, options.bins);
    if (options.by) {
      const segmenter = SEGMENTERS[options.by];
      if (!segmenter) throw new Error(`--by non riconosciuto: ${options.by} (usa ${Object.keys(SEGMENTERS).join(", ")})`);
      const grouped = new Map();
      for (const row of rows) {
        const key = segmenter.of(row);
        grouped.set(key, [...(grouped.get(key) || []), row]);
      }
      const keys = [...segmenter.order.filter((key) => grouped.has(key)), ...[...grouped.keys()].filter((key) => !segmenter.order.includes(key)).sort()];
      report.segmentedBy = options.by;
      report.segments = Object.fromEntries(keys.map((key) => [key, analyse(grouped.get(key), options.bins)]));
    }
    if (options.json) fs.writeFileSync(path.resolve(root, options.json), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Diagnostica fallita: ${error.message}`);
    process.exitCode = 1;
  }
}
