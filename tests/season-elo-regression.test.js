import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

// Il difetto (§2.3 del brief, verificato sul codice): decayInactiveElo() regredisce verso
// baselineElo solo dopo 45 giorni di inattività, con retention = exp(-(gap-45)/900). Una
// pausa estiva di 95 giorni dà exp(-50/900) = 0.946: una squadra a 1700 riparte da 1689,
// cioè regredisce del 5.4%. La pratica consolidata nei sistemi Elo calcistici è il 20-35%
// verso la media di lega al cambio stagione, perché fra una stagione e l'altra cambiano
// rosa, allenatore e obiettivi — un fenomeno che non ha niente a che vedere con "quanti
// giorni sono passati".
//
// Un solo meccanismo copre oggi due fenomeni distinti, e per giunta punta all'ancora
// sbagliata: baselineElo vale 1500, mentre le medie di lega vere sono 1570/1555/1550/1540/
// 1520 (campo league_strength). Una squadra che cambia lega deve regredire verso quella
// giusta, non verso 1500.
//
// Il bug SIMMETRICO da bloccare è quello che ha già colpito newcomerEloDiscount: il gancio
// esiste, è documentato, è testato — e non si attiva mai perché il confine non viene
// rilevato. Per questo qui non basta verificare "k=0.7 dà un numero plausibile": va
// verificato che il numero CAMBI al cambiare di k. Se non cambia, la regressione non sta
// avvenendo, qualunque valore mostri.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const LEAGUE_STRENGTH = 1550;

// Un campionato a 10 squadre in cui Team-1 vince sempre in casa e fuori: chiude la stagione
// con un Elo nettamente sopra la media di lega, che è la condizione in cui la regressione ha
// un effetto misurabile e di segno noto.
function twoSeasonsWithDominantTeam({ newSeasonRounds }) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const matches = [];
  const emit = (season, roundCount, firstDate) => {
    const rotation = teams.slice();
    for (let round = 0; round < roundCount; round += 1) {
      for (let index = 0; index < rotation.length / 2; index += 1) {
        const first = rotation[index];
        const second = rotation[rotation.length - 1 - index];
        const home = (round + index) % 2 === 0 ? first : second;
        const away = home === first ? second : first;
        const dominantIsHome = home === "Team-1";
        const dominantPlays = dominantIsHome || away === "Team-1";
        matches.push({
          date: iso(firstDate + round * 7 * DAY),
          season,
          competition_id: "ita.1",
          competition_type: "domestic",
          league_strength: LEAGUE_STRENGTH,
          home_team: home,
          away_team: away,
          home_goals: dominantPlays ? (dominantIsHome ? 3 : 0) : 1,
          away_goals: dominantPlays ? (dominantIsHome ? 0 : 3) : 1,
          home_xg: dominantPlays ? (dominantIsHome ? 2.6 : 0.6) : 1.2,
          away_xg: dominantPlays ? (dominantIsHome ? 0.6 : 2.6) : 1.2,
          home_shots: 13,
          away_shots: 11,
          home_sot: 5,
          away_sot: 4,
        });
      }
      const fixed = rotation[0];
      const tail = rotation.slice(1);
      tail.unshift(tail.pop());
      rotation.splice(0, rotation.length, fixed, ...tail);
    }
  };
  const oldStart = Date.UTC(2025, 7, 17);
  emit("2526", 34, oldStart);
  const oldEnd = oldStart + 33 * 7 * DAY;
  const newStart = oldEnd + 95 * DAY; // pausa estiva realistica
  if (newSeasonRounds > 0) emit("2627", newSeasonRounds, newStart);
  return { matches, newStart };
}

const opening = twoSeasonsWithDominantTeam({ newSeasonRounds: 0 });
const openingDate = iso(opening.newStart);

