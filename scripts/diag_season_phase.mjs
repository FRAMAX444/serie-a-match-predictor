#!/usr/bin/env node
// Diagnostica segmentata: la qualità della previsione dipende dalla fase della stagione?
//
// R5 del brief impone di segmentare SEMPRE per fase di stagione, lega e copertura xG: un
// guadagno aggregato che nasconde un peggioramento su un segmento non è un guadagno. La
// struttura a bucket è la stessa per i tre assi, cambia solo la funzione bucketOf().
//
// Uso:
//   node scripts/diag_season_phase.mjs [since] [--by phase|league|xgcoverage]
//                                      [--competition ita.1] [--variant '{"k":1}']
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOM = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);

function parseArguments(argv) {
  const options = { since: "2024-08-01", until: "9999-12-31", by: "phase", competition: "", variant: null, file: "data/matches.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--until") options.until = String(argv[++index] || "").slice(0, 10);
    else if (argument === "--by") options.by = String(argv[++index] || "phase");
    else if (argument === "--competition") options.competition = String(argv[++index] || "");
    else if (argument === "--variant") options.variant = JSON.parse(String(argv[++index] || "null"));
    else if (argument === "--file") options.file = String(argv[++index] || options.file);
    else if (!argument.startsWith("--")) options.since = String(argument).slice(0, 10);
    else throw new Error(`Opzione non riconosciuta: ${argument}`);
  }
  if (!BUCKETERS[options.by]) {
    throw new Error(`--by non riconosciuto: ${options.by} (usa ${Object.keys(BUCKETERS).join(", ")})`);
  }
  return options;
}

// Ogni bucketer dichiara anche l'ordine in cui le fasce vanno stampate: un ordinamento
// alfabetico metterebbe "20+" prima di "04-06" e renderebbe illeggibile il trend.
const BUCKETERS = {
  phase: {
    order: ["01-03", "04-06", "07-10", "11-19", "20+"],
    of: (match) => (match.__phase <= 3 ? "01-03" : match.__phase <= 6 ? "04-06" : match.__phase <= 10 ? "07-10" : match.__phase <= 19 ? "11-19" : "20+"),
  },
  league: {
    order: ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"],
    of: (match) => String(match.competition_id),
  },
  // La copertura xG è una proprietà della PREVISIONE (quota di gare recenti delle due
  // squadre con xG reale e non dal fallback di xgValue), non della partita: per questo il
  // bucketer riceve anche il risultato del modello.
  xgcoverage: {
    order: ["0-25%", "25-50%", "50-75%", "75-100%"],
    of: (_match, result) => {
      const coverage = result.xgCoverage;
      if (coverage < 0.25) return "0-25%";
      if (coverage < 0.5) return "25-50%";
      if (coverage < 0.75) return "50-75%";
      return "75-100%";
    },
  },
};

const options = parseArguments(process.argv.slice(2));
const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, options.file), "utf8"));
// L'array passato a predictFromMatches deve contenere ANCHE le coppe, anche quando si
// valuta un campionato. predictFromMatches filtra da sé le competizioni per costruire Elo e
// medie (competitionAllowed), quindi includerle non cambia nulla di quel calcolo — ma
// recentLoad(), resolveCurrentSeason() e newcomerIndex() leggono l'array COMPLETO, e con un
// array filtrato non vedrebbero mai una partita di Champions.
//
// Non è teoria: la prima esecuzione di questo confronto dava "0/2779 gare cambiate" per la
// variante sull'impegno europeo. Il meccanismo funzionava, la misura era cieca — lo stesso
// modo in cui newcomerEloDiscount è rimasto inerte per mesi.
const universe = payload.matches
  .filter((m) => m.home_goals !== null && m.away_goals !== null)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const all = universe.filter((m) => DOM.has(String(m.competition_id)));

// giornata "effettiva" per squadra: n-esima partita della squadra in quella stagione
const counter = new Map();
for (const m of all) {
  const kh = `${m.season}|${m.home_team}`;
  const ka = `${m.season}|${m.away_team}`;
  const ch = (counter.get(kh) || 0) + 1;
  const ca = (counter.get(ka) || 0) + 1;
  counter.set(kh, ch);
  counter.set(ka, ca);
  m.__phase = Math.min(ch, ca); // la più "acerba" delle due
}

const candidates = all
  .filter((m) => String(m.date) >= options.since && String(m.date) <= options.until)
  .filter((m) => !options.competition || String(m.competition_id) === options.competition);
const buckets = new Map();
const bucketer = BUCKETERS[options.by];

let done = 0;
let failed = 0;
for (const m of candidates) {
  try {
    const r = predictFromMatches(universe, {
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      date: m.date,
      cutoffDate: m.date,
      competitionId: m.competition_id,
      hyperparameters: options.variant,
    });
    const p = [r.probabilities.homeWin, r.probabilities.draw, r.probabilities.awayWin];
    const actual = m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2;
    const key = bucketer.of(m, r);
    const b = buckets.get(key) || { n: 0, ll: 0, acc: 0, q: 0, pHome: 0, pDraw: 0, pAway: 0, oHome: 0, oDraw: 0, oAway: 0, lam: 0, goals: 0, xg: 0 };
    b.n += 1;
    b.ll -= Math.log(Math.max(1e-15, p[actual]));
    b.acc += p.indexOf(Math.max(...p)) === actual ? 1 : 0;
    b.q += r.quality.score;
    b.pHome += p[0]; b.pDraw += p[1]; b.pAway += p[2];
    b.oHome += actual === 0 ? 1 : 0; b.oDraw += actual === 1 ? 1 : 0; b.oAway += actual === 2 ? 1 : 0;
    b.lam += r.lambdaHome + r.lambdaAway;
    b.goals += m.home_goals + m.away_goals;
    b.xg += r.xgCoverage;
    buckets.set(key, b);
    done += 1;
  } catch (e) { failed += 1; /* dati insufficienti */ }
}

const label = options.competition ? `${options.competition}, ` : "";
console.log(`valutate ${done} gare (${failed} scartate per dati insufficienti) — ${label}da ${options.since}, segmentate per ${options.by}\n`);
console.log("fascia  |    n | logLoss | acc   | quality | P(1)  oss   | P(X)  oss   | P(2)  oss   | gol att/oss | xgCov");
// Le chiavi osservate ma non previste dall'ordine dichiarato vanno stampate comunque, in
// coda: un bucketer che incontra una competizione nuova non deve perdere righe in silenzio.
const seen = [...buckets.keys()];
const order = [...bucketer.order.filter((k) => buckets.has(k)), ...seen.filter((k) => !bucketer.order.includes(k)).sort()];
for (const key of order) {
  const b = buckets.get(key);
  const f = (x) => (x / b.n).toFixed(3);
  console.log(
    `${key.padEnd(7)} | ${String(b.n).padStart(4)} |  ${f(b.ll)} | ${f(b.acc)} |  ${f(b.q)}  | ` +
    `${f(b.pHome)} ${f(b.oHome)} | ${f(b.pDraw)} ${f(b.oDraw)} | ${f(b.pAway)} ${f(b.oAway)} | ${f(b.lam)} ${f(b.goals)} | ${f(b.xg)}`,
  );
}
const total = [...buckets.values()].reduce((s, b) => ({ n: s.n + b.n, ll: s.ll + b.ll, acc: s.acc + b.acc }), { n: 0, ll: 0, acc: 0 });
console.log(`${"TOTALE".padEnd(7)} | ${String(total.n).padStart(4)} |  ${(total.ll / total.n).toFixed(3)} | ${(total.acc / total.n).toFixed(3)} |`);
