#!/usr/bin/env node
// Il vantaggio campo va aggiunto come parametro, o è già catturato da quello che c'è?
//
// §2.7 del brief osserva 5.4 punti percentuali di spread fra il tasso di vittorie casalinghe
// di Serie A e LaLiga, contro due costanti globali (homeAdvantage = 48 in applyMatch,
// venueTilt = 0.018 in DEFAULT_CALIBRATION). Il brief però pone anche la condizione giusta
// prima di toccare il codice: parte dell'effetto è GIÀ catturata dalle baseline
// league.homeGoals/awayGoals, che weightedCompetitionAverages calcola per competizione. La
// domanda non è "le leghe differiscono?" — è ovvio che differiscono — ma "quanto ne resta
// fuori dopo che il modello ha fatto la sua parte?".
//
// Tre misure, in quest'ordine:
//   1. TREND: il tasso di vittorie casalinghe sta scendendo, su tutte e cinque le leghe?
//      Se sì, una costante stimata su tre stagioni è la media di un fenomeno in deriva.
//   2. RESIDUO PER LEGA: scarto fra P(1) previsto e osservato, con errore standard e un test
//      congiunto — cinque scarti da 1 sigma ciascuno possono essere rumore, ma il loro
//      insieme può non esserlo, ed è quello il test che decide.
//   3. RESIDUO PER SQUADRA: stesso scarto per squadra, con lo shrinkage che ~19 gare interne
//      per stagione impongono.
//
// Uso: node scripts/diag_home_advantage.mjs [since]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOM = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"];
const DOMSET = new Set(DOM);
const since = process.argv[2] || "2024-08-01";

const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "matches.json"), "utf8"));
const all = payload.matches
  .filter((match) => DOMSET.has(String(match.competition_id)))
  .filter((match) => match.home_goals !== null && match.away_goals !== null)
  .sort((left, right) => String(left.date).localeCompare(String(right.date)));

// --- 1. Trend, sui dati grezzi: nessun modello coinvolto --------------------------------
console.log("=== 1. Tasso di vittorie casalinghe per lega e stagione (dati grezzi) ===\n");
const seasons = [...new Set(all.map((match) => String(match.season)))].sort();
const cell = new Map();
for (const match of all) {
  const key = `${match.competition_id}|${match.season}`;
  const value = cell.get(key) || { n: 0, home: 0, draw: 0, goalsHome: 0, goalsAway: 0 };
  value.n += 1;
  value.home += match.home_goals > match.away_goals ? 1 : 0;
  value.draw += match.home_goals === match.away_goals ? 1 : 0;
  value.goalsHome += match.home_goals;
  value.goalsAway += match.away_goals;
  cell.set(key, value);
}
console.log("lega   | " + seasons.map((season) => season.padEnd(16)).join("| "));
for (const competition of DOM) {
  let row = `${competition.padEnd(6)} | `;
  for (const season of seasons) {
    const value = cell.get(`${competition}|${season}`);
    row += value && value.n >= 50
      ? `${(value.home / value.n).toFixed(3)} n=${String(value.n).padEnd(4)} `.padEnd(16) + "| "
      : "-".padEnd(16) + "| ";
  }
  console.log(row);
}
// Pendenza per lega su stagioni complete, e test congiunto sul segno.
console.log("\nvariazione fra la prima e l'ultima stagione completa (errore std ~2.5pp per stagione):");
let declines = 0;
let counted = 0;
for (const competition of DOM) {
  const complete = seasons
    .map((season) => ({ season, value: cell.get(`${competition}|${season}`) }))
    .filter((entry) => entry.value && entry.value.n >= 250);
  if (complete.length < 2) continue;
  const first = complete[0];
  const last = complete.at(-1);
  const delta = last.value.home / last.value.n - first.value.home / first.value.n;
  counted += 1;
  if (delta < 0) declines += 1;
  console.log(`  ${competition}: ${first.season} ${(first.value.home / first.value.n).toFixed(3)} -> ${last.season} ${(last.value.home / last.value.n).toFixed(3)}   delta ${(100 * delta).toFixed(1)}pp`);
}
// Sotto l'ipotesi "nessun trend" il segno è una moneta: la probabilità che TUTTE e cinque le
// leghe scendano è 1/32 = 3.1%. È il test giusto qui, perché non richiede di stimare una
// pendenza da tre punti per lega — cosa che con questo rumore non è possibile.
const binomialTail = (successes, trials) => {
  let total = 0;
  const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1); return r; };
  for (let k = successes; k <= trials; k += 1) total += choose(trials, k) * Math.pow(0.5, trials);
  return total;
};
console.log(`\n  leghe in calo: ${declines}/${counted} — probabilità sotto l'ipotesi "nessun trend": ${(100 * binomialTail(declines, counted)).toFixed(1)}%`);

