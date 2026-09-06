#!/usr/bin/env node
// Lo strumento che mancava: dato un segnale, contiene informazione che la linea di chiusura NON
// prezza gia'?
//
// Tre sessioni hanno misurato "quanto siamo indietro al mercato" e hanno accettato o respinto
// meccanismi sul log loss del modello preso da solo. Nessuna delle due misure risponde alla
// domanda che decide se un segnale valga qualcosa, perche' un modello puo' essere peggiore del
// mercato e contenere comunque informazione che il mercato non ha — ed e' l'unico caso in cui
// aggiungerlo migliora davvero la previsione.
//
// Il test e' un'inclinazione a UN parametro sopra la linea di mercato:
//
//     p_casa  ∝ p_mkt_casa · e^(+beta·z)          (asimmetria)
//     p_pari  ∝ p_mkt_pari
//     p_osp   ∝ p_mkt_osp  · e^(−beta·z)
//
// con z il segnale standardizzato. `beta` si stima sul training e il guadagno si legge
// sull'holdout. Un parametro solo: se anche cosi' il guadagno fuori campione e' zero, non e'
// una questione di come il segnale e' stato combinato — l'informazione non c'e'.
//
// L'inclinazione sul pareggio (`p_pari ∝ p_mkt_pari · e^(gamma·z)`) e' la seconda forma testata,
// perche' un segnale puo' spostare probabilita' verso il pareggio senza toccare l'asimmetria.
//
//   node scripts/diag_signal_orthogonality.mjs                # bancata completa, ~2 min
//   node scripts/diag_signal_orthogonality.mjs --only coppe   # solo la diagnosi delle coppe
//   node scripts/diag_signal_orthogonality.mjs --only 1x2
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";

const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);
const BIG_FIVE = new Set(["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"]);
const CUPS = new Set(["ucl", "uel", "uecl"]);
const SECTIONS = ["1x2", "livello", "coppe"];

// Finestre di R7. Il peso si stima a sinistra e si legge a destra, sempre.
const TRAIN_END = "2025-05-31";
const HOLDOUT_START = "2025-07-08";

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const standardError = (v) => {
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1) / v.length);
};
const outcomeIndex = (m) => (m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2);
const finite = (x) => (Number.isFinite(x) ? x : null);

// Shin invece del de-vig proporzionale: e' il migliore dei due contro gli esiti (+0.00086 ±
// 0.00026, 3.3σ — vedi diag_market_execution.mjs), e qui il mercato e' il BENCHMARK da battere,
// quindi va preso nella sua forma piu' forte. Usarne una piu' debole gonfierebbe ogni guadagno.
function shinDevig(odds) {
  const q = odds.map((v) => 1 / v);
  const Q = q.reduce((s, v) => s + v, 0);
  const implied = (z) => q.map((qi) => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / Q) - z) / (2 * (1 - z)));
  const f = (z) => implied(z).reduce((s, v) => s + v, 0) - 1;
  let low = 1e-9;
  let high = 0.5;
  if (f(low) * f(high) > 0) return q.map((v) => v / Q);
  for (let i = 0; i < 120; i += 1) {
    const mid = (low + high) / 2;
    if (f(low) * f(mid) <= 0) high = mid; else low = mid;
  }
  const p = implied((low + high) / 2);
  const total = p.reduce((s, v) => s + v, 0);
  return p.map((v) => v / total);
}

function parseArguments(argv) {
  const options = { file: "data/matches.json", only: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") options.only = String(argv[++i] || "");
    else if (!argv[i].startsWith("--")) options.file = argv[i];
    else throw new Error(`Opzione non riconosciuta: ${argv[i]}`);
  }
  if (options.only && !SECTIONS.includes(options.only)) {
    throw new Error(`--only non riconosciuto: ${options.only} (usa ${SECTIONS.join(", ")})`);
  }
  return options;
}

