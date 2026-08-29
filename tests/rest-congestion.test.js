import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

// restFactor() conosceva soltanto i giorni di riposo, con quattro soglie. Il dataset sa già
// QUALE competizione una squadra ha giocato mercoledì, perché ogni partita porta
// competition_id — ma per una previsione domestica predictFromMatches() filtra le coppe via
// da `chronological` (competitionAllowed), quindi quella partita non è priva di etichetta:
// è invisibile.
//
// Misura del 25/08/2026, 7088 osservazioni squadra-partita: per una squadra con una gara
// europea 2-5 giorni prima il riposo che il modello crede di vedere supera quello vero di
// 5.1 giorni in media, 6.0 se la trasferta europea era fuori casa. Il difetto non è un
// fattore mancante, è un input sbagliato — ed è invisibile perché produce un numero
// plausibile (7 giorni di riposo) invece di un errore.
//
// Direzione misurata prima di guardare il log loss (R6): dopo una TRASFERTA europea la
// probabilità di vittoria osservata sta 4.5pp sotto quella prevista (± 2.3pp), mentre dopo
// una gara europea IN CASA sta 2.1pp sopra. I due casi hanno segno opposto, ed è per questo
// che sono due parametri distinti e non uno.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

function league(rounds = 30) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      matches.push({
        date: iso(START + round * 7 * DAY), season: "2526", competition_id: "ita.1",
        competition_type: "domestic", league_strength: 1550,
        home_team: home, away_team: away, home_goals: 2, away_goals: 1,
        home_xg: 1.72, away_xg: 1.02, home_shots: 14, away_shots: 9, home_sot: 5, away_sot: 3,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const base = league(30);
const predictionDate = iso(START + 30 * 7 * DAY);
// Mercoledì precedente la giornata da prevedere: tre giorni di distanza.
const midweek = iso(START + 30 * 7 * DAY - 3 * DAY);

const cupMatch = (homeTeam, awayTeam) => ({
  date: midweek, season: "2526", competition_id: "ucl", competition_type: "europe",
  league_strength: 1500, home_team: homeTeam, away_team: awayTeam,
  home_goals: 1, away_goals: 1, home_xg: 1.2, away_xg: 1.1,
  home_shots: 12, away_shots: 11, home_sot: 4, away_sot: 4,
});
const domesticMidweek = { ...cupMatch("Team-1", "Estero"), competition_id: "ita.1", competition_type: "domestic", away_team: "Team-9", league_strength: 1550 };

const predict = (matches, hyperparameters) => predictFromMatches(matches, {
  homeTeam: "Team-1", awayTeam: "Team-2", date: predictionDate, cutoffDate: predictionDate,
  competitionId: "ita.1", windowDays: 730, hyperparameters,
});

// --- Neutralità (R1) --------------------------------------------------------------------
assert.equal(DEFAULT_HYPERPARAMETERS.restFactor.afterEuropeAway, 1, "il fattore trasferta europea resta neutro");
assert.equal(DEFAULT_HYPERPARAMETERS.restFactor.afterEuropeHome, 1, "il fattore coppa in casa resta neutro");
assert.equal(DEFAULT_HYPERPARAMETERS.restFactor.thirdInEight, 1, "il fattore terza partita in otto giorni resta neutro");

const awayTrip = base.concat([cupMatch("Estero", "Team-1")]);
assert.equal(
  predict(awayTrip, { restFactor: { afterEuropeAway: 1, afterEuropeHome: 1, thirdInEight: 1 } }).lambdaHome,
  predict(awayTrip, null).lambdaHome,
  "A fattori neutri il lambda deve essere identico bit per bit",
);

// --- La gara europea deve essere VISTA, pur essendo filtrata via da chronological --------
const withoutCup = predict(base, { restFactor: { afterEuropeAway: 0.9 } });
const withCup = predict(awayTrip, { restFactor: { afterEuropeAway: 0.9 } });
assert.ok(
  withCup.lambdaHome < withoutCup.lambdaHome,
  `Una trasferta europea tre giorni prima deve abbassare il lambda: ${withCup.lambdaHome.toFixed(4)} contro ${withoutCup.lambdaHome.toFixed(4)}`,
);
assert.equal(
  withCup.load.home.europeAway,
  true,
  "la gara europea più recente della squadra di casa era in trasferta",
);
assert.equal(withCup.load.home.europeGapDays, 3, "distanza dalla gara europea in giorni");

// --- Casa e trasferta europea sono due casi distinti, non uno -----------------------------
const homeCup = base.concat([cupMatch("Team-1", "Estero")]);
const homeCupPrediction = predict(homeCup, { restFactor: { afterEuropeAway: 0.9, afterEuropeHome: 1 } });
// La gara europea in casa NON deve attivare il fattore trasferta...
assert.equal(homeCupPrediction.load.home.europeAway, false);
// ...ma cambia comunque il lambda, perché corregge il RIPOSO: la squadra ha giocato tre
// giorni prima, e prima della correzione di tests/true-rest-days.test.js il modello la
// credeva riposata da sette. Che i due fattori europei siano neutri non rende invisibile una
// partita realmente giocata.
assert.ok(
  homeCupPrediction.lambdaHome < predict(base, { restFactor: { afterEuropeAway: 0.9, afterEuropeHome: 1 } }).lambdaHome,
  "Una gara europea in casa tre giorni prima deve comunque accorciare il riposo",
);
assert.equal(homeCupPrediction.load.home.lastMatchGapDays, 3);
// La distinzione fra i due casi resta: a parità di riposo, solo la trasferta attiva il suo
// fattore, quindi il lambda dopo una trasferta europea deve essere più basso.
assert.ok(
  predict(awayTrip, { restFactor: { afterEuropeAway: 0.9, afterEuropeHome: 1 } }).lambdaHome
    < homeCupPrediction.lambdaHome,
  "A parità di riposo, la trasferta europea deve pesare più della gara europea in casa",
);

// --- Una gara DOMESTICA infrasettimanale non deve attivare il fattore europeo -------------
// È la distinzione che il task esiste per introdurre: prima del cambiamento "quattro giorni
// di riposo" era una cosa sola, qualunque partita ci fosse stata dentro.
const domesticPrediction = predict(base.concat([domesticMidweek]), { restFactor: { afterEuropeAway: 0.9, afterEuropeHome: 0.9 } });
assert.ok(
  !Number.isFinite(domesticPrediction.load.home.europeGapDays),
  "una partita di campionato infrasettimanale non è un impegno europeo",
);

// --- Terza partita in otto giorni --------------------------------------------------------
const congested = base.concat([cupMatch("Estero", "Team-1")]);
const congestedPrediction = predict(congested, { restFactor: { thirdInEight: 0.9 } });
assert.ok(
  congestedPrediction.load.home.priorInEight >= 2,
  `La squadra ha giocato ${congestedPrediction.load.home.priorInEight} partite negli 8 giorni precedenti, attese almeno 2`,
);
assert.ok(
  congestedPrediction.lambdaHome < predict(congested, null).lambdaHome,
  "Il fattore di congestione deve abbassare il lambda quando è attivo",
);

// --- Vincolo di direzione (R6) sui valori spediti ----------------------------------------
// Un impegno europeo non può aumentare il rendimento successivo. Se un giorno qualcuno
// stimasse un valore > 1 e lo mettesse in produzione, starebbe compensando un altro errore,
// e questo test lo blocca prima del merge.
for (const key of ["afterEuropeAway", "afterEuropeHome", "thirdInEight"]) {
  assert.ok(
    DEFAULT_HYPERPARAMETERS.restFactor[key] <= 1,
    `${key} non può superare 1: un impegno in più non aumenta il rendimento successivo`,
  );
}

console.log("OK: riposo e congestione — la gara europea è visibile benché filtrata, casa e trasferta distinte, congestione a otto giorni, neutralità bit per bit e vincolo di direzione");
