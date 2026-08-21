import { predictMatchdayFromMatches, estimatePlayerMarkets } from "./model.js";
import { buildCompetitionCatalog, buildMatchdays } from "./matchdays.js";

export const ODDS_API_KEY_STORAGE = "serie-a-predictor-odds-api-key";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Ogni voce: termini di ricerca in ordine di priorità (il primo che produce ESATTAMENTE
// un risultato tra i campionati attivi vince) più un blocklist per escludere campionati
// femminili/giovanili/riserve che potrebbero condividere una parola chiave (es.
// "bundesliga" da solo matcherebbe anche "Frauen-Bundesliga" o "2. Bundesliga").
// I sport_key esatti di the-odds-api.com non sono verificabili dal vivo da qui (nessun
// dominio di quote nella rete consentita): per questo la scoperta è dinamica via /v4/sports/
// invece di un valore hardcoded, con fallback a scelta manuale se il match non è univoco.
export const LEAGUE_SEARCH_TERMS = {
  "eng.1": ["epl", "premier league"],
  "esp.1": ["la liga", "laliga"],
  "ita.1": ["serie a"],
  "ger.1": ["bundesliga"],
  "fra.1": ["ligue 1", "ligue one"],
};
const EXCLUDE_TERMS = ["women", "frauen", "u21", "u20", "u19", "youth", "reserve", " 2", "ii ", "b -"];

const NAME_OVERRIDES = {
  // Nomi canonici della pipeline (spesso italianizzati, vedi NAME_MAP in
  // update_europe_data.py) -> forma inglese più probabile usata dalle API di quote.
  "Bayern Monaco": "Bayern Munich", "Dortmund": "Borussia Dortmund", "Lipsia": "RB Leipzig",
  "Francoforte": "Eintracht Frankfurt", "PSG": "Paris Saint Germain", "Marsiglia": "Marseille",
  "Lione": "Lyon", "Atletico Madrid": "Atletico Madrid", "Man United": "Manchester United",
  "Man City": "Manchester City", "Newcastle": "Newcastle United", "Wolves": "Wolverhampton Wanderers",
};

function normalizeTeamName(name) {
  const mapped = NAME_OVERRIDES[name] || name;
  return mapped
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|afc|calcio|ssc|ac)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesMatch(pipelineName, oddsApiName) {
  const left = normalizeTeamName(pipelineName);
  const right = normalizeTeamName(oddsApiName);
  return left === right || left.includes(right) || right.includes(left);
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

export async function fetchLeagueOdds(apiKey, sportKey) {
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=eu&markets=h2h&oddsFormat=decimal`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Quote non raggiungibili (HTTP ${response.status}) ${body.slice(0, 200)}`);
  }
  return response.json();
}

