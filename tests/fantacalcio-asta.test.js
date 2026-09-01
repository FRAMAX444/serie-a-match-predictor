import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  roleOf, leggiStorico, righeDaCsv, abbinaStorico, tassiStorici, proiezione,
  quotaPresenzeAttese, pesoTitolaritaAttuale, livelliDiSostituzione, assegnaCrediti,
  coppieAlternate, postiDaModulo, modificatoreDifesa, pendenzaModificatore,
  LEGA_DEFAULT, PUNTEGGI, GIORNATE, MODIFICATORE_DIFESA,
} from "../scripts/fantacalcio_asta.mjs";
import { writeWorkbook, readSheet } from "../scripts/xlsx.mjs";

// Contratti del foglio per l'asta, tutti su funzioni pure. Il modello e il dataset sono coperti
// altrove; qui sta l'aritmetica del valore, che e' la parte che sbaglia in silenzio — un prezzo
// consigliato non solleva mai un'eccezione, qualunque numero sia.

// --- 1) Ruoli ---------------------------------------------------------------------------------
assert.equal(roleOf("GK"), "P");
assert.equal(roleOf("DEF"), "D");
assert.equal(roleOf("MID"), "C");
assert.equal(roleOf("FWD"), "A");
assert.equal(roleOf("qualunque cosa"), "C", "una posizione ignota non deve far sparire il giocatore");

