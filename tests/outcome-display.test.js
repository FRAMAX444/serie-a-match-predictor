import assert from "node:assert/strict";
import { chooseDisplayedOutcome } from "../outcome-display.js";

assert.equal(
  chooseDisplayedOutcome({ homeWin: 0.36, draw: 0.38, awayWin: 0.26 }, "Roma", "Lecce").key,
  "1",
  "una favorita netta deve poter superare un pareggio avanti di soli pochi punti",
);

assert.equal(
  chooseDisplayedOutcome({ homeWin: 0.23, draw: 0.39, awayWin: 0.38 }, "Lecce", "Inter").key,
  "2",
  "la stessa regola deve funzionare per la favorita in trasferta",
);

assert.equal(
  chooseDisplayedOutcome({ homeWin: 0.31, draw: 0.38, awayWin: 0.31 }, "Roma", "Inter").key,
  "X",
  "nelle partite equilibrate il pareggio deve restare il risultato mostrato",
);

assert.equal(
  chooseDisplayedOutcome({ homeWin: 0.35, draw: 0.43, awayWin: 0.22 }, "Roma", "Lecce").key,
  "X",
  "un pareggio nettamente più probabile non deve essere forzato verso la favorita",
);

assert.equal(
  chooseDisplayedOutcome({ homeWin: 0.48, draw: 0.29, awayWin: 0.23 }, "Roma", "Lecce").key,
  "1",
  "quando 1 o 2 sono già primi si mantiene il massimo probabilistico puro",
);

console.log("OK: selezione contestuale dell'esito mostrato");