function loadChronological(file) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const payload = JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
  const matches = Array.isArray(payload) ? payload : payload.matches;
  if (!Array.isArray(matches)) throw new Error("Il dataset non contiene un array matches.");
  return matches
    .filter((m) => SUPPORTED.has(String(m.competition_id)))
    .filter((m) => m.home_goals !== null && m.home_goals !== undefined)
    .filter((m) => m.away_goals !== null && m.away_goals !== undefined)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// R14: le stesse opzioni della pagina e di ogni backtest, dalla stessa funzione.
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

// Massimo a un parametro per sezione aurea. L'intervallo [-0.6, 0.6] copre inclinazioni molto
// piu' forti di qualunque segnale plausibile: se l'ottimo ci finisce sopra, il segnale sta
// facendo qualcosa di strano e va guardato, non accettato.
function fitTilt(rows, evaluate) {
  let low = -0.6;
  let high = 0.6;
  const phi = 0.6180339887;
  let a = high - phi * (high - low);
  let b = low + phi * (high - low);
  for (let i = 0; i < 60; i += 1) {
    if (evaluate(a) < evaluate(b)) high = b; else low = a;
    a = high - phi * (high - low);
    b = low + phi * (high - low);
  }
  return (low + high) / 2;
}

function tiltedThreeWay(market, z, beta, kind) {
  const raw = kind === "asimmetria"
    ? [market[0] * Math.exp(beta * z), market[1], market[2] * Math.exp(-beta * z)]
    : [market[0], market[1] * Math.exp(beta * z), market[2]];
  const total = raw[0] + raw[1] + raw[2];
  return raw.map((v) => v / total);
}

function benchThreeWay(rows, names, kind) {
  const train = rows.filter((r) => r.date <= TRAIN_END);
  const holdout = rows.filter((r) => r.date >= HOLDOUT_START);
  const results = [];
  for (const name of names) {
    const sample = train.map((r) => r.signals[name]).filter((x) => x !== null);
    if (sample.length < 200) continue;
    const centre = mean(sample);
    const spread = Math.sqrt(sample.reduce((s, x) => s + (x - centre) ** 2, 0) / (sample.length - 1));
    if (!(spread > 1e-9)) continue;
    const loss = (set, beta) => {
      let total = 0;
      let count = 0;
      for (const r of set) {
        if (r.signals[name] === null) continue;
        const p = tiltedThreeWay(r.market, (r.signals[name] - centre) / spread, beta, kind);
        total += -Math.log(Math.max(1e-15, p[r.outcome]));
        count += 1;
      }
      return count ? total / count : Infinity;
    };
    const beta = fitTilt(train, (b) => loss(train, b));
    const gains = (set) => set.filter((r) => r.signals[name] !== null).map((r) => {
      const p = tiltedThreeWay(r.market, (r.signals[name] - centre) / spread, beta, kind);
      return -Math.log(Math.max(1e-15, r.market[r.outcome])) + Math.log(Math.max(1e-15, p[r.outcome]));
    });
    const onHoldout = gains(holdout);
    if (onHoldout.length < 200) continue;
    results.push({ name, beta, train: mean(gains(train)), holdout: mean(onHoldout), error: standardError(onHoldout) });
  }
  return results.sort((a, b) => b.holdout - a.holdout);
}

