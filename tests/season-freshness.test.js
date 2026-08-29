import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

// Il difetto che questo file cattura (misura sul dataset del 25/08/2026, 3544 gare):
//
//   fascia   |    n | logLoss | quality
//   01-03    |  330 |  1.004  |  0.947
//   20+      | 1672 |  0.994  |  1.000
//
// Alla prima giornata il modello è praticamente sicuro quanto alla trentesima. Non perché
// creda di avere dati freschi, ma perché non ha modo di sapere che non li ha: dataQuality è
// dominata da `depth = (home.matches + away.matches) / 20`, dove `matches` è la coda di 40
// partite che ATTRAVERSA L'ESTATE. Venti partite della stagione scorsa contano come venti
// partite di questa.
//
// Il meccanismo di prudenza esiste ed è calibrato — applyCalibration interpola `shrink` fra
// asymmetryShrinkLowQuality (0.30) e asymmetryShrink (0.71) in base a quality.score — ma con
// uno score che non scende sotto 0.94 la compressione passa da 0.71 a 0.694: inerte.
//
// Nota storica: prima di Task 1 lo score alla prima giornata era 0.902 e in fascia 20+ 0.976.
// Correggere la copertura xG lo ha fatto SALIRE e ne ha compresso ancora lo spread, perché la
// componente xgCoverage era una delle poche che variava. Il problema è quindi peggiorato, non
// migliorato, ed è per questo che questo test è stato scritto dopo Task 1 e non prima.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);

// Due stagioni consecutive separate da una pausa estiva realistica (95 giorni), con un
// calendario a rotazione che dà a ogni squadra la stessa quantità di storia.
function twoSeasons({ newSeasonRounds }) {
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
        matches.push({
          date: iso(firstDate + round * 7 * DAY),
          season,
          competition_id: "ita.1",
          competition_type: "domestic",
          home_team: home,
          away_team: away,
          home_goals: 2,
          away_goals: 1,
          home_xg: 1.72,
          away_xg: 1.02,
          home_shots: 14,
          away_shots: 9,
          home_sot: 5,
          away_sot: 3,
        });
      }
      const fixed = rotation[0];
      const tail = rotation.slice(1);
      tail.unshift(tail.pop());
      rotation.splice(0, rotation.length, fixed, ...tail);
    }
  };
  const oldSeasonStart = Date.UTC(2024, 7, 18); // 2024-08-18
  emit("2425", 34, oldSeasonStart);
  const oldSeasonEnd = oldSeasonStart + 33 * 7 * DAY;
  const newSeasonStart = oldSeasonEnd + 95 * DAY; // pausa estiva di 95 giorni
  if (newSeasonRounds > 0) emit("2526", newSeasonRounds, newSeasonStart);
  return { matches, newSeasonStart };
}

// --- Direzione (R6): la qualità deve crollare all'apertura di stagione ------------------
// Il peso con cui il meccanismo viene ESERCITATO qui non è quello di produzione: in
// produzione seasonQualityWeight resta 0 perché la stima l'ha respinto (vedi in fondo).
// Serve comunque provare che il meccanismo funziona, altrimenti il risultato negativo non
// sarebbe interpretabile — "non migliora" e "non fa niente" sono due conclusioni diverse.
const EXERCISED_WEIGHT = 0.6;

const openingDay = twoSeasons({ newSeasonRounds: 0 });
const opening = predictFromMatches(openingDay.matches, {
  homeTeam: "Team-1",
  awayTeam: "Team-2",
  date: iso(openingDay.newSeasonStart),
  cutoffDate: iso(openingDay.newSeasonStart),
  competitionId: "ita.1",
  windowDays: 730,
  hyperparameters: { seasonQualityWeight: EXERCISED_WEIGHT },
});

const midSeason = twoSeasons({ newSeasonRounds: 20 });
const mature = predictFromMatches(midSeason.matches, {
  homeTeam: "Team-1",
  awayTeam: "Team-2",
  date: iso(midSeason.newSeasonStart + 20 * 7 * DAY),
  cutoffDate: iso(midSeason.newSeasonStart + 20 * 7 * DAY),
  competitionId: "ita.1",
  windowDays: 730,
  hyperparameters: { seasonQualityWeight: EXERCISED_WEIGHT },
});