// --- 2) Lettura dello storico Fantagazzetta ---------------------------------------------------
const righe = [
  ["Statistiche Fantacalcio Stagione 2025 26", "", "", "", "", "", "", "", "", "", ""],
  ["Id", "R", "Rm", "Nome", "Squadra", "Pv", "Mv", "Fm", "Gf", "Ass", "Amm", "Esp", "Au", "Gs", "Rp", "R-"],
  ["1", "A", "Pc", "Lautaro Martinez", "Inter", "30", "6,42", "8,1", "17", "6", "3", "0", "0", "0", "0", "1"],
  ["2", "P", "Por", "Svilar", "Roma", "38", "6.26", "5.45", "0", "0", "1", "0", "0", "31", "2", "0"],
  ["3", "C", "M;C", "Riserva Mai Vista", "Lecce", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
];
const storico = leggiStorico(righe);
assert.equal(storico.length, 3, "anche chi ha 0 presenze resta: dice una cosa diversa da «non trovato»");
const lautaro = storico[0];
assert.equal(lautaro.ruolo, "A");
assert.equal(lautaro.ruoloMantra, "Pc");
assert.equal(lautaro.presenze, 30);
assert.equal(lautaro.votoMedio, 6.42, "la virgola decimale italiana va letta come decimale");
assert.equal(lautaro.gol, 17);
assert.equal(lautaro.rigoriSbagliati, 1);
assert.equal(storico[1].golSubiti, 31);
assert.equal(storico[1].rigoriParati, 2);
assert.throws(() => leggiStorico([["niente", "di", "utile"]]), /intestazione/);
assert.deepEqual(righeDaCsv("a;b;c\n1;2;3")[1], ["1", "2", "3"], "il CSV con ; resta supportato");

// --- 3) Abbinamento dei nomi ------------------------------------------------------------------
// E' il confine su cui questo repo ha sbagliato piu' volte. Ogni riga qui sotto e' un caso vero
// trovato sul file 2025/26 e sulle rose ESPN.
const candidati = leggiStorico([
  ["Nome", "Squadra", "R", "Pv", "Mv", "Gf", "Ass", "Amm", "Esp"],
  ["Svilar", "Roma", "P", "38", "6.26", "0", "0", "1", "0"],
  ["Milinkovic-Savic V.", "Napoli", "P", "27", "6.2", "0", "0", "0", "0"],
  ["N'Dicka", "Roma", "D", "31", "6.1", "2", "1", "4", "0"],
  ["Hojlund", "Napoli", "A", "33", "6.21", "12", "5", "2", "0"],
  ["De Marzi", "Roma", "P", "3", "6.0", "0", "0", "0", "0"],
  ["De Silvestri", "Bologna", "D", "20", "6.0", "0", "1", "2", "0"],
  ["Thuram", "Inter", "A", "29", "6.43", "13", "6", "3", "0"],
  ["Thuram K.", "Juventus", "C", "34", "6.1", "3", "2", "5", "0"],
]);
assert.equal(abbinaStorico("M. Svilar", candidati).esito.nome, "Svilar");
assert.equal(abbinaStorico("V. Milinkovic-Savic", candidati).esito.nome, "Milinkovic-Savic V.",
  "le due fonti scrivono l'iniziale da lati opposti");
assert.equal(abbinaStorico("E. Ndicka", candidati).esito.nome, "N'Dicka",
  "un apostrofo tolto non deve creare due giocatori");
assert.equal(abbinaStorico("R. Højlund", candidati).esito.nome, "Hojlund",
  "la o barrata danese non e' una o accentata: NFD da sola non la tocca");
assert.equal(abbinaStorico("G. De Marzi", candidati).esito.nome, "De Marzi",
  "«De» e' una particella: non deve rendere ambiguo ogni cognome che comincia per De");
assert.equal(abbinaStorico("M. Thuram", candidati).esito.nome, "Thuram");
assert.equal(abbinaStorico("K. Thuram", candidati).esito.nome, "Thuram K.",
  "due fratelli con lo stesso cognome si distinguono per iniziale");
assert.equal(abbinaStorico("A. Sconosciuto", candidati).esito, null);
assert.match(abbinaStorico("A. Sconosciuto", candidati).motivo, /non trovato/);

// --- 4) Presenze attese -----------------------------------------------------------------------
// Il peso della titolarita' di oggi cresce con le giornate viste: a una giornata giocata quel
// segnale e' quasi rumore, e pesarlo troppo faceva scendere un titolare assoluto a 22 presenze
// perche' era in panchina alla prima.
assert.ok(pesoTitolaritaAttuale(1) < 0.2, "a una giornata il presente pesa poco");
assert.ok(pesoTitolaritaAttuale(20) > pesoTitolaritaAttuale(1), "piu' giornate viste, piu' peso al presente");
const titolareInPanchina = quotaPresenzeAttese(29, 0.25, 1);
assert.ok(titolareInPanchina > 0.6, `29 presenze l'anno scorso non spariscono per una panchina (era ${titolareInPanchina})`);
// Un giocatore mai visto in Serie A e' un'incognita, non un titolare: senza sconto proiettava
// piu' presenze dei titolari veri e invadeva le liste delle coppie.
assert.ok(quotaPresenzeAttese(0, 0.75, 1) < quotaPresenzeAttese(30, 0.75, 1),
  "senza storico si proietta meno di chi ha giocato 30 partite");
assert.ok(quotaPresenzeAttese(0, 0.75, 1) < 0.6);

// --- 5) Modificatore di difesa ----------------------------------------------------------------
assert.equal(modificatoreDifesa(5.8), 0);
assert.equal(modificatoreDifesa(6.1), 1);
assert.equal(modificatoreDifesa(6.6), 3);
assert.equal(modificatoreDifesa(7.2), MODIFICATORE_DIFESA[0].punti);
assert.ok(pendenzaModificatore(6.1) > 0, "la pendenza attorno alla media tipica dev'essere positiva");

// --- 6) Proiezione ----------------------------------------------------------------------------
const tassi = tassiStorici({
  presenze: 30, gol: 15, assist: 6, ammonizioni: 3, espulsioni: 0, autogol: 0,
  rigoriSbagliati: 0, rigoriParati: 0,
});
assert.equal(tassi.gol, 0.5, "15 gol in 30 presenze");
const squadra = { lambdaMedio: 1.5, golSubiti: 38, cleanSheet: 12, scalaAttacco: 1 };
const attaccante = proiezione({ tassi, squadra, ruolo: "A", votoBase: 6.4, quotaPresenze: 1 });
assert.equal(attaccante.presenze, GIORNATE);
assert.equal(attaccante.gol, 19, "0.5 gol per presenza su 38 giornate");
assert.equal(attaccante.golSubiti, 0, "un attaccante non prende il malus dei gol della sua squadra");
assert.ok(Math.abs(attaccante.fantapunti - (38 * 6.4 + 3 * 19 + 7.6 - 1.9)) < 1e-9);

// L'attacco della squadra nuova riscala quello che il giocatore ha prodotto nella vecchia.
const versoUnAttaccoMigliore = proiezione({
  tassi, squadra: { ...squadra, scalaAttacco: 1.3 }, ruolo: "A", votoBase: 6.4, quotaPresenze: 1,
});
assert.ok(versoUnAttaccoMigliore.gol > attaccante.gol);

const portiere = proiezione({ tassi: tassiStorici({ presenze: 38, gol: 0, assist: 0, ammonizioni: 1, espulsioni: 0, autogol: 0, rigoriSbagliati: 0, rigoriParati: 2 }), squadra, ruolo: "P", votoBase: 6.2, quotaPresenze: 1 });
assert.equal(portiere.golSubiti, 38, "i gol subiti vengono dalla difesa prevista per QUEST'anno");
assert.equal(portiere.cleanSheet, 12);
assert.ok(Math.abs(portiere.rigoriParati - 2) < 1e-9);
// Meta' presenze, meta' malus: il gol subito segue i minuti, non la stagione.
const secondoPortiere = proiezione({ tassi: tassiStorici({ presenze: 38, gol: 0, assist: 0, ammonizioni: 0, espulsioni: 0, autogol: 0, rigoriSbagliati: 0, rigoriParati: 0 }), squadra, ruolo: "P", votoBase: 6.2, quotaPresenze: 0.5 });
assert.ok(Math.abs(secondoPortiere.golSubiti - 19) < 1e-9);

// Il modificatore vale solo per chi entra nella media della difesa, ed e' un contributo
// MARGINALE diviso i quattro giocatori che la compongono: attribuirlo intero conterebbe lo
// stesso punto quattro volte.
const modificatore = { votoRiferimento: 6.0, pendenza: 4 };
const difensoreForte = proiezione({ tassi, squadra, ruolo: "D", votoBase: 6.4, quotaPresenze: 1, modificatore });
const difensoreDebole = proiezione({ tassi, squadra, ruolo: "D", votoBase: 6.0, quotaPresenze: 1, modificatore });
assert.ok(Math.abs(difensoreForte.contributoModificatore - 38 * 4 * 0.4 / 4) < 1e-9);
assert.equal(difensoreDebole.contributoModificatore, 0, "chi sta sul riferimento non aggiunge nulla");
assert.ok(difensoreForte.fantapunti > difensoreDebole.fantapunti);
assert.equal(
  proiezione({ tassi, squadra, ruolo: "C", votoBase: 6.4, quotaPresenze: 1, modificatore }).contributoModificatore,
  0,
  "il modificatore e' della difesa: un centrocampista non lo prende",
);

// --- 7) Livello di sostituzione: i titolari, non i posti in rosa ------------------------------
// Difetto misurato mentre scrivevo lo script: con i posti in rosa (3 portieri x 10 squadre = 30)
// il livello cadeva su una RISERVA che gioca un quarto delle giornate, ogni portiere titolare
// valeva cento punti sopra il suo sostituto e usciva a 168 crediti su 500.
const lega = { ...LEGA_DEFAULT, squadre: 10 };
const portieri = [
  ...Array.from({ length: 20 }, (_, i) => ({ ruolo: "P", proiezione: { fantapunti: 200 - i } })),
  ...Array.from({ length: 40 }, () => ({ ruolo: "P", proiezione: { fantapunti: 50 } })),
];
assert.ok(livelliDiSostituzione(portieri, lega).P > 180,
  "il livello dei portieri sta fra i titolari, non fra le riserve");

// --- 8) Crediti -------------------------------------------------------------------------------
const rosa = [];
for (const [ruolo, posti] of Object.entries(LEGA_DEFAULT.rosa)) {
  for (let i = 0; i < posti * 10 + 20; i += 1) {
    rosa.push({ nome: `${ruolo}${i}`, ruolo, proiezione: { fantapunti: 300 - i * 2 } });
  }
}
const { montepremi } = assegnaCrediti(rosa, lega);
assert.equal(montepremi, 5000);
const totale = rosa.reduce((sum, g) => sum + g.crediti, 0);
assert.ok(Math.abs(totale - 5000) < 1e-6, `i prezzi devono chiudere sul montepremi, erano ${totale}`);
for (const [ruolo, quota] of Object.entries(lega.quoteRuolo)) {
  const perRuolo = rosa.filter((g) => g.ruolo === ruolo).reduce((sum, g) => sum + g.crediti, 0);
  assert.ok(Math.abs(perRuolo - 5000 * quota) < 1e-6, `${ruolo}: ${perRuolo} invece di ${5000 * quota}`);
}
const comprati = rosa.filter((g) => g.crediti > 0);
assert.equal(comprati.length, 10 * 25, "un prezzo lo ricevono esattamente i giocatori che verranno comprati");
assert.ok(comprati.every((g) => g.crediti >= 1), "nessun prezzo sotto il credito minimo dell'asta");
// I giocatori sotto la soglia da titolare non valgono tutti uguale: con il solo livello dei
// titolari uscivano cinquanta difensori a 1 credito esatto, un prezzo che all'asta non esiste.
const difensori = rosa.filter((g) => g.ruolo === "D" && g.crediti > 0).sort((a, b) => b.crediti - a.crediti);
const panchina = difensori.slice(-20);
assert.ok(new Set(panchina.map((g) => Math.round(g.crediti * 100))).size > 1,
  "i prezzi della panchina devono essere distinti, non tutti al minimo");
assert.ok(difensori[0].crediti > difensori.at(-1).crediti, "il prezzo e' monotono nel valore");

// --- 9) Coppie che si contendono lo stesso posto ----------------------------------------------
assert.deepEqual(postiDaModulo("3-5-2"), { P: 1, D: 3, C: 5, A: 2 });
assert.deepEqual(postiDaModulo("4-2-3-1"), { P: 1, D: 4, C: 5, A: 1 });
assert.deepEqual(postiDaModulo(""), { P: 1, D: 4, C: 4, A: 2 }, "senza modulo si usa un ripiego dichiarato");

const finto = (nome, presenze, crediti, extra = {}) => ({
  nome, squadra: "Inter", ruolo: "D", crediti,
  proiezione: { presenze, fantapunti: 100 + presenze },
  storico: { presenze: 30, ruoloMantra: "Dc", votoMedio: 6.2 },
  ...extra,
});
// Difetto corretto: in una difesa a tre, i primi tre difensori giocano INSIEME. Accoppiarli non
// copre uno slot, ne occupa due — ed e' esattamente cio' che il foglio proponeva.
const difesaATre = [finto("Bastoni", 30, 40), finto("Bisseck", 28, 30), finto("Acerbi", 26, 20), finto("Riserva", 12, 3)];
const coppie = coppieAlternate(difesaATre, new Map([["Inter", "3-5-2"]]));
assert.ok(coppie.length > 0);
for (const coppia of coppie) {
  assert.equal(coppia.b.nome, "Riserva", "il secondo dev'essere chi sta FUORI dalla formazione tipo");
}
assert.ok(!coppie.some((c) => c.a.nome === "Bastoni" && c.b.nome === "Bisseck"),
  "due titolari della stessa difesa a tre non sono una coppia che si alterna");
// Il costo di una coppia non e' mai zero: all'asta ogni giocatore costa almeno un credito.
assert.ok(coppie.every((c) => c.costo >= 2), "prezzo minimo di un credito a testa");
// Un titolare sconosciuto non fa classifica: i suoi punti sono una mediana di ruolo, cioe' un
// segnaposto, e con due crediti di costo dominerebbe ogni rapporto punti/prezzo.
const ignoti = [finto("Ignoto", 25, 1, { storico: null }), finto("AltroIgnoto", 12, 1, { storico: null })];
assert.equal(coppieAlternate(ignoti, new Map([["Inter", "3-5-2"]])).length, 0);

// --- 10) Il file .xlsx si scrive e si rilegge -------------------------------------------------
// Difetto trovato al primo tentativo: nella directory centrale il metodo di compressione era
// scritto nel campo dei FLAG, quindi un lettore vedeva "non compresso" e prendeva i byte deflate
// per dati veri. Il file si scriveva senza errori e si rifiutava di aprirsi. Scrivere e poi
// rileggere con il nostro stesso lettore copre entrambi i lati.
const cartella = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-"));
const destinazione = path.join(cartella, "prova.xlsx");
writeWorkbook(destinazione, [
  {
    name: "Uno",
    rows: [
      [{ v: "Nome", style: "intestazione" }, { v: "Valore", style: "intestazione" }],
      ["Città accentata & <xml>", { v: 3.5, style: "decimale" }],
      ["", { v: 12, style: "intero" }],
    ],
    widths: [30, 12],
    freezeRow: 1,
  },
  { name: "Due: nome/impossibile", rows: [["ok"]] },
]);
const rilette = readSheet(destinazione, 0);
assert.deepEqual(rilette[0], ["Nome", "Valore"]);
assert.deepEqual(rilette[1], ["Città accentata & <xml>", "3.5"], "testo con entita' XML e numeri sopravvivono al giro");
// Una cella vuota all'inizio riga non deve far scivolare le colonne successive: Excel omette del
// tutto le celle vuote, e leggerle in sequenza metterebbe i valori sotto l'intestazione sbagliata.
assert.equal(rilette[2].length, 2);
assert.equal(rilette[2][1], "12");
assert.deepEqual(readSheet(destinazione, 1)[0], ["ok"]);
fs.rmSync(cartella, { recursive: true, force: true });

console.log("OK: asta fantacalcio — storico, abbinamento nomi, presenze, modificatore difesa, prezzi che chiudono sul montepremi, coppie dal modulo e giro completo xlsx");
