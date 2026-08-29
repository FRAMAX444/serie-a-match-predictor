import { predictMatchdayFromMatches, estimatePlayerMarkets, deriveMarkets } from "./model.js";
import { modelInputs } from "./prediction-inputs.js";
import { buildCompetitionCatalog, buildMatchdays } from "./matchdays.js";
import {
  buildSlip, buildSlipSeries, resolveConfidence, CONFIDENCE_LEVELS, DEFAULT_MIN_LEG_ODDS,
} from "./slip-builder.js";
import {
  readCachedOdds, writeCachedOdds, leagueOddsKey, eventOddsKey, DEFAULT_TTL_MINUTES,
} from "./odds-cache.js";

export { buildSlip, buildSlipSeries, resolveConfidence, CONFIDENCE_LEVELS, DEFAULT_MIN_LEG_ODDS };

export const ODDS_API_KEY_STORAGE = "serie-a-predictor-odds-api-key";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Ogni voce: termini di ricerca in ordine di priorità (il primo che produce ESATTAMENTE
// un risultato tra i campionati attivi vince) più un blocklist per escludere campionati
// femminili/giovanili/riserve che potrebbero condividere una parola chiave (es.
// "bundesliga" da solo matcherebbe anche "Frauen-Bundesliga" o "2. Bundesliga").
// I sport_key esatti di the-odds-api.com non sono verificabili dal vivo da qui (nessun
// dominio di quote nella rete consentita): per questo la scoperta è dinamica via /v4/sports/
// invece di un valore hardcoded, con fallback a scelta manuale se il match non è univoco.
// I sport_key di the-odds-api sono identificatori stabili e documentati: quando il catalogo li
// contiene, sono la risposta esatta e non c'e' niente da indovinare. La ricerca per parola
// chiave qui sotto resta come ripiego nel caso l'API rinominasse una chiave, ma NON puo' essere
// il criterio principale: "bundesliga" corrisponde anche alla Bundesliga austriaca, che e'
// attiva negli stessi mesi, quindi per ger.1 la ricerca non era univoca e la pagina finiva
// sempre sulla scelta manuale del campionato (MISTAKES.md 19).
export const LEAGUE_SPORT_KEYS = {
  "eng.1": "soccer_epl",
  "esp.1": "soccer_spain_la_liga",
  "ita.1": "soccer_italy_serie_a",
  "ger.1": "soccer_germany_bundesliga",
  "fra.1": "soccer_france_ligue_one",
};

export const LEAGUE_SEARCH_TERMS = {
  "eng.1": ["epl", "premier league"],
  "esp.1": ["la liga", "laliga"],
  "ita.1": ["serie a"],
  "ger.1": ["bundesliga"],
  "fra.1": ["ligue 1", "ligue one"],
};
const EXCLUDE_TERMS = ["women", "frauen", "u21", "u20", "u19", "youth", "reserve", " 2", "ii ", "b -"];

// Nomi che due fonti scrivono in modo incompatibile, dove nessuna somiglianza fra stringhe puo'
// aiutare: "M'gladbach" e "Borussia Monchengladbach" non hanno una sottostringa in comune, e
// "Rennes" contro "Stade Rennais" nemmeno. Ogni voce elenca le forme accettabili perche' non
// sappiamo quale delle due usi l'API — il punteggio prende la migliore, quindi elencarle
// entrambe non costa nulla e toglie una scommessa sul catalogo altrui.
const ODDS_NAME_ALIASES = {
  "Bayern Monaco": ["Bayern Munich"],
  Dortmund: ["Borussia Dortmund"],
  "M'gladbach": ["Borussia Monchengladbach", "Monchengladbach"],
  Lipsia: ["RB Leipzig"],
  Francoforte: ["Eintracht Frankfurt"],
  "FC Koln": ["FC Koln", "Cologne"],
  Hamburg: ["Hamburger SV", "Hamburg"],
  PSG: ["Paris Saint Germain"],
  Paris: ["Paris FC"],
  Marsiglia: ["Olympique Marseille", "Marseille"],
  Lione: ["Olympique Lyonnais", "Lyon"],
  Rennes: ["Stade Rennais", "Rennes"],
  "Man United": ["Manchester United"],
  "Man City": ["Manchester City"],
  Newcastle: ["Newcastle United"],
  Wolves: ["Wolverhampton Wanderers"],
};

// Sigle societarie e numeri di fondazione: presenti o assenti a seconda della fonte, non
// distinguono un club da un altro. Stanno qui e non in una regex dentro normalizeTeamName
// perche' il confronto e' per token, e un token o e' rumore o non lo e'.
const NOISE_TOKENS = new Set([
  "fc", "cf", "afc", "ac", "as", "ss", "ssc", "sc", "us", "ud", "rc", "rcd", "cd", "sv", "bc",
  "vfb", "vfl", "tsg", "rb", "aj", "ogc", "losc", "calcio", "club", "and", "de", "the",
  "04", "05", "09", "1899", "1900",
]);

function normalizeTeamName(name) {
  return String(name ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameTokens(name) {
  const all = normalizeTeamName(name).split(" ").filter(Boolean);
  const significant = all.filter((token) => !NOISE_TOKENS.has(token));
  // Un nome fatto di sole sigle ("PSG" prima dell'alias) resterebbe senza token: meglio
  // confrontarlo per quello che e' che non confrontarlo affatto.
  return new Set(significant.length ? significant : all);
}

// Due token contano come lo stesso se uno e' il prefisso dell'altro ("hamburg" /
// "hamburger", "brest" / "brestois"): e' la sola tolleranza che serve fra le grafie viste, e
// resta stretta abbastanza da non far collidere due club diversi.
function tokensAgree(left, right) {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

// Quanto due nomi si somigliano, su due assi che servono a cose diverse:
//   copertura = quanta parte del nome PIU' CORTO e' condivisa. Riconosce "Brighton" dentro
//              "Brighton and Hove Albion", ma da' 1 anche a "Paris" dentro "Paris Saint
//              Germain", che e' un altro club;
//   jaccard   = quanta parte dell'unione e' condivisa. Vale 1 solo per due nomi equivalenti,
//              quindi separa "Paris"/"Paris FC" (1) da "Paris"/"Paris Saint Germain" (0.33).
// La copertura decide chi e' ammissibile, il jaccard decide chi vince fra piu' ammissibili.
function nameScore(pipelineName, oddsApiName) {
  const rightTokens = nameTokens(oddsApiName);
  const forms = [pipelineName, ...(ODDS_NAME_ALIASES[pipelineName] || [])];
  let best = { coverage: 0, jaccard: 0 };
  for (const form of forms) {
    const leftTokens = nameTokens(form);
    if (!leftTokens.size || !rightTokens.size) continue;
    let shared = 0;
    for (const left of leftTokens) {
      if ([...rightTokens].some((right) => tokensAgree(left, right))) shared += 1;
    }
    if (!shared) continue;
    const coverage = shared / Math.min(leftTokens.size, rightTokens.size);
    const jaccard = shared / (leftTokens.size + rightTokens.size - shared);
    if (coverage > best.coverage || (coverage === best.coverage && jaccard > best.jaccard)) {
      best = { coverage, jaccard };
    }
  }
  return best;
}

// Sotto questa soglia i due nomi non condividono abbastanza per essere lo stesso club.
const MIN_NAME_COVERAGE = 0.5;

// Abbina le partite del turno agli eventi dell'API risolvendo il turno INTERO, non una partita
// alla volta. La differenza non e' teorica: "Paris" (il Paris FC) e' contenuto in "Paris Saint
// Germain", quindi cercando un evento per volta la prima partita che scorre si prende l'evento
// dell'altra squadra e nessuno se ne accorge — le quote di un'altra partita sono peggio di
// nessuna quota, perche' la schedina le usa come vere. Qui ogni evento e' assegnato a una sola
// partita, e le coppie piu' somiglianti scelgono per prime.
export function assignEventsToFixtures(fixtures, events) {
  const pairs = [];
  fixtures.forEach((fixture, fixtureIndex) => {
    (events || []).forEach((event, eventIndex) => {
      const sameDay = String(event.commence_time || "").slice(0, 10) === String(fixture.date).slice(0, 10);
      if (!sameDay) return;
      const home = nameScore(fixture.home_team, event.home_team || "");
      const away = nameScore(fixture.away_team, event.away_team || "");
      const coverage = Math.min(home.coverage, away.coverage);
      if (coverage < MIN_NAME_COVERAGE) return;
      pairs.push({ fixtureIndex, eventIndex, coverage, jaccard: (home.jaccard + away.jaccard) / 2 });
    });
  });
  pairs.sort((left, right) => (right.coverage - left.coverage) || (right.jaccard - left.jaccard));

  const assigned = new Map();
  const usedEvents = new Set();
  for (const pair of pairs) {
    if (assigned.has(pair.fixtureIndex) || usedEvents.has(pair.eventIndex)) continue;
    assigned.set(pair.fixtureIndex, events[pair.eventIndex]);
    usedEvents.add(pair.eventIndex);
  }
  return assigned;
}

export function getStoredOddsApiKey() {
  try {
    return localStorage.getItem(ODDS_API_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function setStoredOddsApiKey(key) {
  try {
    if (key) localStorage.setItem(ODDS_API_KEY_STORAGE, key.trim());
    else localStorage.removeItem(ODDS_API_KEY_STORAGE);
  } catch {
    /* storage non disponibile: la chiave andrà semplicemente re-inserita ad ogni sessione */
  }
}

// Interroga il catalogo sport (chiamata leggera, non conteggiata nella quota nella
// documentazione di the-odds-api.com) e prova a individuare un unico campionato di calcio
// attivo che corrisponda a uno dei termini di ricerca per la lega scelta, escludendo le
// categorie in EXCLUDE_TERMS. Se il match non è univoco, ritorna tutti i candidati soccer
// attivi: la UI chiede scelta manuale invece di indovinare.
export async function discoverSportKey(apiKey, competitionId) {
  const response = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${encodeURIComponent(apiKey)}`);
  if (!response.ok) throw new Error(`Catalogo sport non raggiungibile (HTTP ${response.status})`);
  const sports = await response.json();
  const soccer = sports.filter((sport) => sport.active && /soccer/i.test(sport.group || sport.key || ""));

  const known = soccer.find((sport) => sport.key === LEAGUE_SPORT_KEYS[competitionId]);
  if (known) return { key: known.key, title: known.title, candidates: soccer };

  const terms = LEAGUE_SEARCH_TERMS[competitionId] || [];
  for (const term of terms) {
    const matches = soccer.filter((sport) => {
      const haystack = `${sport.title || ""} ${sport.description || ""} ${sport.key || ""}`.toLowerCase();
      const excluded = EXCLUDE_TERMS.some((bad) => haystack.includes(bad));
      return !excluded && haystack.includes(term);
    });
    if (matches.length === 1) return { key: matches[0].key, title: matches[0].title, candidates: soccer };
  }
  return { key: null, title: null, candidates: soccer };
}

// L'endpoint /odds di lega accetta SOLO i mercati "featured". Chiedergliene un altro non degrada
// la risposta: fa fallire l'intera chiamata con HTTP 422 `INVALID_MARKET`, quindi si perdono
// anche le quote 1X2 che erano disponibili. Misurato dal vivo il 28/08/2026 chiedendo `btts`
// (MISTAKES.md 22). I mercati non-featured — btts, linee alternative, player prop — esistono solo
// sull'endpoint per singolo evento, che costa una richiesta a partita.
const FEATURED_MARKETS = Object.freeze(["h2h", "spreads", "totals", "outrights"]);

// ATTENZIONE ALLA QUOTA: the-odds-api conta una richiesta per ogni combinazione mercato x
// regione, quindi chiedere h2h+totals costa 2 richieste invece di 1 (piano gratuito: 500 al
// mese). Per questo la lista non e' fissa: `totals` si chiede solo se l'utente ha acceso il
// gruppo "gol", e chi gioca 1X2 e doppia chance continua a pagare una richiesta sola.
export const ODDS_MARKETS_BY_GROUP = Object.freeze({
  "1X2": ["h2h"],
  doppia: ["h2h"], // 1X/12/X2 si ricavano esattamente dalle tre quote 1X2, nessun mercato in piu'
  gol: ["totals"], // Over/Under si'; Gol/No gol (btts) non e' featured, resta quota equa
  squadra: [], // nessun mercato standard su the-odds-api: resta la quota equa del modello
  giocatori: [], // hanno il loro endpoint per evento, vedi collectEventOdds
});

export function oddsMarketsFor(groups) {
  const markets = new Set(["h2h"]); // sempre: e' la base di 1X2 e delle doppie chance
  for (const group of groups || []) {
    for (const market of ODDS_MARKETS_BY_GROUP[group] || []) markets.add(market);
  }
  // Rete sul difetto 22: un mercato non-featured qui dentro non toglie una selezione, fa
  // fallire tutta la richiesta e lascia la schedina senza nessuna quota reale.
  return [...markets].filter((market) => FEATURED_MARKETS.includes(market));
}

export async function fetchLeagueOdds(apiKey, sportKey, markets = ["h2h"]) {
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds/?apiKey=${encodeURIComponent(apiKey)}`
    + `&regions=eu&markets=${encodeURIComponent(markets.join(","))}&oddsFormat=decimal`;
  const response = await fetch(url);
  readQuotaHeaders(response);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Quote non raggiungibili (HTTP ${response.status}) ${body.slice(0, 200)}`);
  }
  return response.json();
}

// Prezzo medio fra i bookmaker per un esito, identificato da mercato + nome (+ linea, per i
// totals). La media e' il consenso di mercato: prendere il massimo sarebbe la quota migliore
// ottenibile, ma non e' un prezzo che esiste ovunque e renderebbe ogni confronto ottimistico.
function averageOutcomeOdds(event, marketKey, outcomeName, point = null) {
  const prices = [];
  (event.bookmakers || []).forEach((bookmaker) => {
    const market = (bookmaker.markets || []).find((entry) => entry.key === marketKey);
    const outcome = market?.outcomes?.find((entry) => (
      entry.name === outcomeName && (point === null || Number(entry.point) === point)
    ));
    if (outcome && Number.isFinite(outcome.price) && outcome.price > 1) prices.push(outcome.price);
  });
  if (!prices.length) return null;
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

// Le linee Over/Under che il modello sa produrre. Il bookmaker ne espone di solito una o due:
// quelle mancanti restano senza prezzo di mercato invece di essere estrapolate, perche' una
// linea estrapolata non e' una quota, e' di nuovo una stima travestita da mercato.
const TOTALS_LINES = [0.5, 1.5, 2.5, 3.5];

function marketPricesFromEvent(event) {
  const totals = {};
  for (const line of TOTALS_LINES) {
    const over = averageOutcomeOdds(event, "totals", "Over", line);
    const under = averageOutcomeOdds(event, "totals", "Under", line);
    if (over || under) totals[line] = { over, under };
  }
  return {
    home: averageOutcomeOdds(event, "h2h", event.home_team),
    draw: averageOutcomeOdds(event, "h2h", "Draw"),
    away: averageOutcomeOdds(event, "h2h", event.away_team),
    totals,
    // Presenti solo se l'evento arriva dall'endpoint per singolo evento: `btts` e `team_totals`
    // non sono mercati featured e la chiamata di lega non li puo' contenere. Li riempie
    // collectEventOdds, quando i gruppi selezionati li richiedono.
    btts: {
      yes: averageOutcomeOdds(event, "btts", "Yes"),
      no: averageOutcomeOdds(event, "btts", "No"),
    },
    teamScores: { home: null, away: null },
  };
}

// Due esiti che non possono verificarsi insieme si combinano esattamente: la probabilita'
// implicita della doppia chance e' la somma delle due implicite, quindi la quota e' l'inverso
// della somma degli inversi. Il margine del banco contenuto nelle due quote resta dentro, ed e'
// esattamente cio' che serve: la quota che ne esce e' sulla stessa scala di prezzo delle altre,
// non una quota equa spacciata per mercato.
function combineExclusive(first, second) {
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 1 || second <= 1) return null;
  return 1 / (1 / first + 1 / second);
}

// Quota di mercato per un esito del modello, o null se il bookmaker non lo prezza.
export function marketOddsForKey(odds, key) {
  if (!odds) return null;
  switch (key) {
    case "1": return odds.home ?? null;
    case "X": return odds.draw ?? null;
    case "2": return odds.away ?? null;
    case "1X": return combineExclusive(odds.home, odds.draw);
    case "12": return combineExclusive(odds.home, odds.away);
    case "X2": return combineExclusive(odds.draw, odds.away);
    case "GG": return odds.btts?.yes ?? null;
    case "NG": return odds.btts?.no ?? null;
    // "la squadra segna" e' esattamente il team total sopra 0.5.
    case "HOME_SCORES": return odds.teamScores?.home ?? null;
    case "AWAY_SCORES": return odds.teamScores?.away ?? null;
    default: break;
  }
  const total = /^(OVER|UNDER)(\d)(\d)$/.exec(key);
  if (total) {
    const line = Number(`${total[2]}.${total[3]}`);
    const prices = odds.totals?.[line];
    return (total[1] === "OVER" ? prices?.over : prices?.under) ?? null;
  }
  return null;
}

// Quote medie di mercato 1/X/2 per ogni partita del turno. Le fixture senza corrispondenza
// tornano con odds: null sui tre esiti — restano visibili come "senza quote" invece di sparire,
// e `oddsEventId` dice a quale evento sono state agganciate quelle che ce l'hanno.
export function matchOddsToFixtures(predictions, oddsEvents) {
  const assigned = assignEventsToFixtures(predictions.map(({ fixture }) => fixture), oddsEvents);
  return predictions.map(({ fixture, result }, index) => {
    const event = assigned.get(index) || null;
    const odds = event
      ? marketPricesFromEvent(event)
      : {
        home: null, draw: null, away: null, totals: {},
        btts: { yes: null, no: null }, teamScores: { home: null, away: null },
      };
    return { fixture, result, odds, matched: Boolean(event), oddsEventId: event?.id ?? null };
  });
}

// Gruppi di mercato selezionabili dall'interfaccia. `1X2` da solo produce schedine povere
// (tre soli esiti per partita, spesso nessuno abbastanza sicuro); aggiungendo doppie chance e
// gol si moltiplicano le combinazioni ammissibili senza uscire dai mercati che ogni bookmaker
// offre davvero.
export const MARKET_GROUPS = Object.freeze({
  "1X2": "Esito finale (1X2)",
  doppia: "Doppia chance",
  gol: "Over/Under e Gol/No gol",
  squadra: "Squadra segna",
  giocatori: "Mercati sui giocatori",
});

export const DEFAULT_MARKET_GROUPS = Object.freeze(["1X2", "doppia", "gol"]);

// I mercati 1X2 sono gli unici per cui questa pipeline può avere una quota REALE (h2h da
// the-odds-api). Per tutti gli altri si usa la quota equa del modello, etichettata
// source:"model": va mostrata come stima, mai spacciata per quota di mercato.
/**
 * Candidati da tutti i mercati derivabili dalla matrice dei punteggi della partita.
 *
 * Ogni candidato porta con sé l'affidabilità della previsione (`quality.score` del modello per
 * quella partita), che il costruttore della schedina usa per scegliere tra selezioni
 * ugualmente probabili: vedi il commento in testa a slip-builder.js sul perché a parità di
 * probabilità non tutte le selezioni valgano uguale.
 */
export function buildMarketCandidates(entries, options = {}) {
  const { groups = DEFAULT_MARKET_GROUPS, minLegProbability = 0 } = options;
  const allowed = new Set(groups);
  const candidates = [];
  entries.forEach((entry, fixtureIndex) => {
    const fixtureLabel = `${entry.fixture.home_team} - ${entry.fixture.away_team}`;
    const reliability = clampReliability(entry.result?.quality?.score);
    deriveMarkets(entry.result.probabilities).forEach((market) => {
      if (!allowed.has(market.group) || market.probability < minLegProbability) return;
      const liveOdds = marketOddsForKey(entry.odds, market.key);
      const usesLiveOdds = Number.isFinite(liveOdds) && liveOdds > 1;
      candidates.push({
        fixtureIndex,
        fixtureLabel,
        fixtureDate: entry.fixture.date,
        // L'identita' della partita viaggia con la selezione: lo storico deve poterne risolvere
        // l'esito, e ricavarla riparsando "Casa - Trasferta" sarebbe un secondo modo di
        // identificare la stessa gara.
        homeTeam: entry.fixture.home_team,
        awayTeam: entry.fixture.away_team,
        competitionId: entry.fixture.competition_id,
        key: market.key,
        group: market.group,
        label: marketLabel(market, entry.fixture),
        probability: market.probability,
        odds: usesLiveOdds ? liveOdds : market.fairOdds,
        fairOdds: market.fairOdds,
        source: usesLiveOdds ? "market" : "model",
        reliability,
      });
    });
  });
  return candidates;
}

// L'etichetta mostra il nome della squadra invece di "casa"/"trasferta" dove il mercato lo
// consente: su una schedina si legge "Inter (1)", non "1 (casa)".
function marketLabel(market, fixture) {
  switch (market.key) {
    case "1": return `${fixture.home_team} (1)`;
    case "2": return `${fixture.away_team} (2)`;
    case "1X": return `${fixture.home_team} o pareggio (1X)`;
    case "X2": return `Pareggio o ${fixture.away_team} (X2)`;
    case "HOME_SCORES": return `${fixture.home_team} segna`;
    case "AWAY_SCORES": return `${fixture.away_team} segna`;
    default: return market.label;
  }
}

// Un'affidabilità mai nulla e mai piena: zero renderebbe -Infinity il punteggio logaritmico
// di quella selezione (escludendola sempre, anche quando è l'unica disponibile), uno
// dichiarerebbe una certezza che nessuna previsione ha.
function clampReliability(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(0.99, Math.max(0.05, parsed)) : 0.5;
}

// Costruisce le giocate candidate: una per esito con quota nota e probabilità del modello
// sopra la soglia minima. minLegProbability di default esclude esiti "lunghi" a priori,
// coerente con l'obiettivo "il più probabile possibile" — non ha senso includere un esito
// al 12% in una schedina pensata per essere sicura.
export function buildCandidates(entries, minLegProbability = 0.35) {
  const candidates = [];
  entries.forEach((entry, fixtureIndex) => {
    if (!entry.matched) return;
    const options = [
      { key: "1", label: `${entry.fixture.home_team} (1)`, odds: entry.odds.home, probability: entry.result.probabilities.homeWin },
      { key: "X", label: "Pareggio (X)", odds: entry.odds.draw, probability: entry.result.probabilities.draw },
      { key: "2", label: `${entry.fixture.away_team} (2)`, odds: entry.odds.away, probability: entry.result.probabilities.awayWin },
    ];
    options.forEach((option) => {
      if (Number.isFinite(option.odds) && option.odds > 1 && option.probability >= minLegProbability) {
        candidates.push({
          fixtureIndex,
          fixtureLabel: `${entry.fixture.home_team} - ${entry.fixture.away_team}`,
          ...option,
        });
      }
    });
  });
  return candidates;
}

// Cerca, tra le combinazioni con al più una selezione per partita, quella con quota
// combinata entro tolleranza dal target e probabilità combinata (prodotto delle probabilità
// del modello, assunte indipendenti tra partite) massima. Pota i rami dove la quota parziale
// ha già superato il limite superiore: tutte le quote sono > 1, quindi da lì può solo
// crescere. Con al più ~3 candidati qualificanti per partita e turni tipici di 8-10 gare
// resta rapido senza bisogno di altre ottimizzazioni.
export function bestAccumulator(candidates, targetOdds, tolerance = 0.15, maxLegs = 8) {
  const byFixture = new Map();
  candidates.forEach((candidate) => {
    if (!byFixture.has(candidate.fixtureIndex)) byFixture.set(candidate.fixtureIndex, []);
    byFixture.get(candidate.fixtureIndex).push(candidate);
  });
  const fixtures = [...byFixture.values()];
  const minTarget = targetOdds / (1 + tolerance);
  const maxTarget = targetOdds * (1 + tolerance);

  let best = null;
  const chosen = [];

  function visit(index, combinedOdds, combinedProbability) {
    if (combinedOdds > maxTarget) return;
    if (chosen.length > maxLegs) return;
    if (index === fixtures.length) {
      if (combinedOdds >= minTarget && chosen.length > 0 && (!best || combinedProbability > best.combinedProbability)) {
        best = { legs: chosen.slice(), combinedOdds, combinedProbability };
      }
      return;
    }
    visit(index + 1, combinedOdds, combinedProbability); // salta questa partita
    for (const candidate of fixtures[index]) {
      chosen.push(candidate);
      visit(index + 1, combinedOdds * candidate.odds, combinedProbability * candidate.probability);
      chosen.pop();
    }
  }

  visit(0, 1, 1);
  return best;
}

// --- Mercati sui singoli giocatori (marcatore in qualsiasi momento) -----------------------
// Opt-in: una chiamata per evento (più costosa della quota 1X2 in blocco), e solo su
// bookmaker USA (regions=us — the-odds-api.com documenta la copertura player-prop per le 5
// leghe Big Five solo lì, non su eu). Il market key "player_goal_scorer_anytime" è la mia
// migliore stima informata della convenzione the-odds-api.com — verificata via ricerca sulla
// loro documentazione, NON testata dal vivo con una chiave reale (nessun accesso di rete a
// domini di quote da questo ambiente). Se la chiamata fallisce o il piano non include questo
// mercato, il fallback usa la quota equa stimata dal modello (1/probabilità) invece di far
// fallire l'intera schedina: le giocate risultanti sono etichettate source:"model", non
// source:"market", così resta chiaro cos'è una quota reale e cosa una stima.
export async function fetchEventIds(apiKey, sportKey) {
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/events/?apiKey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Elenco eventi non raggiungibile (HTTP ${response.status})`);
  return response.json();
}

// Regioni interrogate sull'endpoint per singolo evento. I player-prop delle Big Five stanno sui
// libri USA, i mercati di squadra anche su quelli europei: tenerle entrambe massimizza la
// copertura ed e' esattamente cio' che costa.
//
// ATTENZIONE alla quota: the-odds-api conta una richiesta per ogni combinazione
// mercato x regione x evento. Due regioni RADDOPPIANO il costo di ogni evento, e il piano
// gratuito e' di 500 richieste al mese. Il preventivo si calcola con estimateOddsRequests().
export const EVENT_ODDS_REGIONS = "eu,us";

// Mercati NON featured, disponibili solo per singolo evento. Ognuno serve una selezione che il
// modello sa gia' produrre: nessuno e' chiesto "per completezza", perche' ogni mercato in piu'
// e' una richiesta per ogni partita del turno.
export const EVENT_MARKETS_BY_GROUP = Object.freeze({
  // OVER25/UNDER25 arrivano gia' da `totals` con la chiamata di lega, che costa una richiesta
  // sola per tutto il turno; `alternate_totals` porta le altre linee (0.5, 1.5, 3.5).
  gol: ["alternate_totals", "btts"],
  squadra: ["team_totals"],
});

// Mercato dell'API che prezza ciascuna selezione sui giocatori, con la linea da leggere.
// `goal_assist` non compare: ne' player_assists ne' il marcatore prezzano "gol O assist", e
// costruirlo combinando i due significherebbe assumerne l'indipendenza — la stessa assunzione
// che estimatePlayerMarkets dichiara come propria approssimazione. Resta quota equa.
export const PLAYER_API_MARKETS = Object.freeze({
  goalscorer: { market: "player_goal_scorer_anytime", point: null },
  shot: { market: "player_shots", point: 0.5 },
  shots_2: { market: "player_shots", point: 1.5 },
  shot_on_target: { market: "player_shots_on_target", point: 0.5 },
});

export function eventMarketsFor(groups = [], playerMarkets = []) {
  const markets = new Set();
  for (const group of groups) {
    for (const market of EVENT_MARKETS_BY_GROUP[group] || []) markets.add(market);
  }
  if (groups.includes("giocatori")) {
    for (const key of playerMarkets) {
      const descriptor = PLAYER_API_MARKETS[key];
      if (descriptor) markets.add(descriptor.market);
    }
  }
  return [...markets];
}

// Preventivo in richieste, da dire PRIMA di spenderle: la chiamata di lega costa un mercato
// (le regioni sono una), quella per evento costa mercati x regioni per ogni partita.
export function estimateOddsRequests(fixtureCount, leagueMarkets, eventMarkets, regions = EVENT_ODDS_REGIONS) {
  const regionCount = regions.split(",").filter(Boolean).length;
  return leagueMarkets.length + eventMarkets.length * regionCount * fixtureCount;
}

// Richieste rimaste, dichiarate dall'API negli header di ogni risposta. Non e' un dettaglio
// cosmetico: senza, l'unico modo di sapere di aver finito la quota e' vedere fallire una
// generazione con HTTP 429.
export const oddsQuota = { used: null, remaining: null };

// Ogni chiamata passa da qui: una risposta gia' in cache e ancora valida non si ripaga. Il
// bilancio (quante servite dalla cache, quante scaricate, quanto e' vecchia la piu' vecchia)
// finisce nel resoconto: una quota vecchia mostrata come fresca sarebbe peggio di una mancante.
async function fetchOddsCached(key, loader, ledger) {
  const ttlMinutes = ledger.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  if (!ledger.force) {
    const hit = readCachedOdds(key, { ttlMinutes });
    if (hit) {
      ledger.fromCache += 1;
      ledger.oldestMinutes = Math.max(ledger.oldestMinutes, hit.ageMinutes);
      return hit.value;
    }
  }
  const value = await loader();
  if (value !== null && value !== undefined) {
    writeCachedOdds(key, value);
    ledger.fetched += 1;
  }
  return value;
}

function readQuotaHeaders(response) {
  const used = Number(response.headers?.get?.("x-requests-used"));
  const remaining = Number(response.headers?.get?.("x-requests-remaining"));
  if (Number.isFinite(used)) oddsQuota.used = used;
  if (Number.isFinite(remaining)) oddsQuota.remaining = remaining;
}

export async function fetchEventOdds(apiKey, sportKey, eventId, markets, regions = EVENT_ODDS_REGIONS) {
  if (!markets.length) return null;
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(eventId)}/odds/`
    + `?apiKey=${encodeURIComponent(apiKey)}&regions=${encodeURIComponent(regions)}`
    + `&markets=${encodeURIComponent(markets.join(","))}&oddsFormat=decimal`;
  const response = await fetch(url);
  readQuotaHeaders(response);
  if (!response.ok) return null; // piano/mercato non disponibile per questo evento: gestito, non fatale
  return response.json();
}

// Indice medio di tutti gli esiti di un evento, su tutti i mercati e tutti i bookmaker, con
// chiave `soggetto|esito|linea`. Il soggetto e' il giocatore o la squadra quando l'API lo
// specifica (`description`), vuoto per i mercati che riguardano la partita intera.
//
// Difensivo per costruzione: la forma esatta delle risposte non e' verificabile da qui, quindi
// un blocco che non ha la forma attesa viene ignorato invece di far fallire tutto il resto.
export function indexEventOutcomes(eventOdds) {
  const buckets = new Map();
  for (const bookmaker of eventOdds?.bookmakers || []) {
    for (const marketBlock of bookmaker.markets || []) {
      const marketKey = marketBlock?.key;
      if (!marketKey) continue;
      for (const outcome of marketBlock.outcomes || []) {
        const price = Number(outcome?.price);
        if (!Number.isFinite(price) || price <= 1) continue;
        const subject = outcome.description ?? "";
        const point = outcome.point === undefined || outcome.point === null ? "" : Number(outcome.point);
        const key = `${marketKey}|${subject}|${outcome.name ?? ""}|${point}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(price);
      }
    }
  }
  const averaged = new Map();
  for (const [key, prices] of buckets) {
    averaged.set(key, prices.reduce((sum, price) => sum + price, 0) / prices.length);
  }
  return averaged;
}

const outcomeAt = (index, market, subject, name, point = "") => (
  index.get(`${market}|${subject}|${name}|${point}`) ?? null
);

// Dai mercati per evento estrae ciò che il modello sa consumare: linee Over/Under aggiuntive,
// Gol/No gol, e "la squadra segna" (che e' il team total sopra 0.5).
export function teamMarketsFromEventOdds(index, event) {
  const totals = {};
  for (const line of TOTALS_LINES) {
    const over = outcomeAt(index, "alternate_totals", "", "Over", line);
    const under = outcomeAt(index, "alternate_totals", "", "Under", line);
    if (over || under) totals[line] = { over, under };
  }
  const teamTotal = (team) => outcomeAt(index, "team_totals", team, "Over", 0.5);
  return {
    totals,
    btts: {
      yes: outcomeAt(index, "btts", "", "Yes"),
      no: outcomeAt(index, "btts", "", "No"),
    },
    teamScores: {
      home: teamTotal(event.home_team),
      away: teamTotal(event.away_team),
    },
  };
}

// I nostri nomi vengono da ESPN e sono abbreviati — "F. Conceição", "R. Kolo Muani" — mentre
// l'API di quote usa il nome completo. Con l'uguaglianza esatta fra nomi normalizzati non si
// agganciava praticamente nessun giocatore: solo i mononimi come "Bremer". Si confrontano quindi
// i soli token di cognome (le iniziali puntate si scartano), e si pretende che il cognome sia
// contenuto in un UNICO nome dell'API.
//
// L'unicita' non e' pignoleria: Marcus e Khéphren Thuram giocano nello stesso campionato e a
// volte nella stessa partita. Con due candidati si preferisce quello la cui iniziale coincide,
// e se resta ambiguo non si restituisce alcun prezzo — una quota attribuita al fratello sbagliato
// e' peggio di una quota mancante.
function surnameTokens(name) {
  return normalizeTeamName(name).split(" ").filter((token) => token.length > 1);
}

function firstInitial(name) {
  return normalizeTeamName(name).split(" ").filter(Boolean)[0]?.[0] ?? "";
}

// Prezzo di una selezione sui giocatori, per il mercato del modello (non quello dell'API).
export function playerMarketPrice(index, playerName, modelMarketKey) {
  const descriptor = PLAYER_API_MARKETS[modelMarketKey];
  if (!descriptor) return null;
  const point = descriptor.point === null ? "" : descriptor.point;
  const wanted = surnameTokens(playerName);
  if (!wanted.length) return null;

  const bySubject = new Map();
  for (const [key, price] of index) {
    const [market, subject, name, line] = key.split("|");
    if (market !== descriptor.market || line !== String(point)) continue;
    // "Over" per i tiri, "Yes" o il nome stesso per il marcatore: l'API non e' uniforme fra
    // mercati, quindi si accetta qualunque esito affermativo e si scarta solo l'opposto.
    if (name === "Under" || name === "No") continue;
    const candidate = surnameTokens(subject);
    if (!wanted.every((token) => candidate.includes(token))) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, price);
  }
  if (bySubject.size === 1) return [...bySubject.values()][0];
  if (bySubject.size > 1) {
    const initial = firstInitial(playerName);
    const sameInitial = [...bySubject].filter(([subject]) => firstInitial(subject) === initial);
    if (sameInitial.length === 1) return sameInitial[0][1];
  }
  return null;
}

// Mercati sui giocatori disponibili per la schedina. Ognuno legge un campo diverso di
// estimatePlayerMarkets; solo il marcatore ha una quota reale ottenibile (player-prop di
// the-odds-api), gli altri usano la quota equa del modello.
// Quali di questi abbiano una quota reale non e' scritto qui: lo dice PLAYER_API_MARKETS, che e'
// anche cio' che determina i mercati chiesti all'API. Due elenchi separati erano gia' bastati a
// far divergere due strade (difetto 9).
const PLAYER_MARKETS = [
  { key: "goalscorer", field: "anytimeScorerProbability", label: (name) => `${name} marcatore` },
  { key: "goal_assist", field: "goalOrAssistProbability", label: (name) => `${name} gol o assist` },
  { key: "shot", field: "shotProbability", label: (name) => `${name} almeno 1 tiro` },
  { key: "shots_2", field: "multiShotProbability", label: (name) => `${name} almeno 2 tiri` },
  { key: "shot_on_target", field: "shotOnTargetProbability", label: (name) => `${name} almeno 1 tiro in porta` },
];

// Genera i candidati sui giocatori con la STESSA fixtureIndex delle giocate sul risultato di
// quella partita: il costruttore della schedina sceglie al più una selezione per fixtureIndex,
// quindi una giocata sul risultato e una su un marcatore della stessa partita restano
// automaticamente alternative escludenti. È così che si evita di moltiplicare come
// indipendenti due probabilità in realtà correlate (un attaccante segna più facilmente se la
// sua squadra vince nettamente) senza dover modellare esplicitamente quella correlazione — e
// vale anche tra due giocatori DELLA STESSA partita, che sarebbero correlati allo stesso modo.
export function buildPlayerCandidates(entries, playerContextByTeam, options = {}) {
  const {
    minLegProbability = 0.35,
    maxPlayersPerTeam = 3,
    playerIndexByFixture = null,
    markets = ["goalscorer"],
    minPlayerConfidence = 0.1,
  } = options;
  const wanted = PLAYER_MARKETS.filter((market) => markets.includes(market.key));
  const candidates = [];
  entries.forEach((entry, fixtureIndex) => {
    const fixtureReliability = clampReliability(entry.result?.quality?.score);
    [
      { team: entry.fixture.home_team, teamLambda: entry.result.lambdaHome, teamGoalsFor: entry.result.home?.gf5 || 0 },
      { team: entry.fixture.away_team, teamLambda: entry.result.lambdaAway, teamGoalsFor: entry.result.away?.gf5 || 0 },
    ].forEach(({ team, teamLambda, teamGoalsFor }) => {
      const players = (playerContextByTeam?.[team]?.players || [])
        .slice()
        .sort((left, right) => (right.impact ?? 0) - (left.impact ?? 0))
        .slice(0, maxPlayersPerTeam);
      players.forEach((player) => {
        const estimates = estimatePlayerMarkets(player, teamLambda, teamGoalsFor);
        // Un giocatore con pochissimi minuti campionati ha stime dominate dal prior di ruolo:
        // utili da mostrare come contesto, non da mettere in una schedina come se fossero una
        // previsione su quel giocatore specifico.
        if (estimates.confidence < minPlayerConfidence) return;
        wanted.forEach((market) => {
          const probability = estimates[market.field];
          if (!Number.isFinite(probability) || probability < minLegProbability) return;
          const index = playerIndexByFixture?.get(fixtureIndex);
          const liveOdds = index ? playerMarketPrice(index, player.name, market.key) : null;
          const fairOdds = 1 / Math.max(0.02, probability);
          candidates.push({
            fixtureIndex,
            fixtureLabel: `${entry.fixture.home_team} - ${entry.fixture.away_team}`,
            fixtureDate: entry.fixture.date,
            homeTeam: entry.fixture.home_team,
            awayTeam: entry.fixture.away_team,
            competitionId: entry.fixture.competition_id,
            key: `${market.key}:${player.id ?? player.name}`,
            group: "giocatori",
            label: market.label(player.name),
            probability,
            odds: liveOdds ?? fairOdds,
            fairOdds,
            source: liveOdds !== null && liveOdds !== undefined ? "market" : "model",
            // L'affidabilità di una selezione su un giocatore è il prodotto di due incertezze
            // distinte: quanto il modello conosce la PARTITA e quanto conosce il GIOCATORE.
            reliability: clampReliability(fixtureReliability * estimates.confidence),
          });
        });
      });
    });
  });
  return candidates;
}

// Le sole partite su cui ha senso costruire una giocata: non ancora concluse e non in una data
// passata. Un turno non e' un blocco atomico — la giornata 3 di Liga del 2026 va dal 25 al 29
// agosto — quindi al momento della generazione parte del turno puo' essere gia' stata giocata.
// Senza questo filtro la schedina proponeva scommesse su partite finite il giorno prima, e
// contava quelle partite nel minimo di selezioni richieste.
//
// `completed` da solo non basta: una gara di stamattina puo' non essere ancora stata ingerita
// dalla pipeline. La data e' la seconda rete, ed e' la stessa regola che segue un'API di quote,
// che smette di esporre un evento quando comincia.
export function upcomingFixtures(fixtures, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return (fixtures || []).filter((fixture) => !fixture.completed && String(fixture.date) >= today);
}

export async function generateSlip({
  payload, competitionId,
  legs = 3,
  confidence = "media",
  marketGroups = DEFAULT_MARKET_GROUPS,
  playerMarkets = ["goalscorer"],
  maxPlayersPerTeam = 3,
  apiKey = "",
  round = null,
  // Campionato gia' scelto a mano dall'utente perche' la scoperta automatica non era univoca.
  // Passa da qui invece di avere un percorso suo: una seconda funzione che rifacesse lo stesso
  // lavoro tornerebbe a divergere da questa alla prima modifica (difetto 9).
  sportKey = null,
  // Riscarica le quote ignorando la cache locale. Serve quando il turno si avvicina e i prezzi
  // si sono mossi: la cache fa risparmiare richieste, non deve poter mostrare prezzi vecchi
  // senza dirlo.
  forceRefresh = false,
  // Quante schedine produrre in un colpo solo, e la quota minima ammessa per selezione.
  seriesCount = 10,
  minLegOdds = DEFAULT_MIN_LEG_ODDS,
}) {
  const catalog = buildCompetitionCatalog(payload);
  const competition = catalog.find((entry) => entry.id === competitionId);
  if (!competition || !competition.available) throw new Error("Nessuna partita disponibile per questa lega nel dataset locale.");

  const calendar = buildMatchdays(payload, competitionId);
  const matchday = (round !== null && calendar.matchdays?.find((item) => item.round === Number(round)))
    || calendar.firstUpcoming
    || calendar.matchdays?.[0];
  if (!matchday) throw new Error("Nessun turno futuro trovato per questa lega.");

  const requestedLegs = Math.max(1, Math.round(legs));
  const fixtures = upcomingFixtures(matchday.fixtures);
  if (!fixtures.length) {
    throw new Error(
      `Il turno ${matchday.round} risulta gia' giocato per intero: non c'e' nulla su cui `
      + "costruire una schedina, e nessuna API di quote espone eventi conclusi.",
    );
  }
  if (fixtures.length < requestedLegs) {
    const played = matchday.fixtures.length - fixtures.length;
    throw new Error(
      `Il turno ${matchday.round} ha ${fixtures.length} partite ancora da giocare`
      + `${played ? ` (${played} gia' concluse)` : ""}: non si possono comporre `
      + `${requestedLegs} selezioni da partite diverse.`,
    );
  }

  const { predictions } = predictMatchdayFromMatches(payload.matches, fixtures, { ...modelInputs(), competitionId });

  // Le quote reali sono un MIGLIORAMENTO opzionale, non un prerequisito: senza chiave API la
  // schedina si costruisce lo stesso sulle quote eque del modello. Prima era il contrario — la
  // pagina non produceva nulla senza chiave — il che rendeva inutilizzabile la funzione
  // principale del sito per chiunque non avesse un account su un servizio di quote.
  let entries = predictions.map(({ fixture, result }) => ({
    fixture, result, odds: { home: null, draw: null, away: null }, matched: false,
  }));
  let sportTitle = null;
  let oddsError = null;
  let requestEstimate = 0;
  const cacheLedger = { force: forceRefresh, fromCache: 0, fetched: 0, oldestMinutes: 0 };
  if (apiKey) {
    try {
      const discovery = sportKey
        ? { key: sportKey, title: sportKey, candidates: [] }
        : await discoverSportKey(apiKey, competitionId);
      if (!discovery.key) {
        const error = new Error("Campionato non individuato automaticamente tra le quote disponibili.");
        error.candidates = discovery.candidates;
        throw error;
      }
      sportTitle = discovery.title;
      const leagueMarkets = oddsMarketsFor(marketGroups);
      const leagueOdds = await fetchOddsCached(
        leagueOddsKey(discovery.key, matchday.round, leagueMarkets),
        () => fetchLeagueOdds(apiKey, discovery.key, leagueMarkets),
        cacheLedger,
      );
      entries = matchOddsToFixtures(predictions, leagueOdds);
      // I mercati non-featured richiedono una chiamata per partita: si fanno solo se uno dei
      // gruppi selezionati li consuma davvero, e il preventivo finisce nel resoconto.
      const eventMarkets = eventMarketsFor(marketGroups, playerMarkets);
      if (eventMarkets.length) {
        const coverage = await collectEventOdds(apiKey, discovery.key, entries, eventMarkets, cacheLedger);
        entries.playerIndexByFixture = coverage.playerIndexByFixture;
        entries.eventOddsCoverage = coverage.summary;
      }
      requestEstimate = estimateOddsRequests(fixtures.length, leagueMarkets, eventMarkets);
    } catch (error) {
      if (error.candidates) throw error; // scelta manuale del campionato: la gestisce la pagina
      // Le quote sono opzionali: un errore di rete non deve impedire la generazione della
      // schedina, ma va riportato invece di far sembrare "modello" una quota mancante.
      oddsError = error.message;
    }
  }

  const marketCandidates = buildMarketCandidates(entries, { groups: marketGroups });
  const playerCandidates = marketGroups.includes("giocatori") && playerMarkets.length
    ? buildPlayerCandidates(entries, payload.player_context, {
      minLegProbability: 0,
      maxPlayersPerTeam,
      markets: playerMarkets,
      playerIndexByFixture: entries.playerIndexByFixture || null,
    })
    : [];
  const candidates = [...marketCandidates, ...playerCandidates];

  const slipOptions = { legs: requestedLegs, confidence, minLegOdds };
  const slips = buildSlipSeries(candidates, { ...slipOptions, count: seriesCount });
  return {
    slips,
    // La prima della serie e' la schedina ottima, la stessa che buildSlip restituirebbe da sola.
    slip: slips[0] || null,
    matchday,
    entries,
    candidates,
    sportTitle,
    oddsError,
    eventOddsCoverage: entries.eventOddsCoverage || null,
    requestEstimate,
    // Il preventivo dice quanto sarebbe costato scaricare tutto; il bilancio della cache dice
    // quanto e' costato davvero.
    oddsCache: { ...cacheLedger },
    quota: { ...oddsQuota },
    oddsCoverage: {
      matched: entries.filter((entry) => entry.matched).length,
      total: entries.length,
    },
  };
}

// Una chiamata per evento (i player-prop non sono disponibili in blocco): isolata qui perché
// generateSlip resti leggibile e perché ogni fallimento sia contenuto al singolo evento.
// Una sola chiamata per evento, con TUTTI i mercati non-featured che servono al turno: quelli
// di squadra (linee Over/Under aggiuntive, Gol/No gol, squadra che segna) finiscono dentro
// entry.odds accanto a quelli della chiamata di lega, quelli sui giocatori restano indicizzati
// per partita. Chiedere gli stessi mercati in due giri costerebbe il doppio, e ogni mercato per
// ogni evento e' una richiesta del piano.
async function collectEventOdds(apiKey, sportKey, entries, markets, ledger) {
  const playerIndexByFixture = new Map();
  let resolvedEvents = 0;
  // Le due ragioni per cui una partita resta senza quote sono diverse e vanno distinte: "non
  // l'ho trovata nel catalogo eventi" e' un problema nostro (nomi, date), "il mercato non e'
  // offerto per questo evento" e' una scelta del bookmaker. Contarle insieme rendeva
  // impossibile capire quale delle due stesse succedendo.
  let unmatchedFixtures = 0;
  let marketUnavailable = 0;
  try {
    const events = await fetchEventIds(apiKey, sportKey);
    // La STESSA assegnazione delle quote 1X2, chiamata una volta sul turno intero. Le due
    // strade avevano due matcher diversi e sulle stesse fixture davano risultati diversi —
    // 1X2 abbinate 10 su 10, marcatori 7 su 10 — e la differenza sembrava una lacuna del
    // bookmaker invece che un'incoerenza interna (difetto 9).
    const assigned = assignEventsToFixtures(entries.map(({ fixture }) => fixture), events);
    for (let fixtureIndex = 0; fixtureIndex < entries.length; fixtureIndex += 1) {
      const { fixture } = entries[fixtureIndex];
      const event = assigned.get(fixtureIndex);
      if (!event) {
        unmatchedFixtures += 1;
        continue;
      }
      try {
        const eventOdds = await fetchOddsCached(
          eventOddsKey(sportKey, event.id, markets),
          () => fetchEventOdds(apiKey, sportKey, event.id, markets),
          ledger,
        );
        if (!eventOdds) {
          marketUnavailable += 1;
          continue;
        }
        const index = indexEventOutcomes(eventOdds);
        const team = teamMarketsFromEventOdds(index, event);
        const target = entries[fixtureIndex].odds;
        // Le linee dell'endpoint per evento completano quelle della chiamata di lega senza
        // sovrascriverle: `totals` di lega e' il consenso su tutti i libri della regione,
        // `alternate_totals` porta le linee che quella non copre.
        for (const [line, prices] of Object.entries(team.totals)) {
          if (!target.totals[line]) target.totals[line] = prices;
        }
        if (team.btts.yes || team.btts.no) target.btts = team.btts;
        if (team.teamScores.home || team.teamScores.away) target.teamScores = team.teamScores;
        playerIndexByFixture.set(fixtureIndex, index);
        resolvedEvents += 1;
      } catch (error) {
        console.error(`Quote per evento ${fixture.home_team}-${fixture.away_team}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Elenco eventi non disponibile: ${error.message}`);
  }
  return {
    playerIndexByFixture,
    summary: {
      eventsWithLiveOdds: resolvedEvents,
      totalFixtures: entries.length,
      unmatchedFixtures,
      marketUnavailable,
      markets,
      region: EVENT_ODDS_REGIONS,
    },
  };
}
