#!/usr/bin/env node
// CANCELLO DI ACCETTAZIONE di T1 (ipotesi P1 di PROMPT-sessione-5.md §5): quanto vale, sul
// dataset ODIERNO, ancorare la matrice dei punteggi alle marginali della linea di mercato.
//
// Perche' esiste PRIMA dell'implementazione: §1.2 di PROMPT-sessione-5.md riporta +0.0285 sull'1X2
// su un dataset piu' piccolo, e quel numero e' l'unica ragione per cui T1 viene aperto. Se il
// guadagno non e' riproducibile oggi, T1 non va implementato — e scoprirlo dopo aver toccato
// model.js significherebbe non sapere piu' se il difetto sta nella misura o nel modello. Questo
// script non tocca nessun file esistente: importa `predictFromMatches` e `scoreMatrix` da
// ../model.js come ogni altro diagnostico e tiene `shinDevig`/`anchorToMarket` in locale finche'
// T1 non li promuove.
//
//   node scripts/diag_market_anchor.mjs                 # tutte le gare (~6 min)
//   node scripts/diag_market_anchor.mjs --max 800       # campionamento DICHIARATO, ~50 s
//   node scripts/diag_market_anchor.mjs --since 2024-08-01
//
// Puro: nessuna rete, legge solo data/matches.json.
//
// SOGLIA PRE-REGISTRATA (R15, P1): guadagno appaiato >= +0.020 sull'1X2 contro ENTRAMBE le linee
// — chiusura E apertura. Scritta qui perche' la decisione non dipenda dall'esito guardato.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, shinDevig, anchorToMarket, matrixProbabilities, deriveMarkets } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";
import { mean, standardError } from "./paired_stats.mjs";

// Solo i Big Five: le coppe hanno copertura quote 0% e non c'e' niente a cui ancorarsi
// (PROMPT-sessione-5.md §1.3). Non e' un filtro di comodo, e' l'intero dominio di T1.
const BIG_FIVE = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"];

// Finestre di R7, le stesse di PROMPT-sessione-5.md §1.1 e di ogni altro diagnostico.
const TRAIN_END = "2025-05-31";
const HOLDOUT_START = "2025-07-08";

// Le due linee. MISTAKES.md §25: un numero sul mercato senza l'etichetta di QUALE prezzo e'
// stato usato non e' leggibile, quindi ogni tabella qui sotto porta la sua linea in testa.
// L'apertura e' il caso peggiore realistico in produzione — the-odds-api restituisce il prezzo
// del momento in cui si guarda la pagina, non quello di chiusura.
const LINES = {
  chiusura: { three: ["home_odds_close", "draw_odds_close", "away_odds_close"], total: ["over25_odds_close", "under25_odds_close"] },
  apertura: { three: ["home_odds", "draw_odds", "away_odds"], total: ["over25_odds", "under25_odds"] },
};

// Le sette righe di PROMPT-sessione-5.md §1.2, lette dalla STESSA matrice via deriveMarkets() —
// cioe' dal percorso di produzione, non da formule riscritte qui. 1X, X2 e 12 sono somme esatte
// dell'1X2 e quindi riproducono le marginali di mercato per costruzione; Over 1.5 e Gol no, e
// sono le due righe che misurano davvero cosa resta del modello dentro la matrice riancorata.
const MARKETS = [
  { name: "1X2", kind: "tre", keys: ["1", "X", "2"], outcome: (m) => (m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2) },
  { name: "Over/Under 2.5", kind: "binario", key: "OVER25", hit: (m) => m.home_goals + m.away_goals >= 3 },
  { name: "X2", kind: "binario", key: "X2", hit: (m) => m.home_goals <= m.away_goals },
  { name: "1X", kind: "binario", key: "1X", hit: (m) => m.home_goals >= m.away_goals },
  { name: "Over 1.5", kind: "binario", key: "OVER15", hit: (m) => m.home_goals + m.away_goals >= 2 },
  { name: "Gol", kind: "binario", key: "GG", hit: (m) => m.home_goals > 0 && m.away_goals > 0 },
  { name: "12", kind: "binario", key: "12", hit: (m) => m.home_goals !== m.away_goals },
];

