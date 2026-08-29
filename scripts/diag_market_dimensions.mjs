#!/usr/bin/env node
// Il modello e' dietro il mercato sull'1X2. La domanda che questo script chiude in un'esecuzione
// e' se lo sia allo stesso modo sulle DUE dimensioni che la matrice dei punteggi produce
// separatamente:
//
//   asimmetria  -> chi vince, misurata dall'1X2;
//   livello     -> quanti gol in totale, misurato dall'Over/Under 2.5.
//
// La calibrazione della 6.0 le tratta gia' come cose distinte (levelShrink 0.45 contro
// asymmetryShrink 0.71: il livello viene compresso quasi il doppio), il che rende legittimo
// chiedersi se il divario sia tutto sull'asimmetria. Se sull'Over/Under il divario e'
// sensibilmente piu' piccolo, c'e' qualcosa di reale da guardare; se e' uguale o peggiore, la
// domanda e' chiusa.
//
// Terza misura, quella che il denaro segue davvero: il movimento apertura -> chiusura. Se il
// disaccordo del modello con la linea di APERTURA predice la direzione in cui la linea si muove
// fino alla CHIUSURA, il modello sa qualcosa in anticipo. Se non lo predice, il disaccordo e'
// rumore — ed e' esattamente la differenza fra "valore" e "imprecisione".
import fs from "node:fs";
import { predictFromMatches, deriveMarkets } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";
import { mean, standardError } from "./paired_stats.mjs";

const LEAGUES = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);

function parseArguments(argv) {
  const options = { file: "data/matches.json", since: "", max: 20000, competition: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 20000);
    else if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--dataset") options.file = String(argv[++index] || "");
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  return options;
}

const number = (value) => Number(value);
const valid = (value) => Number.isFinite(number(value)) && number(value) > 1;
const logLoss = (probability) => -Math.log(Math.max(1e-15, probability));

// De-vig proporzionale, lo stesso di backtest_vs_market.mjs: non corregge il favourite-longshot
// bias, ma e' sufficiente a stabilire chi e' davanti.
function devig(...odds) {
  const raw = odds.map((value) => 1 / number(value));
  const overround = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / overround);
}

function summarise(label, modelLosses, marketLosses) {
  const differences = modelLosses.map((loss, index) => loss - marketLosses[index]);
  const gap = mean(differences);
  const error = standardError(differences);
  const market = mean(marketLosses);
  return {
    label,
    n: differences.length,
    model: mean(modelLosses),
    market,
    gap,
    error,
    sigma: gap / error,
    relative: gap / market,
  };
}