function averageOutcomeOdds(event, outcomeName) {
  const prices = [];
  (event.bookmakers || []).forEach((bookmaker) => {
    const market = (bookmaker.markets || []).find((entry) => entry.key === "h2h");
    const outcome = market?.outcomes?.find((entry) => entry.name === outcomeName);
    if (outcome && Number.isFinite(outcome.price) && outcome.price > 1) prices.push(outcome.price);
  });
  if (!prices.length) return null;
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

// Abbina ogni fixture del turno (per nome squadra, tollerante a forma inglese/italianizzata,
// e data) alle quote medie di mercato per 1/X/2. Fixture senza corrispondenza tornano con
// odds: null sui tre esiti: restano visibili come "senza quote" invece di sparire.
export function matchOddsToFixtures(predictions, oddsEvents) {
  return predictions.map(({ fixture, result }) => {
    const event = oddsEvents.find((candidate) => {
      const sameDay = String(candidate.commence_time || "").slice(0, 10) === String(fixture.date).slice(0, 10);
      return sameDay
        && namesMatch(fixture.home_team, candidate.home_team || "")
        && namesMatch(fixture.away_team, candidate.away_team || "");
    });
    const odds = event ? {
      home: averageOutcomeOdds(event, event.home_team),
      draw: averageOutcomeOdds(event, "Draw"),
      away: averageOutcomeOdds(event, event.away_team),
    } : { home: null, draw: null, away: null };
    return { fixture, result, odds, matched: Boolean(event) };
  });
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

export async function fetchPlayerPropOdds(apiKey, sportKey, eventId, market = "player_goal_scorer_anytime") {
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(eventId)}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=us&markets=${encodeURIComponent(market)}&oddsFormat=decimal`;
  const response = await fetch(url);
  if (!response.ok) return null; // piano/mercato non disponibile per questo evento: gestito, non fatale
  return response.json();
}

// Difensivo per costruzione: la forma esatta della risposta player-prop non è verificata dal
// vivo, quindi ignora blocchi che non hanno la forma attesa invece di lanciare un'eccezione
// su un formato leggermente diverso da quello documentato.
export function parseAnytimeScorerOdds(eventOdds, market = "player_goal_scorer_anytime") {
  const prices = new Map();
  for (const bookmaker of eventOdds?.bookmakers || []) {
    for (const marketBlock of bookmaker.markets || []) {
      if (marketBlock.key !== market) continue;
      for (const outcome of marketBlock.outcomes || []) {
        const name = outcome.description || outcome.name;
        const price = Number(outcome.price);
        if (!name || !Number.isFinite(price) || price <= 1) continue;
        if (!prices.has(name)) prices.set(name, []);
        prices.get(name).push(price);
      }
    }
  }
  const averaged = new Map();
  for (const [name, values] of prices) {
    averaged.set(name, values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return averaged;
}

function matchPlayerOdds(playerName, oddsMap) {
  const normalized = normalizeTeamName(playerName); // stessa normalizzazione delle squadre, funziona anche su nomi persona
  for (const [oddsName, price] of oddsMap) {
    if (normalizeTeamName(oddsName) === normalized) return price;
  }
  return null;
}

// Genera candidati "marcatore in qualsiasi momento" con la STESSA fixtureIndex delle giocate
// 1X2 di quella partita: bestAccumulator sceglie al più un candidato per fixtureIndex, quindi
// una selezione sul risultato e una sul marcatore della stessa partita restano
// automaticamente alternative reciprocamente esclusive nella ricerca, non combinabili nella
// stessa schedina — è così che si evita di trattare come indipendenti due eventi in realtà
// correlati (un giocatore segna più facilmente se la sua squadra vince nettamente), senza
// dover modellare esplicitamente quella correlazione.
export function buildPlayerCandidates(entries, playerContextByTeam, options = {}) {
  const { minLegProbability = 0.35, maxPlayersPerTeam = 3, oddsByFixture = null } = options;
  const candidates = [];
  entries.forEach((entry, fixtureIndex) => {
    [
      { team: entry.fixture.home_team, teamLambda: entry.result.lambdaHome, teamGoalsFor: entry.result.home?.gf5 || 0 },
      { team: entry.fixture.away_team, teamLambda: entry.result.lambdaAway, teamGoalsFor: entry.result.away?.gf5 || 0 },
    ].forEach(({ team, teamLambda, teamGoalsFor }) => {
      const players = (playerContextByTeam?.[team]?.players || [])
        .slice()
        .sort((left, right) => (right.impact ?? 0) - (left.impact ?? 0))
        .slice(0, maxPlayersPerTeam);
      players.forEach((player) => {
        const markets = estimatePlayerMarkets(player, teamLambda, teamGoalsFor);
        if (markets.anytimeScorerProbability < minLegProbability) return;
        const liveOdds = oddsByFixture ? matchPlayerOdds(player.name, oddsByFixture.get(fixtureIndex) || new Map()) : null;
        const odds = liveOdds ?? 1 / Math.max(0.02, markets.anytimeScorerProbability);
        candidates.push({
          fixtureIndex,
          fixtureLabel: `${entry.fixture.home_team} - ${entry.fixture.away_team}`,
          key: "goalscorer",
          label: `${player.name} marcatore`,
          odds,
          probability: markets.anytimeScorerProbability,
          source: liveOdds !== null ? "market" : "model",
        });
      });
    });
  });
  return candidates;
}

export async function generateSlip({
  apiKey, payload, competitionId, targetOdds, tolerance = 0.15, minLegProbability = 0.35,
  includePlayerMarkets = false, maxPlayersPerTeam = 3,
}) {
  const catalog = buildCompetitionCatalog(payload);
  const competition = catalog.find((entry) => entry.id === competitionId);
  if (!competition || !competition.available) throw new Error("Nessuna partita disponibile per questa lega nel dataset locale.");

  const calendar = buildMatchdays(payload, competitionId);
  const matchday = calendar.firstUpcoming || calendar.matchdays?.[0];
  if (!matchday) throw new Error("Nessun turno futuro trovato per questa lega.");

  const { predictions } = predictMatchdayFromMatches(payload.matches, matchday.fixtures, { competitionId });

  const discovery = await discoverSportKey(apiKey, competitionId);
  if (!discovery.key) {
    const error = new Error("Campionato non individuato automaticamente tra le quote disponibili.");
    error.candidates = discovery.candidates;
    throw error;
  }

  const oddsEvents = await fetchLeagueOdds(apiKey, discovery.key);
  const entries = matchOddsToFixtures(predictions, oddsEvents);
  let candidates = buildCandidates(entries, minLegProbability);
  let playerOddsCoverage = null;

  if (includePlayerMarkets) {
    const oddsByFixture = new Map();
    let resolvedEvents = 0;
    try {
      const events = await fetchEventIds(apiKey, discovery.key);
      for (let fixtureIndex = 0; fixtureIndex < entries.length; fixtureIndex += 1) {
        const { fixture } = entries[fixtureIndex];
        const event = events.find((candidate) => {
          const sameDay = String(candidate.commence_time || "").slice(0, 10) === String(fixture.date).slice(0, 10);
          return sameDay && normalizeTeamName(fixture.home_team) === normalizeTeamName(candidate.home_team || "")
            && normalizeTeamName(fixture.away_team) === normalizeTeamName(candidate.away_team || "");
        });
        if (!event) continue;
        try {
          const eventOdds = await fetchPlayerPropOdds(apiKey, discovery.key, event.id);
          if (eventOdds) {
            oddsByFixture.set(fixtureIndex, parseAnytimeScorerOdds(eventOdds));
            resolvedEvents += 1;
          }
        } catch (error) {
          console.error(`Quote giocatori ${fixture.home_team}-${fixture.away_team}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`Elenco eventi per mercati giocatori non disponibile: ${error.message}`);
    }
    const playerCandidates = buildPlayerCandidates(entries, payload.player_context, {
      minLegProbability, maxPlayersPerTeam, oddsByFixture,
    });
    candidates = [...candidates, ...playerCandidates];
    playerOddsCoverage = { eventsWithLiveOdds: resolvedEvents, totalFixtures: entries.length };
  }

  const slip = bestAccumulator(candidates, targetOdds, tolerance);
  return { matchday, entries, candidates, slip, sportTitle: discovery.title, playerOddsCoverage };
}
