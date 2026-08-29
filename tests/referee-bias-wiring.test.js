import assert from "node:assert/strict";
import { predictMatchdayFromMatches, refereeBiasFor } from "../model.js";

// `refereeHomeBias` era un parametro di predictFromMatches che NESSUN chiamante passava mai:
// il gancio esisteva, era documentato, era testato, ed era inerte. È lo stesso anti-pattern
// di newcomerEloDiscount, e il brief v1 lo elencava fra gli otto ganci a valore costante.
//
// Il brief v1 metteva lo scraping delle designazioni come contenuto principale di Task 10.
// È l'ordine sbagliato: il campo `referee` è presente sul **21.5%** delle gare passate,
// quindi l'effetto è misurabile senza rete. Prima si cabla e si misura; solo se l'effetto è
// distinguibile da zero ha senso pagare il costo di una fonte per le partite future.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

function league(rounds) {
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
        home_xg: 1.7, away_xg: 1.0, home_shots: 13, away_shots: 10, home_sot: 5, away_sot: 4,
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

const matches = league(30);
const date = iso(START + 30 * 7 * DAY);
const refereeStats = { "M Rossi": { matches: 80, home_win_rate: 0.48, home_bias: 0.05, avg_cards: 4.1 } };

const run = (fixtures, options) => predictMatchdayFromMatches(matches, fixtures, {
  competitionId: "ita.1", windowDays: 730, ...options,
});

// --- Arbitro ignoto: nessun effetto, che è il caso di ogni partita futura ---------------
const anonymous = [{ home_team: "Team-1", away_team: "Team-2", date, competition_id: "ita.1" }];
assert.equal(refereeBiasFor(anonymous[0], refereeStats), 0, "nessun campo referee -> nessun bias");
assert.equal(
  run(anonymous, { refereeStats }).predictions[0].result.refereeBias,
  0,
  "Con l'arbitro ignoto il bias deve restare 0: è il comportamento di prima del cablaggio",
);
assert.equal(
  run(anonymous, { refereeStats }).predictions[0].result.lambdaHome,
  run(anonymous, {}).predictions[0].result.lambdaHome,
  "Con l'arbitro ignoto passare referee_stats non deve cambiare nulla, bit per bit",
);

// --- Arbitro noto ma assente dalle statistiche: nessun effetto ---------------------------
const unknownName = [{ home_team: "Team-1", away_team: "Team-2", date, competition_id: "ita.1", referee: "Chi Sa" }];
assert.equal(refereeBiasFor(unknownName[0], refereeStats), 0, "arbitro non tracciato -> nessun bias");

// --- Arbitro noto e tracciato: il gancio si attiva ---------------------------------------
const known = [{ home_team: "Team-1", away_team: "Team-2", date, competition_id: "ita.1", referee: "M Rossi" }];
const withReferee = run(known, { refereeStats }).predictions[0].result;
assert.equal(withReferee.refereeBias, 0.05, "il bias deve essere letto da referee_stats");
assert.ok(
  withReferee.lambdaHome > run(known, {}).predictions[0].result.lambdaHome,
  "Un arbitro con bias casalingo positivo deve alzare il lambda di casa",
);

// --- È per PARTITA, non per turno ---------------------------------------------------------
// Un turno contiene arbitri diversi: applicare a tutte le gare il bias della prima sarebbe
// peggio che non applicarlo affatto.
const mixed = [
  { home_team: "Team-1", away_team: "Team-2", date, competition_id: "ita.1", referee: "M Rossi" },
  { home_team: "Team-3", away_team: "Team-4", date, competition_id: "ita.1" },
];
const batch = run(mixed, { refereeStats }).predictions;
assert.equal(batch[0].result.refereeBias, 0.05);
assert.equal(batch[1].result.refereeBias, 0, "la seconda gara non ha arbitro: deve restare a 0");

// --- Un valore esplicito vince sulla tabella ---------------------------------------------
// È il caso "lo so in anticipo e lo passo a mano" che il README documenta già.
assert.equal(
  run(known, { refereeStats, refereeHomeBias: -0.09 }).predictions[0].result.refereeBias,
  -0.09,
);

console.log("OK: cablaggio del bias arbitro — per partita, letto da referee_stats, 0 quando l'arbitro è ignoto o non tracciato, sovrascrivibile a mano");
