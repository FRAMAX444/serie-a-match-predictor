#!/usr/bin/env node
// Stima i parametri di calibrazione di model.js (blocco `calibration` di
// DEFAULT_HYPERPARAMETERS) su una finestra di training e li valida su una finestra
// successiva mai usata per la stima.
//
// Perché serve. La diagnostica (scripts/diagnose_calibration.mjs) mostra un difetto
// sistematico, non rumore: il modello è SOVRA-SICURO. Quando dà 74% a una vittoria esterna
// succede il 54% delle volte; quando dà 15% a una vittoria casalinga succede il 23%. La curva
// di affidabilità è più piatta della diagonale su entrambi i lati — il pattern classico di un
// modello i cui rapporti di forza sono troppo estremi.
//
// Cosa NON facciamo: temperature scaling sulle tre probabilità finali. Sarebbe il rimedio da
// manuale, ma romperebbe la coerenza interna del modello — Over 2.5, BTTS e i risultati esatti
// derivano tutti dalla stessa matrice di punteggio, e ricalibrare solo l'1X2 li lascerebbe
// incoerenti con l'1X2 mostrato accanto.
//
// Cosa facciamo: ricalibriamo i due lambda PRIMA di costruire la matrice. In coordinate
// log rispetto alla baseline di competizione,
//     sH = ln(lambdaHome / league.homeGoals),  sA = ln(lambdaAway / league.awayGoals)
// si separano il livello (quanti gol in totale) e l'asimmetria (chi è più forte):
//     level = (sH + sA)/2       asymmetry = (sH - sA)/2
// La sovra-sicurezza è un eccesso di ASIMMETRIA, non di livello (il bias su Over 2.5 è già
// solo -0.5pp): comprimendo l'asimmetria di un fattore < 1 le probabilità 1X2 si avvicinano
// alla frequenza reale mentre il numero di gol atteso resta quello di prima, e tutti i mercati
// derivati restano coerenti tra loro perché continuano a venire da un'unica matrice.
//
// I quattro parametri stimati qui sono quindi correzioni di secondo ordine su un modello che
// resta strutturalmente lo stesso, non un nuovo modello: `asymmetryShrink` (compressione
// dell'asimmetria), `levelShrink` e `levelShift` (livello dei gol), `venueTilt` (residuo
// casa/trasferta), più `rho` di Dixon-Coles ristimato insieme a loro.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HYPERPARAMETERS, matrixProbabilities, scoreMatrix, applyCalibration } from "../model.js";
import { collectRows } from "./diagnose_calibration.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = {
    file: "data/matches.json",
    competition: "",
    trainUntil: "",
    max: 6000,
    cache: "",
    metric: "combined",
    // Iperparametri con cui produrre i lambda grezzi da calibrare (R4): la calibrazione
    // stimata su un modello e applicata a un altro non è la calibrazione di nessuno dei due.
    hyperparameters: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--train-until") options.trainUntil = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 6000);
    else if (argument === "--cache") options.cache = String(argv[++index] || "");
    else if (argument === "--metric") options.metric = String(argv[++index] || "logLoss");
    else if (argument === "--hyperparameters") options.hyperparameters = JSON.parse(String(argv[++index] || "null"));
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  return options;
}

function unpackPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.columns) && payload.matches.length && Array.isArray(payload.matches[0])) {
    return payload.matches.map((row) => Object.fromEntries(payload.columns.map((column, index) => [column, row[index]])));
  }
  return payload.matches;
}

