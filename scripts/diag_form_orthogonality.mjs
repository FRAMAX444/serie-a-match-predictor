#!/usr/bin/env node
// La "forma" del modello è forma, o è forza contata due volte?
//
// §2.5 del brief misura corr(EloDiff, momentum) = 0.750 su 590 gare di Serie A: il termine
// di forma è collineare al 75% con l'Elo, quindi il modello conta il livello due volte — una
// via eloHome/eloAway e una via formHome/formAway, con clamp indipendenti (±0.34 e ±0.16)
// che non si parlano.
//
// La causa è concettuale: la forma è misurata in PUNTI ASSOLUTI, non come scostamento dal
// livello atteso della squadra. L'Inter a 2.1 punti a partita è "in forma" permanentemente;
// il Venezia a 0.9 è "in crisi" permanentemente. Nessuna delle due è un'informazione nuova
// rispetto all'Elo.
//
// Questo script misura la correlazione delle DUE definizioni, ed è il criterio di direzione
// (R6) del task: la forma-residuo deve scendere sotto 0.30, altrimenti non sta facendo ciò
// per cui è stata scritta e va rivista PRIMA di guardarne il log loss.
//
// Uso: node scripts/diag_form_orthogonality.mjs [since] [--competition ita.1]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOM = new Set(["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"]);
const since = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "2025-01-01";
const competitionIndex = process.argv.indexOf("--competition");
const competition = competitionIndex >= 0 ? process.argv[competitionIndex + 1] : "";

const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "matches.json"), "utf8"));
const all = payload.matches
  .filter((match) => DOM.has(String(match.competition_id)))
  .filter((match) => match.home_goals !== null && match.away_goals !== null)
  .sort((left, right) => String(left.date).localeCompare(String(right.date)));

const short = DEFAULT_HYPERPARAMETERS.momentumShortWeight;
const series = { eloDiff: [], legacy: [], residual: [], xgResidual: [], outcome: [] };
for (const match of all) {
  if (String(match.date) < since) continue;
  if (competition && String(match.competition_id) !== competition) continue;
  let result;
  try {
    result = predictFromMatches(all, {
      homeTeam: match.home_team, awayTeam: match.away_team, date: match.date,
      cutoffDate: match.date, competitionId: match.competition_id,
    });
  } catch { continue; }
  const { home, away } = result;
  series.eloDiff.push(home.elo - away.elo);
  // La definizione attuale, riprodotta qui dalla stessa formula di predictFromMatches.
  series.legacy.push(
    (short * home.ppg3 + (1 - short) * home.ppg10) - (short * away.ppg3 + (1 - short) * away.ppg10),
  );
  // La definizione proposta: scostamento del rendimento osservato da quello atteso dal
  // livello della squadra stessa, sulla scala del punteggio Elo (vittoria 1, pareggio 0.5).
  series.residual.push(
    (short * home.resultResidual3 + (1 - short) * home.resultResidual10)
    - (short * away.resultResidual3 + (1 - short) * away.resultResidual10),
  );
  series.xgResidual.push(home.xgResidual5 - away.xgResidual5);
  series.outcome.push(match.home_goals > match.away_goals ? 1 : match.home_goals === match.away_goals ? 0.5 : 0);
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sd = (values) => {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const corr = (left, right) => {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  for (let index = 0; index < left.length; index += 1) covariance += (left[index] - leftMean) * (right[index] - rightMean);
  return covariance / ((left.length - 1) * sd(left) * sd(right));
};

console.log(`${series.eloDiff.length} gare${competition ? ` di ${competition}` : ""} dal ${since}\n`);
console.log("termine                        | sd      | corr con EloDiff | corr con l'esito");
console.log("-".repeat(78));
for (const [label, values] of [
  ["momentum attuale (punti)", series.legacy],
  ["forma-residuo (risultato)", series.residual],
  ["forma-residuo (xG)", series.xgResidual],
]) {
  const withElo = corr(series.eloDiff, values);
  const withOutcome = corr(values, series.outcome);
  console.log(
    `${label.padEnd(30)} | ${sd(values).toFixed(4).padStart(7)} |           ${withElo.toFixed(3).padStart(6)} |          ${withOutcome.toFixed(3).padStart(6)}`,
  );
}
console.log(`${"EloDiff".padEnd(30)} | ${sd(series.eloDiff).toFixed(1).padStart(7)} |            1.000 |          ${corr(series.eloDiff, series.outcome).toFixed(3).padStart(6)}`);
// Perché il residuo sul RISULTATO resta correlato all'Elo più di quello sull'xG: l'Elo è
// letteralmente la somma dei residui passati (delta = k · margin · residuo), quindi una
// squadra con residui recenti positivi ha, per costruzione, un Elo appena salito. È una
// collinearità meccanica, non concettuale, e nessuna riscrittura della forma la elimina.
// Il residuo sull'xG ne soffre molto meno perché entra nell'aggiornamento Elo con peso 0.45
// e solo quando entrambi gli xG sono reali.
console.log("\ncombinazioni risultato/xG:");
for (const weight of [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1]) {
  const blended = series.residual.map((value, index) => (1 - weight) * value + weight * series.xgResidual[index] * (sd(series.residual) / sd(series.xgResidual)));
  const withElo = Math.abs(corr(series.eloDiff, blended));
  const withOutcome = corr(blended, series.outcome);
  console.log(
    `  peso xG ${weight.toFixed(2)}  corr con EloDiff ${withElo.toFixed(3)}  corr con esito ${withOutcome.toFixed(3)}`
    + `  ${withElo < 0.30 ? "<- sotto soglia" : ""}`,
  );
}
console.log(`\ncorr fra le due forme: ${corr(series.legacy, series.residual).toFixed(3)}`);
console.log(`corr fra forma-residuo risultato e xG: ${corr(series.residual, series.xgResidual).toFixed(3)}`);

const legacyCorr = Math.abs(corr(series.eloDiff, series.legacy));
const residualCorr = Math.abs(corr(series.eloDiff, series.residual));
console.log("\n=== criterio di direzione (R6) ===");
console.log(`  attuale  : ${legacyCorr.toFixed(3)}`);
console.log(`  residuo  : ${residualCorr.toFixed(3)}  -> ${residualCorr < 0.30 ? "SOTTO 0.30: la forma è ortogonale al livello, si può misurare il log loss" : "SOPRA 0.30: la modifica non ha fatto ciò che doveva, va rivista prima di guardare il log loss"}`);

// Il clamp va ritarato quando cambia la scala della variabile: un clamp a ±0.16 su una
// variabile con deviazione standard dieci volte più piccola non morde mai, e la modifica
// diventa inerte senza che nulla lo segnali.
const scale = DEFAULT_HYPERPARAMETERS.momentumScale;
const clampAt = DEFAULT_HYPERPARAMETERS.momentumClamp;
const share = (values, factor) => values.filter((value) => Math.abs(value * factor) >= clampAt).length / values.length;
console.log("\n=== taratura del clamp ===");
console.log(`  momentumScale ${scale}, momentumClamp ±${clampAt}`);
console.log(`  quota di gare al clamp, momentum attuale : ${(100 * share(series.legacy, scale)).toFixed(1)}%`);
console.log(`  quota di gare al clamp, forma-residuo    : ${(100 * share(series.residual, scale)).toFixed(1)}%`);
const equivalentScale = scale * sd(series.legacy) / sd(series.residual);
console.log(`  scala equivalente per pari ampiezza: ${equivalentScale.toFixed(4)} (contro ${scale})`);
