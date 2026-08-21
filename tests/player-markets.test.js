import assert from "node:assert/strict";
import { estimatePlayerMarkets, poissonPmf } from "../model.js";

// Attaccante con storico solido: 0.7 gol/90, 0.15 assist/90, 0.2 gialli/90, 2.5 tiri/90
// (nel range "buon attaccante" 2.5-3.0 tiri/90 di FBref/Opta, vedi docs/player-probability-study.md).
const striker = { appearances: 10, minutes: 850, goals_per90: 0.7, assists_per90: 0.15, yellow_per90: 0.2, red_per90: 0, shots_per90: 2.5 };

// 1) Con lambda squadra pari alla sua media storica, le probabilità devono essere
// plausibili (non 0, non vicine a 1) e i minuti attesi devono riflettere minutes/appearances.
const normal = estimatePlayerMarkets(striker, 1.5, 1.5);
assert.ok(normal.anytimeScorerProbability > 0.3 && normal.anytimeScorerProbability < 0.6);
assert.equal(normal.expectedMinutes, Math.round((850 / 10 / 90) * 90));

// 1b) shotProbability/multiShotProbability devono coincidere ESATTAMENTE con la definizione
// Poisson (P(X>=1) = 1-P(0), P(X>=2) = 1-P(0)-P(1)) calcolata con lo stesso poissonPmf usato
// dal modello: non un range plausibile ma il numero esatto che la formula deve produrre.
const expectedShotsNormal = 2.5 * ((850 / 10) / 90) * 1; // shots_per90 * minutesFactor * teamScaling(=1 qui)
assert.ok(Math.abs(normal.expectedShots - Math.round(expectedShotsNormal * 100) / 100) < 1e-9);
const p0 = poissonPmf(0, expectedShotsNormal);
const p1 = poissonPmf(1, expectedShotsNormal);
assert.ok(Math.abs(normal.shotProbability - (1 - p0)) < 1e-9, "shotProbability deve essere esattamente 1 - P(0 tiri)");
assert.ok(Math.abs(normal.multiShotProbability - (1 - p0 - p1)) < 1e-9, "multiShotProbability deve essere esattamente 1 - P(0) - P(1)");
// Un attaccante titolare con 2.5 tiri/90 è nel range realistico "probabile almeno un tiro":
// il range 0.85-0.95 riflette i benchmark reali di mercato per Over 0.5 tiri di un titolare offensivo.
assert.ok(normal.shotProbability > 0.85 && normal.shotProbability < 0.95, `shotProbability fuori dal range plausibile: ${normal.shotProbability}`);

// 1c) Invariante matematico che deve valere SEMPRE, qualunque siano gli input: la probabilità
// di 2+ eventi non può mai superare quella di 1+ eventi (P(X>=2) <= P(X>=1)). Se questo fallisse
// vorrebbe dire un errore di segno o di indice nella formula Poisson, non solo un valore fuori range.
assert.ok(normal.multiShotProbability <= normal.shotProbability, "P(>=2 tiri) non può superare P(>=1 tiro)");

// 2) Avversario più debole (lambda squadra più alto della media storica): la probabilità di
// gol, assist E TIRI deve salire (tutti scalano con l'intensità offensiva della squadra in
// questa partita), i cartellini (non legati al lambda) devono restare invariati.
const easyMatch = estimatePlayerMarkets(striker, 3.0, 1.5);
assert.ok(easyMatch.anytimeScorerProbability > normal.anytimeScorerProbability, "lambda più alto deve alzare la probabilità di gol");
assert.ok(easyMatch.assistProbability > normal.assistProbability, "lambda più alto deve alzare la probabilità di assist");
assert.ok(easyMatch.shotProbability > normal.shotProbability, "lambda più alto deve alzare la probabilità di tiro (stesso teamScaling degli assist)");
assert.ok(easyMatch.multiShotProbability > normal.multiShotProbability, "lambda più alto deve alzare anche la probabilità di 2+ tiri");
assert.equal(easyMatch.cardProbability, normal.cardProbability, "i cartellini non devono dipendere dal lambda squadra");

// 3) Avversario più forte (lambda squadra più basso): l'effetto deve essere simmetrico, verso il basso.
const hardMatch = estimatePlayerMarkets(striker, 0.7, 1.5);
assert.ok(hardMatch.anytimeScorerProbability < normal.anytimeScorerProbability);
assert.ok(hardMatch.shotProbability < normal.shotProbability, "lambda più basso deve abbassare la probabilità di tiro");

// 4) Giocatore che non ha mai giocato (0 presenze) o panchinaro (0 minuti): tutto a zero,
// niente NaN o probabilità spurie.
const noAppearances = estimatePlayerMarkets({ appearances: 0, minutes: 0, goals_per90: 0, assists_per90: 0, yellow_per90: 0, red_per90: 0, shots_per90: 0 }, 1.5, 1.5);
assert.deepEqual(noAppearances, {
  expectedMinutes: 0,
  expectedShots: 0,
  anytimeScorerProbability: 0,
  assistProbability: 0,
  cardProbability: 0,
  shotProbability: 0,
  multiShotProbability: 0,
});

const benchWarmer = { appearances: 5, minutes: 0, goals_per90: 0, assists_per90: 0, yellow_per90: 0, red_per90: 0, shots_per90: 0 };
const bench = estimatePlayerMarkets(benchWarmer, 1.5, 1.5);
assert.equal(bench.expectedMinutes, 0);
assert.equal(bench.anytimeScorerProbability, 0);
assert.equal(bench.shotProbability, 0);

// 5) Tutte le probabilità restano dentro [0, 1] anche con input volutamente estremi
// (tassi storici anomali, lambda squadra molto alto): il clamp deve tenerle sotto controllo.
const extreme = estimatePlayerMarkets({ appearances: 1, minutes: 90, goals_per90: 50, assists_per90: 50, yellow_per90: 50, red_per90: 50, shots_per90: 50 }, 10, 0.1);
for (const value of [extreme.anytimeScorerProbability, extreme.assistProbability, extreme.cardProbability, extreme.shotProbability, extreme.multiShotProbability]) {
  assert.ok(value >= 0 && value <= 1, `probabilità fuori range [0,1]: ${value}`);
}
assert.ok(extreme.multiShotProbability <= extreme.shotProbability, "l'invariante P(>=2)<=P(>=1) deve reggere anche negli estremi");

// 6) Ruoli difensivi (bassi tiri/90, coerente con il benchmark reale 0.3-0.8 tiri/90 per i
// difensori): shotProbability deve restare nettamente più bassa di un attaccante a parità di
// minuti e lambda, non solo "diversa da zero".
const centreBack = { appearances: 10, minutes: 900, goals_per90: 0.05, assists_per90: 0.03, yellow_per90: 0.15, red_per90: 0.02, shots_per90: 0.4 };
const defenderMarkets = estimatePlayerMarkets(centreBack, 1.5, 1.5);
assert.ok(defenderMarkets.shotProbability < normal.shotProbability, "un difensore centrale deve avere probabilità di tiro nettamente inferiore a un attaccante");
assert.ok(defenderMarkets.shotProbability > 0 && defenderMarkets.shotProbability < 0.4, `shotProbability difensore fuori dal range atteso: ${defenderMarkets.shotProbability}`);

console.log("OK: estimatePlayerMarkets — direzione corretta rispetto al lambda, gestione presenze/minuti a zero, clamp su input estremi, shotProbability/multiShotProbability coerenti con Poisson e con i benchmark reali per ruolo");
