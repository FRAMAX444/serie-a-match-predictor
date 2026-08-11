#!/usr/bin/env node
// Confronta le probabilità del modello con quelle implicite nelle quote di chiusura
// (Football-Data.co.uk: media di mercato, altrimenti Bet365, altrimenti Pinnacle — vedi
// parse_csv() in update_europe_data.py). Richiede che data/matches.json contenga
// home_odds/draw_odds/away_odds: verifica che scripts/update_top5_data.py sia aggiornato
// (MATCH_FIELDS deve includerle) e che il dataset sia stato rigenerato dopo la modifica.
//
// backtest_model.mjs risponde a "il modello è calibrato?". Questo script risponde alla
// domanda che conta per l'uso profittevole: "il modello sa qualcosa che il mercato non
// sa già?". Senza questo confronto, un log loss basso in isolamento non dice nulla sul
// battere il mercato: le quote di chiusura sono già un ottimo stimatore.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);

function parseArguments(argv) {
  const options = { file: "data/matches.json", competition: "", since: "", max: 2000, edgeThreshold: 0.04 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 2000);
    else if (argument === "--edge-threshold") options.edgeThreshold = Math.max(0, Number(argv[++index]) || 0.04);
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

// Rimozione proporzionale del margine (overround). È il metodo di de-vig più semplice:
// non corregge il favourite-longshot bias (per quello serve il metodo di Shin), ma è
// sufficiente per stabilire se esiste un vantaggio grezzo prima di raffinare oltre.
function devigMarket(homeOdds, drawOdds, awayOdds) {
  const rawHome = 1 / homeOdds;
  const rawDraw = 1 / drawOdds;
  const rawAway = 1 / awayOdds;
  const overround = rawHome + rawDraw + rawAway;
  return { probabilities: [rawHome / overround, rawDraw / overround, rawAway / overround], overround };
}

function hasValidOdds(match) {
  return [match.home_odds, match.draw_odds, match.away_odds]
    .every((value) => Number.isFinite(Number(value)) && Number(value) > 1);
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

  const withOdds = rows.filter(({ match }) => hasValidOdds(match));
  const count = withOdds.length;
  if (!count) {
    throw new Error(
      "Nessuna delle partite valutate ha home_odds/draw_odds/away_odds. "
      + "Verifica che MATCH_FIELDS in update_top5_data.py includa i campi quote "
      + "e rigenera data/matches.json prima di rilanciare questo backtest.",
    );
  }

  let modelLogLoss = 0;
  let marketLogLoss = 0;
  let modelBrier = 0;
  let marketBrier = 0;
  let overroundSum = 0;
  const signedEdge = [0, 0, 0]; // media (probabilità modello − probabilità mercato) per 1 / X / 2

  let bets = 0;
  let staked = 0;
  let returned = 0;
  let betsWon = 0;

  withOdds.forEach(({ match, result }) => {
    const modelProbabilities = [result.probabilities.homeWin, result.probabilities.draw, result.probabilities.awayWin];
    const odds = [Number(match.home_odds), Number(match.draw_odds), Number(match.away_odds)];
    const { probabilities: marketProbabilities, overround } = devigMarket(...odds);
    const actual = resultIndex(match);
    overroundSum += overround;

    modelLogLoss -= Math.log(Math.max(1e-15, modelProbabilities[actual]));
    marketLogLoss -= Math.log(Math.max(1e-15, marketProbabilities[actual]));

    modelProbabilities.forEach((probability, index) => {
      modelBrier += (probability - (index === actual ? 1 : 0)) ** 2;
      marketBrier += (marketProbabilities[index] - (index === actual ? 1 : 0)) ** 2;
      signedEdge[index] += probability - marketProbabilities[index];

      const edge = probability - marketProbabilities[index];
      if (edge > options.edgeThreshold) {
        bets += 1;
        staked += 1;
        if (index === actual) {
          returned += odds[index];
          betsWon += 1;
        }
      }
    });
  });

  return {
    matchesEvaluated: rows.length,
    matchesWithOdds: count,
    oddsCoverage: round(count / rows.length),
    averageOverround: round(overroundSum / count),
    logLoss: { model: round(modelLogLoss / count), market: round(marketLogLoss / count) },
    brier: { model: round(modelBrier / count), market: round(marketBrier / count) },
    note_logloss: "Se logLoss.model > logLoss.market, il mercato de-vigato batte il modello: nessun edge da sfruttare, a prescindere da quanto sembri buono il modello preso da solo.",
    averageSignedEdge: { home: round(signedEdge[0] / count), draw: round(signedEdge[1] / count), away: round(signedEdge[2] / count) },
    valueBetSimulation: {
      edgeThreshold: options.edgeThreshold,
      bets,
      betsWon,
      hitRate: bets ? round(betsWon / bets) : null,
      staked: round(staked),
      returned: round(returned),
      roi: staked ? round((returned - staked) / staked) : null,
      note: "Puntata fissa (1 unità) sulle sole occasioni con edge > soglia, a scopo diagnostico. Non tiene conto di limitazioni dei bookmaker, movimento delle quote dopo la puntata né costi di esecuzione. Con poche centinaia di scommesse la varianza campionaria domina: guarda l'intervallo, non il singolo ROI.",
    },
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
  console.error(`Backtest vs mercato fallito: ${error.message}`);
  process.exitCode = 1;
}
