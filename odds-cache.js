// Cache locale delle quote gia' scaricate, per non ripagare la stessa informazione.
//
// Il motivo e' contabile prima che tecnico: the-odds-api conta una richiesta per ogni
// combinazione mercato x regione, e per l'endpoint per evento anche per ogni partita. Rigenerare
// due volte la schedina dello stesso turno — cosa che si fa continuamente, cambiando numero di
// partite o sicurezza — costava due volte lo stesso pacchetto di quote, fino a un centinaio di
// richieste su un piano che ne ha 500 al mese.
//
// Sta in localStorage e non in memoria perche' il caso d'uso e' proprio ricaricare la pagina e
// rigenerare: una cache che muore con il tab non risolverebbe il problema che ha.
//
// LA SCADENZA NON E' UN DETTAGLIO. Una quota e' un prezzo, e un prezzo vecchio non e' una quota
// mancante: e' una quota SBAGLIATA, che la schedina userebbe come vera. Per questo ogni voce
// porta il momento in cui e' stata scaricata, scade da sola, e l'interfaccia dichiara sempre
// l'eta' di cio' che sta mostrando invece di far sembrare tutto appena sceso dalla rete.
export const ODDS_CACHE_STORAGE = "serie-a-predictor-odds-cache";

// Tre ore: abbastanza per coprire una sessione di prove sullo stesso turno, poco abbastanza da
// non arrivare al giorno della partita con i prezzi della vigilia.
export const DEFAULT_TTL_MINUTES = 180;

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage negato (modalita' privata, policy): si lavora senza cache
  }
}

function readAll(storage) {
  try {
    const raw = storage?.getItem(ODDS_CACHE_STORAGE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // contenuto illeggibile: si riparte da zero invece di far fallire la generazione
  }
}

function writeAll(storage, entries) {
  try {
    storage.setItem(ODDS_CACHE_STORAGE, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

// Chiave di una richiesta. Il turno fa parte della chiave: le quote di una giornata non sono
// quelle della successiva, e senza il turno la seconda generazione servirebbe le prime.
export function leagueOddsKey(sportKey, round, markets) {
  return `lega|${sportKey}|turno:${round ?? "?"}|${[...markets].sort().join(",")}`;
}

export function eventOddsKey(sportKey, eventId, markets) {
  return `evento|${sportKey}|${eventId}|${[...markets].sort().join(",")}`;
}

/** Voce ancora valida, o null. Restituisce anche quando e' stata salvata: l'eta' va mostrata. */
export function readCachedOdds(key, options = {}) {
  const { now = Date.now(), ttlMinutes = DEFAULT_TTL_MINUTES, storage = safeStorage() } = options;
  if (!storage) return null;
  const entry = readAll(storage)[key];
  if (!entry || typeof entry.savedAt !== "number") return null;
  const ageMinutes = (now - entry.savedAt) / 60000;
  if (ageMinutes < 0 || ageMinutes > ttlMinutes) return null;
  return { value: entry.value, savedAt: entry.savedAt, ageMinutes };
}

/**
 * Salva una risposta. Se lo storage e' pieno elimina le voci piu' vecchie e riprova una volta:
 * una cache che non riesce a scrivere deve degradare a "nessuna cache", mai far fallire la
 * generazione della schedina.
 */
export function writeCachedOdds(key, value, options = {}) {
  const { now = Date.now(), storage = safeStorage(), maxEntries = 60 } = options;
  if (!storage) return false;
  const entries = readAll(storage);
  entries[key] = { savedAt: now, value };

  const ordered = Object.entries(entries).sort((left, right) => right[1].savedAt - left[1].savedAt);
  let kept = Object.fromEntries(ordered.slice(0, maxEntries));
  if (writeAll(storage, kept)) return true;
  // Ancora troppo: si tiene solo la voce appena scritta, che e' quella che serve adesso.
  kept = { [key]: entries[key] };
  return writeAll(storage, kept);
}

export function clearOddsCache(storage = safeStorage()) {
  try {
    storage?.removeItem(ODDS_CACHE_STORAGE);
  } catch {
    /* niente da pulire */
  }
}

/** Quante voci, e quanto e' vecchia la piu' vecchia ancora valida. */
export function oddsCacheStatus(options = {}) {
  const { now = Date.now(), ttlMinutes = DEFAULT_TTL_MINUTES, storage = safeStorage() } = options;
  const entries = Object.values(readAll(storage));
  const fresh = entries.filter((entry) => (now - entry.savedAt) / 60000 <= ttlMinutes);
  return {
    entries: fresh.length,
    oldestMinutes: fresh.length ? Math.max(...fresh.map((entry) => (now - entry.savedAt) / 60000)) : null,
  };
}