// Il passaggio costoso (ricostruire l'Elo e le medie pesate per ogni partita) viene fatto una
// volta sola e messo in cache: la ricerca dei parametri poi lavora sui lambda grezzi già
// calcolati, quindi una valutazione completa costa millisecondi invece di minuti. È questo che
// rende praticabile una coordinate descent con centinaia di valutazioni.
function buildSamples(options) {
  if (options.cache && fs.existsSync(path.resolve(ROOT, options.cache))) {
    return JSON.parse(fs.readFileSync(path.resolve(ROOT, options.cache), "utf8"));
  }
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, options.file), "utf8"));
  const rows = collectRows(unpackPayload(payload), options);
  const samples = rows.map(({ match, result }) => ({
    date: String(match.date).slice(0, 10),
    competitionId: String(match.competition_id || ""),
    homeGoals: Number(match.home_goals),
    awayGoals: Number(match.away_goals),
    rawLambdaHome: result.rawLambdaHome ?? result.lambdaHome,
    rawLambdaAway: result.rawLambdaAway ?? result.lambdaAway,
    baselineHome: result.league.homeGoals,
    baselineAway: result.league.awayGoals,
    quality: result.quality.score,
  }));
  if (options.cache) fs.writeFileSync(path.resolve(ROOT, options.cache), JSON.stringify(samples));
  return samples;
}

const binaryLogLoss = (probability, hit) => -Math.log(Math.max(1e-15, hit ? probability : 1 - probability));

// La metrica `combined` è quella da usare per stimare i parametri, e il motivo non è
// estetico. Livello e asimmetria sono ortogonali per costruzione, ma il log loss 1X2 è quasi
// insensibile al livello: sposta la somma dei lambda del 10% e l'1X2 cambia a malapena. Una
// ricerca guidata dal solo 1X2 usa quindi `levelShift` come variabile libera e la spinge dove
// capita — nella prima versione di questo fitter l'ha portata a +0.11, migliorando l'1X2 e
// contemporaneamente gonfiando Over 2.5 di 4.6 punti e BTTS di 5.2. Sommando anche il log loss
// di Over 2.5 e BTTS ogni parametro viene vincolato dalla parte di dati che lo identifica
// davvero, e nessun mercato mostrato nell'app resta fuori dalla funzione obiettivo.
function scoreSamples(samples, calibration, rho) {
  let logLoss = 0;
  let rankedProbabilityScore = 0;
  let brier = 0;
  let correct = 0;
  let over25LogLoss = 0;
  let bttsLogLoss = 0;
  let over25Predicted = 0;
  let over25Observed = 0;
  let goalsPredicted = 0;
  let goalsObserved = 0;
  for (const sample of samples) {
    const { lambdaHome, lambdaAway } = applyCalibration(
      sample.rawLambdaHome,
      sample.rawLambdaAway,
      sample.baselineHome,
      sample.baselineAway,
      sample.quality,
      calibration,
    );
    const probabilities = matrixProbabilities(scoreMatrix(lambdaHome, lambdaAway, 8, rho));
    const vector = [probabilities.homeWin, probabilities.draw, probabilities.awayWin];
    const actual = sample.homeGoals > sample.awayGoals ? 0 : sample.homeGoals === sample.awayGoals ? 1 : 2;
    logLoss -= Math.log(Math.max(1e-15, vector[actual]));
    vector.forEach((probability, index) => {
      brier += (probability - (index === actual ? 1 : 0)) ** 2;
    });
    const cumulative = [vector[0], vector[0] + vector[1]];
    const actualCumulative = [actual === 0 ? 1 : 0, actual <= 1 ? 1 : 0];
    rankedProbabilityScore += ((cumulative[0] - actualCumulative[0]) ** 2 + (cumulative[1] - actualCumulative[1]) ** 2) / 2;
    if (vector.indexOf(Math.max(...vector)) === actual) correct += 1;

    const over25Hit = sample.homeGoals + sample.awayGoals >= 3;
    const bttsHit = sample.homeGoals > 0 && sample.awayGoals > 0;
    over25LogLoss += binaryLogLoss(probabilities.over25, over25Hit);
    bttsLogLoss += binaryLogLoss(probabilities.bothScore, bttsHit);
    over25Predicted += probabilities.over25;
    over25Observed += over25Hit ? 1 : 0;
    goalsPredicted += lambdaHome + lambdaAway;
    goalsObserved += sample.homeGoals + sample.awayGoals;
  }
  const count = samples.length || 1;
  return {
    logLoss: logLoss / count,
    rankedProbabilityScore: rankedProbabilityScore / count,
    brier: brier / count,
    accuracy: correct / count,
    over25LogLoss: over25LogLoss / count,
    bttsLogLoss: bttsLogLoss / count,
    over25Bias: (over25Predicted - over25Observed) / count,
    goalsBias: (goalsPredicted - goalsObserved) / count,
    combined: (logLoss + over25LogLoss + bttsLogLoss) / count,
    matches: samples.length,
  };
}

