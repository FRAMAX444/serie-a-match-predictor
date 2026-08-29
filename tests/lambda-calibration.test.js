import assert from "node:assert/strict";
import { applyCalibration, DEFAULT_CALIBRATION, DEFAULT_HYPERPARAMETERS, matrixProbabilities, scoreMatrix } from "../model.js";

const NEUTRAL = { asymmetryShrink: 1, asymmetryShrinkLowQuality: 1, levelShrink: 1, levelShift: 0, venueTilt: 0 };
const close = (left, right, tolerance = 1e-9) => Math.abs(left - right) < tolerance;

// 1) Identità: con parametri neutri la calibrazione deve restituire ESATTAMENTE i lambda in
// ingresso. È l'invariante che rende il livello di calibrazione un'aggiunta e non una
// riscrittura: se questo si rompe, ogni confronto con un backtest precedente perde senso.
const identity = applyCalibration(1.83, 0.94, 1.42, 1.18, 0.9, NEUTRAL);
assert.ok(close(identity.lambdaHome, 1.83), `identità casa: ${identity.lambdaHome}`);
assert.ok(close(identity.lambdaAway, 0.94), `identità trasferta: ${identity.lambdaAway}`);

// 2) Il punto fisso della trasformazione è la baseline di competizione: una partita in cui il
// modello non distingue le due squadre dalla media di lega deve restare sulla media di lega,
// qualunque sia la compressione dell'asimmetria (lì l'asimmetria è zero, non c'è nulla da
// comprimere). Con levelShift != 0 il livello si sposta, quindi il test isola il solo effetto
// dell'asimmetria.
const onlyAsymmetry = { ...NEUTRAL, asymmetryShrink: 0.5, asymmetryShrinkLowQuality: 0.5 };
const atBaseline = applyCalibration(1.42, 1.18, 1.42, 1.18, 1, onlyAsymmetry);
assert.ok(close(atBaseline.lambdaHome, 1.42), `punto fisso casa: ${atBaseline.lambdaHome}`);
assert.ok(close(atBaseline.lambdaAway, 1.18), `punto fisso trasferta: ${atBaseline.lambdaAway}`);

// 3) Comprimere l'asimmetria deve avvicinare i due lambda ai rispettivi baseline SENZA
// invertirne l'ordine: una favorita resta favorita, solo meno nettamente. È esattamente ciò
// che serve per correggere la sovra-sicurezza misurata (curva di affidabilità più piatta della
// diagonale), e un'inversione d'ordine significherebbe un errore di segno.
const strongHome = applyCalibration(2.4, 0.8, 1.42, 1.18, 1, onlyAsymmetry);
assert.ok(strongHome.lambdaHome < 2.4 && strongHome.lambdaHome > 1.42, `casa deve avvicinarsi alla baseline: ${strongHome.lambdaHome}`);
assert.ok(strongHome.lambdaAway > 0.8 && strongHome.lambdaAway < 1.18, `trasferta deve avvicinarsi alla baseline: ${strongHome.lambdaAway}`);
assert.ok(strongHome.lambdaHome / strongHome.lambdaAway < 2.4 / 0.8, "il rapporto di forza deve ridursi");
assert.ok(strongHome.lambdaHome > strongHome.lambdaAway, "la favorita deve restare favorita");

// 3b) ...e la compressione dell'asimmetria da sola non deve spostare il prodotto dei due
// lambda: è la proprietà che rende la decomposizione livello/asimmetria una vera separazione
// (in coordinate log, il prodotto dipende solo dal livello).
assert.ok(
  close(Math.log(strongHome.lambdaHome * strongHome.lambdaAway), Math.log(2.4 * 0.8), 1e-9),
  "comprimere l'asimmetria non deve toccare il livello (prodotto dei lambda invariato)",
);

// 4) Il livello agisce nella direzione dichiarata: levelShift positivo alza entrambi i lambda,
// negativo li abbassa, senza cambiare chi è favorito.
const raised = applyCalibration(1.8, 1.1, 1.42, 1.18, 1, { ...NEUTRAL, levelShift: 0.2 });
assert.ok(raised.lambdaHome > 1.8 && raised.lambdaAway > 1.1, "levelShift > 0 deve alzare entrambi i lambda");
assert.ok(close(raised.lambdaHome / raised.lambdaAway, 1.8 / 1.1), "levelShift non deve cambiare il rapporto di forza");