assert.ok(
  mature.quality.score > 0.85,
  `A stagione inoltrata la qualità deve restare alta (>0.85), vale ${mature.quality.score.toFixed(3)}`,
);
assert.ok(
  opening.quality.score < 0.6,
  "Alla prima giornata di una stagione nuova ogni media del modello viene dalla stagione "
  + `precedente: quality.score deve scendere sotto 0.6, vale ${opening.quality.score.toFixed(3)}`,
);
assert.ok(
  opening.quality.score < mature.quality.score - 0.3,
  `Lo scarto fra prima giornata e stagione matura deve superare 0.3, vale ${(mature.quality.score - opening.quality.score).toFixed(3)}`,
);

// La freschezza deve essere esposta, non solo usata: senza il valore in chiaro non è
// verificabile dall'esterno né diagnosticabile quando cambierà comportamento.
assert.ok(
  Number.isFinite(opening.quality.seasonFreshness),
  "quality.seasonFreshness deve essere esposto",
);
assert.ok(
  opening.quality.seasonFreshness < 0.05,
  `Alla prima giornata nessuna gara della stagione corrente è nelle medie: freschezza attesa ~0, vale ${opening.quality.seasonFreshness}`,
);
assert.ok(
  mature.quality.seasonFreshness > 0.9,
  `Dopo 20 giornate le medie vengono quasi solo dalla stagione corrente, vale ${mature.quality.seasonFreshness}`,
);

// --- Neutralità (R1): a peso 0 l'output deve essere identico bit per bit -----------------
// Il default di produzione è 0, ed è una DECISIONE presa sui dati, non una dimenticanza.
// Stima su 2324+2425 (2779 gare, cinque valori di griglia) e validazione sull'holdout 2526:
// ogni peso maggiore di zero peggiora il log loss, in modo monotono nel peso, e a peggiorare
// di più sono proprio le fasce di inizio stagione che la modifica doveva aiutare. Il
// meccanismo funziona (le asserzioni sopra lo provano); l'ipotesi che lo motivava no.
// Se qualcuno lo riattiverà, dovrà prima cambiare questo numero e rifare la misura.
assert.equal(
  DEFAULT_HYPERPARAMETERS.seasonQualityWeight,
  0,
  "seasonQualityWeight deve restare neutro in produzione: la stima l'ha respinto",
);

const neutral = { seasonQualityWeight: 0 };
for (const scenario of [openingDay, midSeason]) {
  const rounds = scenario === midSeason ? 20 : 0;
  const date = iso(scenario.newSeasonStart + rounds * 7 * DAY);
  const withZero = predictFromMatches(scenario.matches, {
    homeTeam: "Team-1", awayTeam: "Team-2", date, cutoffDate: date,
    competitionId: "ita.1", windowDays: 730, hyperparameters: neutral,
  });
  // Il riferimento è il comportamento pre-modifica, riprodotto qui dalla formula originale
  // di dataQuality: 0.32 depth + 0.22 totalDepth + 0.18 baselineDepth + 0.18 freshness
  // + 0.10 (0.35 + 0.65 xg). A peso 0 il nuovo termine deve sparire esattamente, non
  // "quasi": una differenza nell'ultimo bit si propagherebbe a shrink e quindi ai lambda.
  const home = withZero.home;
  const away = withZero.away;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const legacy = clamp(
    0.32 * clamp((home.matches + away.matches) / 20, 0, 1)
    + 0.22 * clamp(withZero.trainingMatches / 500, 0, 1)
    + 0.18 * clamp(withZero.baselineMatches / 180, 0, 1)
    + 0.18 * Math.exp(-Math.max(0, Math.max(home.freshnessDays, away.freshnessDays) - 21) / 75)
    + 0.10 * (0.35 + 0.65 * ((home.xgCoverage + away.xgCoverage) / 2)),
    0,
    1,
  );
  assert.equal(
    withZero.quality.score,
    legacy,
    `A seasonQualityWeight = 0 la qualità deve coincidere bit per bit con la formula precedente (${withZero.quality.score} contro ${legacy})`,
  );
}

console.log("OK: freschezza di stagione — direzione (crollo all'apertura), esposizione del valore e neutralità bit per bit a peso 0");
