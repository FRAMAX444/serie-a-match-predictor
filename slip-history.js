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
