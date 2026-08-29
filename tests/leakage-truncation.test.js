import assert from "node:assert/strict";
import { predictFromMatches, predictMatchdayFromMatches } from "../model.js";

// Q2 — R13 come invariante eseguibile, non come ispezione dei campi.
//
// R13 chiede che nulla di ciò che il modello usa dipenda da informazione posteriore alla
// previsione. La forma verificabile è un'invarianza: prevedere una gara con il dataset intero
// e con il dataset TRONCATO alla data della previsione deve dare lo stesso risultato, bit per
// bit. Se differiscono, qualcosa legge il futuro — quale campo sia è una domanda successiva.
//
// Il caso che si costruisce qui è la prima giornata di una stagione nuova, ed è il caso in cui
// il difetto si era nascosto: `resolveCurrentSeason()` deduceva la stagione dai confini delle
// stagioni presenti nell'array, quindi con l'array intero riconosceva la stagione N (dalle sue
// gare successive) e con l'array troncato no. In backtest l'array è intero, in produzione
// `payload.matches` contiene solo gare concluse ed è quindi sempre troncato a oggi: le due
// parti rispondevano diversamente alla stessa domanda.
//
// Il test gira con gli iperparametri di stagione ACCESI. Con i default non si vedrebbe nulla:
// seasonEloRegression 1, seasonQualityWeight 0 e il cold-start neopromosse 0/1 sono tutti
// neutri per decisione misurata, e rendono `currentSeason` inerte. Un test ai soli default
// avrebbe dato verde su un difetto armato — è esattamente ciò che è successo per due sessioni.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);

// Due stagioni consecutive della stessa lega, separate da una pausa estiva.
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
      // I risultati variano con la giornata: se fossero tutti uguali, troncare il dataset non
      // potrebbe cambiare nessuna media e il test non avrebbe denti.
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

const FIRST_START = Date.UTC(2024, 7, 17);
const SECOND_START = Date.UTC(2025, 7, 16); // ~52 settimane dopo: pausa estiva vera
const previous = season("2425", FIRST_START, 30, [2, 1, 3, 0, 1, 2]);
const current = season("2526", SECOND_START, 6, [1, 2, 0, 3, 2, 1]);
const all = [...previous, ...current].sort((left, right) => left.date.localeCompare(right.date));

// La gara da prevedere è la PRIMA della stagione nuova: il dataset troncato non contiene
// nessuna gara della stagione 2526, quello intero ne contiene sei giornate.
const target = current[0];
const identity = {
  homeTeam: target.home_team,
  awayTeam: target.away_team,
  date: target.date,
  cutoffDate: target.date,
  competitionId: "ita.1",
};
const truncated = all.filter((match) => match.date < target.date);
assert.ok(truncated.length >= 100, "servono almeno 100 gare precedenti perché il modello risponda");
assert.equal(
  truncated.filter((match) => match.season === "2526").length,
  0,
  "il dataset troncato non deve contenere nulla della stagione da prevedere",
);
assert.ok(
  all.filter((match) => match.season === "2526").length > 0,
  "il dataset intero deve contenere gare della stagione da prevedere, altrimenti non c'è niente da rilevare",
);

// Gli iperparametri che consumano `currentSeason`, accesi. Sono a valore neutro in produzione
// per decisione misurata: qui servono a rendere osservabile ciò che altrimenti è inerte.
const SCENARI = [
  ["seasonEloRegression", { seasonEloRegression: 0.80 }],
  ["seasonQualityWeight", { seasonQualityWeight: 0.50 }],
  ["cold-start neopromosse", { newcomerEloAnchor: 1, newcomerEloRetention: 0.7 }],
  ["tutti insieme", { seasonEloRegression: 0.80, seasonQualityWeight: 0.50, newcomerEloAnchor: 1, newcomerEloRetention: 0.7 }],
];

for (const [label, hyperparameters] of SCENARI) {
  const options = { ...identity, season: target.season, hyperparameters };
  const full = predictFromMatches(all, options);
  const cut = predictFromMatches(truncated, options);

  assert.equal(full.currentSeason, cut.currentSeason, `${label}: la stagione risolta dipende dal futuro`);
  assert.equal(full.currentSeason, "2526", `${label}: la stagione deve essere quella della gara`);
  for (const outcome of ["homeWin", "draw", "awayWin"]) {
    assert.equal(
      full.probabilities[outcome],
      cut.probabilities[outcome],
      `${label}: troncare il dataset alla data della previsione cambia P(${outcome}) — `
      + "qualcosa nel modello legge informazione posteriore alla previsione (R13)",
    );
  }
  assert.equal(full.lambdaHome, cut.lambdaHome, `${label}: lambda di casa dipendente dal futuro`);
  assert.equal(full.lambdaAway, cut.lambdaAway, `${label}: lambda ospite dipendente dal futuro`);
}

// --- Il meccanismo, fissato -------------------------------------------------------------
// Senza `season`, la stagione viene dedotta dall'array e le due parti rispondono
// diversamente. Non è uno scenario ipotetico: è ciò che facevano produzione e backtest fino
// al 27/08/2026. Fissarlo qui serve perché il test sopra non diventi verde per la ragione
// sbagliata — se un giorno il ripiego smettesse di divergere, il test perderebbe i denti
// senza che nessuno se ne accorga.
const deducedFull = predictFromMatches(all, identity).currentSeason;
const deducedCut = predictFromMatches(truncated, identity).currentSeason;
assert.notEqual(
  deducedFull,
  deducedCut,
  "Dedurre la stagione dall'array deve ancora divergere fra dataset intero e troncato: "
  + "se non diverge più, questo test non sta più verificando nulla",
);
assert.equal(deducedFull, "2526", "con l'array intero la stagione si deduce dalle gare successive");
assert.notEqual(deducedCut, "2526", "con l'array troncato la stagione della gara non è deducibile");

// --- Il percorso di produzione, che è quello troncato ------------------------------------
// I backtest passano `season` da sé; la pagina no — la riceve dalla fixture dentro
// predictMatchdayFromMatches. È l'anello che il test di parità non può vedere, perché
// `predictionOptions()` in app.js non conosce la partita. Qui si verifica sul comportamento:
// il dataset è quello troncato, cioè la forma che `payload.matches` ha davvero in produzione,
// e la stagione deve arrivare comunque.
const batch = predictMatchdayFromMatches(
  truncated,
  [{
    home_team: target.home_team,
    away_team: target.away_team,
    date: target.date,
    competition_id: "ita.1",
    season: target.season,
  }],
  { competitionId: "ita.1", hyperparameters: { seasonQualityWeight: 0.50 } },
);
assert.equal(
  batch.predictions[0].result.currentSeason,
  "2526",
  "predictMatchdayFromMatches deve propagare fixture.season: senza, la pagina deduce la stagione "
  + "da un array che in produzione non contiene la stagione in corso, e torna a divergere dai backtest",
);

console.log("OK: invarianza per troncamento (R13) — la previsione non cambia rimuovendo tutto ciò che segue il cutoff, anche con gli iperparametri di stagione accesi");