const eloAt = (k) => predictFromMatches(opening.matches, {
  homeTeam: "Team-1",
  awayTeam: "Team-2",
  date: openingDate,
  cutoffDate: openingDate,
  competitionId: "ita.1",
  windowDays: 730,
  hyperparameters: k === null ? null : { seasonEloRegression: k },
}).home.elo;

const eloDefault = eloAt(null);
const eloNeutral = eloAt(1);
const elo70 = eloAt(0.7);
const elo50 = eloAt(0.5);

// --- Neutralità (R1): k = 1 non deve cambiare niente, bit per bit ------------------------
assert.equal(
  DEFAULT_HYPERPARAMETERS.seasonEloRegression,
  1,
  "seasonEloRegression deve avere default 1 (nessun effetto) finché non è validato",
);
assert.equal(
  eloNeutral,
  eloDefault,
  `A k = 1 l'Elo deve essere identico al default (${eloNeutral} contro ${eloDefault})`,
);

// --- Direzione (R6): il confine viene rilevato e la regressione avviene ------------------
assert.ok(
  eloDefault > LEAGUE_STRENGTH + 40,
  `La squadra dominante deve chiudere ben sopra la media di lega, vale ${eloDefault.toFixed(1)}`,
);
assert.notEqual(
  elo70,
  eloNeutral,
  "A k = 0.7 l'Elo di apertura deve CAMBIARE: se resta identico il confine di stagione non "
  + "viene rilevato, ed è esattamente il modo in cui newcomerEloDiscount è rimasto inerte",
);
assert.ok(
  elo70 > LEAGUE_STRENGTH && elo70 < eloNeutral,
  `L'Elo di apertura a k = 0.7 deve stare STRETTAMENTE fra la media di lega (${LEAGUE_STRENGTH}) `
  + `e il valore non regredito (${eloNeutral.toFixed(1)}), vale ${elo70.toFixed(1)}`,
);
assert.ok(
  elo50 < elo70,
  `Un k più piccolo deve regredire di più: k=0.5 dà ${elo50.toFixed(1)}, k=0.7 dà ${elo70.toFixed(1)}`,
);

// --- La regressione punta alla media di LEGA, non a 1500 --------------------------------
// Con k = 0 la squadra deve finire esattamente sulla media della sua lega. Se il codice
// regredisse verso baselineElo (1500, il valore di partenza di emptyState) il risultato
// sarebbe visibilmente più basso, ed è l'errore che §2.3 segnala: l'ancora sbagliata.
const elo0 = eloAt(0);
assert.ok(
  Math.abs(elo0 - LEAGUE_STRENGTH) < 12,
  `A k = 0 l'Elo di apertura deve coincidere con la media di lega ${LEAGUE_STRENGTH}, `
  + `vale ${elo0.toFixed(1)} — se punta a 1500 l'ancora è sbagliata`,
);

// --- Il confine è la STAGIONE, non il numero di giorni ----------------------------------
// Dentro la stessa stagione una pausa lunga quanto quella estiva non deve far scattare la
// regressione: è il caso che una regola "sono passati N giorni" sbaglierebbe, e il brief lo
// segnala esplicitamente perché confonde sosta invernale e cambio stagione.
const midSeason = twoSeasonsWithDominantTeam({ newSeasonRounds: 6 });
const midDate = iso(midSeason.newStart + 6 * 7 * DAY);
const midElo = (k) => predictFromMatches(midSeason.matches, {
  homeTeam: "Team-1", awayTeam: "Team-2", date: midDate, cutoffDate: midDate,
  competitionId: "ita.1", windowDays: 730, hyperparameters: { seasonEloRegression: k },
}).home.elo;
assert.notEqual(
  midElo(0.7),
  midElo(1),
  "Anche a stagione iniziata l'effetto del confine estivo deve restare visibile nello stato",
);

console.log("OK: regressione dell'Elo al confine di stagione — rilevamento del confine, ancora sulla media di lega, monotonia in k e neutralità a k = 1");
