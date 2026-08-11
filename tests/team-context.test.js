import assert from "node:assert/strict";
import { predictFromMatches } from "../model.js";

const start = Date.UTC(2024, 0, 1);
const isoDate = (offset) => new Date(start + offset * 86400000).toISOString().slice(0, 10);

function balancedLeague(rounds = 36) {
  const teams = Array.from({ length: 10 }, (_, index) => `Team-${index + 1}`);
  const rotation = teams.slice();
  const matches = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < rotation.length / 2; index += 1) {
      const first = rotation[index];
      const second = rotation[rotation.length - 1 - index];
      const home = (round + index) % 2 === 0 ? first : second;
      const away = home === first ? second : first;
      matches.push({
        date: isoDate(round * 7),
        season: "2425",
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
  return matches;
}

const balanced = balancedLeague();
const baseOptions = {
  homeTeam: "Team-1",
  awayTeam: "Team-2",
  date: isoDate(260),
  competitionId: "ita.1",
  windowDays: 730,
  halfLifeDays: 120,
};

// 1) Senza teamContext il comportamento deve restare identico a prima di questa feature:
// è un'aggiunta opzionale, non deve alterare nessuna previsione esistente.
const withoutContext = predictFromMatches(balanced, baseOptions);
assert.equal(withoutContext.context.applied, false);
assert.equal(withoutContext.context.homeAttack, 1);
assert.equal(withoutContext.context.awayDefense, 1);

// Una voce per una squadra non coinvolta nella partita non deve avere alcun effetto.
const irrelevantEntry = predictFromMatches(balanced, {
  ...baseOptions,
  teamContext: { "Squadra-Inesistente": { lineup_strength: 0.5 } },
});
assert.equal(irrelevantEntry.lambdaHome, withoutContext.lambdaHome);
assert.equal(irrelevantEntry.lambdaAway, withoutContext.lambdaAway);

// 2) Formazione indebolita in attacco per la squadra di casa: il suo lambda deve scendere,
// quello ospite deve restare intatto.
const weakenedHomeAttack = predictFromMatches(balanced, {
  ...baseOptions,
  teamContext: { "Team-1": { lineup_strength: 0.85 } },
});
assert.ok(weakenedHomeAttack.lambdaHome < withoutContext.lambdaHome, "lineup_strength < 1 deve abbassare il lambda della squadra indebolita");
assert.ok(Math.abs(weakenedHomeAttack.lambdaAway - withoutContext.lambdaAway) < 1e-9, "lineup_strength della squadra di casa non deve toccare il lambda ospite");

// 3) Difesa ospite indebolita (availability_defense < 1): deve alzare il lambda di CASA
// (più gol attesi contro una difesa più debole), il lambda ospite non deve muoversi.
const weakenedAwayDefense = predictFromMatches(balanced, {
  ...baseOptions,
  teamContext: { "Team-2": { availability_defense: 0.85 } },
});
assert.ok(weakenedAwayDefense.lambdaHome > withoutContext.lambdaHome, "availability_defense < 1 in trasferta deve alzare il lambda di casa");
assert.ok(Math.abs(weakenedAwayDefense.lambdaAway - withoutContext.lambdaAway) < 1e-9);

// 4) Input fuori scala o malformati (override manuale scritto male in context_overrides.json)
// non devono esplodere il modello: il clamp interno deve contenerli.
const extreme = predictFromMatches(balanced, {
  ...baseOptions,
  teamContext: { "Team-1": { lineup_strength: 50, availability_attack: -3, promotion_attack: "non-numerico" } },
});
assert.ok(Number.isFinite(extreme.lambdaHome) && extreme.lambdaHome > 0 && extreme.lambdaHome < 5);
assert.ok(extreme.context.homeAttack <= 1.3, "il fattore di contesto combinato deve restare clampato anche con input fuori scala");

console.log("OK: team_context (lineup/disponibilità/promozione) opzionale, retro-compatibile e clampato");