// --- 2 e 3. Residui del modello -----------------------------------------------------------
console.log("\n=== 2. Residuo del modello sul vantaggio campo, per lega ===\n");
const rows = [];
for (const match of all.filter((item) => String(item.date) >= since)) {
  try {
    const result = predictFromMatches(all, {
      homeTeam: match.home_team, awayTeam: match.away_team, date: match.date,
      cutoffDate: match.date, competitionId: match.competition_id,
    });
    rows.push({
      competition: String(match.competition_id),
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      awayPredicted: result.probabilities.awayWin,
      awayObserved: match.away_goals > match.home_goals ? 1 : 0,
      predicted: result.probabilities.homeWin,
      observed: match.home_goals > match.away_goals ? 1 : 0,
      lambdaGap: result.lambdaHome - result.lambdaAway,
      goalGap: match.home_goals - match.away_goals,
    });
  } catch { /* dati insufficienti */ }
}

const summarise = (subset) => {
  const n = subset.length;
  const predicted = subset.reduce((sum, row) => sum + row.predicted, 0) / n;
  const observed = subset.reduce((sum, row) => sum + row.observed, 0) / n;
  // Errore standard della DIFFERENZA appaiata fra previsto e osservato: la varianza di
  // ciascuna previsione è p(1-p), e sommarle è più preciso che usare 0.25 come se ogni gara
  // fosse un lancio di moneta equo.
  const variance = subset.reduce((sum, row) => sum + row.predicted * (1 - row.predicted), 0) / (n * n);
  const lambdaGap = subset.reduce((sum, row) => sum + row.lambdaGap, 0) / n;
  const goalGap = subset.reduce((sum, row) => sum + row.goalGap, 0) / n;
  return { n, predicted, observed, residual: observed - predicted, error: Math.sqrt(variance), lambdaGap, goalGap };
};

console.log("lega   |    n | P(1) prev | P(1) oss | residuo  | err.std | sigma | gap gol att/oss");
const leagueStats = [];
for (const competition of DOM) {
  const stats = summarise(rows.filter((row) => row.competition === competition));
  leagueStats.push({ competition, ...stats });
  console.log(
    `${competition.padEnd(6)} | ${String(stats.n).padStart(4)} |     ${stats.predicted.toFixed(3)} |    ${stats.observed.toFixed(3)} | `
    + `${(stats.residual >= 0 ? "+" : "")}${stats.residual.toFixed(4)} |  ${stats.error.toFixed(4)} | ${(stats.residual / stats.error).toFixed(2).padStart(5)} | `
    + `${stats.lambdaGap.toFixed(3)} ${stats.goalGap.toFixed(3)}`,
  );
}
// Test congiunto: la somma dei quadrati degli scarti normalizzati si distribuisce come un
// chi-quadro con 5 gradi di libertà se il modello è ben calibrato in ogni lega. È la domanda
// che conta — "l'insieme dei cinque scarti è più grande di quanto il caso spieghi?" — e non
// si risponde guardando i cinque valori uno per uno.
const chiSquare = leagueStats.reduce((sum, stats) => sum + (stats.residual / stats.error) ** 2, 0);
console.log(`\n  chi-quadro congiunto su ${leagueStats.length} leghe: ${chiSquare.toFixed(2)}`);
console.log("  soglie con 5 gradi di libertà: 9.24 (p=0.10) · 11.07 (p=0.05) · 15.09 (p=0.01)");
console.log(`  -> ${chiSquare > 11.07 ? "il residuo per lega NON è spiegabile dal caso: vale la pena parametrizzarlo" : "il residuo per lega è dentro il rumore: aggiungere un parametro per lega significherebbe stimare rumore"}`);

console.log("\n=== 3. Residuo per squadra (in casa) ===\n");
const byTeam = new Map();
for (const row of rows) {
  const list = byTeam.get(row.homeTeam) || [];
  list.push(row);
  byTeam.set(row.homeTeam, list);
}
const teamStats = [...byTeam.entries()]
  .filter(([, list]) => list.length >= 15)
  .map(([team, list]) => ({ team, ...summarise(list) }))
  .sort((left, right) => right.residual - left.residual);