// Coordinate descent con griglia che si restringe. Cinque parametri e una funzione obiettivo
// che si valuta in millisecondi: non serve nulla di più sofisticato, e una discesa per
// coordinate è ispezionabile (si vede quale parametro ha prodotto quale guadagno) mentre un
// ottimizzatore black-box no.
const SEARCH_SPACE = {
  asymmetryShrink: [0.3, 1.15],
  asymmetryShrinkLowQuality: [0.0, 1.15],
  levelShrink: [0.2, 1.2],
  levelShift: [-0.2, 0.2],
  venueTilt: [-0.15, 0.15],
  rho: [-0.2, 0.05],
};

function searchParameters(samples, metric, verbose = true) {
  const keys = Object.keys(SEARCH_SPACE);
  let current = {
    asymmetryShrink: 1,
    asymmetryShrinkLowQuality: 1,
    levelShrink: 1,
    levelShift: 0,
    venueTilt: 0,
    rho: DEFAULT_HYPERPARAMETERS.rho,
  };
  const evaluate = (parameters) => {
    const { rho, ...calibration } = parameters;
    return scoreSamples(samples, calibration, rho)[metric];
  };
  let best = evaluate(current);
  let scale = 1;
  for (let sweep = 0; sweep < 7; sweep += 1) {
    let improved = false;
    for (const key of keys) {
      const [low, high] = SEARCH_SPACE[key];
      const width = ((high - low) / 2) * scale;
      const steps = 9;
      for (let step = 0; step < steps; step += 1) {
        const value = Math.min(high, Math.max(low, current[key] - width + (2 * width * step) / (steps - 1)));
        const score = evaluate({ ...current, [key]: value });
        if (score < best - 1e-9) {
          best = score;
          current = { ...current, [key]: value };
          improved = true;
        }
      }
    }
    if (verbose) console.error(`  sweep ${sweep} scale=${scale.toFixed(3)} ${metric}=${best.toFixed(5)} ${JSON.stringify(current)}`);
    if (!improved && scale <= 0.05) break;
    scale *= 0.5;
  }
  return { parameters: current, score: best };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const samples = buildSamples(options);
  if (!samples.length) throw new Error("Nessun campione raccolto.");

  const trainUntil = options.trainUntil || samples[Math.floor(samples.length * 0.7)].date;
  const train = samples.filter((sample) => sample.date <= trainUntil);
  const holdout = samples.filter((sample) => sample.date > trainUntil);
  if (!train.length || !holdout.length) throw new Error("Split train/holdout vuoto: cambia --train-until.");

  console.error(`Campioni: ${samples.length} (train ${train.length} fino a ${trainUntil}, holdout ${holdout.length})`);
  const { parameters } = searchParameters(train, options.metric);
  const { rho, ...calibration } = parameters;
  const neutral = { asymmetryShrink: 1, asymmetryShrinkLowQuality: 1, levelShrink: 1, levelShift: 0, venueTilt: 0 };

  console.log(JSON.stringify({
    trainUntil,
    fitted: parameters,
    train: {
      before: scoreSamples(train, neutral, DEFAULT_HYPERPARAMETERS.rho),
      after: scoreSamples(train, calibration, rho),
    },
    holdout: {
      before: scoreSamples(holdout, neutral, DEFAULT_HYPERPARAMETERS.rho),
      after: scoreSamples(holdout, calibration, rho),
    },
  }, null, 2));
} catch (error) {
  console.error(`Fit calibrazione fallito: ${error.message}`);
  process.exitCode = 1;
}