const logOf = (probability) => -Math.log(Math.max(1e-15, probability));

function parseArguments(argv) {
  const options = { file: "data/matches.json", since: "2023-08-01", max: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--since") options.since = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--max") options.max = Math.max(1, Number(argv[++index]) || 0);
    else if (!argument.startsWith("--")) options.file = argument;
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  return options;
}

// shinDevig e anchorToMarket NON vivono piu' qui. Fino alla promozione di T1 questo script
// ne teneva una copia locale, insieme a scripts/diag_market_execution.mjs e a
// scripts/diag_signal_orthogonality.mjs: tre copie della stessa formula, cioe' tre modi di
// divergere in silenzio. Ora arrivano da model.js, quindi questo banco misura ESATTAMENTE
// il codice che gira in produzione e non una sua riscrittura d'accordo per ora.
//
// Conseguenza da tenere presente leggendo i numeri: anchorToMarket() di model.js risolve
// sulla griglia della produzione (maxGoals 8) e con il suo sharedDispersion, mentre la copia
// locale usava 10 e 0 cablati. E' la differenza giusta — si misura cio' che si esegue — e
// sposta le cifre solo nella quarta decimale.

function loadChronological(file) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const payload = JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
  const matches = Array.isArray(payload) ? payload : payload.matches;
  if (!Array.isArray(matches)) throw new Error("Il dataset non contiene un array matches.");
  return matches.sort((left, right) => String(left.date).localeCompare(String(right.date)));
}

// R14: le stesse opzioni della pagina e di ogni backtest, dalla stessa funzione, un solo spread.
function predictOne(chronological, match) {
  return predictFromMatches(chronological, {
    ...modelInputs(),
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    date: match.date,
    cutoffDate: match.date,
    competitionId: match.competition_id,
    season: match.season,
  });
}

const probabilityByKey = (probabilities) => {
  const table = {};
  for (const entry of deriveMarkets(probabilities)) table[entry.key] = entry.probability;
  return table;
};

const lossesFor = (table, match) => MARKETS.map((market) => (
  market.kind === "tre"
    ? logOf(table[market.keys[market.outcome(match)]])
    : (market.hit(match) ? logOf(table[market.key]) : logOf(1 - table[market.key]))
));

const usable = (match, line) => [...line.three, ...line.total].every((field) => Number(match[field]) > 1);

// Differenza APPAIATA sulle stesse gare: loss(modello) − loss(riancorato), quindi positivo =
// l'ancoraggio migliora. L'errore std e' quello della differenza, non delle due serie separate:
// e' l'appaiamento a rendere la misura precisa, non la numerosita'.
function summarise(rows, lineName, marketIndex) {
  const differences = rows.map((row) => row.model[marketIndex] - row.anchored[lineName][marketIndex]);
  const error = standardError(differences);
  return {
    n: rows.length,
    model: mean(rows.map((row) => row.model[marketIndex])),
    anchored: mean(rows.map((row) => row.anchored[lineName][marketIndex])),
    gain: mean(differences),
    error,
    sigma: mean(differences) / error,
  };
}

