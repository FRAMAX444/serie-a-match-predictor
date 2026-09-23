import assert from "node:assert/strict";
import {
  shinDevig,
  anchorToMarket,
  marketOddsUsable,
  matrixProbabilities,
  scoreMatrix,
  deriveMarkets,
  predictFromMatches,
} from "../model.js";
import { modelInputs } from "../prediction-inputs.js";

// T1 (PROMPT-sessione-5.md §3). Dove una linea di mercato esiste, la linea batte il modello:
// +0.0284 ± 0.0026 sull'1X2 (11.0σ) sull'intero dataset, +0.0219 ± 0.0043 (5.1σ) sul solo
// holdout, misurato da scripts/diag_market_anchor.mjs. Questo file non rimisura il guadagno —
// lo fa quello script sui dati veri — ma difende le proprietà da cui quel guadagno dipende, e
// soprattutto quelle il cui cedimento NON solleverebbe niente.

const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const START = Date.UTC(2025, 7, 17);

// Un campionato sintetico deterministico, la stessa forma usata da prediction-input-parity.
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
        home_team: home, away_team: away,
        home_goals: (round + index) % 3, away_goals: (round + index + 1) % 3,
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

const matches = league(30);
const identity = {
  homeTeam: "Team-1", awayTeam: "Team-2",
  date: iso(START + 30 * 7 * DAY), cutoffDate: iso(START + 30 * 7 * DAY),
  competitionId: "ita.1", season: "2526",
};
const LINEA = { home: 2.10, draw: 3.40, away: 3.60, over25: 1.95, under25: 1.90, line: "chiusura" };

// --- De-vig di Shin --------------------------------------------------------------------------
{
  const shin = shinDevig([LINEA.home, LINEA.draw, LINEA.away]);
  const somma = shin.reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(somma - 1) < 1e-12, `le probabilità de-vigate devono sommare a 1, sommano a ${somma}`);

  // La proprietà che distingue Shin dal proporzionale, e la sola ragione per cui è qui: toglie
  // il margine in modo NON proporzionale e lascia più probabilità al favorito. Verificarlo solo
  // sulla somma a 1 darebbe verde anche al proporzionale, cioè al metodo che NON vogliamo.
  const grezze = [LINEA.home, LINEA.draw, LINEA.away].map((quota) => 1 / quota);
  const totale = grezze.reduce((sum, value) => sum + value, 0);
  const proporzionale = grezze.map((value) => value / totale);
  const favorito = 0;
  assert.ok(
    shin[favorito] > proporzionale[favorito],
    "Shin deve restituire al favorito PIÙ probabilità del de-vig proporzionale",
  );
  assert.ok(shin[2] < proporzionale[2], "e meno allo sfavorito");
}

{
  // Nessun margine da togliere: la bisezione non ha un cambio di segno da cercare e si ripiega
  // sul proporzionale invece di restituire NaN.
  const equa = shinDevig([3, 3, 3]);
  assert.ok(equa.every(Number.isFinite), "un margine nullo non deve produrre NaN");
  equa.forEach((value) => assert.ok(Math.abs(value - 1 / 3) < 1e-9));
}

// --- Riancoraggio: riproduce le marginali del mercato -----------------------------------------
{
  const ancora = anchorToMarket(LINEA);
  assert.ok(ancora, "la linea di esempio deve convergere");
  const [mercatoCasa, mercatoPari] = shinDevig([LINEA.home, LINEA.draw, LINEA.away]);
  const [mercatoOver] = shinDevig([LINEA.over25, LINEA.under25]);
  const ricostruite = matrixProbabilities(ancora.matrix);

  // Il cancello di PROMPT-sessione-5.md §3 T1: le marginali riprodotte entro 1e-5.
  assert.ok(Math.abs(ricostruite.homeWin - mercatoCasa) < 1e-5, "P(1) deve tornare quella del mercato");
  assert.ok(Math.abs(ricostruite.draw - mercatoPari) < 1e-5, "P(X) deve tornare quella del mercato");
  assert.ok(Math.abs(ricostruite.over25 - mercatoOver) < 1e-5, "P(Over 2.5) deve tornare quella del mercato");
  assert.ok(ancora.residual < 1e-5, "il residuo dichiarato deve rispettare il proprio cancello");

  // La matrice è una distribuzione di probabilità, non una tabella di numeri qualunque.
  const massa = ancora.matrix.reduce((total, row) => total + row.reduce((sum, value) => sum + value, 0), 0);
  assert.ok(Math.abs(massa - 1) < 1e-12, "la matrice riancorata deve sommare a 1");

  // Ogni mercato derivato nasce dalla STESSA matrice, quindi non può contraddirsi: è la
  // proprietà che il progetto difende da sempre, e vale anche in regime ancorato.
  const mercati = deriveMarkets(ricostruite);
  const probabilita = Object.fromEntries(mercati.map((voce) => [voce.key, voce.probability]));
  assert.ok(
    Math.abs(probabilita["1X"] - (probabilita["1"] + probabilita.X)) < 1e-12,
    "P(1X) deve essere P(1) + P(X) per costruzione anche sulla matrice ancorata",
  );
}