function printComparison(rows) {
  console.log("dimensione            n      modello   mercato    divario ±  e.s.      σ      % del mercato");
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(20)} ${String(row.n).padStart(5)}  `
      + `${row.model.toFixed(4)}   ${row.market.toFixed(4)}   `
      + `${(row.gap >= 0 ? "+" : "") + row.gap.toFixed(4)} ± ${row.error.toFixed(4)}  `
      + `${row.sigma.toFixed(1).padStart(5)}  ${(row.relative * 100).toFixed(2)}%`,
    );
  }
}

// Il modello e' d'accordo con la linea di apertura o no; poi la linea si muove fino alla
// chiusura. Se i due segni coincidono piu' spesso del caso, il disaccordo era informazione.
function movementReport(label, rows) {
  const aligned = rows.filter((row) => Math.abs(row.disagreement) > 1e-9 && Math.abs(row.move) > 1e-9);
  if (aligned.length < 30) return null;
  const signed = aligned.map((row) => Math.sign(row.disagreement) * row.move);
  const share = aligned.filter((row) => Math.sign(row.disagreement) === Math.sign(row.move)).length / aligned.length;
  return {
    label,
    n: aligned.length,
    share,
    captured: mean(signed),
    error: standardError(signed),
    sigma: mean(signed) / standardError(signed),
  };
}

function run() {
  const options = parseArguments(process.argv.slice(2));
  const payload = JSON.parse(fs.readFileSync(options.file, "utf8"));
  const all = (Array.isArray(payload) ? payload : payload.matches)
    .filter((match) => match.home_goals !== null && match.home_goals !== undefined)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

  let candidates = all.filter((match) => LEAGUES.has(String(match.competition_id)));
  if (options.competition) candidates = candidates.filter((match) => match.competition_id === options.competition);
  if (options.since) candidates = candidates.filter((match) => String(match.date) >= options.since);
  candidates = candidates
    .filter((match) => valid(match.home_odds_close) && valid(match.draw_odds_close) && valid(match.away_odds_close))
    .filter((match) => valid(match.over25_odds_close) && valid(match.under25_odds_close))
    .slice(-options.max);

  if (!candidates.length) {
    throw new Error(
      "Nessuna gara con le quote di chiusura 1X2 e Over/Under. Servono i campi *_odds_close e "
      + "over25_odds_close/under25_odds_close: rigenera data/matches.json con update_top5_data.py "
      + "dopo l'estensione di parse_csv, oppure passa --dataset con una copia che li contenga.",
    );
  }

  const position = new Map(all.map((match, index) => [match, index]));
  const outcome = [];
  const model1x2 = [];
  const market1x2 = [];
  const modelOU = [];
  const marketOU = [];
  const move1x2 = [];
  const moveOU = [];
  const byLeague = new Map();

  for (const match of candidates) {
    if ((position.get(match) ?? 0) < 100) continue;
    let result;
    try {
      // Stessi input di app.js e degli altri backtest, dalla stessa funzione (R14).
      result = predictFromMatches(all, {
        ...modelInputs(),
        homeTeam: match.home_team,
        awayTeam: match.away_team,
        date: match.date,
        cutoffDate: match.date,
        competitionId: match.competition_id,
        season: match.season,
      });
    } catch (error) {
      if (/Dati recenti insufficienti/i.test(String(error?.message || error))) continue;
      throw error;
    }

    const goals = Number(match.home_goals) + Number(match.away_goals);
    const actual = match.home_goals > match.away_goals ? 0 : match.home_goals === match.away_goals ? 1 : 2;
    const modelTriple = [result.probabilities.homeWin, result.probabilities.draw, result.probabilities.awayWin];
    const marketTriple = devig(match.home_odds_close, match.draw_odds_close, match.away_odds_close);

    const over = deriveMarkets(result.probabilities).find((market) => market.key === "OVER25").probability;
    const [marketOver] = devig(match.over25_odds_close, match.under25_odds_close);
    const overHappened = goals >= 3;

    const modelLoss1x2 = logLoss(modelTriple[actual]);
    const marketLoss1x2 = logLoss(marketTriple[actual]);
    const modelLossOU = logLoss(overHappened ? over : 1 - over);
    const marketLossOU = logLoss(overHappened ? marketOver : 1 - marketOver);

    model1x2.push(modelLoss1x2);
    market1x2.push(marketLoss1x2);
    modelOU.push(modelLossOU);
    marketOU.push(marketLossOU);
    outcome.push(match);

    const league = String(match.competition_id);
    if (!byLeague.has(league)) byLeague.set(league, { model1x2: [], market1x2: [], modelOU: [], marketOU: [] });
    const bucket = byLeague.get(league);
    bucket.model1x2.push(modelLoss1x2);
    bucket.market1x2.push(marketLoss1x2);
    bucket.modelOU.push(modelLossOU);
    bucket.marketOU.push(marketLossOU);

    // Movimento apertura -> chiusura, sulla probabilita' di vittoria casalinga e su Over 2.5.
    if (valid(match.home_odds) && valid(match.draw_odds) && valid(match.away_odds)) {
      const [openHome] = devig(match.home_odds, match.draw_odds, match.away_odds);
      move1x2.push({ disagreement: modelTriple[0] - openHome, move: marketTriple[0] - openHome });
    }
    if (valid(match.over25_odds) && valid(match.under25_odds)) {
      const [openOver] = devig(match.over25_odds, match.under25_odds);
      moveOU.push({ disagreement: over - openOver, move: marketOver - openOver });
    }
  }

  console.log(`Dataset: ${options.file}`);
  console.log(`Gare valutate: ${outcome.length}${options.since ? ` dal ${options.since}` : ""}\n`);

  console.log("=== Divario dal mercato di CHIUSURA, per dimensione ===");
  console.log("(divario positivo = il modello perde; confronto appaiato sulle stesse partite)\n");
  printComparison([
    summarise("1X2 (asimmetria)", model1x2, market1x2),
    summarise("O/U 2.5 (livello)", modelOU, marketOU),
  ]);

  console.log("\n=== Per lega ===");
  const perLeague = [];
  for (const [league, bucket] of [...byLeague].sort()) {
    perLeague.push(summarise(`${league} 1X2`, bucket.model1x2, bucket.market1x2));
    perLeague.push(summarise(`${league} O/U`, bucket.modelOU, bucket.marketOU));
  }
  printComparison(perLeague);

  console.log("\n=== Movimento apertura -> chiusura ===");
  console.log("(il disaccordo del modello con l'apertura predice dove va la linea?)\n");
  const movements = [movementReport("1X2 casa", move1x2), movementReport("Over 2.5", moveOU)].filter(Boolean);
  console.log("mercato         n      quote nella nostra direzione   movimento catturato ±  e.s.       σ");
  for (const row of movements) {
    console.log(
      `${row.label.padEnd(14)} ${String(row.n).padStart(5)}  ${(row.share * 100).toFixed(1).padStart(24)}%  `
      + `${(row.captured >= 0 ? "+" : "") + row.captured.toFixed(5)} ± ${row.error.toFixed(5)}  ${row.sigma.toFixed(1).padStart(6)}`,
    );
  }
  console.log(
    "\nUna quota nella nostra direzione oltre il 50% con σ > 2 significa che il modello anticipa il\n"
    + "mercato. Al 50% il disaccordo e' rumore, e un filtro \"punta dove vedo valore\" selezionerebbe\n"
    + "le partite in cui il modello sbaglia di piu'.",
  );
}

run();
