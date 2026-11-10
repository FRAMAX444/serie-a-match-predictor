import assert from "node:assert/strict";
import { predictFromMatches, DEFAULT_HYPERPARAMETERS } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";

// Prior Elo per nazione dei club di coppa (`cupCountryPriorWeight`). Acceso (1) dal 10/11/2026
// dopo la pre-registrazione superata (docs/pre-registrazione-cup-country-prior.md). Si verifica
// sia spento (neutralità bit per bit) sia acceso (direzione e monotonia).

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 6, 10);

// Due club di coppa senza campionato nel dataset, identici in tutto tranne la nazione: Forte
// (campionato a 1495) e Debole (1225). Ogni gara è contro avversari neutri, con lo stesso
// risultato, così che solo il prior possa separarli.
function cupMatches({ withStrength }) {
  const rows = [];
  const opponents = ["Neutro-1", "Neutro-2", "Neutro-3", "Neutro-4"];
  for (let round = 0; round < 120; round += 1) {
    const home = opponents[round % 4];
    const away = opponents[(round + 1) % 4];
    rows.push({
      date: iso(START + round * DAY), season: "2526", competition_id: "uecl", competition_type: "europe",
      league_strength: 1500, home_team: home, away_team: away, home_goals: round % 3, away_goals: (round + 1) % 3,
      home_shots: 12, away_shots: 10, home_sot: 4, away_sot: 3, home_red: 0, away_red: 0,
    });
  }
  for (const [team, strength] of [["Forte", 1495], ["Debole", 1225]]) {
    for (let round = 0; round < 6; round += 1) {
      rows.push({
        date: iso(START + (30 + round * 7) * DAY + (team === "Forte" ? 0 : DAY)), season: "2526",
        competition_id: "uecl", competition_type: "europe", league_strength: 1500,
        home_team: team, away_team: `Neutro-${(round % 4) + 1}`, home_goals: 1, away_goals: 1,
        home_shots: 11, away_shots: 11, home_sot: 4, away_sot: 4, home_red: 0, away_red: 0,
        ...(withStrength ? { home_country_code: team === "Forte" ? "POR" : "GIB", home_league_strength: strength, away_league_strength: 1500 } : {}),
      });
    }
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date));
}

const identity = { homeTeam: "Forte", awayTeam: "Debole", date: iso(START + 125 * DAY), cutoffDate: iso(START + 125 * DAY), competitionId: "uecl", season: "2526" };
const options = (weight) => ({ ...modelInputs(), ...identity, hyperparameters: { cupCountryPriorWeight: weight } });

assert.equal(DEFAULT_HYPERPARAMETERS.cupCountryPriorWeight, 1, "accettato con la pre-registrazione: C1 e C2 superati");

// Neutralità bit per bit: a peso 0 i campi nuovi del dataset non cambiano NULLA.
const without = predictFromMatches(cupMatches({ withStrength: false }), options(0));
const withFieldsOff = predictFromMatches(cupMatches({ withStrength: true }), options(0));
assert.deepEqual(withFieldsOff.probabilities, without.probabilities, "a peso 0 la forza di lega deve essere inerte");
assert.equal(withFieldsOff.home.elo, without.home.elo);

// Acceso: direzione giusta. Il club del campionato più forte parte più in alto e la previsione
// si sposta verso di lui; senza i campi nel dataset anche acceso non fa niente.
const on = predictFromMatches(cupMatches({ withStrength: true }), options(1));
assert.ok(on.home.elo > on.away.elo, `Elo Forte ${on.home.elo} non sopra Debole ${on.away.elo}`);
assert.ok(on.probabilities.homeWin > without.probabilities.homeWin, "il prior acceso non sposta la previsione verso il club più forte");
const onWithoutFields = predictFromMatches(cupMatches({ withStrength: false }), options(1));
assert.deepEqual(onWithoutFields.probabilities, without.probabilities, "senza forza di lega nel dato il prior deve restare a 1500");

// Mezzo peso sta in mezzo: il parametro è continuo, non un interruttore mascherato.
const half = predictFromMatches(cupMatches({ withStrength: true }), options(0.5));
assert.ok(half.home.elo - half.away.elo > 0 && half.home.elo - half.away.elo < on.home.elo - on.away.elo);

console.log("OK: prior Elo per nazione in coppa — neutro bit per bit a peso 0, inerte senza il dato, direzione e monotonia quando acceso");
