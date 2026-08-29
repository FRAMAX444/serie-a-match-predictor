import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS, competitionNewcomers } from "../model.js";

// Il difetto (§2.4 del brief, riprodotto: la variante newcomerEloDiscount = -65 cambia
// qualcosa in 87 gare su 768 di Serie A, e quasi tutte nella fascia 20+ invece che a inizio
// stagione — cioè il gancio esiste, è documentato, è testato, ed è inerte).
//
// newcomerTeams() definiva "nuova" una squadra la cui prima gara nella finestra coincide con
// la prima gara nell'INTERO dataset non filtrato. Frosinone era in Serie A nel 2324, quindi è
// nel dataset, quindi non è mai stata riconosciuta come neopromossa — qualunque valore si
// mettesse in newcomerEloDiscount. La definizione giusta non è "prima apparizione assoluta"
// ma "non era in QUESTA competizione nella stagione PRECEDENTE", informazione già presente
// perché ogni partita porta competition_id e season.
//
// C'è un secondo pezzo, mancante nella vecchia versione: il gancio si consultava solo al
// cold start (`!states.has(team)`). Per una squadra rientrata dopo un anno lo stato ESISTE
// già — con l'Elo di due stagioni fa — quindi anche una definizione corretta non sarebbe
// bastata. Il riconoscimento va applicato al CONFINE DI STAGIONE, non solo alla prima
// apparizione in assoluto.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATASET = path.join(ROOT, "data", "matches.json");

if (!fs.existsSync(DATASET)) {
  console.log("SKIP: data/matches.json assente");
  process.exit(0);
}

const payload = JSON.parse(fs.readFileSync(DATASET, "utf8"));
const matches = payload.matches;

// --- Direzione (R6): i tre nomi di §2.4 devono essere riconosciuti --------------------
const italian2627 = competitionNewcomers(matches, "ita.1", "2627");
for (const team of ["Frosinone", "Monza", "Venezia"]) {
  assert.ok(
    italian2627.has(team),
    `${team} non è in ita.1 2526 e deve risultare non-continua in ita.1 2627; `
    + `riconosciute: ${[...italian2627.keys()].sort().join(", ") || "(nessuna)"}`,
  );
}

// E il controllo simmetrico, altrettanto importante: chi c'era NON deve essere segnalato.
// Una definizione troppo larga sarebbe un difetto peggiore di quella troppo stretta, perché
// applicherebbe un prior da neopromossa a squadre con la storia completa.
for (const team of ["Inter", "Juventus", "Napoli", "Como", "Parma", "Sassuolo"]) {
  assert.ok(
    !italian2627.has(team),
    `${team} era in ita.1 2526 e non deve risultare non-continua in ita.1 2627`,
  );
}

// --- Gli anni di assenza vanno distinti, non solo il fatto dell'assenza ---------------
// Frosinone manca dal 2324 (due stagioni fuori), Monza e Venezia dal 2425 (una). Un Elo di
// due anni fa è più stale di uno di un anno fa, e l'attuale exp(-(gap-45)/900) dopo 800
// giorni lascia ancora il 43% dello scostamento: non è una regressione, è una carezza.
assert.equal(italian2627.get("Frosinone").seasonsAway, 2, "Frosinone manca da due stagioni");
assert.equal(italian2627.get("Monza").seasonsAway, 1, "Monza manca da una stagione");
assert.equal(italian2627.get("Venezia").seasonsAway, 1, "Venezia manca da una stagione");

// Una squadra mai vista in quella competizione deve essere distinguibile da una rientrata.
const spanish2627 = competitionNewcomers(matches, "esp.1", "2627");
const debutants = [...spanish2627.entries()].filter(([, info]) => info.seasonsAway === Infinity);
assert.ok(
  debutants.length > 0,
  "Almeno una squadra di esp.1 2627 non compare in nessuna stagione precedente di esp.1: "
  + "il caso 'mai vista' deve essere rappresentabile, non confuso con 'rientrata'",
);

// --- Neutralità (R1): a parametri neutri l'output non cambia -------------------------
assert.equal(DEFAULT_HYPERPARAMETERS.newcomerEloDiscount, 0, "il prior resta opt-in");
assert.equal(DEFAULT_HYPERPARAMETERS.newcomerEloAnchor, 0, "l'ancora resta quella storica (1500)");
assert.equal(DEFAULT_HYPERPARAMETERS.newcomerEloRetention, 1, "nessuna regressione per assenza");

const opening = matches
  .filter((match) => match.competition_id === "ita.1" && String(match.season) === "2627")
  .sort((left, right) => String(left.date).localeCompare(String(right.date)))[0];

const eloOf = (team, hyperparameters) => predictFromMatches(matches, {
  homeTeam: team,
  awayTeam: team === "Inter" ? "Juventus" : "Inter",
  date: opening.date,
  cutoffDate: opening.date,
  competitionId: "ita.1",
  hyperparameters,
}).home.elo;

for (const team of ["Frosinone", "Monza", "Inter"]) {
  assert.equal(
    eloOf(team, { newcomerEloDiscount: 0, newcomerEloAnchor: 0, newcomerEloRetention: 1 }),
    eloOf(team, null),
    `A parametri neutri l'Elo di ${team} deve essere identico al default`,
  );
}

// --- Il gancio non deve più essere inerte --------------------------------------------
// È il punto che §2.4 misura: prima, cambiare newcomerEloDiscount non spostava l'Elo delle
// squadre rientrate, perché non venivano riconosciute. Ora deve spostarlo.
const active = { newcomerEloDiscount: -65, newcomerEloAnchor: 1, newcomerEloRetention: 0.5 };
for (const team of ["Frosinone", "Monza", "Venezia"]) {
  assert.notEqual(
    eloOf(team, active),
    eloOf(team, null),
    `Con il prior attivo l'Elo di ${team} deve cambiare: se resta identico il riconoscimento `
    + "non sta avvenendo, ed è esattamente il difetto che questo file esiste per bloccare",
  );
}
// ...mentre su chi era già in campionato l'effetto deve essere solo quello PROPAGATO.
// Non può essere zero — abbassare l'Elo di una neopromossa cambia i delta di ogni partita
// giocata contro di lei, ed è così che l'Elo funziona — ma deve restare di un ordine di
// grandezza più piccolo. Un effetto diretto e uno propagato della stessa ampiezza
// significherebbe che il prior sta toccando le squadre sbagliate.
const directShift = Math.abs(eloOf("Monza", active) - eloOf("Monza", null));
const propagatedShift = Math.abs(eloOf("Inter", active) - eloOf("Inter", null));
assert.ok(
  directShift > 10 * propagatedShift,
  `L'effetto diretto sulla neopromossa (${directShift.toFixed(2)}) deve dominare quello `
  + `propagato su una squadra continua (${propagatedShift.toFixed(2)})`,
);

console.log("OK: riconoscimento delle neopromosse — definizione per competizione e stagione, anni di assenza distinti, neutralità a parametri neutri e gancio non più inerte");
