#!/usr/bin/env node
// Quanto differisce il modello di PRODUZIONE (app.js passa teamContext) da quello
// che ogni backtest ha misurato (teamContext = null)?
import fs from "node:fs";
import { predictFromMatches } from "../model.js";

const DOM = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const payload = JSON.parse(fs.readFileSync("data/matches.json", "utf8"));
const teamContext = payload.team_context || null;
const comp = process.argv[2] || "ita.1";
const since = process.argv[3] || "2024-08-01";

const all = payload.matches
  .filter((m) => DOM.has(String(m.competition_id)))
  .filter((m) => m.home_goals !== null && m.away_goals !== null)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const cand = all.filter((m) => m.competition_id === comp && String(m.date) >= since);

const llA = []; const llB = []; let touched = 0;
for (const m of cand) {
  const base = { homeTeam: m.home_team, awayTeam: m.away_team, date: m.date, cutoffDate: m.date, competitionId: m.competition_id };
  try {
    const rMis = predictFromMatches(all, base);                       // ciò che il backtest misura
    const rPro = predictFromMatches(all, { ...base, teamContext });    // ciò che gira in produzione
    const a = m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2;
    const pM = [rMis.probabilities.homeWin, rMis.probabilities.draw, rMis.probabilities.awayWin];
    const pP = [rPro.probabilities.homeWin, rPro.probabilities.draw, rPro.probabilities.awayWin];
    llA.push(-Math.log(Math.max(1e-15, pM[a])));
    llB.push(-Math.log(Math.max(1e-15, pP[a])));
    if (Math.abs(pM[0] - pP[0]) > 1e-9) touched += 1;
  } catch { /* dati insufficienti */ }
}

const n = llA.length;
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sd = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
const diff = llA.map((v, i) => v - llB[i]);
const se = sd(diff) / Math.sqrt(n);

console.log(`competizione ${comp}, ${n} gare da ${since}`);
console.log(`GARE TOCCATE: ${touched}/${n}  (${(100 * touched / n).toFixed(1)}%)`);
console.log(`log loss MISURATO   (teamContext = null) : ${mean(llA).toFixed(4)}`);
console.log(`log loss PRODUZIONE (teamContext passato): ${mean(llB).toFixed(4)}`);
console.log(`differenza appaiata : ${mean(diff).toFixed(4)} ± ${se.toFixed(4)}   (positivo = produzione migliore)`);
console.log(`sigma               : ${(mean(diff) / se).toFixed(2)}`);
console.log(`IC 95%              : [${(mean(diff) - 1.96 * se).toFixed(4)}, ${(mean(diff) + 1.96 * se).toFixed(4)}]`);
