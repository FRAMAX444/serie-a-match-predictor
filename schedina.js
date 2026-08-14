import { predictMatchdayFromMatches } from "./model.js";
import { buildCompetitionCatalog, buildMatchdays } from "./matchdays.js";

export const ODDS_API_KEY_STORAGE = "serie-a-predictor-odds-api-key";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const HOUR_MS = 3600000;

export const LEAGUE_SEARCH_TERMS = {
  "eng.1": ["epl", "premier league"],
  "esp.1": ["la liga", "laliga"],
  "ita.1": ["serie a"],
  "ger.1": ["bundesliga"],
  "fra.1": ["ligue 1", "ligue one"],
};
const EXCLUDE_TERMS = ["women", "frauen", "u21", "u20", "u19", "youth", "reserve", " 2", "ii ", "b -"];

const NAME_OVERRIDES = {
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

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function fixtureTimestamp(fixture) {
  const kickoff = Date.parse(fixture.kickoff || "");
  if (Number.isFinite(kickoff)) return kickoff;
  const date = String(fixture.date || "").slice(0, 10);
  const noon = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(noon) ? noon : NaN;
}

function eventMatchesFixture(fixture, candidate) {
  if (!namesMatch(fixture.home_team, candidate.home_team || "")
    || !namesMatch(fixture.away_team, candidate.away_team || "")) return false;
  const fixtureTime = fixtureTimestamp(fixture);
  const eventTime = Date.parse(candidate.commence_time || "");
  if (Number.isFinite(fixtureTime) && Number.isFinite(eventTime)) {
    return Math.abs(eventTime - fixtureTime) <= 36 * HOUR_MS;
  }
  return String(candidate.commence_time || "").slice(0, 10) === String(fixture.date || "").slice(0, 10);
}

function outcomeOddsSummary(event, outcomeName) {
  const offers = [];
  (event.bookmakers || []).forEach((bookmaker) => {
    const market = (bookmaker.markets || []).find((entry) => entry.key === "h2h");
    const outcome = market?.outcomes?.find((entry) => entry.name === outcomeName);
    if (outcome && Number.isFinite(outcome.price) && outcome.price > 1) {
      offers.push({
        price: outcome.price,
        bookmaker: bookmaker.title || bookmaker.key || "Bookmaker",
      });
    }
  });
  if (!offers.length) return { consensus: null, best: null, bookmaker: null };
  const best = offers.reduce((current, offer) => offer.price > current.price ? offer : current, offers[0]);
  return {
    consensus: median(offers.map((offer) => offer.price)),
    best: best.price,
    bookmaker: best.bookmaker,
  };
}

function fairMarketProbabilities(odds) {
  const home = Number(odds?.home);
  const draw = Number(odds?.draw);
  const away = Number(odds?.away);
  if (![home, draw, away].every((value) => Number.isFinite(value) && value > 1)) return null;
  const inverse = { home: 1 / home, draw: 1 / draw, away: 1 / away };
  const overround = inverse.home + inverse.draw + inverse.away;
  if (!(overround > 0)) return null;
  return {
    home: inverse.home / overround,
    draw: inverse.draw / overround,
    away: inverse.away / overround,
    overround,
  };
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
    /* storage non disponibile */
  }
}

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

// Per ogni esito conserviamo due valori distinti:
// - consensusOdds: mediana delle quote disponibili, robusta agli outlier e usata per
//   stimare la probabilità di mercato de-vigata;
// - odds: miglior quota effettivamente trovata, usata per payout ed expected value.
export function matchOddsToFixtures(predictions, oddsEvents) {
  return predictions.map(({ fixture, result }) => {
    const event = oddsEvents.find((candidate) => eventMatchesFixture(fixture, candidate));
    if (!event) {
      return {
        fixture,
        result,
        odds: { home: null, draw: null, away: null },
        consensusOdds: { home: null, draw: null, away: null },
        bookmakers: { home: null, draw: null, away: null },
        matched: false,
      };
    }

    const home = outcomeOddsSummary(event, event.home_team);
    const draw = outcomeOddsSummary(event, "Draw");
    const away = outcomeOddsSummary(event, event.away_team);
    return {
      fixture,
      result,
      odds: { home: home.best, draw: draw.best, away: away.best },
      consensusOdds: { home: home.consensus, draw: draw.consensus, away: away.consensus },
      bookmakers: { home: home.bookmaker, draw: draw.bookmaker, away: away.bookmaker },
      matched: true,
    };
  });
}

