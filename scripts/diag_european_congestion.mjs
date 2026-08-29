#!/usr/bin/env node
// L'impegno europeo infrasettimanale costa qualcosa nella partita di campionato successiva?
//
// R6 del brief: la direzione va verificata PRIMA e INDIPENDENTEMENTE dal log loss. Se il
// coefficiente stimato risultasse positivo — un impegno europeo che AUMENTA il rendimento —
// il task fallisce comunque, perché starebbe compensando un altro errore.
//
// C'è un dettaglio del modello che va misurato insieme, e che il brief non nomina: per una
// previsione DOMESTICA, predictFromMatches() filtra `chronological` alle sole competizioni
// domestiche (model.js, competitionAllowed). Le partite di coppa non sono quindi "prive di
// etichetta": sono invisibili. Per una squadra che gioca in Champions il mercoledì e in
// campionato la domenica, `restDays` non vale 3 — vale 7, perché l'ultima partita che il
// modello vede è quella di campionato precedente. Il difetto non è solo un fattore mancante:
// è un input sbagliato.
//
// Uso: node scripts/diag_european_congestion.mjs [since]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOM = new Set(["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"]);
const EUR = new Set(["ucl", "uel", "uecl"]);
const DAY = 86400000;
const since = process.argv[2] || "2024-08-01";
const at = (value) => new Date(`${String(value).slice(0, 10)}T12:00:00Z`).getTime();

const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "matches.json"), "utf8"));
const played = payload.matches.filter((match) => match.home_goals !== null && match.away_goals !== null);
const domestic = played
  .filter((match) => DOM.has(String(match.competition_id)))
  .sort((left, right) => String(left.date).localeCompare(String(right.date)));

// Calendario completo per squadra, coppe INCLUSE: è l'informazione che il modello non ha.
const calendar = new Map();
for (const match of played) {
  for (const team of [match.home_team, match.away_team]) {
    if (!team) continue;
    const list = calendar.get(team) || [];
    list.push({ date: at(match.date), competition: String(match.competition_id), away: match.away_team === team });
    calendar.set(team, list);
  }
}
for (const list of calendar.values()) list.sort((left, right) => left.date - right.date);

// Giorni dall'ultima partita EUROPEA e numero di partite negli 8 giorni precedenti, di
// qualunque competizione.
function loadBefore(team, when) {
  const list = calendar.get(team) || [];
  let europeGapDays = Infinity;
  let europeAway = false;
  let inEight = 0;
  let trueRest = Infinity;
  for (const entry of list) {
    if (entry.date >= when) break;
    const gap = (when - entry.date) / DAY;
    trueRest = Math.min(trueRest, gap);
    if (gap <= 8) inEight += 1;
    if (EUR.has(entry.competition) && gap < europeGapDays) {
      europeGapDays = gap;
      europeAway = entry.away;
    }
  }
  return { europeGapDays, europeAway, inEight, trueRest };
}

const rows = [];
for (const match of domestic.filter((item) => String(item.date) >= since)) {
  let result;
  try {
    result = predictFromMatches(domestic, {
      homeTeam: match.home_team, awayTeam: match.away_team, date: match.date,
      cutoffDate: match.date, competitionId: match.competition_id,
    });
  } catch { continue; }
  const when = at(match.date);
  for (const side of ["home", "away"]) {
    const team = side === "home" ? match.home_team : match.away_team;
    const load = loadBefore(team, when);
    rows.push({
      team,
      side,
      ...load,
      // Riposo che il MODELLO crede di vedere, contro quello vero: la differenza è
      // esattamente ciò che le coppe filtrate via nascondono.
      modelRest: side === "home" ? result.home.restDays : result.away.restDays,
      predictedGoals: side === "home" ? result.lambdaHome : result.lambdaAway,
      actualGoals: side === "home" ? match.home_goals : match.away_goals,
      predictedWin: side === "home" ? result.probabilities.homeWin : result.probabilities.awayWin,
      actualWin: side === "home"
        ? (match.home_goals > match.away_goals ? 1 : 0)
        : (match.away_goals > match.home_goals ? 1 : 0),
    });
  }
}