function printTable(title, rows, lineName) {
  console.log(`  ${title}  (n = ${rows.length})`);
  console.log("  mercato          | modello | riancorato |      guadagno       | sigma");
  console.log("  " + "-".repeat(70));
  MARKETS.forEach((market, index) => {
    const s = summarise(rows, lineName, index);
    console.log(
      `  ${market.name.padEnd(16)} | ${s.model.toFixed(4).padStart(7)} | ${s.anchored.toFixed(4).padStart(10)}`
      + ` | ${(s.gain >= 0 ? "+" : "") + s.gain.toFixed(4)} ± ${s.error.toFixed(4)} | ${s.sigma.toFixed(1).padStart(5)}`,
    );
  });
  console.log("");
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const chronological = loadChronological(options.file);

  const competitions = new Set(BIG_FIVE);
  let candidates = chronological
    .filter((match) => competitions.has(String(match.competition_id)))
    .filter((match) => match.home_goals !== null && match.home_goals !== undefined)
    .filter((match) => match.away_goals !== null && match.away_goals !== undefined)
    .filter((match) => String(match.date) >= options.since)
    .filter((match) => Object.values(LINES).every((line) => usable(match, line)));

  // Campionamento DICHIARATO (a passo costante, deterministico) invece di un numero senza
  // copertura: se si riduce il campione bisogna vederlo scritto sopra la tabella.
  let sampling = "nessuno — tutte le gare con entrambe le linee complete";
  if (options.max && candidates.length > options.max) {
    const stride = candidates.length / options.max;
    const sampled = [];
    for (let index = 0; sampled.length < options.max; index += 1) sampled.push(candidates[Math.floor(index * stride)]);
    sampling = `A PASSO COSTANTE: ${options.max} gare su ${candidates.length} (1 ogni ${stride.toFixed(2)})`;
    candidates = sampled;
  }

  console.log("\n=== ANCORAGGIO AL MERCATO — cancello di accettazione di T1 (P1) ===\n");
  console.log("La matrice dei punteggi viene riancorata risolvendo λcasa, λtrasferta e ρ perche'");
  console.log("riproduca esattamente P(1), P(X) e P(Over 2.5) della linea de-vigata con Shin.");
  console.log("Le marginali diventano quelle del mercato; la dipendenza resta quella del modello.");
  console.log("AVVERTENZA: una previsione ancorata ha valore atteso ESATTAMENTE ZERO contro quel");
  console.log("mercato. Questo script misura l'ACCURATEZZA MOSTRATA, non il valore di una giocata.\n");
  console.log(`dataset      : ${options.file}`);
  console.log(`competizioni : ${BIG_FIVE.join(", ")} (le coppe hanno copertura quote 0%)`);
  console.log(`da           : ${options.since}`);
  console.log(`campionamento: ${sampling}`);
  console.log(`gare candidate: ${candidates.length}\n`);

  const records = [];
  const failures = { chiusura: 0, apertura: 0 };
  let maxMarginError = 0;
  let predicted = 0;
  let skipped = 0;
  const started = Date.now();

  for (const match of candidates) {
    let prediction;
    try {
      prediction = predictOne(chronological, match);
    } catch {
      // Le prime gare della finestra non hanno storia sufficiente: non sono un fallimento
      // dell'ancoraggio e vanno contate a parte, non confuse con la non convergenza.
      skipped += 1;
      continue;
    }
    predicted += 1;
    if (predicted % 500 === 0) process.stderr.write(`  ... ${predicted}/${candidates.length} previsioni (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);

    const anchored = {};
    let complete = true;
    for (const [lineName, line] of Object.entries(LINES)) {
      const [pHome, pDraw] = shinDevig(line.three.map((field) => Number(match[field])));
      const [pOver] = shinDevig(line.total.map((field) => Number(match[field])));
      const solution = anchorToMarket({
        home: Number(match[line.three[0]]), draw: Number(match[line.three[1]]), away: Number(match[line.three[2]]),
        over25: Number(match[line.total[0]]), under25: Number(match[line.total[1]]),
        line: lineName,
      });
      if (!solution) {
        failures[lineName] += 1;
        complete = false;
        continue;
      }
      const table = probabilityByKey(matrixProbabilities(solution.matrix));
      // Controllo del cancello: le marginali riancorate devono riprodurre la linea entro 1e-5.
      // Un guadagno misurato su una matrice che NON riproduce il mercato non misura l'ancoraggio.
      maxMarginError = Math.max(
        maxMarginError,
        Math.abs(table["1"] - pHome),
        Math.abs(table.X - pDraw),
        Math.abs(table.OVER25 - pOver),
      );
      anchored[lineName] = lossesFor(table, match);
    }
    if (!complete) continue;

    records.push({
      competition: String(match.competition_id),
      date: String(match.date),
      window: String(match.date) <= TRAIN_END ? "training" : (String(match.date) >= HOLDOUT_START ? "holdout" : "fra le due"),
      model: lossesFor(probabilityByKey(prediction.probabilities), match),
      anchored,
    });
  }

  console.log(`previsioni calcolate      : ${predicted}/${candidates.length} (${skipped} senza storia sufficiente)`);
  console.log(`riancoraggio non convergente: chiusura ${failures.chiusura}, apertura ${failures.apertura}`);
  console.log(`gare nel confronto appaiato : ${records.length} (le stesse per entrambe le linee, cosi' le due tabelle sono confrontabili)`);
  console.log(`errore massimo sulle marginali riprodotte: ${maxMarginError.toExponential(2)} (cancello: < 1e-5)`);
  console.log(`tempo: ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  if (records.length < 2) throw new Error("Campione insufficiente: nessun confronto possibile.");

  for (const lineName of Object.keys(LINES)) {
    console.log(`\n--- LINEA DI ${lineName.toUpperCase()} ---\n`);
    printTable("AGGREGATO", records, lineName);
    for (const window of ["training", "holdout", "fra le due"]) {
      const subset = records.filter((row) => row.window === window);
      if (subset.length > 1) printTable(`FINESTRA ${window} ${window === "training" ? `(fino al ${TRAIN_END})` : window === "holdout" ? `(dal ${HOLDOUT_START})` : ""}`.trim(), subset, lineName);
    }
    console.log("  per competizione (solo guadagno appaiato e sigma)");
    console.log("  lega   |    n | " + MARKETS.map((m) => m.name.slice(0, 8).padStart(8)).join(" | "));
    console.log("  " + "-".repeat(20 + MARKETS.length * 11));
    for (const competition of BIG_FIVE) {
      const subset = records.filter((row) => row.competition === competition);
      if (subset.length < 2) continue;
      const cells = MARKETS.map((market, index) => {
        const s = summarise(subset, lineName, index);
        return `${(s.gain >= 0 ? "+" : "") + s.gain.toFixed(4)}`.padStart(8);
      });
      console.log(`  ${competition.padEnd(6)} | ${String(subset.length).padStart(4)} | ${cells.join(" | ")}`);
      const sigmas = MARKETS.map((market, index) => `${summarise(subset, lineName, index).sigma.toFixed(1)}σ`.padStart(8));
      console.log(`  ${" ".repeat(6)} |      | ${sigmas.join(" | ")}`);
    }
    console.log("");
  }

  console.log("\n=== VERDETTO SULLA SOGLIA PRE-REGISTRATA P1 ===\n");
  console.log("Soglia: guadagno sull'1X2 >= +0.020 su ENTRAMBE le linee (aggregato, campionati).\n");
  let passed = true;
  for (const lineName of Object.keys(LINES)) {
    const s = summarise(records, lineName, 0);
    const ok = s.gain >= 0.020;
    passed = passed && ok;
    console.log(`  1X2 @ ${lineName.padEnd(9)} : +${s.gain.toFixed(4)} ± ${s.error.toFixed(4)} (${s.sigma.toFixed(1)}σ)  →  ${ok ? "SUPERATA" : "NON superata"}`);
  }
  console.log(`\n  esito: ${passed ? "P1 SUPERATA — T1 ha il suo cancello" : "P1 NON superata — indagare il codice PRIMA di dichiarare l'ipotesi respinta (§5)"}\n`);
}

main();
