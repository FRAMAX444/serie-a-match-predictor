import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

// §2.5 del brief, riprodotto sul dataset corrente (590 gare di Serie A dal 2025-01-01):
//
//   termine                     sd      corr con EloDiff   corr con l'esito
//   momentum attuale (punti)   0.890         0.743               0.323
//   forma-residuo (risultato)  0.211         0.311               0.126
//   forma-residuo (xG)         0.093         0.139               0.120
//   blend 50/50                0.177         0.267               0.146
//
// Il momentum attuale è collineare al 74% con l'Elo: il modello conta la forza due volte,
// una via eloHome/eloAway e una via formHome/formAway, con clamp indipendenti (±0.34 e
// ±0.16) che non si parlano.
//
// La causa è concettuale e questo file la cattura direttamente: la forma è misurata in PUNTI
// ASSOLUTI invece che come scostamento dal livello atteso della squadra. Una squadra molto
// forte che vince come ci si aspetta che vinca risulta "in forma" per sempre — il che non è
// un'informazione, è il suo Elo scritto due volte.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

// Un campionato in cui Team-1 domina in modo COSTANTE: vince sempre, dalla prima giornata
// all'ultima. Non è "in forma": è forte, e lo è sempre stata.
function dominatedLeague(rounds) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      const dominantHome = home === "Team-1";
      const dominantPlays = dominantHome || away === "Team-1";
      matches.push({
        date: iso(START + round * 7 * DAY), season: "2526", competition_id: "ita.1",
        competition_type: "domestic", league_strength: 1550,
        home_team: home, away_team: away,
        home_goals: dominantPlays ? (dominantHome ? 3 : 0) : 1,
        away_goals: dominantPlays ? (dominantHome ? 0 : 3) : 1,
        home_xg: dominantPlays ? (dominantHome ? 2.6 : 0.7) : 1.2,
        away_xg: dominantPlays ? (dominantHome ? 0.7 : 2.6) : 1.2,
        home_shots: 13, away_shots: 11, home_sot: 5, away_sot: 4,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const matches = dominatedLeague(34);
const date = iso(START + 34 * 7 * DAY);
const result = predictFromMatches(matches, {
  homeTeam: "Team-1", awayTeam: "Team-2", date, cutoffDate: date,
  competitionId: "ita.1", windowDays: 730,
});

// --- Il difetto, misurato sul fixture ---------------------------------------------------
// La squadra dominante ha punti per partita altissimi: la forma-livello la segnala "in
// forma" alla 34ª giornata come alla prima.
assert.ok(
  result.home.ppg3 > 2.5,
  `La squadra dominante deve avere punti per partita altissimi, vale ${result.home.ppg3.toFixed(2)}`,
);
// ...ma il suo Elo ha già assorbito gran parte di quel livello, quindi il residuo è di un
// ordine di grandezza più piccolo. È la differenza fra "forte" e "in forma".
//
// Non è esattamente zero, ed è giusto così: con k = 18 l'Elo di una squadra che vince ogni
// partita 3-0 non converge in una sola stagione — servirebbe un divario di ~480 punti e in
// 34 giornate se ne accumulano ~340. Il residuo residuo (0.21 su questo fixture) è quindi
// dominanza non ancora prezzata, che è informazione vera; il punto del test è che vale un
// quattordicesimo del segnale in punti assoluti, non che sia nullo.
assert.ok(
  Math.abs(result.home.resultResidual3) < 0.30,
  `Il residuo di una squadra che rende come il suo livello prevede deve restare piccolo, vale ${result.home.resultResidual3.toFixed(3)}`,
);
assert.ok(
  Math.abs(result.home.resultResidual3) < result.home.ppg3 / 10,
  "Il residuo deve essere di un ordine di grandezza più piccolo del livello assoluto",
);

// Il residuo deve comunque ESISTERE come quantità viva, non essere zero per costruzione:
// una squadra che ha appena perso contro pronostico deve mostrarne uno negativo.
const upset = matches.concat([{
  date: iso(START + 34 * 7 * DAY - 3 * DAY), season: "2526", competition_id: "ita.1",
  competition_type: "domestic", league_strength: 1550,
  home_team: "Team-1", away_team: "Team-3", home_goals: 0, away_goals: 3,
  home_xg: 0.4, away_xg: 2.9, home_shots: 8, away_shots: 15, home_sot: 2, away_sot: 7,
}]);
const afterUpset = predictFromMatches(upset, {
  homeTeam: "Team-1", awayTeam: "Team-2", date, cutoffDate: date,
  competitionId: "ita.1", windowDays: 730,
});
assert.ok(
  afterUpset.home.resultResidual3 < result.home.resultResidual3 - 0.05,
  `Una sconfitta contro pronostico deve abbassare il residuo: ${afterUpset.home.resultResidual3.toFixed(3)} contro ${result.home.resultResidual3.toFixed(3)}`,
);
assert.ok(
  afterUpset.home.xgResidual5 < result.home.xgResidual5,
  "e anche il residuo sugli xG, che è la componente meno collineare con l'Elo",
);

// --- I residui restano una DIAGNOSTICA, non entrano nel lambda -------------------------
// Il termine di forma-residuo è stato implementato e misurato nella sessione 1: risolveva la
// collinearità (0.743 -> 0.267) ma peggiorava le previsioni in modo significativo fuori
// campione (holdout 2526: -0.0011 a peso 0.5, -0.0025 a peso 1.0). È stato rimosso dal
// lambda; i residui restano esposti perché scripts/diag_form_orthogonality.mjs li misura.
//
// Questo test blocca il ritorno silenzioso del parametro: se qualcuno lo reintroduce senza
// nuova evidenza, il primo assert glielo ricorda.
assert.equal(
  DEFAULT_HYPERPARAMETERS.momentumResidualWeight,
  undefined,
  "il peso della forma-residuo è stato RIMOSSO dopo essere stato misurato e respinto "
  + "(holdout 2526: -0.0011 a peso 0.5, -0.0025 a peso 1.0, IC che escludono lo zero). "
  + "Reintrodurlo richiede evidenza nuova, non una variante nuova.",
);
assert.equal(
  predictFromMatches(matches, {
    homeTeam: "Team-1", awayTeam: "Team-2", date, cutoffDate: date,
    competitionId: "ita.1", windowDays: 730, hyperparameters: { momentumResidualWeight: 1 },
  }).lambdaHome,
  result.lambdaHome,
  "Un iperparametro rimosso non deve avere alcun effetto residuo",
);

console.log("OK: residui di rendimento come diagnostica — la squadra forte non è 'in forma', il residuo reagisce ai risultati contro pronostico, e il termine respinto non è tornato nel lambda");
