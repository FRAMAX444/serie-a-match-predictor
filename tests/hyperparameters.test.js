import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";

const start = Date.UTC(2024, 0, 1);
const isoDate = (offset) => new Date(start + offset * 86400000).toISOString().slice(0, 10);

function balancedLeague(rounds = 30, teamCount = 10) {
  const teams = Array.from({ length: teamCount }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      matches.push({
        date: isoDate(round * 7), season: "2425", competition_id: "ita.1", competition_type: "domestic",
        home_team: home, away_team: away, home_goals: 2, away_goals: 1,
        home_xg: 1.72, away_xg: 1.02, home_shots: 14, away_shots: 9, home_sot: 5, away_sot: 3,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const league = balancedLeague();
const baseOptions = {
  homeTeam: "Team-1", awayTeam: "Team-2", date: isoDate(210), competitionId: "ita.1",
  windowDays: 730, halfLifeDays: 120,
};

// 1) Senza override, il merge deve restituire esattamente DEFAULT_HYPERPARAMETERS: nessuna
// deriva rispetto al comportamento pre-refactor (già confermato dal resto della suite che
// continua a passare con asserzioni numeriche esatte).
const baseline = predictFromMatches(league, baseOptions);
assert.deepEqual(baseline.hyperparameters, DEFAULT_HYPERPARAMETERS);
assert.equal(DEFAULT_HYPERPARAMETERS.newcomerEloDiscount, 0, "il default deve restare no-op finché non lo attivi esplicitamente");

// 2) Deep-merge: sovrascrivere un solo esponente non deve toccare gli altri né quelli
// dell'oggetto "gemello" (defenseExponents), né gli altri campi di primo livello.
const partialOverride = predictFromMatches(league, {
  ...baseOptions,
  hyperparameters: { attackExponents: { xg: 0.6 } },
});
assert.equal(partialOverride.hyperparameters.attackExponents.xg, 0.6);
assert.equal(partialOverride.hyperparameters.attackExponents.goals, DEFAULT_HYPERPARAMETERS.attackExponents.goals);
assert.deepEqual(partialOverride.hyperparameters.defenseExponents, DEFAULT_HYPERPARAMETERS.defenseExponents);
assert.equal(partialOverride.hyperparameters.rho, DEFAULT_HYPERPARAMETERS.rho);

// 3) eloDivisor più piccolo = il modello reagisce di più al gap di rating: con due squadre
// di forza diversa il distacco tra i due lambda deve cambiare in modo misurabile.
const strongVsWeak = { ...baseOptions, homeTeam: "Team-1", awayTeam: "Team-6" };
const normalDivisor = predictFromMatches(league, strongVsWeak);
const sharperDivisor = predictFromMatches(league, { ...strongVsWeak, hyperparameters: { eloDivisor: 400 } });
const normalGap = Math.abs(normalDivisor.lambdaHome - normalDivisor.lambdaAway);
const sharperGap = Math.abs(sharperDivisor.lambdaHome - sharperDivisor.lambdaAway);
assert.ok(Number.isFinite(sharperGap));
assert.notEqual(normalGap.toFixed(6), sharperGap.toFixed(6), "eloDivisor deve avere un effetto misurabile sul gap tra i lambda");

// 4) Cold-start neopromosse (opt-in: newcomerEloDiscount di default è 0, va attivato
// esplicitamente). Serve un dataset scaglionato: dei "veterani" con storia PRIMA di
// warmupStart (quindi non trattati da newcomer solo perché la loro partita più vecchia
// nella finestra coincide con l'inizio della finestra stessa) e una neopromossa che non ha
// invece alcuna storia da nessuna parte nel dataset completo.
const windowDays = 200;
const cutoffOffset = 760; // warmupStart = cutoff - windowDays - 420 = giorno 140: i veterani
const veterans = balancedLeague(108, 10); // giocano da 0 a 749, quindi hanno storia prima
const newcomerMatch = {
  date: isoDate(cutoffOffset - 7), season: "2425", competition_id: "ita.1", competition_type: "domestic",
  home_team: "Neopromossa", away_team: "Team-1", home_goals: 1, away_goals: 1,
  home_xg: 1.1, away_xg: 1.1, home_shots: 10, away_shots: 10, home_sot: 4, away_sot: 4,
};
const staggered = veterans.concat([newcomerMatch]);
const predictionDate = isoDate(cutoffOffset);

const newcomerOptions = { homeTeam: "Neopromossa", awayTeam: "Team-5", date: predictionDate, competitionId: "ita.1", windowDays, halfLifeDays: 120 };
const withoutDiscount = predictFromMatches(staggered, newcomerOptions); // default: 0, no-op
const withDiscount = predictFromMatches(staggered, { ...newcomerOptions, hyperparameters: { newcomerEloDiscount: -65 } });
assert.ok(withDiscount.home.elo < withoutDiscount.home.elo, "attivando lo sconto, l'Elo della neopromossa deve scendere sotto il caso senza sconto");

// Due veterani MAI incontrati dalla neopromossa (non Team-1): attivare lo sconto non deve
// spostare di una virgola le loro previsioni, l'effetto deve restare locale.
const establishedOptions = { homeTeam: "Team-7", awayTeam: "Team-8", date: predictionDate, competitionId: "ita.1", windowDays, halfLifeDays: 120 };
const establishedWithoutDiscount = predictFromMatches(staggered, establishedOptions);
const establishedWithDiscount = predictFromMatches(staggered, { ...establishedOptions, hyperparameters: { newcomerEloDiscount: -65 } });
assert.equal(establishedWithDiscount.home.elo, establishedWithoutDiscount.home.elo, "lo sconto neopromosse non deve toccare squadre già affermate e non collegate");
assert.equal(establishedWithDiscount.away.elo, establishedWithoutDiscount.away.elo);

// 5) Bias arbitro: opzionale, di default 0 (nessun effetto), simmetrico sui due lambda, e
// clampato anche con input estremi/malformati.
const noBias = predictFromMatches(league, baseOptions);
assert.equal(noBias.refereeBias, 0);
const withBias = predictFromMatches(league, { ...baseOptions, refereeHomeBias: 0.08 });
assert.ok(withBias.lambdaHome > noBias.lambdaHome);
assert.ok(withBias.lambdaAway < noBias.lambdaAway);
const extremeBias = predictFromMatches(league, { ...baseOptions, refereeHomeBias: 50 });
assert.equal(extremeBias.refereeBias, 0.12, "il bias arbitro deve restare clampato anche con input fuori scala");

console.log("OK: iperparametri configurabili (merge/deep-merge), cold-start neopromosse opt-in localizzato e bias arbitro opzionale");
