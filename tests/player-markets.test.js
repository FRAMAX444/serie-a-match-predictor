import assert from "node:assert/strict";
import { estimatePlayerMarkets, negativeBinomialPmf, poissonPmf, PLAYER_MARKET_DISPERSION } from "../model.js";

// Attaccante titolare fisso con storico solido: 10 partite, sempre titolare, ~85' a partita.
// Tassi nel range "buona punta" dei benchmark reali (vedi docs/player-probability-study.md).
const striker = {
  squad_appearances: 10, appearances: 10, starts: 10, minutes: 850,
  start_probability: 0.95, play_probability: 0.97, minutes_per_start: 85,
  goals_per90_shrunk: 0.7, assists_per90_shrunk: 0.15, shots_per90_shrunk: 2.5,
  shots_on_target_per90_shrunk: 0.9, yellow_per90_shrunk: 0.2, red_per90_shrunk: 0,
};

const ORDERED = (markets) => [
  [markets.multiShotProbability, markets.shotProbability, "P(>=2 tiri) <= P(>=1 tiro)"],
  [markets.threePlusShotProbability, markets.multiShotProbability, "P(>=3 tiri) <= P(>=2 tiri)"],
  [markets.shotOnTargetProbability, markets.shotProbability, "un tiro in porta è un tiro"],
  [markets.twoPlusGoalsProbability, markets.anytimeScorerProbability, "P(2+ gol) <= P(1+ gol)"],
  [markets.anytimeScorerProbability, markets.goalOrAssistProbability, "P(gol) <= P(gol o assist)"],
  [markets.assistProbability, markets.goalOrAssistProbability, "P(assist) <= P(gol o assist)"],
];

function assertCoherent(markets, label) {
  for (const [smaller, larger, message] of ORDERED(markets)) {
    assert.ok(smaller <= larger + 1e-12, `${label}: ${message} (${smaller} > ${larger})`);
  }
  for (const [key, value] of Object.entries(markets)) {
    assert.ok(Number.isFinite(value), `${label}: ${key} non è finito (${value})`);
    if (key.endsWith("Probability")) assert.ok(value >= 0 && value <= 1, `${label}: ${key} fuori da [0,1] (${value})`);
  }
}

// 1) Valori plausibili per un titolare offensivo, e ordinamento interno coerente. Gli
// invarianti in ORDERED devono valere SEMPRE: se cadono è un errore di indice o di segno nella
// distribuzione, non un valore fuori range.
const normal = estimatePlayerMarkets(striker, 1.5, 1.5);
assertCoherent(normal, "titolare");
assert.ok(normal.anytimeScorerProbability > 0.3 && normal.anytimeScorerProbability < 0.6, `gol: ${normal.anytimeScorerProbability}`);
assert.ok(normal.shotProbability > 0.8 && normal.shotProbability < 0.95, `tiro: ${normal.shotProbability}`);
assert.ok(normal.expectedMinutes > 75 && normal.expectedMinutes <= 90, `minuti attesi: ${normal.expectedMinutes}`);

// 2) La binomiale negativa deve dare MENO probabilità della Poisson a "almeno un evento", a
// parità di media: è tutto il punto della correzione per sovradispersione documentata in
// docs/player-probability-study.md §4.3 (il modello era "sistematicamente troppo sicuro nella
// fascia alta"). Se questo test fallisse, la distribuzione sarebbe tornata di fatto Poisson.
for (const lambda of [0.3, 1.0, 2.5, 4.0]) {
  const negativeBinomialZero = negativeBinomialPmf(0, lambda, PLAYER_MARKET_DISPERSION.shots);
  assert.ok(
    negativeBinomialZero > poissonPmf(0, lambda),
    `con lambda ${lambda} la binomiale negativa deve mettere più massa sullo zero della Poisson`,
  );
}
// ...e deve restare una distribuzione di probabilità: somma 1 sui possibili conteggi.
const mass = Array.from({ length: 60 }, (_, count) => negativeBinomialPmf(count, 2.5, PLAYER_MARKET_DISPERSION.shots))
  .reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(mass - 1) < 1e-6, `la binomiale negativa deve sommare a 1, somma ${mass}`);
