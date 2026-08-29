import assert from "node:assert/strict";
import {
  saveSlipSeries, readSlipHistory, clearSlipHistory, settleMarket, settleSeries,
  indexMatches, historyCalibration, SLIP_HISTORY_STORAGE,
} from "../slip-history.js";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

// --- 1) Risoluzione dei mercati dal punteggio -------------------------------------------------
// Ogni chiave che deriveMarkets sa produrre deve avere un esito deciso qui: una chiave nuova nel
// modello e non qui diventerebbe silenziosamente "non verificabile", cioe' una schedina che non
// si conta mai.
assert.equal(settleMarket("1", 2, 1), true);
assert.equal(settleMarket("1", 1, 1), false);
assert.equal(settleMarket("X", 1, 1), true);
assert.equal(settleMarket("2", 0, 3), true);
assert.equal(settleMarket("1X", 1, 1), true, "1X vince anche col pareggio: e' il punto della doppia chance");
assert.equal(settleMarket("1X", 0, 1), false);
assert.equal(settleMarket("12", 1, 1), false);
assert.equal(settleMarket("X2", 1, 2), true);
assert.equal(settleMarket("OVER25", 2, 1), true, "3 gol superano la linea 2.5");
assert.equal(settleMarket("OVER25", 1, 1), false);
assert.equal(settleMarket("UNDER25", 1, 1), true);
assert.equal(settleMarket("OVER05", 0, 0), false);
assert.equal(settleMarket("OVER35", 2, 2), true);
assert.equal(settleMarket("UNDER35", 2, 2), false);
assert.equal(settleMarket("GG", 1, 1), true);
assert.equal(settleMarket("GG", 3, 0), false);
assert.equal(settleMarket("NG", 3, 0), true);
assert.equal(settleMarket("HOME_SCORES", 1, 0), true);
assert.equal(settleMarket("AWAY_SCORES", 1, 0), false);
// I mercati sui giocatori NON sono decidibili dal punteggio: vanno dichiarati, non dati per persi.
assert.equal(settleMarket("goalscorer:123", 3, 0), null);
assert.equal(settleMarket("1", null, 1), null, "senza punteggio non c'e' esito, nemmeno negativo");

// --- 2) Stato di una schedina -----------------------------------------------------------------
const leg = (key, home, away, date, probability = 0.6, odds = 1.7) => ({
  key, label: key, group: "1X2", probability, odds, source: "model",
  competitionId: "ita.1", homeTeam: home, awayTeam: away, date,
});
const matches = indexMatches([
  { competition_id: "ita.1", date: "2026-08-29", home_team: "Inter", away_team: "Milan", home_goals: 2, away_goals: 1 },
  { competition_id: "ita.1", date: "2026-08-29", home_team: "Roma", away_team: "Lazio", home_goals: 0, away_goals: 0 },
  { competition_id: "ita.1", date: "2026-08-30", home_team: "Napoli", away_team: "Como", home_goals: null, away_goals: null },
]);

const record = {
  id: "x", competitionId: "ita.1", round: 2,
  slips: [
    { combinedOdds: 2.9, combinedProbability: 0.34, legs: [leg("1", "Inter", "Milan", "2026-08-29"), leg("X", "Roma", "Lazio", "2026-08-29")] },
    { combinedOdds: 3.1, combinedProbability: 0.30, legs: [leg("1", "Inter", "Milan", "2026-08-29"), leg("1", "Roma", "Lazio", "2026-08-29")] },
    { combinedOdds: 4.0, combinedProbability: 0.25, legs: [leg("1", "Inter", "Milan", "2026-08-29"), leg("1", "Napoli", "Como", "2026-08-30")] },
    { combinedOdds: 5.0, combinedProbability: 0.20, legs: [leg("1", "Inter", "Milan", "2026-08-29"), leg("goalscorer:9", "Roma", "Lazio", "2026-08-29")] },
  ],
};
const settled = settleSeries(record, matches);
assert.equal(settled.slips[0].status, "vinta");
assert.equal(settled.slips[1].status, "persa", "basta una selezione perdente: una multipla non si recupera");
assert.equal(settled.slips[2].status, "in corso", "una partita non ancora giocata tiene la schedina aperta");
assert.equal(settled.slips[3].status, "non verificabile", "un mercato giocatore non decidibile non e' una sconfitta");
assert.equal(settled.slips[0].legs[0].score, "2-1", "il punteggio va mostrato: e' come si controlla l'esito");
assert.equal(settled.slips[2].legs[1].played, false);