// 5) La compressione dipende dalla qualità dei dati: a parità di lambda grezzi, una previsione
// con campione sottile deve risultare più vicina alla baseline di una con campione ricco.
// È il punto della calibrazione quality-aware: quando il modello sa meno, deve dire meno.
const qualityAware = { ...DEFAULT_CALIBRATION, asymmetryShrink: 0.8, asymmetryShrinkLowQuality: 0.2 };
const richSample = applyCalibration(2.4, 0.8, 1.42, 1.18, 1, qualityAware);
const thinSample = applyCalibration(2.4, 0.8, 1.42, 1.18, 0, qualityAware);
assert.ok(
  thinSample.lambdaHome / thinSample.lambdaAway < richSample.lambdaHome / richSample.lambdaAway,
  "con dati scarsi il divario previsto deve essere più compresso",
);

// 6) I default di produzione devono comprimere, non amplificare: se una futura ristima
// producesse asymmetryShrink > 1 il modello tornerebbe sovra-sicuro, il difetto che questo
// livello esiste per correggere.
assert.ok(DEFAULT_CALIBRATION.asymmetryShrink > 0 && DEFAULT_CALIBRATION.asymmetryShrink <= 1, "asymmetryShrink deve stare in (0, 1]");
assert.ok(
  DEFAULT_CALIBRATION.asymmetryShrinkLowQuality <= DEFAULT_CALIBRATION.asymmetryShrink,
  "con dati scarsi la compressione deve essere almeno pari a quella con dati buoni",
);
assert.ok(DEFAULT_CALIBRATION.levelShrink > 0 && DEFAULT_CALIBRATION.levelShrink <= 1, "levelShrink deve stare in (0, 1]");
assert.ok(DEFAULT_HYPERPARAMETERS.rho <= 0, "rho di Dixon-Coles deve restare <= 0 (dipendenza sui punteggi bassi)");
assert.equal(DEFAULT_HYPERPARAMETERS.calibration, DEFAULT_CALIBRATION);

// 7) Effetto sulle probabilità finali: comprimendo l'asimmetria la probabilità del pareggio
// deve salire e quella della favorita scendere. È la traduzione in probabilità del difetto
// misurato in produzione (pareggi sotto-stimati, favorite sopra-stimate).
const beforeMatrix = matrixProbabilities(scoreMatrix(2.4, 0.8, 8, DEFAULT_HYPERPARAMETERS.rho));
const afterMatrix = matrixProbabilities(scoreMatrix(strongHome.lambdaHome, strongHome.lambdaAway, 8, DEFAULT_HYPERPARAMETERS.rho));
assert.ok(afterMatrix.draw > beforeMatrix.draw, "la compressione deve alzare la probabilità di pareggio");
assert.ok(afterMatrix.homeWin < beforeMatrix.homeWin, "la compressione deve abbassare la probabilità della favorita");
for (const probabilities of [beforeMatrix, afterMatrix]) {
  assert.ok(close(probabilities.homeWin + probabilities.draw + probabilities.awayWin, 1, 1e-9), "1X2 deve sommare a 1");
}

// 8) Input degeneri (lambda grezzi a zero o negativi per un bug a monte) non devono produrre
// NaN o Infinity: la calibrazione lavora in coordinate logaritmiche, dove uno zero non gestito
// diventerebbe -Infinity e si propagherebbe fino alle probabilità mostrate all'utente.
for (const [rawHome, rawAway] of [[0, 0], [-1, 2], [1e-9, 1e-9], [99, 99]]) {
  const degenerate = applyCalibration(rawHome, rawAway, 1.42, 1.18, 0.5, DEFAULT_CALIBRATION);
  assert.ok(Number.isFinite(degenerate.lambdaHome) && degenerate.lambdaHome > 0, `lambda casa non finito per (${rawHome}, ${rawAway})`);
  assert.ok(Number.isFinite(degenerate.lambdaAway) && degenerate.lambdaAway > 0, `lambda trasferta non finito per (${rawHome}, ${rawAway})`);
}

console.log("OK: livello di calibrazione dei lambda — identità sui parametri neutri, separazione livello/asimmetria, dipendenza dalla qualità, robustezza sugli input degeneri");