const summarise = (subset, label) => {
  if (!subset.length) return null;
  const n = subset.length;
  const goalResidual = subset.reduce((sum, row) => sum + (row.actualGoals - row.predictedGoals), 0) / n;
  const goalError = Math.sqrt(subset.reduce((sum, row) => sum + row.predictedGoals, 0)) / n;
  const winResidual = subset.reduce((sum, row) => sum + (row.actualWin - row.predictedWin), 0) / n;
  const winError = Math.sqrt(subset.reduce((sum, row) => sum + row.predictedWin * (1 - row.predictedWin), 0)) / n;
  const restGap = subset.reduce((sum, row) => sum + (row.modelRest - Math.min(row.trueRest, 30)), 0) / n;
  console.log(
    `${label.padEnd(34)} | ${String(n).padStart(5)} | ${(goalResidual >= 0 ? "+" : "")}${goalResidual.toFixed(3)} ± ${goalError.toFixed(3)} | `
    + `${(winResidual >= 0 ? "+" : "")}${winResidual.toFixed(4)} ± ${winError.toFixed(4)} | ${restGap.toFixed(2)}`,
  );
  return { n, goalResidual, goalError, winResidual, winError };
};

console.log(`${rows.length} osservazioni squadra-partita dal ${since}\n`);
console.log("segmento                           |     n | residuo gol      | residuo vittoria    | riposo creduto-vero");
console.log("-".repeat(104));
const noEurope = rows.filter((row) => !Number.isFinite(row.europeGapDays) || row.europeGapDays > 8);
summarise(noEurope, "nessuna coppa negli 8 giorni");
summarise(rows.filter((row) => row.europeGapDays >= 2 && row.europeGapDays <= 5), "coppa 2-5 giorni prima");
summarise(rows.filter((row) => row.europeGapDays >= 2 && row.europeGapDays <= 5 && row.europeAway), "  di cui in TRASFERTA");
summarise(rows.filter((row) => row.europeGapDays >= 2 && row.europeGapDays <= 5 && !row.europeAway), "  di cui in casa");
summarise(rows.filter((row) => row.europeGapDays >= 6 && row.europeGapDays <= 8), "coppa 6-8 giorni prima");
console.log("-".repeat(104));
summarise(rows.filter((row) => row.inEight <= 2), "al più 2 partite in 8 giorni");
summarise(rows.filter((row) => row.inEight >= 3), "3 o più partite in 8 giorni");

// Il confronto che decide la direzione: coppa recente contro nessuna coppa, appaiato sulle
// stesse quantità previste dal modello.
const withEurope = rows.filter((row) => row.europeGapDays >= 2 && row.europeGapDays <= 5);
const a = summarise(withEurope, "__");
const b = summarise(noEurope, "__");
if (a && b) {
  const delta = a.goalResidual - b.goalResidual;
  const error = Math.sqrt(a.goalError ** 2 + b.goalError ** 2);
  const deltaWin = a.winResidual - b.winResidual;
  const errorWin = Math.sqrt(a.winError ** 2 + b.winError ** 2);
  console.log("\n=== direzione dell'effetto (R6) ===");
  console.log(`  gol segnati    : ${(delta >= 0 ? "+" : "")}${delta.toFixed(4)} ± ${error.toFixed(4)}  (${(delta / error).toFixed(2)} sigma)`);
  console.log(`  vittorie       : ${(deltaWin >= 0 ? "+" : "")}${deltaWin.toFixed(4)} ± ${errorWin.toFixed(4)}  (${(deltaWin / errorWin).toFixed(2)} sigma)`);
  console.log(`  -> ${delta < 0 && deltaWin < 0 ? "negativa su entrambe: coerente con l'ipotesi" : delta > 0 && deltaWin > 0 ? "POSITIVA: l'ipotesi non regge, il task va chiuso (R6)" : "segni discordi fra gol e vittorie: nessuna direzione stabile"}`);
}