export function buildCandidates(entries, minLegProbability = 0.35, rawOptions = {}) {
  const options = typeof rawOptions === "object" && rawOptions ? rawOptions : {};
  const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : null;
  const candidates = [];
  entries.forEach((entry, fixtureIndex) => {
    if (!entry.matched) return;
    const market = fairMarketProbabilities(entry.consensusOdds || entry.odds);
    const selections = [
      {
        key: "1",
        label: `${entry.fixture.home_team} (1)`,
        odds: entry.odds.home,
        probability: entry.result.probabilities.homeWin,
        marketProbability: market?.home ?? null,
        bookmaker: entry.bookmakers?.home ?? null,
      },
      {
        key: "X",
        label: "Pareggio (X)",
        odds: entry.odds.draw,
        probability: entry.result.probabilities.draw,
        marketProbability: market?.draw ?? null,
        bookmaker: entry.bookmakers?.draw ?? null,
      },
      {
        key: "2",
        label: `${entry.fixture.away_team} (2)`,
        odds: entry.odds.away,
        probability: entry.result.probabilities.awayWin,
        marketProbability: market?.away ?? null,
        bookmaker: entry.bookmakers?.away ?? null,
      },
    ];

    selections.forEach((selection) => {
      if (!Number.isFinite(selection.odds) || selection.odds <= 1 || selection.probability < minLegProbability) return;
      const edge = Number.isFinite(selection.marketProbability)
        ? selection.probability - selection.marketProbability
        : null;
      if (minEdge !== null && (!Number.isFinite(edge) || edge < minEdge)) return;
      candidates.push({
        fixtureIndex,
        fixtureLabel: `${entry.fixture.home_team} - ${entry.fixture.away_team}`,
        ...selection,
        edge,
        expectedValue: selection.probability * selection.odds - 1,
        marketOverround: market?.overround ?? null,
      });
    });
  });
  return candidates;
}

function objectiveScore(strategy, probability, odds) {
  if (strategy === "expectedValue") return probability * odds - 1;
  return probability;
}

function accumulatorMetrics(legs, combinedOdds, combinedProbability) {
  const marketProbabilities = legs.map((leg) => leg.marketProbability).filter(Number.isFinite);
  const combinedMarketProbability = marketProbabilities.length === legs.length
    ? marketProbabilities.reduce((value, probability) => value * probability, 1)
    : null;
  return {
    combinedExpectedValue: combinedProbability * combinedOdds - 1,
    combinedMarketProbability,
    combinedMarketEdge: Number.isFinite(combinedMarketProbability)
      ? combinedProbability - combinedMarketProbability
      : null,
    averageLegEdge: legs.every((leg) => Number.isFinite(leg.edge))
      ? legs.reduce((sum, leg) => sum + leg.edge, 0) / legs.length
      : null,
  };
}

export function bestAccumulator(candidates, targetOdds, tolerance = 0.15, maxLegs = 8, rawOptions = {}) {
  if (typeof maxLegs === "object" && maxLegs) {
    rawOptions = maxLegs;
    maxLegs = Number(rawOptions.maxLegs) || 8;
  }
  const strategy = rawOptions?.objective === "expectedValue" ? "expectedValue" : "probability";
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

  function consider(combinedOdds, combinedProbability) {
    if (combinedOdds < minTarget || !chosen.length) return;
    const score = objectiveScore(strategy, combinedProbability, combinedOdds);
    const distance = Math.abs(Math.log(combinedOdds / targetOdds));
    if (!best
      || score > best.objectiveScore + 1e-12
      || (Math.abs(score - best.objectiveScore) <= 1e-12 && distance < best.targetDistance - 1e-12)
      || (Math.abs(score - best.objectiveScore) <= 1e-12 && Math.abs(distance - best.targetDistance) <= 1e-12 && chosen.length < best.legs.length)) {
      best = {
        legs: chosen.slice(),
        combinedOdds,
        combinedProbability,
        objective: strategy,
        objectiveScore: score,
        targetDistance: distance,
        ...accumulatorMetrics(chosen, combinedOdds, combinedProbability),
      };
    }
  }

  function visit(index, combinedOdds, combinedProbability) {
    if (combinedOdds > maxTarget || chosen.length > maxLegs) return;
    if (index === fixtures.length) {
      consider(combinedOdds, combinedProbability);
      return;
    }
    visit(index + 1, combinedOdds, combinedProbability);
    if (chosen.length >= maxLegs) return;
    for (const candidate of fixtures[index]) {
      chosen.push(candidate);
      visit(index + 1, combinedOdds * candidate.odds, combinedProbability * candidate.probability);
      chosen.pop();
    }
  }

  visit(0, 1, 1);
  return best;
}

export async function generateSlip({
  apiKey,
  payload,
  competitionId,
  targetOdds,
  tolerance = 0.15,
  minLegProbability = 0.35,
  minEdge = null,
  strategy = "probability",
  maxLegs = 4,
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
  const candidates = buildCandidates(entries, minLegProbability, { minEdge });
  const slip = bestAccumulator(candidates, targetOdds, tolerance, maxLegs, { objective: strategy });

  return { matchday, entries, candidates, slip, sportTitle: discovery.title };
}