function printBench(title, results) {
  console.log(`\n${title}\n`);
  console.log("segnale                              |  beta   | guad. training | guad. HOLDOUT       | sigma");
  console.log("-".repeat(102));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(36)} | ${(r.beta >= 0 ? "+" : "")}${r.beta.toFixed(3).padStart(6)} |    ${(r.train >= 0 ? "+" : "")}${r.train.toFixed(5)}    |  ${(r.holdout >= 0 ? "+" : "")}${r.holdout.toFixed(5)} ± ${r.error.toFixed(5)} | ${(r.holdout / r.error).toFixed(2).padStart(6)}`,
    );
  }
  const best = results[0];
  console.log(`\nmigliore fuori campione: ${best.name} a ${(best.holdout / best.error).toFixed(2)}σ.`);
  console.log(results.every((r) => r.holdout / r.error < 2)
    ? "NESSUN segnale raggiunge 2σ sull'holdout: non c'e' informazione ortogonale alla linea di chiusura."
    : "Almeno un segnale supera 2σ: va ri-testato su una finestra successiva prima di crederci (R15).");
  const overfit = results.filter((r) => r.train > 0 && r.holdout <= 0).length;
  console.log(`${overfit}/${results.length} segnali guadagnano sul training e non sull'holdout: e' la firma del sovradattamento.`);
}

// -------------------------------------------------------------- costruzione dei segnali
const DIFFERENCE_KEYS = {
  "Elo (differenza)": "elo",
  "punti/gara ultime 3": "ppg3",
  "punti/gara ultime 5": "ppg5",
  "punti/gara ultime 10": "ppg10",
  "gol fatti recenti": "gf5",
  "gol subiti recenti": "ga5",
  "xG fatti recenti": "xgFor5",
  "xG subiti recenti": "xgAgainst5",
  "tiri recenti": "shots5",
  "tiri concessi recenti": "shotsAgainst5",
  "tiri in porta recenti": "sot5",
  "residuo di risultato (3)": "resultResidual3",
  "residuo di risultato (10)": "resultResidual10",
  "sovra-rendimento xG": "xgResidual5",
  "giorni di riposo": "restDays",
  "gare giocate (differenza)": "matches",
  "affidabilita' del campione": "sampleReliability",
};

function signalsFor(result, market) {
  const s = {};
  for (const [label, key] of Object.entries(DIFFERENCE_KEYS)) {
    s[label] = finite(result.home?.[key] - result.away?.[key]);
  }
  const p = result.probabilities;
  // Il segnale che conta piu' di tutti: di quanto il modello dissente dal mercato. Se questo non
  // aggiunge nulla, nessuna ricombinazione degli altri puo' farlo.
  s["MODELLO: asimmetria contro mercato"] = finite(Math.log(p.homeWin / p.awayWin) - Math.log(market[0] / market[2]));
  s["MODELLO: pareggio contro mercato"] = finite(Math.log(p.draw) - Math.log(market[1]));
  s["forza netta xG"] = finite((result.home.xgFor5 - result.home.xgAgainst5) - (result.away.xgFor5 - result.away.xgAgainst5));
  s["forza netta gol"] = finite((result.home.gf5 - result.home.ga5) - (result.away.gf5 - result.away.ga5));
  s["rendimento in casa/trasferta"] = finite((result.home.venueGf5 - result.home.venueGa5) - (result.away.venueGf5 - result.away.venueGa5));
  s["carico recente (coppe incl.)"] = finite(result.load?.home - result.load?.away);
  return s;
}

function levelSignals(result, marketOver) {
  return {
    "lambda totale del modello": finite(result.lambdaHome + result.lambdaAway),
    "MODELLO: livello contro mercato": finite(
      Math.log(result.probabilities.over25 / (1 - result.probabilities.over25)) - Math.log(marketOver / (1 - marketOver)),
    ),
    "xG totali recenti": finite(result.home.xgFor5 + result.home.xgAgainst5 + result.away.xgFor5 + result.away.xgAgainst5),
    "gol totali recenti": finite(result.home.gf5 + result.home.ga5 + result.away.gf5 + result.away.ga5),
    "tiri totali recenti": finite(result.home.shots5 + result.away.shots5),
    "tiri in porta totali": finite(result.home.sot5 + result.away.sot5),
    "gare giocate (minimo)": finite(Math.min(result.home.matches, result.away.matches)),
    "qualita' dei dati": finite(result.quality?.score),
    "riposo (minimo)": finite(Math.min(result.home.restDays, result.away.restDays)),
  };
}

// -------------------------------------------------------------- sezione: coppe
// Nelle coppe non esiste una linea di mercato (copertura 0%), quindi la domanda cambia: il
// modello sa qualcosa rispetto al NON sapere niente? Il riferimento e' la frequenza storica
// degli esiti, che e' la previsione di chi non guarda la partita.
const FIXED_PRIOR = [0.437, 0.244, 0.319];

function sectionCoppe(chronological) {
  console.log("\n=== COPPE — dove il mercato non c'e', quanto sa il modello? ===\n");
  console.log("Copertura quote: 0% su tutte e tre le coppe UEFA. Il modello e' l'unico stimatore.");
  console.log("Riferimento: la frequenza storica fissa (43.7 / 24.4 / 31.9), cioe' non sapere niente.\n");
  const position = new Map(chronological.map((m, i) => [m, i]));
  const domesticSeen = new Map();
  const rows = [];
  for (const match of chronological) {
    if ((position.get(match) ?? 0) >= 100 && CUPS.has(match.competition_id)) {
      const home = domesticSeen.get(match.home_team) || 0;
      const away = domesticSeen.get(match.away_team) || 0;
      try {
        const result = predictOne(chronological, match);
        const p = result.probabilities;
        rows.push({
          competition: match.competition_id,
          home,
          away,
          outcome: outcomeIndex(match),
          probabilities: [p.homeWin, p.draw, p.awayWin],
        });
      } catch (error) {
        if (!/Dati recenti insufficienti/i.test(String(error?.message || error))) throw error;
      }
    }
    // Conteggio walk-forward: quante gare di campionato la squadra ha giocato PRIMA di adesso.
    if (BIG_FIVE.has(match.competition_id)) {
      for (const team of [match.home_team, match.away_team]) {
        domesticSeen.set(team, (domesticSeen.get(team) || 0) + 1);
      }
    }
  }
  const loss = (r) => -Math.log(Math.max(1e-15, r.probabilities[r.outcome]));
  const gainOverPrior = (r) => -Math.log(Math.max(1e-15, FIXED_PRIOR[r.outcome])) - loss(r);
  const hit = (r) => (r.probabilities.indexOf(Math.max(...r.probabilities)) === r.outcome ? 1 : 0);
  console.log(`gare di coppa valutate: ${rows.length}\n`);
  console.log("per DATI DOMESTICI disponibili (gare Big Five viste prima della partita)");
  console.log("gruppo                             |    n | logLoss | accuratezza | guadagno sul prior fisso | sigma");
  console.log("-".repeat(112));
  const groups = [
    ["entrambe con >= 20 gare", (r) => r.home >= 20 && r.away >= 20],
    ["una sola con >= 20", (r) => (r.home >= 20) !== (r.away >= 20)],
    ["nessuna delle due", (r) => r.home < 20 && r.away < 20],
  ];
  for (const [label, predicate] of groups) {
    const group = rows.filter(predicate);
    if (!group.length) continue;
    const gains = group.map(gainOverPrior);
    console.log(
      `${label.padEnd(34)} | ${String(group.length).padStart(4)} | ${mean(group.map(loss)).toFixed(4)}  |    ${(100 * mean(group.map(hit))).toFixed(1)}%    |     ${mean(gains).toFixed(4)} ± ${standardError(gains).toFixed(4)}     | ${(mean(gains) / standardError(gains)).toFixed(1).padStart(4)}`,
    );
  }
  console.log("\nper competizione");
  for (const competition of ["ucl", "uel", "uecl"]) {
    const group = rows.filter((r) => r.competition === competition);
    if (!group.length) continue;
    const gains = group.map(gainOverPrior);
    const share = group.filter((r) => r.home < 20 && r.away < 20).length / group.length;
    console.log(
      `  ${competition.padEnd(5)} n=${String(group.length).padStart(4)}  logLoss ${mean(group.map(loss)).toFixed(4)}`
      + `  guadagno sul prior ${mean(gains).toFixed(4)} ± ${standardError(gains).toFixed(4)} (${(mean(gains) / standardError(gains)).toFixed(1)}σ)`
      + `  ·  ${(100 * share).toFixed(0)}% di gare senza dati domestici`,
    );
  }
  const orphanTeams = new Set();
  const cupTeams = new Set();
  const nonCupTeams = new Set();
  for (const m of chronological) {
    for (const t of [m.home_team, m.away_team]) {
      if (CUPS.has(m.competition_id)) cupTeams.add(t); else nonCupTeams.add(t);
    }
  }
  for (const t of cupTeams) if (!nonCupTeams.has(t)) orphanTeams.add(t);
  console.log(`\nsquadre viste in coppa: ${cupTeams.size} · di cui senza NESSUNA gara non-di-coppa nel dataset: ${orphanTeams.size} (${(100 * orphanTeams.size / cupTeams.size).toFixed(0)}%)`);
  console.log("E' un buco di DATI, non un difetto del modello: per quelle squadre non esistono ne'");
  console.log("Elo costruito su un campionato, ne' forma, ne' una linea di mercato da cui dedurli.");
}

// -------------------------------------------------------------- main
try {
  const options = parseArguments(process.argv.slice(2));
  const chronological = loadChronological(options.file);
  const wants = (section) => !options.only || options.only === section;
  console.log(`dataset: ${options.file} · ${chronological.length} gare concluse nelle competizioni supportate`);
  console.log(`training fino al ${TRAIN_END} · holdout dal ${HOLDOUT_START}`);

  if (wants("1x2") || wants("livello")) {
    const position = new Map(chronological.map((m, i) => [m, i]));
    const rows = [];
    const levelRows = [];
    for (const match of chronological) {
      if ((position.get(match) ?? 0) < 100) continue;
      if (!(Number(match.home_odds_close) > 1 && Number(match.draw_odds_close) > 1 && Number(match.away_odds_close) > 1)) continue;
      let result;
      try {
        result = predictOne(chronological, match);
      } catch (error) {
        if (/Dati recenti insufficienti/i.test(String(error?.message || error))) continue;
        throw error;
      }
      const market = shinDevig([match.home_odds_close, match.draw_odds_close, match.away_odds_close]);
      rows.push({ date: match.date, market, outcome: outcomeIndex(match), signals: signalsFor(result, market) });
      if (Number(match.over25_odds_close) > 1 && Number(match.under25_odds_close) > 1) {
        const raw = [1 / match.over25_odds_close, 1 / match.under25_odds_close];
        const over = raw[0] / (raw[0] + raw[1]);
        levelRows.push({
          date: match.date,
          market: [over, 0, 1 - over],
          outcome: match.home_goals + match.away_goals >= 3 ? 0 : 2,
          signals: levelSignals(result, over),
        });
      }
    }
    console.log(`\ngare con linea di chiusura: ${rows.length} (di cui ${levelRows.length} anche con Over/Under 2.5)`);
    if (wants("1x2")) {
      const names = Object.keys(rows[0].signals);
      printBench("=== 1X2 — il segnale aggiunge informazione alla chiusura de-vigata con Shin? ===", benchThreeWay(rows, names, "asimmetria"));
      printBench("=== 1X2 — stessa bancata, inclinando il PAREGGIO invece dell'asimmetria ===", benchThreeWay(rows, names, "pareggio"));
    }
    if (wants("livello")) {
      printBench("=== OVER/UNDER 2.5 — stessa domanda sulla dimensione del livello ===", benchThreeWay(levelRows, Object.keys(levelRows[0].signals), "asimmetria"));
    }
  }

  if (wants("coppe")) sectionCoppe(chronological);
} catch (error) {
  console.error(`diag_signal_orthogonality fallito: ${error.message}`);
  process.exitCode = 1;
}
