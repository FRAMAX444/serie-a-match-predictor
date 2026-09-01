// Storico delle schedine generate, e verifica del loro esito.
//
// A cosa serve, e a cosa NON serve. Non serve ad addestrare il modello: una schedina e' una
// funzione dei risultati delle partite, e quei risultati sono gia' — tutti — i dati su cui il
// modello e' costruito. Sapere che una combinazione di quattro esiti e' andata male aggiunge
// zero informazione rispetto ai quattro risultati, che il modello ha gia'; e a dieci schedine a
// settimana servirebbero comunque anni per distinguere un vantaggio dal rumore.
//
// Serve invece a una cosa che il progetto non ha mai avuto: verificare che la probabilita'
// dichiarata sia quella vera. Se il modello dice 20% e su cinquanta schedine ne vincono nove, la
// probabilita' e' onesta; se ne vincono due, il numero mostrato accanto alla quota e' decorativo.
// E' una misura di calibrazione, non un canale di addestramento — la stessa distinzione fra
// `confidence` (dichiarata) e i parametri del modello (che non la leggono).
export const SLIP_HISTORY_STORAGE = "serie-a-predictor-slip-history";
export const MAX_STORED_SERIES = 40;

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSlipHistory(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(SLIP_HISTORY_STORAGE);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(storage, series) {
  try {
    storage.setItem(SLIP_HISTORY_STORAGE, JSON.stringify(series));
    return true;
  } catch {
    return false;
  }
}

/** Registra una serie generata. Ritorna false se lo storage non e' disponibile o pieno. */
export function saveSlipSeries(entry, options = {}) {
  const { storage = safeStorage(), now = Date.now(), max = MAX_STORED_SERIES } = options;
  if (!storage || !entry?.slips?.length) return false;
  const record = {
    id: `${now}-${entry.competitionId}-${entry.round}`,
    generatedAt: new Date(now).toISOString(),
    competitionId: entry.competitionId,
    competitionName: entry.competitionName || entry.competitionId,
    round: entry.round ?? null,
    confidence: entry.confidence ?? null,
    requestedLegs: entry.requestedLegs ?? null,
    usesMarketOdds: Boolean(entry.usesMarketOdds),
    slips: entry.slips.map((slip) => ({
      combinedOdds: slip.combinedOdds,
      combinedProbability: slip.combinedProbability,
      legs: slip.legs.map((leg) => ({
        key: leg.key,
        label: leg.label,
        group: leg.group,
        probability: leg.probability,
        odds: leg.odds,
        source: leg.source,
        competitionId: leg.competitionId,
        homeTeam: leg.homeTeam,
        awayTeam: leg.awayTeam,
        // Il candidato la chiama `fixtureDate`, il record salvato `date`. Si accettano entrambe:
        // un campo che cambia nome attraversando un confine e' il modo in cui questo progetto ha
        // gia' perso dati piu' volte, e qui il costo sarebbe una schedina che resta "in corso"
        // per sempre perche' la sua partita non si trova.
        date: leg.fixtureDate ?? leg.date ?? null,
      })),
    })),
  };
  const history = readSlipHistory(storage);
  // Le serie piu' vecchie escono per prime, ma una serie ancora da verificare non deve sparire
  // per fare posto a una appena generata: sono le uniche che il calcolo dell'esito aspetta.
  const kept = [record, ...history].slice(0, max);
  if (persist(storage, kept)) return true;
  return persist(storage, [record]);
}

export function clearSlipHistory(storage = safeStorage()) {
  try {
    storage?.removeItem(SLIP_HISTORY_STORAGE);
  } catch {
    /* niente da pulire */
  }
}

// Esito di un mercato dato il punteggio finale. `null` = non decidibile da qui: i mercati sui
// giocatori richiedono gli eventi della singola partita, che il dataset non conserva. Vanno
// dichiarati non verificabili, non contati come persi — contarli come persi renderebbe ogni
// statistica dello storico falsa verso il basso.
export function settleMarket(key, homeGoals, awayGoals) {
  // `Number(null)` vale 0, non NaN: senza questo controllo una partita senza risultato verrebbe
  // letta come uno 0-0 e la selezione risolta come persa. E' lo stesso difetto dei minuti dei
  // giocatori (difetto 10) — un dato mancante che diventa un numero plausibile.
  if (homeGoals === null || homeGoals === undefined) return null;
  if (awayGoals === null || awayGoals === undefined) return null;
  const home = Number(homeGoals);
  const away = Number(awayGoals);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  const total = home + away;
  switch (key) {
    case "1": return home > away;
    case "X": return home === away;
    case "2": return home < away;
    case "1X": return home >= away;
    case "12": return home !== away;
    case "X2": return home <= away;
    case "OVER05": return total >= 1;
    case "OVER15": return total >= 2;
    case "OVER25": return total >= 3;
    case "OVER35": return total >= 4;
    case "UNDER15": return total < 2;
    case "UNDER25": return total < 3;
    case "UNDER35": return total < 4;
    case "GG": return home > 0 && away > 0;
    case "NG": return !(home > 0 && away > 0);
    case "HOME_SCORES": return home > 0;
    case "AWAY_SCORES": return away > 0;
    default: return null; // mercati sui giocatori e chiavi future
  }
}

const matchKey = (competitionId, date, homeTeam, awayTeam) => (
  `${competitionId}|${String(date).slice(0, 10)}|${homeTeam}|${awayTeam}`
);

export function indexMatches(matches) {
  const index = new Map();
  for (const match of matches || []) {
    index.set(matchKey(match.competition_id, match.date, match.home_team, match.away_team), match);
  }
  return index;
}

/**
 * Esito di una serie salvata, letto dai risultati veri.
 *
 * Stati di una schedina: `vinta` (tutte le selezioni verificate e vincenti), `persa` (almeno una
 * perdente, e basta quella: una multipla non si recupera), `in corso` (nessuna perdente ma
 * qualche partita non ancora giocata), `non verificabile` (nessuna perdente, tutte le partite
 * giocate, ma almeno una selezione che da qui non si puo' decidere).
 */
export function settleSeries(record, matchIndex) {
  const slips = record.slips.map((slip) => {
    const legs = slip.legs.map((leg) => {
      const match = matchIndex.get(matchKey(leg.competitionId, leg.date, leg.homeTeam, leg.awayTeam));
      const played = match && match.home_goals !== null && match.home_goals !== undefined;
      const won = played ? settleMarket(leg.key, match.home_goals, match.away_goals) : null;
      return {
        ...leg,
        played: Boolean(played),
        score: played ? `${match.home_goals}-${match.away_goals}` : null,
        won,
      };
    });
    const lost = legs.some((leg) => leg.won === false);
    const pending = legs.some((leg) => !leg.played);
    const undecidable = legs.some((leg) => leg.played && leg.won === null);
    const status = lost ? "persa" : pending ? "in corso" : undecidable ? "non verificabile" : "vinta";
    return { ...slip, legs, status };
  });
  return { ...record, slips };
}

/**
 * Calibrazione: la probabilita' dichiarata corrisponde alla frequenza osservata?
 *
 * Solo schedine con esito deciso (vinta o persa). Le fasce sono ampie di proposito: con poche
 * decine di schedine fasce strette darebbero percentuali che oscillano di venti punti per una
 * schedina in piu', e sembrerebbero un segnale.
 */
export const CALIBRATION_BANDS = Object.freeze([
  { label: "fino al 10%", from: 0, to: 0.10 },
  { label: "10-20%", from: 0.10, to: 0.20 },
  { label: "20-35%", from: 0.20, to: 0.35 },
  { label: "35-50%", from: 0.35, to: 0.50 },
  { label: "oltre il 50%", from: 0.50, to: 1.01 },
]);

export function historyCalibration(settled) {
  const decided = [];
  for (const record of settled) {
    for (const slip of record.slips) {
      if (slip.status === "vinta" || slip.status === "persa") {
        decided.push({ probability: slip.combinedProbability, odds: slip.combinedOdds, won: slip.status === "vinta" });
      }
    }
  }
  const bands = CALIBRATION_BANDS.map((band) => {
    const inBand = decided.filter((slip) => slip.probability >= band.from && slip.probability < band.to);
    const won = inBand.filter((slip) => slip.won).length;
    return {
      ...band,
      n: inBand.length,
      expected: inBand.length ? inBand.reduce((sum, slip) => sum + slip.probability, 0) / inBand.length : null,
      observed: inBand.length ? won / inBand.length : null,
      won,
    };
  });
  const staked = decided.length;
  const returned = decided.filter((slip) => slip.won).reduce((sum, slip) => sum + slip.odds, 0);
  return {
    decided: decided.length,
    won: decided.filter((slip) => slip.won).length,
    expectedWins: decided.reduce((sum, slip) => sum + slip.probability, 0),
    staked,
    returned,
    bands,
  };
}

// --- Archivio su disco -------------------------------------------------------------------
//
// `localStorage` non e' un archivio: e' una cache legata all'origine. Cambia porta
// (`npm start -- --port 8080`), pulisci i dati di Chrome, apri da un altro browser, e lo storico
// risulta vuoto — senza errori, esattamente come se non avessi mai generato niente. La pagina
// pero' promette che "le schedine generate restano qui", e una promessa che lo storage non
// mantiene e' un difetto, non una limitazione.
//
// Da qui l'archivio vero: `data/slip-history.json`, scritto dal server di sviluppo. La lettura e'
// un file statico e funziona ovunque (anche su GitHub Pages); la scrittura passa da un endpoint
// che solo `scripts/serve.mjs` espone, quindi in locale i dati sopravvivono al browser, e in
// produzione il salvataggio semplicemente fallisce e resta `localStorage`. Nessuno dei due lati
// puo' rompere l'altro: l'unione e' per id, mai una sostituzione.
export const SLIP_WINS_STORAGE = "serie-a-predictor-slip-wins";
export const ARCHIVE_FILE = "data/slip-history.json";
export const ARCHIVE_ENDPOINT = "/api/slip-history";

/** Unione di piu' elenchi di serie, per id, dalla piu' recente. Il primo che vince tiene. */
export function mergeSeries(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const record of list || []) {
      if (record?.id && !byId.has(record.id)) byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}

export const winId = (seriesId, slipIndex) => `${seriesId}#${slipIndex}`;

/**
 * Le schedine vinte, estratte da serie gia' risolte con `settleSeries`.
 *
 * Sono copie complete, non riferimenti: una vincita deve restare leggibile anche quando la serie
 * che la conteneva e' uscita dalla rotazione delle ultime `MAX_STORED_SERIES`, altrimenti
 * "permanente" vale finche' non generi altre quaranta serie.
 */
export function collectWins(settled, options = {}) {
  const { now = Date.now() } = options;
  const wins = [];
  for (const record of settled || []) {
    (record.slips || []).forEach((slip, index) => {
      if (slip.status !== "vinta") return;
      wins.push({
        id: winId(record.id, index),
        seriesId: record.id,
        slipIndex: index,
        generatedAt: record.generatedAt,
        settledAt: new Date(now).toISOString(),
        competitionId: record.competitionId,
        competitionName: record.competitionName || record.competitionId,
        round: record.round ?? null,
        confidence: record.confidence ?? null,
        combinedOdds: slip.combinedOdds,
        combinedProbability: slip.combinedProbability,
        legs: slip.legs,
      });
    });
  }
  return wins;
}

/** Unione delle vincite, per id. La copia gia' archiviata vince: `settledAt` non deve ballare. */
export function mergeWins(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const win of list || []) {
      if (win?.id && !byId.has(win.id)) byId.set(win.id, win);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}

export function readSlipWins(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(SLIP_WINS_STORAGE);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistWins(storage, wins) {
  try {
    storage?.setItem(SLIP_WINS_STORAGE, JSON.stringify(wins));
    return true;
  } catch {
    return false;
  }
}

/** Legge l'archivio su disco. `null` = non raggiungibile (assente, o servito da GitHub Pages). */
export async function fetchRemoteArchive(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(ARCHIVE_FILE, { cache: "no-store" });
    if (!response?.ok) return null;
    const data = await response.json();
    return {
      series: Array.isArray(data?.series) ? data.series : [],
      wins: Array.isArray(data?.wins) ? data.wins : [],
    };
  } catch {
    return null;
  }
}

/** Scrive l'archivio su disco. `false` senza server di sviluppo: non e' un errore, e' l'assenza. */
export async function pushRemoteArchive(archive, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return false;
  try {
    const response = await fetchImpl(ARCHIVE_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        series: archive.series || [],
        wins: archive.wins || [],
      }),
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

/**
 * Unione di quanto c'e' nel browser e di quanto c'e' su disco.
 *
 * `remote: false` significa "archivio su disco non raggiungibile", ed e' l'unico caso in cui i
 * dati vivono ancora nel solo `localStorage`. La pagina deve dirlo, perche' e' la condizione in
 * cui una pulizia della cache cancella davvero tutto.
 */
export async function loadArchive(options = {}) {
  const { storage = safeStorage(), fetchImpl = globalThis.fetch } = options;
  const remote = await fetchRemoteArchive(fetchImpl);
  return {
    series: mergeSeries(readSlipHistory(storage), remote?.series || []),
    wins: mergeWins(readSlipWins(storage), remote?.wins || []),
    remote: Boolean(remote),
  };
}

/**
 * Salva l'archivio da entrambe le parti.
 *
 * Il file su disco tiene tutto; `localStorage` tiene solo le ultime `MAX_STORED_SERIES` serie —
 * e' una cache, e riempirla fino alla quota farebbe fallire il salvataggio della serie
 * successiva. Le vincite non si potano mai: sono il punto della sezione permanente.
 */
export async function saveArchive(archive, options = {}) {
  const { storage = safeStorage(), fetchImpl = globalThis.fetch } = options;
  const series = archive.series || [];
  const wins = archive.wins || [];
  const local = storage ? persist(storage, series.slice(0, MAX_STORED_SERIES)) && persistWins(storage, wins) : false;
  const saved = await pushRemoteArchive({ series, wins }, fetchImpl);
  return { local, saved };
}

/** Legge, unisce, riscrive. Usata dopo una generazione: la serie appena salvata finisce su disco. */
export async function syncArchive(options = {}) {
  const archive = await loadArchive(options);
  const { saved } = await saveArchive(archive, options);
  return { ...archive, saved };
}
