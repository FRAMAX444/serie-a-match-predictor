import assert from "node:assert/strict";
import { scoreMatrix, matrixProbabilities, DEFAULT_HYPERPARAMETERS } from "../model.js";

// Q4 — fattore di prolificità condiviso fra le due squadre della stessa partita.
//
// Un fattore Z di media 1 e varianza φ moltiplica ENTRAMBI i lambda: X|Z ~ Poisson(Z·λcasa),
// Y|Z ~ Poisson(Z·λtrasferta). Integrando Z fuori si ottiene la binomiale negativa bivariata.
// Il test verifica le tre proprietà che rendono il meccanismo quello dichiarato, e non un
// altro travestito — la distinzione che il prompt sessione 3 mette al centro di Q4.

const LAMBDA = [[1.55, 1.20], [2.10, 0.85], [1.05, 1.05], [0.70, 2.40]];
const PHI = [0, 0.02, 0.05, 0.10, 0.20, 0.40];

// --- 1) Neutralità esatta a φ = 0 --------------------------------------------------------
// Non "quasi uguale": bit per bit. A φ = 0 scoreMatrix passa dal ramo Poisson di sempre, e il
// default in produzione è 0 — un parametro nuovo non deve poter cambiare una previsione
// finché non lo si accende (R1).
assert.equal(DEFAULT_HYPERPARAMETERS.sharedDispersion, 0, "il default deve essere neutro");
for (const [home, away] of LAMBDA) {
  const withoutParameter = scoreMatrix(home, away, 8, -0.04);
  const explicitZero = scoreMatrix(home, away, 8, -0.04, 0);
  for (let x = 0; x <= 8; x += 1) {
    for (let y = 0; y <= 8; y += 1) {
      assert.equal(explicitZero[x][y], withoutParameter[x][y], `φ = 0 deve essere identico alla Poisson in (${x},${y})`);
    }
  }
}

// --- 2) Le marginali restano di media λ ---------------------------------------------------
// È la proprietà che distingue questo meccanismo dalla compressione dell'asimmetria, respinta
// tre volte: E[Z] = 1, quindi il LIVELLO dei gol previsti non si muove e resta quello
// calibrato altrove. Si muove solo la forma della congiunta.
//
// Il confronto è fatto a rho = 0: la correzione di Dixon-Coles sposta massa fra quattro celle
// e altera le medie di suo, quindi mescolarla qui misurerebbe due cose insieme.
for (const [home, away] of LAMBDA) {
  for (const phi of PHI) {
    const matrix = scoreMatrix(home, away, 12, 0, phi);
    let meanHome = 0;
    let meanAway = 0;
    matrix.forEach((row, x) => row.forEach((probability, y) => {
      meanHome += x * probability;
      meanAway += y * probability;
    }));
    // La tolleranza copre il troncamento della matrice a 12 gol, non un errore del meccanismo:
    // la coda oltre il 12 è più pesante con φ alto ed è lì che finisce la media mancante.
    assert.ok(
      Math.abs(meanHome - home) < 0.02 && Math.abs(meanAway - away) < 0.02,
      `φ = ${phi}: le marginali devono restare di media λ (atteso ${home}/${away}, ottenuto ${meanHome.toFixed(3)}/${meanAway.toFixed(3)})`,
    );
  }
}

// --- 3) Direzione (R6), nota in anticipo e monotona ---------------------------------------
// Un fattore condiviso induce correlazione POSITIVA fra i due punteggi, quindi alza P(X=Y).
// Il segno è noto prima di misurare, che è il criterio che ha protetto gli unici interventi
// riusciti di tre sessioni. La probabilità che il pareggio guadagna deve venire da ENTRAMBE le
// vittorie, non da una sola: se venisse da una sola, il meccanismo starebbe spostando
// l'asimmetria e sarebbe il meccanismo già respinto sotto un altro nome.
for (const [home, away] of LAMBDA) {
  let previous = null;
  for (const phi of PHI) {
    const current = matrixProbabilities(scoreMatrix(home, away, 10, -0.04, phi));
    assert.ok(
      Math.abs(current.homeWin + current.draw + current.awayWin - 1) < 1e-9,
      `φ = ${phi}: le tre probabilità devono sommare a 1`,
    );
    if (previous) {
      assert.ok(current.draw > previous.draw, `φ = ${phi}: il pareggio deve crescere con φ (λ ${home}/${away})`);
      assert.ok(current.homeWin < previous.homeWin, `φ = ${phi}: la vittoria casalinga deve calare con φ (λ ${home}/${away})`);
      assert.ok(current.awayWin < previous.awayWin, `φ = ${phi}: la vittoria ospite deve calare con φ (λ ${home}/${away})`);
    }
    previous = current;
  }
}

