import assert from "node:assert/strict";
import {
  readCachedOdds, writeCachedOdds, clearOddsCache, oddsCacheStatus,
  leagueOddsKey, eventOddsKey, ODDS_CACHE_STORAGE, DEFAULT_TTL_MINUTES,
} from "../odds-cache.js";

// Storage finto iniettabile: la cache deve essere verificabile senza browser, e il caso
// "storage pieno" va provocato apposta perche' e' quello in cui una cache mal scritta rompe la
// funzione che dovrebbe accelerare.
function fakeStorage({ maxBytes = Infinity } = {}) {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (String(value).length > maxBytes) {
        const error = new Error("QuotaExceededError");
        error.name = "QuotaExceededError";
        throw error;
      }
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
    get size() { return map.size; },
  };
}

const MINUTE = 60000;
const storage = fakeStorage();
const key = leagueOddsKey("soccer_italy_serie_a", 3, ["h2h", "totals"]);

// --- la voce si rilegge, e porta con se' la propria eta' -------------------------------------
assert.equal(readCachedOdds(key, { storage }), null, "cache vuota: nessuna voce");
writeCachedOdds(key, [{ id: "evento-1" }], { storage, now: 1_000 * MINUTE });
const hit = readCachedOdds(key, { storage, now: 1_010 * MINUTE });
assert.deepEqual(hit.value, [{ id: "evento-1" }]);
assert.equal(Math.round(hit.ageMinutes), 10, "l'eta' va restituita: e' cio' che l'interfaccia dichiara");

// --- la scadenza esiste, ed e' il punto -------------------------------------------------------
// Una quota vecchia non e' una quota mancante: e' un prezzo sbagliato che la schedina userebbe
// come vero. Oltre il TTL la voce deve sparire, non essere servita "meglio di niente".
assert.ok(readCachedOdds(key, { storage, now: (1_000 + DEFAULT_TTL_MINUTES - 1) * MINUTE }));
assert.equal(readCachedOdds(key, { storage, now: (1_000 + DEFAULT_TTL_MINUTES + 1) * MINUTE }), null);
// Orologio spostato all'indietro (fuso, sincronizzazione): una voce "dal futuro" non e' valida.
assert.equal(readCachedOdds(key, { storage, now: 900 * MINUTE }), null);

// --- la chiave distingue cio' che va distinto -------------------------------------------------
// Il turno fa parte della chiave: senza, la seconda generazione servirebbe le quote della
// giornata precedente, che sono quote di partite diverse.
assert.notEqual(leagueOddsKey("soccer_italy_serie_a", 3, ["h2h"]), leagueOddsKey("soccer_italy_serie_a", 4, ["h2h"]));
// I mercati anche: chiedere in piu' `totals` non e' la stessa richiesta.
assert.notEqual(leagueOddsKey("s", 3, ["h2h"]), leagueOddsKey("s", 3, ["h2h", "totals"]));
// L'ordine dei mercati no: e' la stessa richiesta scritta in due modi.
assert.equal(leagueOddsKey("s", 3, ["totals", "h2h"]), leagueOddsKey("s", 3, ["h2h", "totals"]));
assert.notEqual(eventOddsKey("s", "e1", ["btts"]), eventOddsKey("s", "e2", ["btts"]));
assert.notEqual(leagueOddsKey("soccer_epl", 3, ["h2h"]), leagueOddsKey("soccer_italy_serie_a", 3, ["h2h"]));

// --- storage pieno: si degrada a "nessuna cache", non si rompe la generazione -----------------
const tiny = fakeStorage({ maxBytes: 120 });
const written = writeCachedOdds(leagueOddsKey("s", 1, ["h2h"]), { grande: "x".repeat(500) }, { storage: tiny });
assert.equal(written, false, "una scrittura impossibile deve restituire false, non lanciare");
assert.equal(readCachedOdds(leagueOddsKey("s", 1, ["h2h"]), { storage: tiny }), null);

// Storage assente del tutto (modalita' privata, policy): stesso contratto.
assert.equal(readCachedOdds("qualsiasi", { storage: null }), null);
assert.equal(writeCachedOdds("qualsiasi", { a: 1 }, { storage: null }), false);

