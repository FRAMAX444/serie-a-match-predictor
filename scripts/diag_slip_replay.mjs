#!/usr/bin/env node
// La schedina dice la verità sulla propria sicurezza?
//
// Rigioca il costruttore di schedine dell'app (buildMarketCandidates + buildSlipSeries, lo stesso
// percorso di generateSlip) su ogni turno passato dei Big Five, con le quote di CHIUSURA come
// prezzo e come linea di ancoraggio, e confronta la probabilità combinata DICHIARATA dalla
// schedina con la frequenza OSSERVATA di schedine vinte.
//
// Due regimi, sullo stesso turno e sulle stesse previsioni:
//   ancorata  — ciò che fa la produzione dal 10/11/2026: dove c'è una linea, decide l'ancora;
//   endogena  — ciò che faceva prima: l'ancora viene tolta dal risultato prima di costruire.
//
// Uso (nessuna rete; ~15 minuti su WSL per calcolare le previsioni, poi pochi secondi):
//   node scripts/diag_slip_replay.mjs
//   node scripts/diag_slip_replay.mjs --cache /percorso/previsioni.json   # riusa le previsioni
//
// Limiti dichiarati: le quote di chiusura sono più informate di quelle che la pagina vede (è il
// caso migliore per l'ancora); solo 1X2, doppia chance e Over/Under 2.5 hanno un prezzo, gli
// altri mercati usano la quota equa del proprio regime; si valuta la prima schedina del turno.
import fs from "node:fs";
import { predictFromMatches, marketOddsFrom } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";
import { buildMarketCandidates, buildSlipSeries } from "../schedina.js";
import { settleMarket } from "../slip-history.js";

const LEAGUES = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const HOLDOUT_FROM = "2025-07-08";
const argv = process.argv.slice(2);
const cacheFile = argv.includes("--cache") ? argv[argv.indexOf("--cache") + 1] : null;

const payload = JSON.parse(fs.readFileSync("data/matches.json", "utf8"));
const chronological = payload.matches
  .filter((m) => m.home_goals !== null && m.home_goals !== undefined && m.away_goals !== null && m.away_goals !== undefined)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const position = new Map(chronological.map((m, i) => [m, i]));
const targets = chronological.filter((m) => LEAGUES.has(m.competition_id) && m.date >= "2023-08-01" && marketOddsFrom(m, "chiusura"));

let cache = {};
if (cacheFile && fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const started = Date.now();
let computed = 0;
for (const match of targets) {
  if (cache[match.id] !== undefined) continue;
  if ((position.get(match) ?? 0) < 100) { cache[match.id] = null; continue; }
  try {
    const result = predictFromMatches(chronological, {
      ...modelInputs(),
      homeTeam: match.home_team, awayTeam: match.away_team, date: match.date, cutoffDate: match.date,
      competitionId: match.competition_id, season: match.season,
      marketOdds: marketOddsFrom(match, "chiusura"),
    });
    cache[match.id] = {
      probabilities: result.probabilities,
      anchor: result.marketAnchor?.status === "anchored" ? result.marketAnchor.probabilities : null,
      quality: result.quality?.score ?? null,
    };
  } catch (error) {
    if (!/Dati recenti insufficienti/i.test(String(error?.message || error))) throw error;
    cache[match.id] = null;
  }
  computed += 1;
  if (computed % 500 === 0) console.error(`  ... ${computed} previsioni (${Math.round((Date.now() - started) / 1000)}s)`);
}
if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(cache));

const rounds = new Map();
for (const match of targets) {
  const cached = cache[match.id];
  if (!cached?.anchor) continue;
  const key = `${match.competition_id}|${match.season}|${match.round}`;
  if (!rounds.has(key)) rounds.set(key, []);
  rounds.get(key).push({ match, cached });
}

function entryFor({ match, cached }, regime) {
  return {
    fixture: match,
    result: {
      probabilities: cached.probabilities,
      marketAnchor: regime === "ancorata" ? { status: "anchored", line: "chiusura", probabilities: cached.anchor } : null,
      quality: { score: cached.quality },
    },
    odds: {
      home: match.home_odds_close, draw: match.draw_odds_close, away: match.away_odds_close,
      totals: { 2.5: { over: match.over25_odds_close, under: match.under25_odds_close } },
      btts: { yes: null, no: null }, teamScores: { home: null, away: null },
    },
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stderr = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length); };
const pct = (value) => `${(100 * value).toFixed(1)}%`;

function replay({ legs, confidence, regime, window, marketOnly }) {
  const declared = [];
  const won = [];
  const returns = [];
  for (const list of rounds.values()) {
    if (list.length < Math.max(5, legs)) continue;
    const date = list[0].match.date;
    if (window === "holdout" && date < HOLDOUT_FROM) continue;
    const entries = list.map((item) => entryFor(item, regime));
    let candidates = buildMarketCandidates(entries, { groups: ["1X2", "doppia", "gol"] });
    if (marketOnly) candidates = candidates.filter((candidate) => candidate.source === "market");
    const [slip] = buildSlipSeries(candidates, { legs, confidence, count: 1 });
    if (!slip) continue;
    const hit = slip.legs.every((leg) => settleMarket(leg.key, entries[leg.fixtureIndex].fixture.home_goals, entries[leg.fixtureIndex].fixture.away_goals));
    declared.push(slip.combinedProbability);
    won.push(hit ? 1 : 0);
    returns.push(hit ? slip.combinedOdds - 1 : -1);
  }
  const observed = mean(won);
  return `${String(declared.length).padStart(4)} | ${pct(mean(declared)).padStart(6)} | ${pct(observed).padStart(6)} ± ${pct(Math.sqrt(observed * (1 - observed) / won.length)).padStart(5)} | ${pct(mean(returns)).padStart(7)} ± ${pct(stderr(returns)).padStart(5)}`;
}

console.log(`\n=== SCHEDINA: SICUREZZA DICHIARATA CONTRO OSSERVATA ===\n`);
console.log(`turni con previsioni ancorate: ${rounds.size} · quote di chiusura · prima schedina del turno\n`);
for (const window of ["tutto", "holdout"]) {
  for (const marketOnly of [false, true]) {
    console.log(`--- finestra ${window}${window === "holdout" ? ` (dal ${HOLDOUT_FROM})` : ""} · ${marketOnly ? "solo gambe con prezzo di mercato" : "tutti i candidati di 1X2, doppia, gol"}`);
    console.log("gambe sicurezza regime   | turni | dichiar. | osservata      | ROI");
    for (const [legs, confidence] of [[3, "media"], [3, "alta"], [5, "media"]]) {
      for (const regime of ["endogena", "ancorata"]) {
        console.log(`${String(legs).padStart(5)} ${confidence.padEnd(9)} ${regime.padEnd(9)}| ${replay({ legs, confidence, regime, window, marketOnly })}`);
      }
    }
    console.log("");
  }
}