const extremes = [...teamStats.slice(0, 5), null, ...teamStats.slice(-5)];
console.log("squadra          |  n | P(1) prev | oss   | residuo | err.std | sigma");
for (const stats of extremes) {
  if (!stats) { console.log("  ..."); continue; }
  console.log(
    `${stats.team.padEnd(16)} | ${String(stats.n).padStart(2)} |     ${stats.predicted.toFixed(3)} | ${stats.observed.toFixed(3)} | `
    + `${(stats.residual >= 0 ? "+" : "")}${stats.residual.toFixed(3)} |  ${stats.error.toFixed(3)} | ${(stats.residual / stats.error).toFixed(2).padStart(5)}`,
  );
}
const teamChi = teamStats.reduce((sum, stats) => sum + (stats.residual / stats.error) ** 2, 0);
const teamSigma = (teamChi - teamStats.length) / Math.sqrt(2 * teamStats.length);
console.log(`\n  chi-quadro congiunto su ${teamStats.length} squadre: ${teamChi.toFixed(1)} (attesi ~${teamStats.length} se è tutto rumore, scarto ${teamSigma.toFixed(2)} sigma)`);

// --- 4. Il test che separa "vantaggio campo per squadra" da "squadra mal valutata" -------
//
// Il punto 3 da solo non basta e prenderlo per buono sarebbe l'errore classico. Una squadra
// sistematicamente sottovalutata dal modello mostra un residuo POSITIVO in casa e anche in
// trasferta: la dispersione del solo residuo casalingo non distingue "questa squadra ha un
// vantaggio campo speciale" da "questa squadra è più forte di quanto il modello creda".
//
// La quantità specifica del venue è la DIFFERENZA fra il residuo in casa e quello in
// trasferta. Se il vantaggio campo varia davvero per squadra, quella differenza ha una
// dispersione oltre il caso; se invece le squadre sono solo mal valutate, i due residui si
// muovono insieme e la differenza è rumore puro.
console.log("\n=== 4. Vantaggio campo per squadra, al netto della forza mal valutata ===\n");
const venueByTeam = new Map();
for (const row of rows) {
  const home = venueByTeam.get(row.homeTeam) || { home: [], away: [] };
  home.home.push({ predicted: row.predicted, observed: row.observed });
  venueByTeam.set(row.homeTeam, home);
  const away = venueByTeam.get(row.awayTeam) || { home: [], away: [] };
  away.away.push({ predicted: row.awayPredicted, observed: row.awayObserved });
  venueByTeam.set(row.awayTeam, away);
}
const meanResidual = (list) => list.reduce((sum, item) => sum + (item.observed - item.predicted), 0) / list.length;
const varResidual = (list) => list.reduce((sum, item) => sum + item.predicted * (1 - item.predicted), 0) / (list.length ** 2);
const venueStats = [...venueByTeam.entries()]
  .filter(([, split]) => split.home.length >= 15 && split.away.length >= 15)
  .map(([team, split]) => {
    const gap = meanResidual(split.home) - meanResidual(split.away);
    const error = Math.sqrt(varResidual(split.home) + varResidual(split.away));
    return { team, gap, error, sigma: gap / error, homeGames: split.home.length };
  })
  .sort((left, right) => right.gap - left.gap);
console.log("squadra          | residuo casa - residuo trasferta | err.std | sigma");
for (const stats of [...venueStats.slice(0, 4), null, ...venueStats.slice(-4)]) {
  if (!stats) { console.log("  ..."); continue; }
  console.log(`${stats.team.padEnd(16)} |                          ${(stats.gap >= 0 ? "+" : "")}${stats.gap.toFixed(3)} |   ${stats.error.toFixed(3)} | ${stats.sigma.toFixed(2).padStart(5)}`);
}
const venueChi = venueStats.reduce((sum, stats) => sum + stats.sigma ** 2, 0);
const venueSigma = (venueChi - venueStats.length) / Math.sqrt(2 * venueStats.length);
console.log(`\n  chi-quadro su ${venueStats.length} squadre: ${venueChi.toFixed(1)} (attesi ~${venueStats.length}, scarto ${venueSigma.toFixed(2)} sigma)`);
console.log(`  -> ${venueSigma > 2 ? "il vantaggio campo varia davvero per squadra oltre il caso" : "nessun vantaggio campo specifico per squadra oltre il caso: la dispersione del punto 3 è forza mal valutata, non venue"}`);