// --- La griglia e la dispersione sono quelle della produzione, non cablate --------------------
// MISTAKES.md §31 e §21: se il solutore risolve su una griglia e la previsione ricostruisce su
// un'altra, il residuo interno resta verde mentre le marginali che arrivano a deriveMarkets
// sono altre. E CLAUDE.md: un meccanismo spento va ACCESO nel test, altrimenti un difetto
// armato dà verde — `sharedDispersion` vale 0 in produzione per decisione misurata.
{
  const conDispersione = anchorToMarket(LINEA, { sharedDispersion: 0.12 });
  assert.ok(conDispersione, "il riancoraggio deve convergere anche con la dispersione accesa");
  const ricostruite = matrixProbabilities(conDispersione.matrix);
  const [mercatoCasa, mercatoPari] = shinDevig([LINEA.home, LINEA.draw, LINEA.away]);
  const [mercatoOver] = shinDevig([LINEA.over25, LINEA.under25]);
  assert.ok(Math.abs(ricostruite.homeWin - mercatoCasa) < 1e-5, "con φ acceso P(1) deve comunque tornare");
  assert.ok(Math.abs(ricostruite.draw - mercatoPari) < 1e-5, "con φ acceso P(X) deve comunque tornare");
  assert.ok(Math.abs(ricostruite.over25 - mercatoOver) < 1e-5, "con φ acceso P(Over 2.5) deve comunque tornare");

  // E la dispersione deve davvero essere arrivata: se il solutore la ignorasse (cablata a 0),
  // le due matrici sarebbero identiche e l'asserzione qui sopra resterebbe verde lo stesso.
  const senza = anchorToMarket(LINEA, { sharedDispersion: 0 });
  assert.notEqual(
    conDispersione.matrix[0][0], senza.matrix[0][0],
    "sharedDispersion deve raggiungere il solutore, non essere cablato a 0",
  );

  // Stessa verifica per maxGoals: la coda troncata cambia, quindi le celle cambiano.
  const griglia10 = anchorToMarket(LINEA, { maxGoals: 10 });
  assert.equal(griglia10.matrix.length, 11, "maxGoals deve raggiungere il solutore");
  assert.equal(senza.matrix.length, 9, "il default deve essere la griglia 8 della produzione");
}

// --- Quote inutilizzabili: si dichiara, non si ripiega in silenzio ----------------------------
{
  assert.equal(marketOddsUsable(null), false);
  assert.equal(marketOddsUsable({ home: 2, draw: 3, away: 4 }), false, "senza Over/Under non si ancora");
  assert.equal(marketOddsUsable({ ...LINEA, draw: 0.5 }), false, "una quota <= 1 non è una quota");
  assert.equal(anchorToMarket({ home: 2, draw: 3, away: 4 }), null);
}

// --- predictFromMatches: senza quote la previsione è quella di prima, bit per bit (R1) --------
{
  const senzaOpzione = predictFromMatches(matches, { ...modelInputs(), ...identity });
  const conNull = predictFromMatches(matches, { ...modelInputs(), ...identity, marketOdds: null });
  assert.equal(conNull.marketAnchor, null, "senza quote l'ancora deve essere null, non un ripiego muto");
  assert.equal(senzaOpzione.marketAnchor, null);
  // Il confronto che vale: tutto l'oggetto, meno il campo nuovo.
  const spoglia = ({ marketAnchor, ...resto }) => JSON.stringify(resto);
  assert.equal(
    spoglia(conNull), spoglia(senzaOpzione),
    "passare marketOdds: null non deve cambiare NULLA della previsione endogena (R1)",
  );
}

