#!/usr/bin/env node
// Foglio per l'asta del fantacalcio, costruito dal modello di questo repo piu' le statistiche
// ufficiali della stagione conclusa.
//
//   node scripts/fantacalcio_asta.mjs --storico Statistiche_Fantacalcio_Stagione_2025_26.xlsx
//   node scripts/fantacalcio_asta.mjs --storico stats.xlsx --squadre 8 --budget 300
//
// DA DOVE VIENE OGNI NUMERO. Le tre fonti hanno affidabilita' diverse e il foglio le tiene
// separate invece di fonderle in un unico numero che non si puo' piu' interrogare:
//
//   1. Cosa ha fatto il giocatore: dallo storico Fantagazzetta. Presenze, media voto, gol,
//      assist, ammonizioni, rigori. Sono fatti, non stime.
//   2. Dove giochera' e quanto: dal dataset (rose ESPN 2026/27) — chi e' in rosa oggi e chi era
//      in campo all'ultima giornata.
//   3. Quanto rendera' quella squadra: dal modello, che prevede tutti i 380 accoppiamenti del
//      girone doppio. Da li' escono gol subiti e porte inviolate dei portieri, e il fattore con
//      cui i gol dell'anno scorso vanno riportati sull'attacco di quest'anno.
//
// Il voto base e' il Mv vero del giocatore quando lo storico c'e'. Senza storico resta 6.0
// dichiarato, perche' il dataset non contiene i voti (ESPN espone `rating: null`, difetto 15 di
// MISTAKES.md) e un foglio che stimasse la fantamedia senza i voti direbbe una cosa che non sa.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predictFromMatches, estimatePlayerMarkets } from "../model.js";
import { modelInputs } from "../prediction-inputs.js";
import { writeWorkbook, readSheet } from "./xlsx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GIORNATE = 38;

// Punteggi Fantagazzetta classici. Se la tua lega usa regole diverse, si cambiano QUI e tutto il
// foglio si ricalcola: nessun altro punto del codice conosce questi valori.
export const PUNTEGGI = Object.freeze({
  votoBase: 6,
  gol: 3,
  assist: 1,
  ammonizione: -0.5,
  espulsione: -1,
  autogol: -2,
  rigoreSbagliato: -3,
  rigoreParato: 3,     // solo portieri
  golSubito: -1,       // solo portieri
  imbattibilita: 1,    // solo portieri
});

// Modificatore di difesa, tabella classica Fantagazzetta: si applica quando si schierano almeno
// tre difensori, e si calcola sulla media dei VOTI (non dei fantavoti) di portiere piu' i tre
// difensori migliori.
//
// Perche' cambia l'asta: senza modificatore un difensore vale per i bonus, che sono pochi e
// rari; con il modificatore vale per la media voto, che ce l'hanno tutti tutte le domeniche. Un
// difensore da 6.3 di media e zero gol diventa piu' utile di uno da 5.9 con due gol.
export const MODIFICATORE_DIFESA = Object.freeze([
  { da: 7.0, punti: 6 },
  { da: 6.75, punti: 4 },
  { da: 6.5, punti: 3 },
  { da: 6.25, punti: 2 },
  { da: 6.0, punti: 1 },
  { da: 0, punti: 0 },
]);
export const modificatoreDifesa = (media) => MODIFICATORE_DIFESA.find((scaglione) => media >= scaglione.da).punti;

// Quanto vale, in punti a giornata, alzare di 1.0 la media della difesa. La tabella e' a scalini,
// quindi la pendenza si misura attorno alla media realistica di una difesa (~6.1) invece di
// derivare una funzione che non e' derivabile. Vale circa 4 punti per punto di media: diviso fra
// i quattro giocatori che compongono la media, ognuno ne porta un quarto.
export const pendenzaModificatore = (mediaRiferimento = 6.1) => (
  (modificatoreDifesa(mediaRiferimento + 0.25) - modificatoreDifesa(mediaRiferimento - 0.25)) / 0.5
);
export const GIOCATORI_NELLA_MEDIA_DIFESA = 4;

export const LEGA_DEFAULT = Object.freeze({
  squadre: 10,
  budget: 500,
  rosa: { P: 3, D: 8, C: 8, A: 6 },
  // Quanti se ne SCHIERANO (3-4-3): e' il termine di paragone del valore. Contro un portiere
  // titolare si schiera un altro portiere titolare, mai il proprio secondo — usare i posti in
  // rosa faceva uscire il primo portiere a un terzo del budget.
  titolari: { P: 1, D: 3, C: 4, A: 3 },
  // Quanta parte del budget va a ciascun ruolo. E' una scelta di strategia, non una deduzione: i
  // punti sopra il sostituto non sono confrontabili fra ruoli (un portiere non e' sostituibile da
  // un attaccante), e lasciando decidere al modello finiva tutto sulla porta, l'unico ruolo in
  // cui la varianza e' misurabile senza dati individuali.
  quoteRuolo: { P: 0.06, D: 0.14, C: 0.32, A: 0.48 },
  // Con il modificatore acceso la difesa rende di piu' e il mercato lo prezza: la quota di
  // budget si sposta su portiere e difensori. Resta una scelta di strategia dichiarata, non una
  // deduzione del modello.
  quoteRuoloModificatore: { P: 0.07, D: 0.18, C: 0.30, A: 0.45 },
  modificatore: true,
});

const RUOLO_DA_POSIZIONE = { GK: "P", DEF: "D", MID: "C", FWD: "A" };
export const roleOf = (position) => RUOLO_DA_POSIZIONE[String(position || "").toUpperCase()] || "C";
export const NOME_RUOLO = { P: "Portieri", D: "Difensori", C: "Centrocampisti", A: "Attaccanti" };

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const mediana = (valori) => {
  if (!valori.length) return 0;
  const ordinati = [...valori].sort((a, b) => a - b);
  const meta = Math.floor(ordinati.length / 2);
  return ordinati.length % 2 ? ordinati[meta] : (ordinati[meta - 1] + ordinati[meta]) / 2;
};

// --- Lettura dello storico --------------------------------------------------------------------

const COLONNE = {
  nome: ["nome", "giocatore", "calciatore", "name"],
  squadra: ["squadra", "team", "sq"],
  ruolo: ["r", "ruolo", "role"],
  ruoloMantra: ["rm", "ruolo mantra"],
  presenze: ["pv", "presenze", "partite"],
  votoMedio: ["mv", "media voto", "mediavoto", "voto medio"],
  fantamedia: ["fm", "fantamedia", "fanta media"],
  gol: ["gf", "gol", "goal", "gol fatti", "reti"],
  golSubiti: ["gs", "gol subiti"],
  rigoriParati: ["rp", "rigori parati"],
  rigoriSegnati: ["r+", "rigori segnati"],
  rigoriSbagliati: ["r-", "rigori sbagliati"],
  assist: ["ass", "assist", "as"],
  ammonizioni: ["amm", "ammonizioni", "gialli"],
  espulsioni: ["esp", "espulsioni", "rossi"],
  autogol: ["au", "autogol", "autoreti"],
};