// --- 4) Come il pareggio guadagna: NON come il prompt sessione 3 sosteneva ----------------
// Q4 nasceva dall'idea che il fattore condiviso alzi «P(X=Y) su tutta la matrice invece che
// solo in basso», a differenza di `rho`. Misurato, è falso, e il test lo fissa perché la
// premessa non torni a circolare: il meccanismo agisce sulla distribuzione del TOTALE dei gol,
// spostando massa dal centro verso ENTRAMBE le code. Il pareggio guadagna in aggregato, ma
// quasi tutto il guadagno finisce su 0-0 (che è per intero la coda "totale = 0"), mentre 1-1 e
// 2-2 PERDONO massa.
//
// La differenza con `rho` resta reale — `rho` tocca quattro celle e basta, questo ridistribuisce
// l'intera matrice — ma non è la differenza che Q4 dichiarava. Vedi docs/misure-riferimento.md §20.
const base = scoreMatrix(1.55, 1.20, 10, 0, 0);
const dispersed = scoreMatrix(1.55, 1.20, 10, 0, 0.10);

const totalGoals = (matrix, total) => {
  let probability = 0;
  for (let home = 0; home <= total; home += 1) {
    if (total - home < matrix.length) probability += matrix[home][total - home];
  }
  return probability;
};

// Le code del totale salgono, il centro scende: è la firma della sovradispersione.
for (const total of [0, 1]) {
  assert.ok(totalGoals(dispersed, total) > totalGoals(base, total), `la coda bassa del totale (${total} gol) deve salire`);
}
for (const total of [2, 3, 4]) {
  assert.ok(totalGoals(dispersed, total) < totalGoals(base, total), `il centro del totale (${total} gol) deve scendere`);
}
for (const total of [6, 7]) {
  assert.ok(totalGoals(dispersed, total) > totalGoals(base, total), `la coda alta del totale (${total} gol) deve salire`);
}

// Il pareggio in aggregato sale, ma la sua struttura è quella misurata, non quella dichiarata.
assert.ok(dispersed[0][0] > base[0][0], "0-0 deve salire");
assert.ok(dispersed[1][1] < base[1][1], "1-1 scende: il guadagno sul pareggio non è distribuito");
assert.ok(dispersed[2][2] < base[2][2], "2-2 scende: il guadagno sul pareggio non è distribuito");
assert.ok(dispersed[3][3] > base[3][3], "la diagonale alta sale, ma pesa poco");
assert.ok(
  dispersed[0][0] - base[0][0] > 0.5 * (matrixProbabilities(dispersed).draw - matrixProbabilities(base).draw),
  "oltre metà del guadagno sul pareggio deve venire da 0-0: è ciò che rende il meccanismo diverso da come era descritto",
);

// Per contrasto: `rho` lascia la diagonale alta esattamente dov'era. È la ragione per cui C1
// lo aveva giudicato la leva sbagliata per un difetto distribuito.
const withRho = scoreMatrix(1.55, 1.20, 10, -0.04, 0);
for (const [x, y] of [[2, 2], [3, 3], [4, 4]]) {
  assert.ok(
    Math.abs(withRho[x][y] - base[x][y]) < 1e-4,
    `rho quasi non tocca il pareggio ${x}-${y} (solo per rinormalizzazione)`,
  );
}

console.log("OK: fattore di dispersione condiviso — neutro a 0 bit per bit, marginali di media invariata, pareggio monotono in φ a spese di entrambe le vittorie, e guadagno concentrato su 0-0 (non distribuito, contro la premessa di Q4)");
