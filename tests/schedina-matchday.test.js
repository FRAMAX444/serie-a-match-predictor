import assert from "node:assert/strict";
import { buildMatchdays } from "../matchdays.js";
import { upcomingFixtures, generateSlip } from "../schedina.js";

// Perché la schedina "non trovava le quote" — due difetti, uno dei quali mascherava l'altro.
//
// 1) buildMatchdays() calcolava `firstUpcoming` ma NON lo restituiva. schedina.js lo legge come
//    `calendar.firstUpcoming`, quindi valeva sempre undefined e il fallback cadeva su
//    `matchdays[0]`: il PRIMO turno della stagione, giocato da giorni. Un'API di quote espone
//    solo eventi futuri, quindi non trovava nulla, e l'errore sembrava della chiave o del
//    servizio. La pagina principale non se ne accorgeva perché usa `defaultRound`, restituito.
//
// 2) Un turno non è un blocco atomico: la giornata 3 di Liga del 2026 va dal 25 al 29 agosto.
//    Con parte del turno già giocata, la schedina proponeva scommesse su partite finite e le
//    contava nel minimo di selezioni richieste.
//
// Nessuno dei due solleva un'eccezione: producono una schedina plausibile su dati sbagliati.

const iso = (offsetDays) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

function fixture(round, home, away, offsetDays, completed) {
  return {
    id: `${round}-${home}-${away}`, season: "2526", competition_id: "ita.1",
    competition_name: "Serie A", competition_type: "domestic", country: "Italy",
    league_strength: 1550, round, round_label: `Giornata ${round}`,
    date: iso(offsetDays), home_team: home, away_team: away, completed,
    home_goals: completed ? 1 : null, away_goals: completed ? 0 : null,
  };
}

// Turno 1 interamente giocato, turno 2 metà giocato, turno 3 tutto da giocare.
const fixtures = [
  fixture(1, "Inter", "Milan", -7, true),
  fixture(1, "Napoli", "Roma", -7, true),
  fixture(2, "Lazio", "Genoa", -1, true),
  fixture(2, "Torino", "Udinese", 1, false),
  fixture(3, "Atalanta", "Bologna", 8, false),
  fixture(3, "Juventus", "Cagliari", 8, false),
];
const payload = {
  competitions: [{ id: "ita.1", name: "Serie A", season: "2526", type: "domestic", country: "Italy", fixtures }],
};

// --- 1) firstUpcoming deve essere RESTITUITO, non solo calcolato ---------------------------
const calendar = buildMatchdays(payload, "ita.1");
assert.ok(
  Object.prototype.hasOwnProperty.call(calendar, "firstUpcoming"),
  "buildMatchdays deve restituire firstUpcoming: schedina.js lo legge, e senza cadeva su matchdays[0]",
);
assert.ok(calendar.firstUpcoming, "firstUpcoming non deve essere nullo quando esiste un turno con gare da giocare");
assert.equal(
  calendar.firstUpcoming.round, 2,
  "il primo turno con almeno una gara da giocare è il 2, non l'1 (interamente concluso)",
);
assert.notEqual(
  calendar.firstUpcoming.round, calendar.matchdays[0].round,
  "il test non verifica nulla se il turno giusto coincide con il primo: la fixture va corretta",
);

// --- 2) upcomingFixtures scarta il già giocato ---------------------------------------------
const secondRound = calendar.matchdays.find((matchday) => matchday.round === 2);
const playable = upcomingFixtures(secondRound.fixtures);
assert.equal(playable.length, 1, "del turno 2 resta giocabile solo Torino - Udinese");
assert.equal(playable[0].home_team, "Torino");

// Il flag da solo non basta: una gara di ieri non ancora ingerita dalla pipeline è comunque
// impossibile da scommettere, e nessuna API di quote la espone più.
const staleFlag = [{ date: iso(-2), completed: false, home_team: "A", away_team: "B" }];
assert.deepEqual(
  upcomingFixtures(staleFlag), [],
  "una gara con data passata va esclusa anche se il flag `completed` non è ancora stato aggiornato",
);
// E una gara di oggi resta giocabile: l'orario non è noto, e scartarla toglierebbe
// esattamente le partite su cui le quote esistono davvero.
assert.equal(upcomingFixtures([{ date: iso(0), completed: false }]).length, 1);

// --- 3) generateSlip non compone giocate su partite concluse -------------------------------
// Il turno 2 ha una sola gara ancora aperta: chiederne due deve fallire con un messaggio che
// dice PERCHÉ, non produrre una schedina che include Lazio - Genoa, finita ieri.
await assert.rejects(
  () => generateSlip({ payload, competitionId: "ita.1", legs: 2, playerMarkets: [] }),
  (error) => {
    assert.match(error.message, /1 partite ancora da giocare/);
    assert.match(error.message, /1 gia' concluse/);
    return true;
  },
  "con una sola gara aperta e due selezioni richieste l'errore deve spiegare il conteggio",
);

console.log("OK: schedina — il turno scelto è il primo con gare ancora da giocare, e le partite già concluse non entrano nelle giocate");