// --- contenuto illeggibile: si riparte, non si fallisce ---------------------------------------
const corrupted = fakeStorage();
corrupted.setItem(ODDS_CACHE_STORAGE, "{non json");
assert.equal(readCachedOdds(key, { storage: corrupted }), null);
assert.equal(writeCachedOdds(key, { a: 1 }, { storage: corrupted }), true);

// --- il numero di voci resta limitato ---------------------------------------------------------
const many = fakeStorage();
for (let index = 0; index < 80; index += 1) {
  writeCachedOdds(leagueOddsKey("s", index, ["h2h"]), { index }, { storage: many, now: (index + 1) * MINUTE, maxEntries: 10 });
}
const status = oddsCacheStatus({ storage: many, now: 81 * MINUTE });
assert.ok(status.entries <= 10, `voci in cache: ${status.entries}, atteso al piu' 10`);
// Le piu' recenti sopravvivono, le piu' vecchie no.
assert.ok(readCachedOdds(leagueOddsKey("s", 79, ["h2h"]), { storage: many, now: 81 * MINUTE }));
assert.equal(readCachedOdds(leagueOddsKey("s", 0, ["h2h"]), { storage: many, now: 81 * MINUTE }), null);

clearOddsCache(storage);
assert.equal(readCachedOdds(key, { storage, now: 1_001 * MINUTE }), null);

console.log("OK: cache delle quote — riuso per turno e mercati, scadenza, storage pieno o assente");

// --- Il contratto vero: la seconda generazione dello stesso turno non ricompra le quote -------
// Il test sopra verifica il magazzino; questo verifica che il magazzino venga davvero usato.
// Gira sul dataset vero e salta senza fallire se non c'e', come player-context-contract.
const fs = await import("node:fs");
const datasetPath = new URL("../data/matches.json", import.meta.url);
if (!fs.existsSync(datasetPath)) {
  console.log("SALTATO (integrazione): data/matches.json non presente");
} else {
  const { generateSlip } = await import("../schedina.js");
  const payload = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

  const store = fakeStorage();
  globalThis.localStorage = store;

  let oddsCalls = 0;
  globalThis.fetch = async (url) => {
    const address = String(url);
    if (address.includes("/sports/?") || address.endsWith("/sports/")) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => [{ key: "soccer_italy_serie_a", group: "Soccer", title: "Serie A - Italy", active: true }],
      };
    }
    oddsCalls += 1;
    // Il contenuto non conta per questo test: conta quante volte lo si va a prendere.
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
  };

  const options = {
    payload, competitionId: "ita.1", legs: 2, confidence: "media",
    marketGroups: ["1X2", "doppia"], playerMarkets: [], apiKey: "chiave-finta",
  };

  const first = await generateSlip({ ...options });
  assert.equal(oddsCalls, 1, "la prima generazione deve scaricare le quote");
  assert.equal(first.oddsCache.fetched, 1);
  assert.equal(first.oddsCache.fromCache, 0);

  const second = await generateSlip({ ...options });
  assert.equal(oddsCalls, 1, "la seconda generazione dello stesso turno NON deve richiamare l'API");
  assert.equal(second.oddsCache.fetched, 0);
  assert.equal(second.oddsCache.fromCache, 1, "la risposta deve arrivare dalla cache");

  // Cambiare i mercati richiesti e' un'altra richiesta: servire la vecchia darebbe una schedina
  // costruita su quote che non contengono i mercati chiesti. Qui si guarda il registro e non il
  // contatore grezzo, perche' accendere il gruppo "gol" aggiunge anche l'elenco eventi — che e'
  // un endpoint diverso, gratuito e non messo in cache.
  const otherMarkets = await generateSlip({ ...options, marketGroups: ["1X2", "doppia", "gol"] });
  assert.equal(otherMarkets.oddsCache.fromCache, 0, "mercati diversi = richiesta diversa, la cache non deve rispondere");
  assert.ok(otherMarkets.oddsCache.fetched >= 1);

  // La casella "riscarica" deve poter scavalcare la cache, altrimenti non c'e' modo di
  // aggiornare i prezzi quando il turno si avvicina.
  const forced = await generateSlip({ ...options, forceRefresh: true });
  assert.equal(forced.oddsCache.fromCache, 0, "forceRefresh deve ignorare la cache");
  assert.equal(forced.oddsCache.fetched, 1);

  console.log("OK: cache delle quote — la seconda schedina dello stesso turno non richiama l'API");
}