// NFD scompone "é" in e + accento, ma NON tocca le lettere che sono un carattere proprio: ø, ł,
// đ, ß. Senza questa tabella "Hojlund" (Fantagazzetta) e "Højlund" (ESPN) restano due giocatori
// diversi, e la stessa cosa vale per Zielinski/Zieliński e per ogni scandinavo o polacco in
// Serie A. E' la stessa famiglia di difetti della normalizzazione dei nomi squadra.
const LETTERE_SPECIALI = { "\u00f8": "o", "\u0142": "l", "\u0111": "d", "\u00f0": "d", "\u00fe": "th", "\u00df": "ss", "\u00e6": "ae", "\u0153": "oe", "\u0131": "i", "\u0127": "h", "\u014b": "n" };
const senzaAccenti = (value) => String(value ?? "")
  .replace(/[\u00f8\u0142\u0111\u00f0\u00fe\u00df\u00e6\u0153\u0131\u0127\u014b]/gi, (lettera) => {
    const minuscola = LETTERE_SPECIALI[lettera.toLowerCase()] ?? lettera;
    return lettera === lettera.toLowerCase() ? minuscola : minuscola.toUpperCase();
  })
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export const parole = (value) => senzaAccenti(value).toUpperCase().replace(/[^A-Z]/g, " ").split(/\s+/).filter(Boolean);
const numero = (valore) => {
  const parsed = Number(String(valore ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Righe grezze (matrice di stringhe) → giocatori dello storico. Accetta xlsx e CSV. */
export function leggiStorico(righe) {
  // L'intestazione non e' la prima riga: l'export ha un titolo sopra. Si cerca per NOME delle
  // colonne, mai per posizione — la posizione cambia da un anno all'altro, e leggere la colonna
  // sbagliata produce numeri plausibili e falsi (MISTAKES.md 25).
  const normalizza = (campo) => senzaAccenti(campo).toLowerCase().trim();
  const indiceIntestazione = righe.findIndex((riga) => {
    const campi = riga.map(normalizza);
    return COLONNE.nome.some((alias) => campi.includes(alias)) && COLONNE.presenze.some((alias) => campi.includes(alias));
  });
  if (indiceIntestazione === -1) {
    throw new Error("Nel file non trovo un'intestazione con una colonna Nome e una colonna Pv (presenze).");
  }
  const intestazione = righe[indiceIntestazione].map(normalizza);
  const indice = {};
  for (const [campo, alias] of Object.entries(COLONNE)) {
    indice[campo] = intestazione.findIndex((testata) => alias.includes(testata));
  }
  const leggi = (campi, campo) => (indice[campo] >= 0 ? numero(campi[indice[campo]]) : 0);
  return righe.slice(indiceIntestazione + 1)
    .filter((campi) => campi[indice.nome])
    .map((campi) => ({
      nome: String(campi[indice.nome]).trim(),
      parole: parole(campi[indice.nome]),
      scomposto: null,   // riempito da preparaStorico: scomporre a ogni confronto costa 500x
      squadra: indice.squadra >= 0 ? String(campi[indice.squadra]).trim() : "",
      ruolo: indice.ruolo >= 0 ? String(campi[indice.ruolo] || "").toUpperCase().trim().slice(0, 1) : "",
      ruoloMantra: indice.ruoloMantra >= 0 ? String(campi[indice.ruoloMantra] || "").trim() : "",
      presenze: leggi(campi, "presenze"),
      votoMedio: leggi(campi, "votoMedio"),
      fantamedia: leggi(campi, "fantamedia"),
      gol: leggi(campi, "gol"),
      golSubiti: leggi(campi, "golSubiti"),
      rigoriParati: leggi(campi, "rigoriParati"),
      rigoriSegnati: leggi(campi, "rigoriSegnati"),
      rigoriSbagliati: leggi(campi, "rigoriSbagliati"),
      assist: leggi(campi, "assist"),
      ammonizioni: leggi(campi, "ammonizioni"),
      espulsioni: leggi(campi, "espulsioni"),
      autogol: leggi(campi, "autogol"),
    }))
    // Le righe con 0 presenze restano: dicono una cosa diversa da "non l'ho trovato" — era in
    // Serie A e non ha giocato — e vanno mostrate come tali invece di sparire.
    .map((riga) => ({ ...riga, scomposto: scomponi(riga.nome) }));
}

export const righeDaCsv = (testo) => {
  const righe = testo.split(/\r?\n/).filter((riga) => riga.trim());
  const separatore = (righe[0].match(/;/g) || []).length >= (righe[0].match(/,/g) || []).length ? ";" : ",";
  return righe.map((riga) => riga.split(separatore).map((campo) => campo.trim().replace(/^"|"$/g, "")));
};

/**
 * Abbina "M. Svilar" (ESPN) a "Svilar" (Fantagazzetta), e "V. Milinkovic-Savic" a
 * "Milinkovic-Savic V.".
 *
 * Le due fonti scrivono lo stesso giocatore in ordine opposto e con l'iniziale da lati diversi,
 * quindi non si confrontano stringhe: si confrontano INSIEMI di parole lunghe (il cognome, anche
 * composto) e, quando servono a distinguere, le iniziali. Un abbinamento sbagliato e' molto
 * peggio di uno mancato — assegnerebbe a un giocatore i numeri di un altro senza che nulla lo
 * segnali — quindi in caso di parita' si rinuncia e lo si dichiara nel foglio «Non abbinati».
 */
// "De", "Di", "Van"... non identificano nessuno: "De Marzi" combaciava con otto cognomi diversi
// e l'abbinamento veniva dichiarato ambiguo. Contano, ma solo come conferma.
const PARTICELLE = new Set(["DE", "DI", "DA", "DEL", "DELLA", "DELLE", "DOS", "DAS", "DU", "VAN", "VON", "DER", "DEN", "LA", "LO", "LE", "EL", "AL", "BIN", "IBN", "SAN", "SANTA"]);

const scomponi = (nome) => {
  const tutte = parole(nome);
  return {
    forti: tutte.filter((parola) => parola.length > 1 && !PARTICELLE.has(parola)),
    particelle: tutte.filter((parola) => PARTICELLE.has(parola)),
    iniziali: tutte.filter((parola) => parola.length === 1),
    compatto: tutte.filter((parola) => parola.length > 1).join(""),
  };
};

/**
 * Abbina "M. Svilar" (ESPN) a "Svilar" (Fantagazzetta), "V. Milinkovic-Savic" a
 * "Milinkovic-Savic V.", "E. Ndicka" a "N'Dicka" e "R. Hojlund" a "R. Højlund".
 *
 * Le due fonti scrivono lo stesso giocatore in ordine opposto, con l'iniziale da lati diversi, con
 * o senza apostrofo e con alfabeti diversi. Quindi non si confrontano stringhe: si confrontano
 * insiemi di parole significative, e in seconda battuta la forma compatta (tutte le lettere
 * attaccate), che e' l'unica a sopravvivere a un apostrofo messo o tolto.
 *
 * In caso di parita' si rinuncia: un abbinamento sbagliato assegnerebbe a un giocatore i numeri di
 * un altro senza che nulla lo segnali, ed e' molto peggio di un abbinamento mancato — che invece
 * finisce dichiarato nel foglio «Non abbinati».
 */
export function abbinaStorico(nomeEspn, candidati) {
  const mio = scomponi(nomeEspn);
  if (!mio.forti.length && !mio.compatto) return { esito: null, motivo: "nome vuoto" };
  const miePartiForti = new Set(mio.forti);
  const mieIniziali = new Set(mio.iniziali);

  let migliori = [];
  let punteggioMigliore = 0;
  for (const candidato of candidati) {
    const suo = candidato.scomposto || scomponi(candidato.nome);
    const sueIniziali = new Set(suo.iniziali);
    const comuni = suo.forti.filter((parola) => miePartiForti.has(parola));
    let punteggio = comuni.length * 10;
    let perFormaCompatta = false;
    if (!punteggio && mio.compatto.length >= 5 && suo.compatto.length >= 5
      && (mio.compatto === suo.compatto || mio.compatto.endsWith(suo.compatto) || suo.compatto.endsWith(mio.compatto))) {
      punteggio = 8; // abbinamento per forma compatta: piu' debole di un cognome intero uguale
      perFormaCompatta = true;
    }
    if (!punteggio) continue;
    // Iniziali dichiarate da entrambe le parti e incompatibili: sono due giocatori diversi con lo
    // stesso cognome — "M. Thuram" e "Thuram K." — non lo stesso scritto in due modi.
    //
    // Il veto vale pero' solo quando il cognome combacia per intero. Su un abbinamento per forma
    // compatta la lettera isolata non e' un'iniziale: in "N'Dicka" la N e' la prima lettera del
    // cognome, e l'apostrofo la stacca. Applicare il veto anche li' faceva rifiutare
    // "E. Ndicka" = "N'Dicka", cioe' proprio il caso che la forma compatta esiste per risolvere.
    if (!perFormaCompatta && mieIniziali.size && sueIniziali.size
      && ![...mieIniziali].some((iniziale) => sueIniziali.has(iniziale))) continue;
    if (comuni.length === suo.forti.length && comuni.length === miePartiForti.size) punteggio += 5;
    if (suo.particelle.some((particella) => mio.particelle.includes(particella))) punteggio += 3;
    if ([...mieIniziali].some((iniziale) => sueIniziali.has(iniziale))) punteggio += 2;

    if (punteggio > punteggioMigliore) {
      punteggioMigliore = punteggio;
      migliori = [candidato];
    } else if (punteggio === punteggioMigliore) {
      migliori.push(candidato);
    }
  }
  if (!migliori.length) return { esito: null, motivo: "cognome non trovato nello storico" };
  if (migliori.length > 1) return { esito: null, motivo: `${migliori.length} omonimi indistinguibili` };
  return { esito: migliori[0], motivo: "cognome + iniziale" };
}

// --- Proiezione ------------------------------------------------------------------------------

/**
 * Tassi per presenza dello storico. Separare "quanto rende quando gioca" da "quante volte gioca"
 * e' l'unico modo per proiettare un giocatore che cambia squadra o ruolo nella rosa.
 */
export function tassiStorici(storico) {
  const presenze = Math.max(1, storico.presenze);
  return {
    gol: storico.gol / presenze,
    assist: storico.assist / presenze,
    ammonizioni: storico.ammonizioni / presenze,
    espulsioni: storico.espulsioni / presenze,
    autogol: storico.autogol / presenze,
    rigoriSbagliati: storico.rigoriSbagliati / presenze,
    rigoriParati: storico.rigoriParati / presenze,
  };
}

/**
 * Proiezione 2026/27 di un giocatore.
 *
 * `tassi` sono per presenza (dallo storico, o la mediana del ruolo per chi lo storico non ce
 * l'ha). `squadra` porta la previsione del modello per la squadra in cui gioca OGGI: e' quella
 * che decide gol subiti e porte inviolate di un portiere, e il fattore `scalaAttacco` con cui i
 * gol dell'anno scorso vengono riportati sull'attacco di quest'anno.
 */
export function proiezione({ tassi, squadra, ruolo, votoBase, quotaPresenze, modificatore = null, punteggi = PUNTEGGI }) {
  const presenze = clamp(quotaPresenze, 0, 1) * GIORNATE;
  const scala = clamp(squadra.scalaAttacco ?? 1, 0.6, 1.6);
  const gol = tassi.gol * presenze * scala;
  const assist = tassi.assist * presenze * scala;
  const ammonizioni = tassi.ammonizioni * presenze;
  const espulsioni = tassi.espulsioni * presenze;
  const autogol = tassi.autogol * presenze;
  const rigoriSbagliati = tassi.rigoriSbagliati * presenze;
  const quota = presenze / GIORNATE;
  const rigoriParati = ruolo === "P" ? tassi.rigoriParati * presenze : 0;
  const golSubiti = ruolo === "P" ? squadra.golSubiti * quota : 0;
  const cleanSheet = ruolo === "P" ? squadra.cleanSheet * quota : 0;

  const bonus = punteggi.gol * gol
    + punteggi.assist * assist
    + punteggi.ammonizione * ammonizioni
    + punteggi.espulsione * espulsioni
    + punteggi.autogol * autogol
    + punteggi.rigoreSbagliato * rigoriSbagliati
    + punteggi.rigoreParato * rigoriParati
    + punteggi.golSubito * golSubiti
    + punteggi.imbattibilita * cleanSheet;
  // Il modificatore non e' un bonus del singolo: e' una proprieta' della difesa intera, e la
  // media a cui contribuisce e' fatta da quattro giocatori. Quindi si attribuisce il contributo
  // MARGINALE — di quanto quel giocatore alza la media rispetto al difensore che schiereresti al
  // suo posto — diviso il numero di giocatori che entrano nella media. Attribuirgli il
  // modificatore intero conterebbe lo stesso punto quattro volte.
  const contributoModificatore = (modificatore && (ruolo === "D" || ruolo === "P"))
    ? presenze * modificatore.pendenza * (votoBase - modificatore.votoRiferimento) / GIOCATORI_NELLA_MEDIA_DIFESA
    : 0;
  const fantapunti = presenze * votoBase + bonus + contributoModificatore;
  return {
    presenze, gol, assist, ammonizioni, espulsioni, autogol, rigoriParati, golSubiti, cleanSheet,
    bonusTotale: bonus,
    contributoModificatore,
    fantapunti,
    fantamedia: presenze > 0 ? fantapunti / presenze : 0,
  };
}

/**
 * Quante giornate giochera'.
 *
 * Due segnali, nessuno dei due sufficiente da solo: le presenze dell'anno scorso (un fatto, ma di
 * un'altra stagione e magari di un'altra squadra) e la titolarita' di oggi secondo ESPN (attuale,
 * ma letta sulle giornate finora giocate — a fine agosto una sola).
 *
 * Il peso del secondo cresce con le giornate viste, e a una giornata vale poco: pesarlo di piu'
 * faceva scendere Marcus Thuram a 22 presenze attese perche' era in panchina alla prima. Piu'
 * avanti nella stagione lo stesso comando dara' automaticamente piu' peso al presente, senza che
 * nessuno debba ritoccare un numero.
 */
export const pesoTitolaritaAttuale = (giornateViste) => clamp(0.12 + 0.5 * (giornateViste / GIORNATE), 0.12, 0.6);

// Un giocatore mai visto in Serie A e' un'incognita, non un titolare: anche se ha giocato la prima
// giornata, il campione che lo riguarda e' una partita. Senza questo sconto le riserve e i
// giovani senza storico proiettavano piu' presenze dei titolari veri, e finivano in cima alle
// liste delle coppie.
export const PRESENZE_IGNOTO = Object.freeze({ base: 0.15, perTitolarita: 0.45 });

export const quotaPresenzeAttese = (presenzeStoriche, playProbability, giornateViste = 1) => {
  if (!(presenzeStoriche > 0)) {
    return clamp(PRESENZE_IGNOTO.base + PRESENZE_IGNOTO.perTitolarita * playProbability, 0, 0.97);
  }
  const peso = pesoTitolaritaAttuale(giornateViste);
  return clamp((1 - peso) * (presenzeStoriche / GIORNATE) + peso * playProbability, 0, 0.97);
};

export function livelliDiSostituzione(giocatori, lega) {
  const livelli = {};
  for (const [ruolo, posti] of Object.entries(lega.titolari)) {
    const ordinati = giocatori.filter((g) => g.ruolo === ruolo)
      .sort((a, b) => b.proiezione.fantapunti - a.proiezione.fantapunti);
    const quanti = lega.squadre * posti;
    const intorno = ordinati.slice(Math.max(0, quanti - 2), quanti + 1);
    livelli[ruolo] = intorno.length
      ? intorno.reduce((sum, g) => sum + g.proiezione.fantapunti, 0) / intorno.length
      : 0;
  }
  return livelli;
}

/**
 * Da fantapunti a crediti. Dentro ogni ruolo il prezzo e' proporzionale ai punti sopra il
 * sostituto; fra i ruoli comandano le quote di budget. La somma chiude esattamente sui crediti
 * della lega: un listino che non chiude consiglia prezzi che nessuno potrebbe pagare tutti
 * insieme.
 */
// Quanto vale un giocatore da panchina rispetto a uno da titolare, per la sola formazione del
// prezzo. Un ottavo difensore non fa punti quasi mai, ma non costa nemmeno un credito come
// l'ultimo nome del listone: copre gli infortuni e le squalifiche, e all'asta si paga.
const PESO_PANCHINA = 0.25;

/**
 * Da fantapunti a crediti.
 *
 * Due livelli, perche' due sono le domande a cui il prezzo deve rispondere. «Quanto vale questo
 * giocatore quando lo schiero» si misura sopra l'ultimo TITOLARE del ruolo; «quanto vale averlo
 * in rosa» si misura sopra l'ultimo giocatore che verra' comprato. Con il solo primo livello i
 * cinquanta difensori sotto la soglia uscivano tutti a 1 credito esatto — vero che valgono poco,
 * falso che valgano tutti uguale, e all'asta quei prezzi non si vedono mai.
 *
 * Dentro ogni ruolo i crediti sono proporzionali a questo peso; fra i ruoli comandano le quote di
 * budget. La somma chiude esattamente sui crediti della lega: un listino che non chiude consiglia
 * prezzi che nessuno potrebbe pagare tutti insieme.
 */
export function assegnaCrediti(giocatori, lega) {
  const livelli = livelliDiSostituzione(giocatori, lega);
  for (const giocatore of giocatori) {
    giocatore.livelloSostituzione = livelli[giocatore.ruolo];
    giocatore.vorp = giocatore.proiezione.fantapunti - livelli[giocatore.ruolo];
    giocatore.crediti = 0;
  }
  const montepremi = lega.squadre * lega.budget;
  const acquistabili = [];
  for (const [ruolo, posti] of Object.entries(lega.rosa)) {
    const delRuolo = giocatori.filter((g) => g.ruolo === ruolo)
      .sort((a, b) => b.proiezione.fantapunti - a.proiezione.fantapunti)
      .slice(0, lega.squadre * posti);
    const livelloRosa = delRuolo.length ? delRuolo.at(-1).proiezione.fantapunti : 0;
    const peso = (g) => Math.max(0, g.vorp) + PESO_PANCHINA * Math.max(0, g.proiezione.fantapunti - livelloRosa);
    const budgetRuolo = montepremi * lega.quoteRuolo[ruolo];
    const distribuibile = Math.max(0, budgetRuolo - lega.squadre * posti);
    const sommaPesi = delRuolo.reduce((sum, g) => sum + peso(g), 0);
    for (const giocatore of delRuolo) {
      const quota = sommaPesi > 0 ? peso(giocatore) / sommaPesi : 1 / delRuolo.length;
      giocatore.crediti = 1 + quota * distribuibile;
      giocatore.strappo = giocatore.crediti * 1.15;
      giocatore.quotaBudget = giocatore.crediti / lega.budget;
    }
    acquistabili.push(...delRuolo);
  }
  return { livelli, acquistabili, montepremi };
}

// --- Squadre ----------------------------------------------------------------------------------

function squadreDiSerieA(payload) {
  const stagione = payload.latest_season;
  const nomi = new Set();
  for (const competizione of payload.competitions) {
    if (competizione.id !== "ita.1") continue;
    for (const fixture of competizione.fixtures) {
      if (String(fixture.season) !== String(stagione)) continue;
      nomi.add(fixture.home_team);
      nomi.add(fixture.away_team);
    }
  }
  return { stagione, squadre: [...nomi].sort() };
}

/** Giornate gia' giocate dalla squadra nella stagione in corso: e' quanto pesa il segnale
 * "titolare oggi" rispetto alle presenze dell'anno scorso. */
function giornateGiocate(payload, stagione) {
  const conteggio = new Map();
  for (const match of payload.matches) {
    if (match.competition_id !== "ita.1" || String(match.season) !== String(stagione)) continue;
    if (match.home_goals === null || match.home_goals === undefined) continue;
    for (const squadra of [match.home_team, match.away_team]) {
      conteggio.set(squadra, (conteggio.get(squadra) || 0) + 1);
    }
  }
  return conteggio;
}

/** Gol per partita segnati da ogni squadra nella stagione dello storico: e' il denominatore con
 * cui si riporta a oggi quanto un giocatore ha prodotto l'anno scorso. */
function attaccoStagionePrecedente(payload, stagione) {
  const somme = new Map();
  for (const match of payload.matches) {
    if (match.competition_id !== "ita.1" || String(match.season) !== String(stagione)) continue;
    if (match.home_goals === null || match.home_goals === undefined) continue;
    for (const [squadra, gol] of [[match.home_team, match.home_goals], [match.away_team, match.away_goals]]) {
      const voce = somme.get(squadra) || { gol: 0, partite: 0 };
      voce.gol += Number(gol);
      voce.partite += 1;
      somme.set(squadra, voce);
    }
  }
  const media = new Map();
  for (const [squadra, voce] of somme) media.set(squadra, voce.partite ? voce.gol / voce.partite : 0);
  return media;
}

/** Ogni squadra contro ogni altra, andata e ritorno: e' esattamente la stagione, e non richiede
 * il calendario — che il dataset conosce solo per le prossime giornate. */
function proiezioneSquadre(payload, squadre, data, stagione) {
  const stato = new Map(squadre.map((nome) => [nome, {
    nome, golFatti: 0, golSubiti: 0, cleanSheet: 0, puntiAttesi: 0, partite: 0, elo: 0, gf5: 0,
  }]));

  for (const casa of squadre) {
    for (const trasferta of squadre) {
      if (casa === trasferta) continue;
      const risultato = predictFromMatches(payload.matches, {
        ...modelInputs(),
        homeTeam: casa,
        awayTeam: trasferta,
        date: data,
        competitionId: "ita.1",
        season: stagione,
      });
      const { probabilities: p } = risultato;
      const inCasa = stato.get(casa);
      inCasa.golFatti += risultato.lambdaHome;
      inCasa.golSubiti += risultato.lambdaAway;
      inCasa.cleanSheet += p.scores.reduce((sum, s) => sum + (s.away === 0 ? s.probability : 0), 0);
      inCasa.puntiAttesi += 3 * p.homeWin + p.draw;
      inCasa.partite += 1;
      inCasa.elo = risultato.home.elo;
      inCasa.gf5 = risultato.home.gf5;

      const fuori = stato.get(trasferta);
      fuori.golFatti += risultato.lambdaAway;
      fuori.golSubiti += risultato.lambdaHome;
      fuori.cleanSheet += p.scores.reduce((sum, s) => sum + (s.home === 0 ? s.probability : 0), 0);
      fuori.puntiAttesi += 3 * p.awayWin + p.draw;
      fuori.partite += 1;
    }
  }

  const proiettate = [...stato.values()].map((squadra) => ({
    ...squadra,
    lambdaMedio: squadra.golFatti / squadra.partite,
  }));
  const perAttacco = [...proiettate].sort((a, b) => b.golFatti - a.golFatti);
  const perDifesa = [...proiettate].sort((a, b) => a.golSubiti - b.golSubiti);
  for (const squadra of proiettate) {
    squadra.rankAttacco = perAttacco.indexOf(squadra) + 1;
    squadra.rankDifesa = perDifesa.indexOf(squadra) + 1;
  }
  return proiettate;
}

export default {
  PUNTEGGI, LEGA_DEFAULT, GIORNATE, NOME_RUOLO, roleOf, parole, leggiStorico, righeDaCsv,
  abbinaStorico, tassiStorici, proiezione, quotaPresenzeAttese, livelliDiSostituzione, assegnaCrediti,
};

// --- Fogli --------------------------------------------------------------------------------

const testata = (etichette) => etichette.map((etichetta) => ({ v: etichetta, style: "intestazione" }));
const dec = (value) => ({ v: round(value, 2), style: "decimale" });
const intero = (value) => ({ v: Math.round(value), style: "intero" });
const pct = (value) => ({ v: round(value, 4), style: "percento" });
const nota = (value) => ({ v: value, style: "nota" });

const FASCE = [
  [80, "Top: uno da rosa"],
  [40, "Semi-top"],
  [15, "Fascia media"],
  [5, "Low cost utile"],
  [0, "Da 1-4 crediti"],
];
const fasciaDi = (crediti) => FASCE.find(([soglia]) => crediti >= soglia)[1];
// All'asta nessuno si porta a casa un giocatore gratis: il prezzo di una coppia e' la somma dei
// prezzi consigliati, ma con il minimo di un credito a testa.
const prezzo = (giocatore) => Math.max(1, giocatore.crediti);

function foglioRuolo(ruolo, giocatori) {
  const delRuolo = giocatori.filter((g) => g.ruolo === ruolo)
    .sort((a, b) => b.crediti - a.crediti || b.proiezione.fantapunti - a.proiezione.fantapunti);
  const portiere = ruolo === "P";
  const difesa = ruolo === "P" || ruolo === "D";
  const conModificatore = difesa && delRuolo.some((g) => g.proiezione.contributoModificatore);
  const intestazioni = [
    "Giocatore", "Squadra 26/27", "Crediti max", "Strappo", "% budget", "Fascia",
    "Fantapunti attesi", "Fantamedia attesa", "Presenze attese", "Gol attesi", "Assist attesi",
    ...(portiere ? ["Gol subiti attesi", "Porte inviolate attese", "Rigori parati attesi"] : ["Bonus attesi (gol+assist)"]),
    ...(conModificatore ? ["Punti dal modificatore difesa"] : []),
    "Titolare oggi", "25/26: squadra", "25/26: presenze", "25/26: voto medio", "25/26: fantamedia",
    "25/26: gol", "25/26: assist", "Ruolo Mantra", "Attendibilità", "Note",
  ];
  const righe = [testata(intestazioni)];
  for (const g of delRuolo) {
    const s = g.storico;
    righe.push([
      g.nome, g.squadra, intero(g.crediti), intero(g.strappo), pct(g.quotaBudget), fasciaDi(g.crediti),
      dec(g.proiezione.fantapunti), dec(g.proiezione.fantamedia), dec(g.proiezione.presenze),
      dec(g.proiezione.gol), dec(g.proiezione.assist),
      ...(portiere
        ? [dec(g.proiezione.golSubiti), dec(g.proiezione.cleanSheet), dec(g.proiezione.rigoriParati)]
        : [dec(PUNTEGGI.gol * g.proiezione.gol + PUNTEGGI.assist * g.proiezione.assist)]),
      ...(conModificatore ? [dec(g.proiezione.contributoModificatore)] : []),
      pct(g.markets.playProbability),
      s ? s.squadra : "—", s ? intero(s.presenze) : "—", s ? dec(s.votoMedio) : "—",
      s ? dec(s.fantamedia) : "—", s ? intero(s.gol) : "—", s ? intero(s.assist) : "—",
      s?.ruoloMantra || "—", g.attendibilita, g.note,
    ]);
  }
  return {
    name: NOME_RUOLO[ruolo],
    rows: righe,
    widths: [
      20, 14, 11, 9, 9, 18, 12, 12, 11, 10, 11,
      ...(portiere ? [12, 13, 12] : [13]),
      ...(conModificatore ? [14] : []),
      11, 13, 11, 11, 11, 9, 10, 11, 16, 40,
    ],
    freezeRow: 1,
    autoFilter: `A1:${String.fromCharCode(64 + intestazioni.length)}${righe.length}`,
  };
}

function foglioPorta(giocatori, squadre) {
  const perSquadra = new Map();
  for (const g of giocatori.filter((x) => x.ruolo === "P")) {
    if (!perSquadra.has(g.squadra)) perSquadra.set(g.squadra, []);
    perSquadra.get(g.squadra).push(g);
  }
  const coppie = [];
  for (const [squadra, portieri] of perSquadra) {
    const ordinati = portieri.sort((a, b) => b.proiezione.presenze - a.proiezione.presenze || b.crediti - a.crediti);
    const dati = squadre.find((s) => s.nome === squadra);
    const titolare = ordinati[0];
    const vice = ordinati[1];
    if (!titolare || !vice) continue;
    // Il valore della coppia e' la somma delle due proiezioni, non quella del solo titolare: si
    // schiera un portiere alla volta, ma le presenze dei due si sommano perche' sono
    // complementari — quando uno non gioca, gioca l'altro. Contare solo il titolare faceva
    // sembrare identiche una porta di un solo portiere e una divisa fra due, che per chi compra
    // sono cose molto diverse: la seconda vale meno e costa il doppio in slot.
    const valorePorta = titolare.proiezione.fantapunti + vice.proiezione.fantapunti;
    coppie.push({
      squadra, titolare, vice, terzo: ordinati[2]?.nome || "—",
      valorePorta,
      costo: prezzo(titolare) + prezzo(vice),
      presenzeCoppia: titolare.proiezione.presenze + vice.proiezione.presenze,
      cleanSheet: dati.cleanSheet, golSubiti: dati.golSubiti,
      dividePorta: titolare.proiezione.presenze < 26,
    });
  }
  coppie.sort((a, b) => b.valorePorta - a.valorePorta);
  const righe = [testata([
    "Squadra", "Titolare", "Vice", "Terzo in rosa", "Fantapunti della coppia",
    "Porte inviolate attese", "Gol subiti attesi", "Presenze attese del titolare",
    "Giornate coperte dalla coppia", "Costo della coppia", "Punti per credito", "Giudizio",
  ])];
  coppie.forEach((coppia, posizione) => {
    const giudizio = posizione < 3
      ? "Da prendere: la porta rende e il vice ti copre le assenze"
      : posizione < 8
        ? "Alternativa solida a meta' prezzo"
        : "Solo se hai finito i crediti: troppi gol subiti";
    righe.push([
      coppia.squadra, coppia.titolare.nome, coppia.vice.nome, coppia.terzo,
      dec(coppia.valorePorta), dec(coppia.cleanSheet), dec(coppia.golSubiti),
      dec(coppia.titolare.proiezione.presenze), dec(coppia.presenzeCoppia),
      intero(coppia.costo), dec(coppia.valorePorta / coppia.costo),
      coppia.dividePorta
        ? `${giudizio} — porta divisa fra i due: prendili entrambi o nessuno`
        : giudizio,
    ]);
  });
  return { name: "Porta (coppie)", rows: righe, widths: [14, 20, 20, 20, 15, 14, 14, 15, 16, 13, 12, 56], freezeRow: 1 };
}

/**
 * Coppie che si ALTERNANO davvero.
 *
 * La versione precedente accoppiava due giocatori qualunque dello stesso ruolo e della stessa
 * squadra: due titolari fissi, che non sono una coppia — sono due giocatori, e comprarli
 * entrambi non copre niente di piu' di quanto copra ciascuno. Qui la coppia deve soddisfare
 * tutte e tre le condizioni: nessuno dei due gioca sempre, insieme coprono quasi tutte le
 * giornate, e si contendono lo stesso posto (stesso ruolo, stessa squadra).
 */
/** Quanti giocatori per ruolo schiera una squadra, letto dal suo modulo ("3-5-2" → 3D, 5C, 2A). */
export function postiDaModulo(modulo) {
  const numeri = String(modulo || "").split("-").map(Number).filter(Number.isFinite);
  if (numeri.length < 3) return { P: 1, D: 4, C: 4, A: 2 };
  const [difensori, ...resto] = numeri;
  const attaccanti = resto.at(-1);
  const centrocampisti = resto.slice(0, -1).reduce((somma, valore) => somma + valore, 0);
  return { P: 1, D: difensori, C: centrocampisti, A: attaccanti };
}

/**
 * Coppie che si contendono lo stesso posto: un titolare non blindato e il suo vice.
 *
 * Il criterio decisivo e' il MODULO della squadra. La versione precedente accoppiava due
 * giocatori qualunque dello stesso ruolo, e proponeva Bastoni con Bisseck: due difensori che in
 * una difesa a tre giocano insieme tutte le domeniche, quindi non si alternano affatto —
 * comprarli entrambi non copre uno slot, ne occupa due. Qui i primi `posti` di ogni ruolo (dal
 * modulo che ESPN riporta per quella squadra) sono i titolari, e la coppia si forma solo fra un
 * titolare e chi sta appena FUORI dalla formazione, cioe' chi entra quando quello non c'e'.
 *
 * Chi gioca in quale giornata resta non ricostruibile: la pipeline non conserva le formazioni
 * partita per partita. Questo dice chi si divide il posto, non il calendario.
 */
export function coppieAlternate(giocatori, moduli, {
  massimoTitolare = 32, minimoTitolare = 20, minimoVice = 5, quante = 40, perGruppo = 2,
} = {}) {
  const gruppi = new Map();
  for (const g of giocatori) {
    if (g.ruolo === "P") continue;
    const chiave = `${g.squadra}|${g.ruolo}`;
    if (!gruppi.has(chiave)) gruppi.set(chiave, []);
    gruppi.get(chiave).push(g);
  }
  const coppie = [];
  for (const [chiave, membri] of gruppi) {
    const [squadra, ruolo] = chiave.split("|");
    const posti = postiDaModulo(moduli.get(squadra))[ruolo];
    const ordinati = [...membri].sort((a, b) => b.proiezione.presenze - a.proiezione.presenze);
    const titolari = ordinati.slice(0, posti);
    // Solo i due che stanno subito fuori: il terzo rincalzo non entra mai abbastanza da coprire.
    const riserve = ordinati.slice(posti, posti + 2);
    const delGruppo = [];
    for (const titolare of titolari) {
      if (titolare.proiezione.presenze > massimoTitolare) continue;
      // Il titolare dev'essere un giocatore CONOSCIUTO. Senza questo filtro la classifica si
      // riempiva di coppie da due crediti fra sconosciuti delle neopromosse: hanno il rapporto
      // punti/credito piu' alto solo perche' costano il minimo e i loro punti sono una mediana
      // di ruolo, cioe' un segnaposto messo al posto di un dato che non esiste.
      if (!titolare.storico || titolare.proiezione.presenze < minimoTitolare) continue;
      for (const vice of riserve) {
        if (vice.proiezione.presenze < minimoVice) continue;
        const mantraA = (titolare.storico?.ruoloMantra || "").split(";").map((x) => x.trim()).filter(Boolean);
        const mantraB = (vice.storico?.ruoloMantra || "").split(";").map((x) => x.trim()).filter(Boolean);
        if (mantraA.length && mantraB.length && !mantraA.some((x) => mantraB.includes(x))) continue;
        const costo = prezzo(titolare) + prezzo(vice);
        delGruppo.push({
          squadra, ruolo, modulo: moduli.get(squadra) || "?", a: titolare, b: vice,
          copertura: Math.min(1, (titolare.proiezione.presenze + vice.proiezione.presenze) / GIORNATE),
          punti: titolare.proiezione.fantapunti + vice.proiezione.fantapunti,
          costo,
        });
      }
    }
    // Lo stesso vice comparirebbe accanto a ognuno dei titolari del suo reparto: quattro righe
    // che dicono la stessa cosa. Si tengono le due migliori per reparto.
    coppie.push(...delGruppo.sort((x, y) => (y.punti / y.costo) - (x.punti / x.costo)).slice(0, perGruppo));
  }
  return coppie.sort((x, y) => (y.punti / y.costo) - (x.punti / x.costo)).slice(0, quante);
}

function foglioAlternanze(coppie) {
  const righe = [testata([
    "Squadra", "Modulo", "Ruolo", "Titolare", "Presenze attese", "Vice", "Presenze attese ",
    "Giornate coperte insieme", "Fantapunti sommati", "Costo della coppia", "Punti per credito",
  ])];
  for (const coppia of coppie) {
    righe.push([
      coppia.squadra, coppia.modulo, coppia.ruolo,
      coppia.a.nome, dec(coppia.a.proiezione.presenze),
      coppia.b.nome, dec(coppia.b.proiezione.presenze),
      pct(coppia.copertura), dec(coppia.punti), intero(coppia.costo),
      dec(coppia.punti / coppia.costo),
    ]);
  }
  if (righe.length === 1) {
    righe.push([nota("Nessuna coppia trovata con questi parametri: secondo presenze attese e formazioni recenti i titolari di ogni ruolo sono tutti fissi.")]);
  }
  righe.push([]);
  righe.push([nota(
    "Che cosa sono: due giocatori della stessa squadra che si contendono lo stesso posto — stesso "
    + "ruolo e, quando lo storico lo dice, stessa posizione Mantra — dove il primo non è un "
    + "titolare blindato e il secondo gioca abbastanza da coprirlo. Comprarli entrambi ti dà lo "
    + "slot coperto tutte le giornate spendendo poco più che per uno. Chi gioca in quale giornata "
    + "non è ricostruibile: la pipeline non conserva le formazioni partita per partita, quindi qui "
    + "trovi chi si divide il posto, non il calendario di chi scende in campo.",
  )]);
  return { name: "Alternanze", rows: righe, widths: [14, 9, 7, 20, 13, 20, 13, 16, 14, 13, 13], freezeRow: 1 };
}

function foglioSquadre(squadre) {
  const ordinate = [...squadre].sort((a, b) => b.puntiAttesi - a.puntiAttesi);
  const righe = [testata([
    "Squadra", "Punti attesi", "Gol fatti attesi", "Gol subiti attesi", "Porte inviolate attese",
    "Elo", "Rank attacco", "Rank difesa", "Reparto offensivo", "Porta e difesa",
  ])];
  for (const squadra of ordinate) {
    const attacco = squadra.rankAttacco <= 5
      ? "Sì: qui vale la pena spendere"
      : squadra.rankAttacco <= 12 ? "Solo il titolare, a prezzo giusto" : "Evita: pochi bonus da distribuire";
    const difesa = squadra.rankDifesa <= 5
      ? "Sì: portiere e difensori da prendere"
      : squadra.rankDifesa <= 12 ? "Difensori solo se costano poco" : "Evita il portiere: troppi gol subiti";
    righe.push([
      squadra.nome, dec(squadra.puntiAttesi), dec(squadra.golFatti), dec(squadra.golSubiti),
      dec(squadra.cleanSheet), intero(squadra.elo), intero(squadra.rankAttacco), intero(squadra.rankDifesa),
      attacco, difesa,
    ]);
  }
  return { name: "Squadre", rows: righe, widths: [16, 12, 13, 14, 15, 8, 10, 10, 34, 34], freezeRow: 1 };
}

function foglioScommesse(giocatori, squadre) {
  const deboli = new Set([...squadre].sort((a, b) => b.puntiAttesi - a.puntiAttesi).slice(10).map((s) => s.nome));
  const candidati = giocatori
    .filter((g) => deboli.has(g.squadra) && g.crediti >= 1 && g.crediti <= 25 && g.proiezione.presenze >= 20)
    .sort((a, b) => (b.proiezione.fantapunti / b.crediti) - (a.proiezione.fantapunti / a.crediti))
    .slice(0, 45);
  const righe = [testata([
    "Giocatore", "Squadra", "Ruolo", "Crediti max", "Fantapunti attesi", "Punti per credito",
    "Presenze attese", "25/26: gol+assist", "Perché",
  ])];
  for (const g of candidati) {
    const bonusScorsi = g.storico ? g.storico.gol + g.storico.assist : null;
    righe.push([
      g.nome, g.squadra, g.ruolo, intero(g.crediti), dec(g.proiezione.fantapunti),
      dec(g.proiezione.fantapunti / g.crediti), dec(g.proiezione.presenze),
      bonusScorsi === null ? "—" : intero(bonusScorsi),
      bonusScorsi
        ? "Ha già portato bonus in una squadra che il modello dà indietro: costa poco perché la squadra è scarsa, non perché lo sia lui"
        : "Presenze quasi garantite a costo minimo: riempie uno slot senza toglierti crediti",
    ]);
  }
  return { name: "Scommesse", rows: righe, widths: [22, 14, 7, 11, 14, 13, 13, 14, 66], freezeRow: 1 };
}

function foglioLeggimi(contesto) {
  return {
    name: "Leggimi",
    widths: [140],
    rows: [
      [{ v: `Asta fantacalcio ${contesto.stagioneEtichetta}`, style: "titolo" }],
      [],
      [{ v: "L'ordine in cui usarlo", style: "grassetto" }],
      [nota("1. «Squadre»: decide da quali difese prendere portiere e difensori, e quali attacchi vale la pena pagare. È la parte più solida del foglio — viene dal modello, non da opinioni.")],
      [nota("2. «Porta (coppie)»: prendi la coppia titolare+vice della stessa squadra, così ogni giornata hai il portiere che gioca. Sono ordinate per valore della porta, cioè porte inviolate meno gol subiti, non per fama del portiere.")],
      [nota("3. I quattro fogli per ruolo — Portieri, Difensori, Centrocampisti, Attaccanti — sono il listone vero e proprio. «Crediti max» è quanto puoi spendere senza sbilanciare la rosa; «Strappo» (+15%) è il massimo che ha ancora senso pagare per uno che vuoi davvero.")],
      [nota("4. «Alternanze»: coppie che si dividono lo stesso posto. Comprarle entrambe copre tutte le giornate spendendo come per un titolare solo.")],
      [nota("5. «Scommesse» a fine asta, quando restano pochi crediti e tanti slot vuoti.")],
      [],
      [{ v: "Da dove viene ogni numero", style: "grassetto" }],
      [nota(`Cosa ha fatto il giocatore: dallo storico ${contesto.storicoNome} — presenze, media voto, gol, assist, ammonizioni, rigori della stagione ${contesto.stagioneStorico}. Sono fatti. ${contesto.abbinati} giocatori su ${contesto.totaleGiocatori} sono stati abbinati; per gli altri (foglio «Non abbinati») si usa la mediana del loro ruolo, e la colonna «Attendibilità» lo dice riga per riga.`)],
      [nota(`Quanto renderà la sua squadra: dal modello, che ha previsto i ${contesto.partite} accoppiamenti del girone doppio alla data ${contesto.data}. Da lì escono i gol subiti e le porte inviolate dei portieri, e il fattore con cui i gol dell'anno scorso vengono riportati sull'attacco di quest'anno (un attaccante che passa a una squadra che segna di più vale di più).`)],
      [nota(`Quante giornate giocherà: 65% dalle presenze dell'anno scorso, 35% dalla titolarità di oggi secondo le formazioni ESPN (aggiornate al ${contesto.asOf}). Nessuno dei due segnali basta da solo: il primo è un fatto ma di un'altra stagione, il secondo è attuale ma letto su pochissime giornate.`)],
      [nota(`Prezzo: valore sopra il sostituto, dove il sostituto è l'ultimo TITOLARE del ruolo (${contesto.lega.squadre} squadre × ${contesto.lega.titolari.P}P/${contesto.lega.titolari.D}D/${contesto.lega.titolari.C}C/${contesto.lega.titolari.A}A schierati). Dentro ogni ruolo i crediti sono proporzionali a quel valore; fra i ruoli comandano le quote di budget (${Math.round(contesto.lega.quoteRuolo.P * 100)}% P, ${Math.round(contesto.lega.quoteRuolo.D * 100)}% D, ${Math.round(contesto.lega.quoteRuolo.C * 100)}% C, ${Math.round(contesto.lega.quoteRuolo.A * 100)}% A). La somma dei prezzi consigliati fa esattamente i ${contesto.montepremi} crediti della lega: se paghi sopra il consigliato, quei crediti li stai togliendo a un altro tuo slot.`)],
      [],
      [nota(contesto.modificatore
        ? `Modificatore di difesa ATTIVO. Si applica alla media dei voti di portiere + i tre difensori migliori, e vale fino a ${MODIFICATORE_DIFESA[0].punti} punti a giornata. Nel foglio ogni difensore e portiere ha una colonna «Punti dal modificatore difesa»: è il contributo MARGINALE del suo voto medio rispetto al difensore da ${round(contesto.modificatore.votoRiferimento, 2)} che schiereresti al suo posto, diviso i quattro giocatori che compongono la media. È già dentro i fantapunti e quindi dentro il prezzo. In pratica: con il modificatore un difensore da 6.3 di media e zero gol vale più di uno da 5.9 con due gol, ed è il motivo per cui la quota di budget della difesa qui è più alta del solito.`
        : "Modificatore di difesa SPENTO (--senza-modificatore): i difensori valgono solo per i bonus.")],
      [],
      [{ v: "Limiti — leggili prima di fidarti di una riga", style: "grassetto" }],
      [nota(`Le rose sono quelle viste da ESPN al ${contesto.asOf}: un acquisto di mercato successivo non c'è, e chi ha cambiato squadra dopo quella data è ancora nella vecchia. Controlla anche che le 20 squadre del foglio «Squadre» siano davvero quelle della Serie A ${contesto.stagioneEtichetta}.`)],
      [nota(`I giocatori che l'anno scorso non erano in Serie A (neopromosse, arrivi dall'estero) non hanno storico: prendono la mediana del loro ruolo e la colonna «Attendibilità» segna «nessun dato ${contesto.stagioneStorico}». Non è una stima del loro valore, è un segnaposto — trattali come incognite, non come giocatori medi.`)],
      [nota("Non c'è il modificatore di difesa, non ci sono i rigoristi designati, e i ruoli Mantra sono riportati dallo storico ma non usati nei calcoli: nessuna delle tre informazioni è ricostruibile dai dati che il progetto ha. Se la tua lega usa il modificatore, i difensori delle prime tre difese valgono più di quanto scritto qui.")],
      [nota("Il gol subito e la porta inviolata di un portiere vengono dalla difesa prevista per la sua squadra QUEST'ANNO, non dai gol che ha subito l'anno scorso: è la correzione che conta di più per chi ha cambiato squadra o per una difesa che si è rinforzata.")],
      [nota(`Punteggi usati: gol ${PUNTEGGI.gol}, assist ${PUNTEGGI.assist}, ammonizione ${PUNTEGGI.ammonizione}, espulsione ${PUNTEGGI.espulsione}, autogol ${PUNTEGGI.autogol}, rigore sbagliato ${PUNTEGGI.rigoreSbagliato}, rigore parato ${PUNTEGGI.rigoreParato}, gol subito ${PUNTEGGI.golSubito}, porta inviolata ${PUNTEGGI.imbattibilita}. Se la tua lega usa regole diverse si cambiano in cima a scripts/fantacalcio_asta.mjs e si rigenera il foglio.`)],
    ],
  };
}

function foglioParametri(contesto) {
  return {
    name: "Parametri",
    widths: [32, 34],
    rows: [
      [{ v: "Parametri usati", style: "titolo" }],
      [],
      [{ v: "Punteggi", style: "grassetto" }, ""],
      ...Object.entries(PUNTEGGI).map(([chiave, valore]) => [chiave, dec(valore)]),
      [],
      [{ v: "Lega", style: "grassetto" }, ""],
      ["squadre", intero(contesto.lega.squadre)],
      ["budget per squadra", intero(contesto.lega.budget)],
      ["rosa comprata", `${contesto.lega.rosa.P}P / ${contesto.lega.rosa.D}D / ${contesto.lega.rosa.C}C / ${contesto.lega.rosa.A}A`],
      ["titolari schierati", `${contesto.lega.titolari.P}P / ${contesto.lega.titolari.D}D / ${contesto.lega.titolari.C}C / ${contesto.lega.titolari.A}A (3-4-3)`],
      ["quote di budget per ruolo", `${Math.round(contesto.lega.quoteRuolo.P * 100)}% P / ${Math.round(contesto.lega.quoteRuolo.D * 100)}% D / ${Math.round(contesto.lega.quoteRuolo.C * 100)}% C / ${Math.round(contesto.lega.quoteRuolo.A * 100)}% A`],
      ["crediti totali della lega", intero(contesto.montepremi)],
      ["modificatore di difesa", contesto.modificatore ? "attivo" : "spento"],
      ...(contesto.modificatore ? [
        ["voto di riferimento della difesa", dec(contesto.modificatore.votoRiferimento)],
        ["punti per 1.0 di media difesa", dec(contesto.modificatore.pendenza)],
        ...MODIFICATORE_DIFESA.filter((scaglione) => scaglione.punti > 0)
          .map((scaglione) => [`media difesa da ${scaglione.da}`, intero(scaglione.punti)]),
      ] : []),
      [],
      [{ v: "Dati", style: "grassetto" }, ""],
      ["dataset generato il", contesto.generatedAt],
      ["rose aggiornate al", contesto.asOf],
      ["data della previsione", contesto.data],
      ["accoppiamenti previsti", intero(contesto.partite)],
      ["storico", contesto.storicoNome],
      ["giocatori abbinati allo storico", `${contesto.abbinati} su ${contesto.totaleGiocatori}`],
      ["versione modello", contesto.modelVersion],
    ],
  };
}

function foglioNonAbbinati(nonAbbinati) {
  const righe = [testata(["Giocatore (rosa 26/27)", "Squadra", "Ruolo", "Perché non abbinato", "Conseguenza"])];
  for (const voce of nonAbbinati) {
    righe.push([voce.nome, voce.squadra, voce.ruolo, voce.motivo,
      "Usata la mediana del ruolo: trattalo come un'incognita, non come un giocatore medio"]);
  }
  return { name: "Non abbinati", rows: righe, widths: [24, 14, 7, 34, 56], freezeRow: 1 };
}

// --- Esecuzione -------------------------------------------------------------------------------

function argomenti(argv) {
  const valore = (nome, predefinito) => {
    const indice = argv.indexOf(`--${nome}`);
    return indice >= 0 && argv[indice + 1] ? argv[indice + 1] : predefinito;
  };
  const lega = {
    squadre: Number(valore("squadre", LEGA_DEFAULT.squadre)),
    budget: Number(valore("budget", LEGA_DEFAULT.budget)),
    rosa: { ...LEGA_DEFAULT.rosa },
    titolari: { ...LEGA_DEFAULT.titolari },
    quoteRuolo: { ...LEGA_DEFAULT.quoteRuolo },
  };
  if (!Number.isInteger(lega.squadre) || lega.squadre < 2) throw new Error("--squadre deve essere un intero >= 2");
  if (!Number.isFinite(lega.budget) || lega.budget <= 0) throw new Error("--budget deve essere un numero positivo");
  lega.modificatore = !argv.includes("--senza-modificatore");
  if (lega.modificatore) lega.quoteRuolo = { ...LEGA_DEFAULT.quoteRuoloModificatore };
  return { lega, storico: valore("storico", null), out: valore("out", null) };
}

function caricaStorico(percorso) {
  if (!percorso) return [];
  const righe = percorso.toLowerCase().endsWith(".csv")
    ? righeDaCsv(fs.readFileSync(percorso, "utf8"))
    : readSheet(percorso, 0);
  return leggiStorico(righe);
}

function main(argv) {
  const { lega, storico: percorsoStorico, out } = argomenti(argv);
  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "matches.json"), "utf8"));
  const { stagione, squadre: nomiSquadre } = squadreDiSerieA(payload);
  const stagioneEtichetta = `20${String(stagione).slice(0, 2)}/${String(stagione).slice(2)}`;
  const precedente = String(Number(stagione) - 101);
  const stagioneStorico = `20${precedente.slice(0, 2)}/${precedente.slice(2)}`;
  const data = new Date().toISOString().slice(0, 10);

  console.log(`Serie A ${stagioneEtichetta}: ${nomiSquadre.length} squadre — ${nomiSquadre.join(", ")}`);
  console.log(`Prevedo ${nomiSquadre.length * (nomiSquadre.length - 1)} accoppiamenti (girone doppio)…`);
  const squadre = proiezioneSquadre(payload, nomiSquadre, data, stagione);
  const attaccoPrecedente = attaccoStagionePrecedente(payload, precedente);
  const giornateViste = giornateGiocate(payload, stagione);
  const mediaLega = mediana([...attaccoPrecedente.values()]) || 1.3;

  const righeStorico = caricaStorico(percorsoStorico);
  if (percorsoStorico) console.log(`Storico: ${righeStorico.length} giocatori da ${path.basename(percorsoStorico)}.`);

  // Prima passata: rose ed elenco dei giocatori, senza ancora abbinare.
  const giocatori = [];
  const nonAbbinati = [];
  const moduli = new Map();
  let asOf = "";
  for (const squadra of squadre) {
    const contesto = payload.player_context?.[squadra.nome];
    if (!contesto?.players?.length) {
      console.warn(`Nessuna rosa per ${squadra.nome}: resta nel foglio «Squadre» ma senza giocatori.`);
      continue;
    }
    asOf = asOf && asOf > contesto.as_of ? asOf : contesto.as_of;
    moduli.set(squadra.nome, contesto.formation);
    for (const player of contesto.players) {
      giocatori.push({
        nome: player.name,
        squadra: squadra.nome,
        posizioneEspn: player.position,
        markets: estimatePlayerMarkets(player, squadra.lambdaMedio, squadra.gf5),
        squadraDati: squadra,
        storico: null,
      });
    }
  }

  // Abbinamento in DUE fasi, e l'ordine e' la cosa che conta.
  //
  // Fase 1, dentro la stessa squadra: se un giocatore e' rimasto dov'era, e' li' che si trova, e
  // quell'abbinamento e' il piu' sicuro che esista. La riga di storico cosi' usata viene
  // "occupata".
  // Fase 2, in tutto il campionato, ma SOLO sulle righe rimaste libere: serve a chi ha cambiato
  // maglia — nello storico sta sotto la squadra vecchia — senza poter rubare l'identita' di un
  // giocatore che invece e' rimasto dov'era.
  //
  // Senza la fase 2 vincolata alle righe libere, il difetto e' reale e l'ho misurato: il Venezia
  // ha in rosa un "A. Rrahmani" che non e' Amir Rrahmani, e si prendeva le statistiche del
  // difensore del Napoli — che nel frattempo era regolarmente abbinato al Napoli. Due giocatori,
  // una sola identita', nessun errore sollevato.
  const occupate = new Set();
  if (righeStorico.length) {
    const perSquadra = new Map();
    for (const riga of righeStorico) {
      const chiave = parole(riga.squadra).join(" ");
      if (!perSquadra.has(chiave)) perSquadra.set(chiave, []);
      perSquadra.get(chiave).push(riga);
    }
    for (const g of giocatori) {
      const compagni = perSquadra.get(parole(g.squadra).join(" ")) || [];
      const { esito } = abbinaStorico(g.nome, compagni);
      if (esito && !occupate.has(esito)) {
        g.storico = esito;
        g.motivoAbbinamento = "stessa squadra";
        occupate.add(esito);
      }
    }
    // Una riga libera contesa da due giocatori di squadre diverse non va assegnata a nessuno dei
    // due: chi arriva prima nell'array non ha piu' diritto dell'altro.
    const pretendenti = new Map();
    for (const g of giocatori) {
      if (g.storico) continue;
      const { esito, motivo } = abbinaStorico(g.nome, righeStorico.filter((riga) => !occupate.has(riga)));
      g.candidato = esito;
      g.motivoAbbinamento = motivo;
      if (esito) pretendenti.set(esito, [...(pretendenti.get(esito) || []), g]);
    }
    for (const [riga, quali] of pretendenti) {
      if (quali.length === 1) {
        quali[0].storico = riga;
        quali[0].motivoAbbinamento = "cambio squadra";
      } else {
        for (const g of quali) g.motivoAbbinamento = `conteso da ${quali.length} giocatori di squadre diverse`;
      }
    }
  }

  for (const g of giocatori) {
    // Il ruolo lo decide Fantagazzetta, non ESPN. All'asta si compra per ruolo, e i due sistemi
    // non concordano: Dimarco per ESPN e' un centrocampista, al fantacalcio e' un difensore —
    // comprarlo dalla lista sbagliata significa non poterlo schierare.
    g.ruolo = g.storico && "PDCA".includes(g.storico.ruolo) ? g.storico.ruolo : roleOf(g.posizioneEspn);
    g.ruoloDaStorico = Boolean(g.storico && "PDCA".includes(g.storico.ruolo));
    g.cambioSquadra = Boolean(g.storico && parole(g.storico.squadra).join(" ") !== parole(g.squadra).join(" "));
    if (righeStorico.length && !g.storico) {
      nonAbbinati.push({ nome: g.nome, squadra: g.squadra, ruolo: g.ruolo, motivo: g.motivoAbbinamento || "cognome non trovato nello storico" });
    }
  }

  // Mediana dei tassi per ruolo, calcolata SOLO sui giocatori con storico e con almeno mezza
  // stagione alle spalle: e' il segnaposto per chi in Serie A non c'era. Calcolarla su tutti
  // includerebbe i segnaposto stessi, cioe' se stessa.
  const perRuolo = (ruolo) => giocatori.filter((g) => g.ruolo === ruolo && g.storico && g.storico.presenze >= 19);
  const medianeRuolo = {};
  for (const ruolo of ["P", "D", "C", "A"]) {
    const campione = perRuolo(ruolo).map((g) => ({ tassi: tassiStorici(g.storico), voto: g.storico.votoMedio }));
    medianeRuolo[ruolo] = {
      tassi: {
        gol: mediana(campione.map((c) => c.tassi.gol)),
        assist: mediana(campione.map((c) => c.tassi.assist)),
        ammonizioni: mediana(campione.map((c) => c.tassi.ammonizioni)),
        espulsioni: mediana(campione.map((c) => c.tassi.espulsioni)),
        autogol: mediana(campione.map((c) => c.tassi.autogol)),
        rigoriSbagliati: mediana(campione.map((c) => c.tassi.rigoriSbagliati)),
        rigoriParati: mediana(campione.map((c) => c.tassi.rigoriParati)),
      },
      voto: mediana(campione.map((c) => c.voto)) || PUNTEGGI.votoBase,
    };
  }

  // Il termine di paragone del modificatore: la media voto del difensore che schiereresti se non
  // prendessi questo. Si legge dai difensori titolari veri, non da tutti — includere le riserve
  // abbasserebbe il riferimento e farebbe sembrare tutti sopra la media.
  const votiDifensoriTitolari = giocatori
    .filter((g) => g.ruolo === "D" && g.storico && g.storico.presenze >= 19 && g.storico.votoMedio > 0)
    .map((g) => g.storico.votoMedio);
  const votoRiferimento = mediana(votiDifensoriTitolari) || PUNTEGGI.votoBase;
  const modificatore = lega.modificatore
    ? { votoRiferimento, pendenza: pendenzaModificatore(votoRiferimento) }
    : null;

  // Le presenze si calcolano PRIMA della proiezione, perche' vanno corrette insieme: in una
  // squadra c'e' una sola porta, e due portieri che l'anno scorso hanno giocato 38 partite
  // ciascuno in due squadre diverse non possono giocarne 38 a testa quest'anno. Senza questo
  // vincolo il Como usciva con Butez e Audero a 36 presenze l'uno, cioe' una coppia da 60
  // giornate su 38 disponibili — e il valore della coppia ne risultava gonfiato di un terzo.
  for (const g of giocatori) {
    g.conTassi = Boolean(g.storico && g.storico.presenze >= 1);
    g.quotaPresenze = quotaPresenzeAttese(
      g.conTassi ? g.storico.presenze : 0,
      g.markets.playProbability,
      giornateViste.get(g.squadra) || 1,
    );
  }
  for (const squadra of squadre) {
    const portieri = giocatori.filter((g) => g.ruolo === "P" && g.squadra === squadra.nome);
    const totale = portieri.reduce((somma, g) => somma + g.quotaPresenze, 0);
    if (totale <= 1) continue;
    // Le 38 giornate si dividono in proporzione a quota x titolarita' di oggi: chi era in campo
    // all'ultima giornata si prende la parte grossa, invece di spartire a meta' fra due ex
    // titolari di squadre diverse.
    const pesi = portieri.map((g) => Math.max(1e-6, g.quotaPresenze * Math.max(0.05, g.markets.playProbability)));
    const sommaPesi = pesi.reduce((somma, peso) => somma + peso, 0);
    portieri.forEach((g, indice) => { g.quotaPresenze = pesi[indice] / sommaPesi; });
  }

  // Seconda passata: proiezione.
  for (const g of giocatori) {
    const mediano = medianeRuolo[g.ruolo];
    // Zero presenze non e' un tasso pari a zero: e' assenza di informazione, e va trattata come
    // tale. E' lo stesso errore dei minuti dei giocatori (difetto 10 di MISTAKES.md), dove un
    // dato mancante diventava uno 0% mostrato come previsione.
    const conTassi = g.conTassi;
    const tassi = conTassi ? tassiStorici(g.storico) : mediano.tassi;
    const votoBase = (conTassi && g.storico.votoMedio) ? g.storico.votoMedio : mediano.voto;
    // L'attacco della squadra in cui gioca OGGI contro quello della squadra in cui ha prodotto
    // quei numeri: e' la correzione che serve a chi ha cambiato maglia.
    const attaccoVecchio = conTassi ? (attaccoPrecedente.get(g.storico.squadra) ?? mediaLega) : mediaLega;
    const squadraConScala = {
      ...g.squadraDati,
      scalaAttacco: attaccoVecchio > 0 ? g.squadraDati.lambdaMedio / attaccoVecchio : 1,
    };
    g.proiezione = proiezione({
      tassi,
      squadra: squadraConScala,
      ruolo: g.ruolo,
      votoBase,
      quotaPresenze: g.quotaPresenze,
      modificatore,
    });
    g.attendibilita = !conTassi
      ? (g.storico ? `0 presenze nel ${stagioneStorico}` : `nessun dato ${stagioneStorico}`)
      : g.storico.presenze >= 25 ? "alta (stagione piena)"
        : g.storico.presenze >= 12 ? "media (mezza stagione)" : "bassa (poche presenze)";
    g.note = [
      g.cambioSquadra ? `Era al ${g.storico.squadra}: gol e assist riscalati sull'attacco nuovo` : "",
      !g.storico ? "Non era in Serie A: numeri da mediana di ruolo, incognita vera" : "",
      g.storico && !conTassi ? "In rosa ma mai in campo l'anno scorso: nessun tasso individuale" : "",
      g.ruoloDaStorico ? "" : "Ruolo da ESPN, non da Fantagazzetta: verifica in che lista sta all'asta",
      g.markets.playProbability >= 0.6 ? "In campo all'ultima giornata" : "",
    ].filter(Boolean).join(" · ") || "—";
  }

  const { montepremi } = assegnaCrediti(giocatori, lega);

  const contesto = {
    lega, montepremi, data, asOf: asOf || "sconosciuta", stagioneEtichetta, stagioneStorico,
    partite: nomiSquadre.length * (nomiSquadre.length - 1),
    generatedAt: payload.generated_at,
    modelVersion: "6.0-shrunk-asymmetry",
    storicoNome: percorsoStorico ? path.basename(percorsoStorico) : "nessuno (voto base 6.0 per tutti)",
    abbinati: giocatori.filter((g) => g.storico).length,
    totaleGiocatori: giocatori.length,
    modificatore,
  };

  const fogli = [
    foglioLeggimi(contesto),
    ...["A", "C", "D", "P"].map((ruolo) => foglioRuolo(ruolo, giocatori)),
    foglioPorta(giocatori, squadre),
    foglioAlternanze(coppieAlternate(giocatori, moduli)),
    foglioSquadre(squadre),
    foglioScommesse(giocatori, squadre),
    foglioParametri(contesto),
  ];
  if (nonAbbinati.length) fogli.push(foglioNonAbbinati(nonAbbinati));

  const destinazione = path.resolve(out || path.join(ROOT, `asta-fantacalcio-${stagioneEtichetta.replace("/", "-")}.xlsx`));
  writeWorkbook(destinazione, fogli);
  console.log(`${giocatori.length} giocatori valutati (${contesto.abbinati} con storico), ${squadre.length} squadre.`);
  console.log(`Somma dei prezzi consigliati: ${Math.round(giocatori.reduce((s, g) => s + g.crediti, 0))} crediti su ${montepremi}.`);
  console.log(`Scritto: ${destinazione}`);
  return destinazione;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