// Con dispersione infinita deve degenerare esattamente nella Poisson.
for (const count of [0, 1, 2, 5]) {
  assert.ok(
    Math.abs(negativeBinomialPmf(count, 1.8, Infinity) - poissonPmf(count, 1.8)) < 1e-12,
    "dispersione infinita deve coincidere con la Poisson",
  );
}

// 3) Direzione rispetto al lambda di squadra: contro un avversario più debole salgono gol,
// assist e tiri; i cartellini, che non dipendono dall'intensità offensiva, restano identici.
const easyMatch = estimatePlayerMarkets(striker, 3.0, 1.5);
const hardMatch = estimatePlayerMarkets(striker, 0.7, 1.5);
assert.ok(easyMatch.anytimeScorerProbability > normal.anytimeScorerProbability, "lambda alto deve alzare la probabilità di gol");
assert.ok(easyMatch.assistProbability > normal.assistProbability, "lambda alto deve alzare la probabilità di assist");
assert.ok(easyMatch.shotProbability > normal.shotProbability, "lambda alto deve alzare la probabilità di tiro");
assert.ok(hardMatch.anytimeScorerProbability < normal.anytimeScorerProbability, "lambda basso deve abbassare la probabilità di gol");
assert.ok(hardMatch.shotProbability < normal.shotProbability, "lambda basso deve abbassare la probabilità di tiro");
assert.equal(easyMatch.cardProbability, normal.cardProbability, "i cartellini non devono dipendere dal lambda di squadra");

// 3b) I tiri devono reagire al contesto di squadra MENO che proporzionalmente rispetto ai gol
// (λ ≈ tiri × conversione: quando il modello prevede più gol, crescono sia il volume sia la
// qualità dei tiri, quindi il solo volume cresce meno del totale).
const goalGrowth = easyMatch.expectedGoals / normal.expectedGoals;
const shotGrowth = easyMatch.expectedShots / normal.expectedShots;
assert.ok(shotGrowth > 1 && shotGrowth < goalGrowth, `i tiri devono crescere ma meno dei gol: tiri ×${shotGrowth}, gol ×${goalGrowth}`);

// 4) Scenari di impiego. Due giocatori con lo STESSO tasso per-90 ma diversa continuità devono
// avere probabilità diverse: è l'errore che il modello precedente faceva: usava i minuti medi
// per presenza, quindi un giocatore che gioca 90' una volta su due riceveva "90 minuti" e
// risultava identico a un titolare fisso.
const rotationPlayer = { ...striker, starts: 5, start_probability: 0.45, play_probability: 0.6 };
const rotation = estimatePlayerMarkets(rotationPlayer, 1.5, 1.5);
assertCoherent(rotation, "rotazione");
assert.ok(
  rotation.anytimeScorerProbability < normal.anytimeScorerProbability,
  "chi gioca meno spesso deve avere una probabilità di segnare più bassa, a parità di tasso per-90",
);
assert.ok(rotation.expectedMinutes < normal.expectedMinutes);
assert.ok(rotation.startProbability < normal.startProbability);

// 5) Riserva che quasi non gioca: probabilità basse ma NON zero (è comunque convocata), e
// nessun NaN.
const deepBench = {
  squad_appearances: 10, appearances: 1, starts: 0, minutes: 12,
  start_probability: 0.04, play_probability: 0.14, minutes_per_start: 0,
  goals_per90_shrunk: 0.3, assists_per90_shrunk: 0.1, shots_per90_shrunk: 1.5,
  shots_on_target_per90_shrunk: 0.5, yellow_per90_shrunk: 0.2, red_per90_shrunk: 0.01,
};
const bench = estimatePlayerMarkets(deepBench, 1.5, 1.5);
assertCoherent(bench, "riserva");
assert.ok(bench.anytimeScorerProbability > 0 && bench.anytimeScorerProbability < 0.1, `riserva: ${bench.anytimeScorerProbability}`);
assert.ok(bench.expectedMinutes < 25, `minuti attesi riserva: ${bench.expectedMinutes}`);
// La fiducia deve riflettere il campione: 12 minuti osservati contro 850 non è lo stesso dato.
assert.ok(bench.confidence < 0.2 && normal.confidence > 0.8, `fiducia: riserva ${bench.confidence}, titolare ${normal.confidence}`);