// Una partita che nel dataset non esiste affatto (nome cambiato, gara rinviata) resta "in corso",
// non "vinta": dare per buono cio' che non si e' trovato gonfierebbe ogni statistica.
const orphan = settleSeries(
  { ...record, slips: [{ combinedOdds: 2, combinedProbability: 0.5, legs: [leg("1", "Sconosciuta", "Ignota", "2026-08-29")] }] },
  matches,
);
assert.equal(orphan.slips[0].status, "in corso");

// --- 3) Calibrazione ---------------------------------------------------------------------------
const calibration = historyCalibration([settled]);
assert.equal(calibration.decided, 2, "solo le schedine con esito deciso entrano nella calibrazione");
assert.equal(calibration.won, 1);
assert.ok(Math.abs(calibration.expectedWins - 0.64) < 1e-9, "vittorie attese = somma delle probabilita' dichiarate");
assert.equal(calibration.staked, 2);
assert.ok(Math.abs(calibration.returned - 2.9) < 1e-9, "il ritorno e' la quota delle sole vinte");
const band = calibration.bands.find((item) => item.label === "20-35%");
assert.equal(band.n, 2);
assert.equal(band.won, 1);

// --- 4) Archivio ------------------------------------------------------------------------------
const storage = fakeStorage();
assert.equal(saveSlipSeries({ competitionId: "ita.1", round: 2, slips: record.slips }, { storage, now: 1000 }), true);
assert.equal(readSlipHistory(storage).length, 1);
assert.equal(readSlipHistory(storage)[0].slips.length, 4);
assert.equal(readSlipHistory(storage)[0].slips[0].legs[0].homeTeam, "Inter", "l'identita' della partita va salvata, non ricavata dall'etichetta");

// Una serie senza schedine non si salva: un archivio pieno di righe vuote e' peggio di niente.
assert.equal(saveSlipSeries({ competitionId: "ita.1", round: 3, slips: [] }, { storage, now: 2000 }), false);

// Il tetto sul numero di serie conservate vale, e le piu' recenti restano.
for (let index = 0; index < 8; index += 1) {
  saveSlipSeries({ competitionId: "ita.1", round: index, slips: record.slips }, { storage, now: 3000 + index, max: 3 });
}
const stored = readSlipHistory(storage);
assert.equal(stored.length, 3);
assert.equal(stored[0].round, 7, "in cima la piu' recente");

// Il giro completo: salva -> rileggi -> risolvi. E' il confine su cui il campo della data cambia
// nome (`fixtureDate` nel candidato, `date` nel record), e senza questo test la schedina restava
// "in corso" per sempre perche' la partita non veniva trovata.
const roundTrip = fakeStorage();
saveSlipSeries({
  competitionId: "ita.1", round: 2,
  slips: [{
    combinedOdds: 2.9,
    combinedProbability: 0.34,
    legs: [{
      key: "1", label: "1", group: "1X2", probability: 0.6, odds: 1.7, source: "model",
      competitionId: "ita.1", homeTeam: "Inter", awayTeam: "Milan", fixtureDate: "2026-08-29",
    }],
  }],
}, { storage: roundTrip, now: 5000 });
const reread = settleSeries(readSlipHistory(roundTrip)[0], matches);
assert.equal(reread.slips[0].legs[0].date, "2026-08-29", "la data deve sopravvivere al salvataggio");
assert.equal(reread.slips[0].status, "vinta", "una selezione salvata deve poter essere risolta dopo la rilettura");

// Storage assente o contenuto illeggibile: si degrada, non si rompe.
assert.deepEqual(readSlipHistory(null), []);
assert.equal(saveSlipSeries({ competitionId: "x", slips: record.slips }, { storage: null }), false);
const corrupted = fakeStorage();
corrupted.setItem(SLIP_HISTORY_STORAGE, "{rotto");
assert.deepEqual(readSlipHistory(corrupted), []);

clearSlipHistory(storage);
assert.deepEqual(readSlipHistory(storage), []);

console.log("OK: storico schedine — esiti dal punteggio, stato delle multiple, calibrazione e archivio");
