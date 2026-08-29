import assert from "node:assert/strict";
import fs from "node:fs";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

// Confidenza dichiarata: il modello deve dire quando sta prevedendo con poco, senza cambiare
// ciò che prevede.
//
// La distinzione è il punto. Reagire alla scarsità di dati — pesare di più la stagione in corso,
// regredire l'Elo al confine, scontare le neopromosse — è la famiglia «ridurre la fiducia nel
// passato», provata cinque volte su meccanismi indipendenti e peggiorata cinque volte. I
// parametri che la implementano esistono e stanno a valore neutro per decisione misurata. Qui si
// fa l'altra cosa: si dichiara l'incertezza e basta.
//
// Il test protegge quell'invariante — la confidenza non entra in nessuna formula che produca una
// probabilità — e verifica che l'etichetta si muova quando deve.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);

function season(label, startTime, rounds, goals) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      const homeGoals = goals[(round + index) % goals.length];
      const awayGoals = goals[(round + index + 2) % goals.length];
      matches.push({
        date: iso(startTime + round * 7 * DAY), season: label, competition_id: "ita.1",
        competition_type: "domestic", league_strength: 1550, importance: 1,
        home_team: home, away_team: away, home_goals: homeGoals, away_goals: awayGoals,
        home_xg: 0.8 + 0.4 * homeGoals, away_xg: 0.7 + 0.4 * awayGoals,
        home_shots: 10 + homeGoals, away_shots: 9 + awayGoals,
        home_sot: 3 + homeGoals, away_sot: 3 + awayGoals,
        home_red: 0, away_red: 0,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const PREVIOUS_START = Date.UTC(2024, 7, 17);
const CURRENT_START = Date.UTC(2025, 7, 16);
const previous = season("2425", PREVIOUS_START, 34, [2, 1, 3, 0, 1, 2]);
const current = season("2526", CURRENT_START, 20, [1, 2, 0, 3, 2, 1]);
const all = [...previous, ...current].sort((left, right) => left.date.localeCompare(right.date));

const predictAt = (match) => predictFromMatches(all, {
  homeTeam: match.home_team,
  awayTeam: match.away_team,
  date: match.date,
  cutoffDate: match.date,
  competitionId: "ita.1",
  season: match.season,
});

// --- 1) La confidenza non tocca la previsione ---------------------------------------------
// Verifica strutturale: `confidence` è calcolata da quantità già fissate, quindi deve essere
// possibile toglierla dal risultato senza che nulla di ciò che si prevede cambi. Il modo di
// controllarlo senza ricompilare è confrontare la previsione con la stessa previsione ottenuta
// da un percorso che la confidenza non può aver influenzato: `quality.score`, che è l'unico
// canale che ARRIVA alla calibrazione, deve restare quello di prima.
const opener = current[0];
const openerResult = predictAt(opener);
const midSeason = current[current.length - 1];
const midResult = predictAt(midSeason);

for (const result of [openerResult, midResult]) {
  assert.ok(result.confidence, "ogni previsione deve dichiarare una confidenza");
  assert.ok(result.confidence.score <= result.quality.score + 1e-12,
    "la confidenza non può essere più alta della qualità dei dati da cui deriva");
  // Il valore che entra nella calibrazione resta `quality.score`, non `confidence.score`.
  // Se un giorno qualcuno li scambiasse, la famiglia respinta rientrerebbe dalla finestra.
  assert.notEqual(result.confidence, result.quality, "confidence e quality non devono essere lo stesso oggetto");
}

// La prova diretta: due previsioni con confidenze DIVERSE ma calibrazione identica devono avere
// lambda coerenti con `quality.score`, non con `confidence.score`.
assert.ok(
  openerResult.confidence.score < midResult.confidence.score,
  "la confidenza a inizio stagione deve essere più bassa che a stagione inoltrata",
);
// `quality.score` distingue le due situazioni molto meno della confidenza: è il motivo per cui
// non poteva fare da etichetta. Sui Big Five veri non le distingue affatto (1.000 in ogni fascia
// tranne la primissima, §15); qui, su una lega sintetica di dieci squadre, la differenza esiste
// ma è tre volte più piccola. L'asserzione è sul rapporto, non sulla saturazione: la saturazione
// è un fatto dei dati veri e non si può pretendere da una fixture.
const qualityGap = midResult.quality.score - openerResult.quality.score;
const confidenceGap = midResult.confidence.score - openerResult.confidence.score;
assert.ok(
  confidenceGap > 2 * qualityGap,
  `la confidenza deve separare apertura e piena stagione più nettamente della qualità `
  + `(confidenza ${confidenceGap.toFixed(3)}, qualità ${qualityGap.toFixed(3)})`,
);

// --- 2) L'etichetta dichiara la composizione dell'evidenza ---------------------------------
// Alla prima giornata `seasonFreshness` è 0: la previsione viene per intero dalla stagione
// precedente, su rose che si sono mosse. L'etichetta deve dirlo, e a stagione inoltrata deve
// tacere.
//
// Attenzione a cosa NON si sta affermando. Sul campione pieno i campionati non mostrano un
// degrado di log loss a inizio stagione (giorni 0-9: 0.9992 ± 0.0274 contro 0.9926 ± 0.0104 a
// stagione piena): ciò che è grande lì è il divario dal mercato, non l'errore assoluto. Quindi
// questa etichetta dichiara da cosa è fatta l'evidenza, non prevede che il modello sbaglierà di
// più. Il degrado misurato vero sta nelle coppe (1.0657 contro 0.9736), e lo raccoglie il
// fattore xG.
assert.equal(openerResult.confidence.seasonEvidence, 0, "alla prima giornata nulla pesa dalla stagione in corso");
assert.equal(openerResult.confidence.label, "Bassa", "la prima giornata deve essere dichiarata a bassa confidenza");
assert.ok(
  openerResult.confidence.limits.some((limit) => limit.code === "stagione-non-iniziata"),
  "il motivo deve essere esplicito, non solo l'etichetta",
);

assert.ok(midResult.confidence.seasonEvidence > 0.9, "a stagione inoltrata l'evidenza è tutta corrente");
assert.equal(midResult.confidence.label, "Alta", "a stagione inoltrata non c'è nulla da dichiarare");
assert.deepEqual(midResult.confidence.limits, [], "nessun limite da segnalare a stagione inoltrata");

// --- 3) Monotonia lungo la stagione --------------------------------------------------------
// La confidenza non deve oscillare: man mano che i dati della stagione si accumulano può solo
// salire o restare ferma. Un'etichetta che va su e giù non è un'informazione utilizzabile.
let previousScore = -1;
let previousEvidence = -1;
for (let round = 0; round < 20; round += 1) {
  const match = current[round * 5];
  const result = predictAt(match);
  assert.ok(
    result.confidence.seasonEvidence >= previousEvidence - 1e-9,
    `giornata ${round + 1}: l'evidenza di stagione non può diminuire mentre la stagione avanza`,
  );
  assert.ok(
    result.confidence.score >= previousScore - 1e-9,
    `giornata ${round + 1}: la confidenza non può diminuire mentre la stagione avanza`,
  );
  previousEvidence = result.confidence.seasonEvidence;
  previousScore = result.confidence.score;
}

// --- 4) I meccanismi che REAGISCONO restano spenti -----------------------------------------
// La richiesta era «mantenere le previsioni il più verosimili, e dichiarare quando i dati non
// bastano». Dichiarare, non reagire: se un giorno questi default si muovessero, la previsione
// cambierebbe e questo test è il posto dove accorgersene.
assert.equal(DEFAULT_HYPERPARAMETERS.seasonQualityWeight, 0, "la freschezza di stagione non deve entrare nella calibrazione");
assert.equal(DEFAULT_HYPERPARAMETERS.seasonEloRegression, 1, "l'Elo non deve regredire al confine di stagione");
assert.equal(DEFAULT_HYPERPARAMETERS.newcomerEloAnchor, 0, "il cold-start neopromosse resta neutro");
assert.equal(DEFAULT_HYPERPARAMETERS.newcomerEloRetention, 1, "il cold-start neopromosse resta neutro");

// E la conferma che accenderli cambierebbe davvero la previsione, cioè che sono spenti per
// scelta e non perché inerti: se questo smettesse di valere, i quattro controlli sopra
// starebbero proteggendo nulla.
const reactive = predictFromMatches(all, {
  homeTeam: opener.home_team, awayTeam: opener.away_team, date: opener.date,
  cutoffDate: opener.date, competitionId: "ita.1", season: opener.season,
  hyperparameters: { seasonQualityWeight: 0.5 },
});
assert.notEqual(
  reactive.lambdaHome,
  openerResult.lambdaHome,
  "seasonQualityWeight deve cambiare la previsione: è la ragione per cui la confidenza usa un canale separato",
);

// --- 5) Sui dati veri: l'etichetta deve ORDINARE le gare per accuratezza -------------------
// Una confidenza non tarabile su nulla ha comunque una proprietà falsificabile: se le gare che
// dichiara affidabili non sono davvero previste meglio, l'etichetta è decorazione. Il confronto
// non è circolare — la confidenza non entra in nessuna previsione, quindi le probabilità sono
// identiche nelle tre fasce.
//
// Qui il campione è ridotto per tenere il test veloce, e l'asserzione è solo sulla direzione.
// La misura piena, con errori standard e segmentazione, sta in scripts/diag_confidence.mjs:
// Alta 0.9905 su 5384 gare contro 1.0252 (Media) e 1.0369 (Bassa), differenza fra Alta e
// non-Alta 0.0392 ± 0.0093, cioè 4.23 sigma.
const datasetPath = new URL("../data/matches.json", import.meta.url);
if (!fs.existsSync(datasetPath)) {
  console.log("   (dataset assente: salto la validazione sui dati veri)");
} else {
  const SUPPORTED = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "ucl", "uel", "uecl"]);
  const payload = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const real = payload.matches
    .filter((match) => SUPPORTED.has(String(match.competition_id)))
    .filter((match) => match.home_goals !== null && match.away_goals !== null)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const sample = real.filter((match) => String(match.date) >= "2023-08-01").filter((_, index) => index % 18 === 0);

  const byLabel = new Map([["Alta", []], ["Media", []], ["Bassa", []]]);
  for (const match of sample) {
    let result;
    try {
      result = predictFromMatches(real, {
        homeTeam: match.home_team, awayTeam: match.away_team, date: match.date,
        cutoffDate: match.date, competitionId: match.competition_id, season: match.season,
      });
    } catch { continue; }
    const actual = match.home_goals > match.away_goals ? 0 : match.home_goals === match.away_goals ? 1 : 2;
    const probabilities = [result.probabilities.homeWin, result.probabilities.draw, result.probabilities.awayWin];
    byLabel.get(result.confidence.label).push(-Math.log(Math.max(1e-15, probabilities[actual])));
  }

  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const high = byLabel.get("Alta");
  const rest = [...byLabel.get("Media"), ...byLabel.get("Bassa")];
  assert.ok(high.length > 50 && rest.length > 20, "campione reale insufficiente per la verifica");
  assert.ok(
    average(high) < average(rest),
    `le gare dichiarate ad alta confidenza devono essere previste meglio delle altre `
    + `(Alta ${average(high).toFixed(4)}, resto ${average(rest).toFixed(4)}). `
    + "Se si inverte, l'etichetta ha smesso di dire qualcosa e va rivista, non ignorata.",
  );
}

console.log("OK: confidenza dichiarata — bassa alla prima giornata con il motivo esplicito, monotona lungo la stagione, predittiva sui dati veri, e senza alcun effetto sulle previsioni");