// 6) Giocatore senza alcuna storia: tutto a zero o quasi, niente NaN e niente probabilità
// inventate da un campione vuoto.
const unknown = estimatePlayerMarkets(
  { squad_appearances: 0, appearances: 0, starts: 0, minutes: 0 },
  1.5,
  1.5,
);
assertCoherent(unknown, "sconosciuto");
assert.equal(unknown.confidence, 0);
assert.ok(unknown.anytimeScorerProbability < 0.05, `sconosciuto non deve ricevere una probabilità reale: ${unknown.anytimeScorerProbability}`);

// 7) Retrocompatibilità: un player_context di schema precedente (solo tassi grezzi,
// appearances/minutes, nessuna probabilità di titolarità) deve continuare a produrre numeri
// sensati invece di rompersi o azzerarsi.
const legacy = { appearances: 10, minutes: 850, goals_per90: 0.7, assists_per90: 0.15, shots_per90: 2.5, yellow_per90: 0.2, red_per90: 0 };
const legacyMarkets = estimatePlayerMarkets(legacy, 1.5, 1.5);
assertCoherent(legacyMarkets, "schema precedente");
assert.ok(legacyMarkets.anytimeScorerProbability > 0.2, `schema precedente azzerato: ${legacyMarkets.anytimeScorerProbability}`);
assert.ok(legacyMarkets.shotProbability > 0.6, `schema precedente azzerato sui tiri: ${legacyMarkets.shotProbability}`);

// 8) Input volutamente estremi (tassi assurdi, lambda altissimo, squadra storicamente
// sterile): i clamp devono contenere tutto dentro [0,1] senza rompere gli invarianti.
const extreme = estimatePlayerMarkets(
  {
    squad_appearances: 1, appearances: 1, starts: 1, minutes: 90, start_probability: 1, play_probability: 1,
    goals_per90_shrunk: 50, assists_per90_shrunk: 50, shots_per90_shrunk: 50,
    shots_on_target_per90_shrunk: 80, yellow_per90_shrunk: 50, red_per90_shrunk: 50,
  },
  10,
  0.1,
);
assertCoherent(extreme, "estremo");
assert.ok(extreme.anytimeScorerProbability <= 0.95 && extreme.shotProbability <= 0.97);

// 9) Ruoli difensivi: a parità di minuti e lambda, un centrale deve restare nettamente sotto
// un attaccante sui tiri. Il confronto usa i benchmark reali per ruolo (0.3-0.8 tiri/90 per i
// difensori contro 2.5-3.0 di una buona punta).
const centreBack = {
  ...striker,
  goals_per90_shrunk: 0.06, assists_per90_shrunk: 0.05, shots_per90_shrunk: 0.45,
  shots_on_target_per90_shrunk: 0.15, yellow_per90_shrunk: 0.2, red_per90_shrunk: 0.02,
};
const defender = estimatePlayerMarkets(centreBack, 1.5, 1.5);
assertCoherent(defender, "difensore");
assert.ok(defender.shotProbability < normal.shotProbability * 0.6, `difensore troppo vicino all'attaccante: ${defender.shotProbability}`);
assert.ok(defender.shotProbability > 0 && defender.shotProbability < 0.4, `tiri difensore fuori range: ${defender.shotProbability}`);

// 10) I tassi con shrinkage hanno la precedenza su quelli grezzi quando entrambi sono presenti:
// è il punto dello shrinkage, e uno scambio silenzioso tra i due campi passerebbe altrimenti
// inosservato (i due numeri si somigliano su campioni ampi, divergono su quelli piccoli).
const bothRates = estimatePlayerMarkets({ ...striker, goals_per90: 0.05, goals_per90_shrunk: 0.7 }, 1.5, 1.5);
assert.ok(
  Math.abs(bothRates.anytimeScorerProbability - normal.anytimeScorerProbability) < 1e-12,
  "il tasso con shrinkage deve prevalere sul grezzo",
);

console.log("OK: mercati giocatore — miscela sugli scenari di impiego, binomiale negativa, shrinkage di ruolo, invarianti di ordinamento, retrocompatibilità e clamp");
