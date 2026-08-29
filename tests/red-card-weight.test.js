import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

// Una squadra rimasta in dieci produce dati che non descrivono il suo livello, e nemmeno
// quelli dell'avversaria, che gioca il resto della partita in superiorità. Il minuto del
// rosso NON è nel dataset (ci sono solo i conteggi), quindi non si può distinguere un rosso
// al 20' da uno al 93': l'unica cosa onesta è pesare meno l'intera partita, senza inventare
// una soglia che i dati non consentono di verificare. Riguarda il 16.5% delle gare.
//
// Questo file resta anche dopo la rimozione dei meccanismi di Task 7, 8 e 14 perché è
// l'unico dei quattro il cui effetto misurato è positivo su entrambe le finestre.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

function league(rounds, withReds) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      const involved = home === "Team-1" || away === "Team-1";
      const match = {
        date: iso(START + round * 7 * DAY), season: "2526", competition_id: "ita.1",
        competition_type: "domestic", league_strength: 1550,
        home_team: home, away_team: away,
        home_goals: home === "Team-1" ? 3 : 1, away_goals: away === "Team-1" ? 3 : 1,
        home_xg: 2.0, away_xg: 1.0, home_shots: 13, away_shots: 10, home_sot: 5, away_sot: 4,
        home_red: 0, away_red: 0,
      };
      if (withReds && involved && round % 2 === 0) match.away_red = 1;
      matches.push(match);
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const date = iso(START + 30 * 7 * DAY);
const predict = (matches, hyperparameters) => predictFromMatches(matches, {
  homeTeam: "Team-1", awayTeam: "Team-2", date, cutoffDate: date,
  competitionId: "ita.1", windowDays: 730, hyperparameters,
});

const withReds = league(30, true);
const noReds = league(30, false);

// --- Neutralità (R1) --------------------------------------------------------------------
assert.equal(
  predict(withReds, { redCardMatchWeight: 1 }).lambdaHome,
  predict(withReds, null).lambdaHome,
  "A peso 1 il lambda deve essere identico bit per bit",
);

// --- Il meccanismo non è inerte ---------------------------------------------------------
assert.notEqual(
  predict(withReds, { redCardMatchWeight: 0.4 }).lambdaHome,
  predict(withReds, null).lambdaHome,
  "Abbassare il peso delle partite con un rosso deve cambiare le medie",
);
// Senza rossi il parametro non deve toccare niente: l'effetto è localizzato alle gare
// falsate, non a tutte.
assert.equal(
  predict(noReds, { redCardMatchWeight: 0.4 }).lambdaHome,
  predict(noReds, null).lambdaHome,
  "Senza rossi il peso non deve avere alcun effetto",
);

// --- Vincolo di direzione ----------------------------------------------------------------
assert.ok(
  DEFAULT_HYPERPARAMETERS.redCardMatchWeight <= 1,
  "una partita falsata da un rosso non può contare PIÙ di una normale",
);

console.log("OK: peso delle partite con cartellino rosso — neutralità bit per bit, effetto localizzato alle sole gare falsate, vincolo di direzione");
