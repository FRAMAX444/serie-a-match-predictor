import assert from "node:assert/strict";
import { predictFromMatches } from "../model.js";

// NON è un'ipotesi respinta: è un dato sbagliato.
//
// Per una previsione domestica predictFromMatches() filtra `chronological` alle sole
// competizioni domestiche (competitionAllowed). Di conseguenza `state.lastDate` è la data
// dell'ultima partita DI CAMPIONATO, e `restDays` conta i giorni da quella. Per una squadra
// che gioca in Champions il mercoledì e in campionato la domenica, il modello non vede tre
// giorni di riposo: ne vede sette.
//
// Misura sul dataset (7088 osservazioni squadra-partita): per una squadra con una gara
// europea 2-5 giorni prima, il riposo che il modello crede di vedere supera quello vero di
// **5.1 giorni** in media, e di **6.0** se la trasferta europea era fuori casa.
//
// L'errore è invisibile perché non produce un'eccezione ma un numero plausibile — sette
// giorni di riposo sono perfettamente normali — ed è esattamente la classe di bug che R2
// esiste per intercettare. Alimenta restFactor() e, via freshnessDays, anche dataQuality.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

function league(rounds) {
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
        date: iso(START + round * 7 * DAY), season: "2526", competition_id: "ita.1",
        competition_type: "domestic", league_strength: 1550,
        home_team: home, away_team: away, home_goals: 2, away_goals: 1,
        home_xg: 1.7, away_xg: 1.0, home_shots: 13, away_shots: 10, home_sot: 5, away_sot: 4,
        home_red: 0, away_red: 0,
      });
    }
    const fixed = rotation[0];
    const tail = rotation.slice(1);
    tail.unshift(tail.pop());
    rotation.splice(0, rotation.length, fixed, ...tail);
  }
  return matches;
}

const base = league(30);
const predictionDate = iso(START + 30 * 7 * DAY);
// Champions il mercoledì: tre giorni prima della giornata di campionato da prevedere.
const midweekCup = {
  date: iso(START + 30 * 7 * DAY - 3 * DAY), season: "2526", competition_id: "ucl",
  competition_type: "europe", league_strength: 1500,
  home_team: "Estero", away_team: "Team-1",
  home_goals: 1, away_goals: 1, home_xg: 1.2, away_xg: 1.1,
  home_shots: 12, away_shots: 11, home_sot: 4, away_sot: 4, home_red: 0, away_red: 0,
};

const predict = (matches) => predictFromMatches(matches, {
  homeTeam: "Team-1", awayTeam: "Team-2", date: predictionDate, cutoffDate: predictionDate,
  competitionId: "ita.1", windowDays: 730,
});

const withoutCup = predict(base);
const withCup = predict(base.concat([midweekCup]));

// Senza la gara di coppa il riposo è di sette giorni: l'ultima partita è quella di campionato.
assert.equal(withoutCup.home.restDays, 7, `riposo atteso 7, vale ${withoutCup.home.restDays}`);

// Con la gara di coppa il riposo VERO è di tre giorni, e il modello deve vederlo — anche se
// quella partita non entra in Elo e medie, che restano costruiti sulle sole gare domestiche.
assert.equal(
  withCup.home.restDays,
  3,
  `Con una gara di Champions tre giorni prima il riposo deve valere 3, vale ${withCup.home.restDays}. `
  + "Se vale 7 il modello sta contando i giorni dall'ultima partita di CAMPIONATO, cioè "
  + "ignorando una partita che la squadra ha davvero giocato.",
);

// L'avversaria, che in coppa non ha giocato, non deve essere toccata.
assert.equal(
  withCup.away.restDays,
  withoutCup.away.restDays,
  "Il riposo dell'avversaria, che non ha giocato in coppa, non deve cambiare",
);

// La correzione deve arrivare fino al lambda: restFactor() penalizza i riposi corti, quindi
// con tre giorni invece di sette il lambda della squadra affaticata deve scendere.
assert.ok(
  withCup.lambdaHome < withoutCup.lambdaHome,
  `Il riposo corretto deve arrivare al lambda: ${withCup.lambdaHome.toFixed(4)} contro ${withoutCup.lambdaHome.toFixed(4)}`,
);

// Elo e medie devono restare quelli delle sole gare domestiche: la correzione riguarda il
// CALENDARIO, non la storia sportiva su cui il modello è calibrato.
assert.equal(
  withCup.home.matches,
  withoutCup.home.matches,
  "La gara di coppa non deve entrare nelle medie di una previsione domestica",
);
assert.equal(
  withCup.home.elo,
  withoutCup.home.elo,
  "La gara di coppa non deve entrare nell'Elo di una previsione domestica",
);

console.log("OK: riposo reale — le partite di coppa contano per il calendario anche quando non contano per Elo e medie");