// --- predictFromMatches con quote: l'ancora c'è e l'endogena NON è stata toccata ---------------
{
  const endogena = predictFromMatches(matches, { ...modelInputs(), ...identity });
  const ancorata = predictFromMatches(matches, { ...modelInputs(), ...identity, marketOdds: LINEA });

  assert.equal(ancorata.marketAnchor.status, "anchored");
  assert.equal(ancorata.marketAnchor.line, "chiusura", "la linea usata deve viaggiare col risultato (MISTAKES §25)");
  assert.equal(ancorata.marketAnchor.devig, "shin");

  // LA proprietà che tiene separate le due previsioni. Se un giorno l'ancoraggio riscrivesse i
  // campi in cima, estimatePlayerMarkets(player, result.lambdaHome, …) — chiamata da app.js per
  // MOSTRARE e da schedina.js per GIOCARE — erediterebbe l'informazione di mercato e la schedina
  // avrebbe valore atteso zero contro il banco, senza sollevare nulla. È MISTAKES.md §21.
  assert.equal(ancorata.lambdaHome, endogena.lambdaHome, "lambdaHome deve restare endogeno");
  assert.equal(ancorata.lambdaAway, endogena.lambdaAway, "lambdaAway deve restare endogeno");
  assert.deepEqual(
    ancorata.probabilities, endogena.probabilities,
    "`probabilities` deve restare endogena: l'ancora vive in un campo suo",
  );

  // E l'ancora contiene davvero il mercato, non una copia dell'endogena.
  const [mercatoCasa] = shinDevig([LINEA.home, LINEA.draw, LINEA.away]);
  assert.ok(
    Math.abs(ancorata.marketAnchor.probabilities.homeWin - mercatoCasa) < 1e-5,
    "le probabilità ancorate devono essere quelle del mercato",
  );
  assert.notEqual(
    ancorata.marketAnchor.probabilities.homeWin, endogena.probabilities.homeWin,
    "se ancorata ed endogena coincidessero, l'ancoraggio non starebbe facendo niente",
  );
}

// --- La circolarità, resa esplicita invece che spiegata in un commento -------------------------
// Una previsione ancorata ha valore atteso ESATTAMENTE nullo contro la linea che l'ha prodotta.
// È la ragione per cui schedina.js deve continuare a cercare valore sulle probabilità endogene:
// cercarlo su queste restituisce zero ovunque, e zero non somiglia a un errore.
{
  const ancora = anchorToMarket(LINEA);
  const probabilita = matrixProbabilities(ancora.matrix);
  const quoteEque = shinDevig([LINEA.home, LINEA.draw, LINEA.away]).map((valore) => 1 / valore);
  const esiti = [probabilita.homeWin, probabilita.draw, probabilita.awayWin];
  esiti.forEach((probabilita_, indice) => {
    const valoreAtteso = probabilita_ * quoteEque[indice] - 1;
    assert.ok(
      Math.abs(valoreAtteso) < 1e-5,
      `il valore atteso dell'esito ${indice} contro la propria linea deve essere nullo, vale ${valoreAtteso}`,
    );
  });
}

// --- Margine assurdo: si rifiuta, perché produrrebbe numeri plausibili -------------------------
// Football-Data pubblica una manciata di righe con margine 0.42. Non sollevano niente e non
// sembrano niente: è la firma della famiglia di difetti più costosa di questo progetto.
{
  const rotta = { home: 5.0, draw: 8.0, away: 9.0, over25: 4.0, under25: 4.5, line: "chiusura" };
  const risultato = predictFromMatches(matches, { ...modelInputs(), ...identity, marketOdds: rotta });
  assert.equal(risultato.marketAnchor.status, "unavailable");
  assert.equal(risultato.marketAnchor.reason, "margine-implausibile");
  assert.equal(risultato.marketAnchor.line, "chiusura", "anche il rifiuto deve dire di quale linea parla");

  const incompleta = predictFromMatches(matches, { ...modelInputs(), ...identity, marketOdds: { home: 2, draw: 3, away: 4 } });
  assert.equal(incompleta.marketAnchor.reason, "quote-incomplete");
}

// --- Nessun chiamante ancora oggi, e non per dimenticanza -------------------------------------
// app.js e index.html non scaricano quote da nessuna fonte, e le 2614 fixture future del
// dataset non portano alcun campo quote: il regime ancorato NON è raggiungibile in produzione
// oggi. Il meccanismo esiste, è misurato e è testato; il cablaggio è una decisione separata,
// e finché non viene presa tests/prediction-input-parity.test.js impedisce a un chiamante di
// passare `marketOdds` di nascosto — che sarebbe "produzione ≠ misura" col segno invertito.
{
  const scoreMatrice = scoreMatrix(1.5, 1.2, 8, -0.04, 0);
  assert.equal(scoreMatrice.length, 9, "la griglia di produzione resta 8");
}

console.log("OK: ancoraggio al mercato — marginali riprodotte entro 1e-5 (anche con φ acceso e griglia diversa), endogena intatta bit per bit, valore atteso nullo contro la propria linea, margine assurdo rifiutato e dichiarato");
