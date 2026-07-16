const LN2 = Math.log(2);
const DAY_MS = 86400000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const safe = (value, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const dateAtNoon = (value) => new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
const blend = (observed, baseline, reliability) => baseline + reliability * (observed - baseline);

export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let index = 2; index <= k; index += 1) factorial *= index;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function dixonColesTau(homeGoals, awayGoals, lambdaHome, lambdaAway, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

export function scoreMatrix(lambdaHome, lambdaAway, maxGoals = 8, rho = -0.07) {
  const matrix = [];
  let total = 0;
  for (let home = 0; home <= maxGoals; home += 1) {
    const row = [];
    for (let away = 0; away <= maxGoals; away += 1) {
      const independent = poissonPmf(home, lambdaHome) * poissonPmf(away, lambdaAway);
      const probability = Math.max(0, independent * dixonColesTau(home, away, lambdaHome, lambdaAway, rho));
      row.push(probability);
      total += probability;
    }
    matrix.push(row);
  }
  return matrix.map((row) => row.map((value) => value / total));
}

export function matrixProbabilities(matrix) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let bothScore = 0;
  const scores = [];
  matrix.forEach((row, home) => row.forEach((probability, away) => {
    if (home > away) homeWin += probability;
    else if (home === away) draw += probability;
    else awayWin += probability;
    if (home + away >= 3) over25 += probability;
    if (home > 0 && away > 0) bothScore += probability;
    scores.push({ home, away, probability });
  }));
  scores.sort((left, right) => right.probability - left.probability);
  return { homeWin, draw, awayWin, over25, bothScore, scores };
}

function xgValue(match, side) {
  const explicit = safe(match[`${side}_xg`], NaN);
  if (Number.isFinite(explicit)) return { value: explicit, actual: true };
  const shots = safe(match[`${side}_shots`], NaN);
  const sot = safe(match[`${side}_sot`], NaN);
  if (Number.isFinite(shots) || Number.isFinite(sot)) {
    return {
      value: clamp(0.18 + 0.024 * safe(shots, 11.2) + 0.185 * safe(sot, 3.9), 0.25, 3.8),
      actual: false,
    };
  }
  const goals = safe(match[`${side}_goals`], 1.25);
  return { value: clamp(0.78 * 1.28 + 0.22 * goals, 0.35, 3.25), actual: false };
}

function possessionValues(match) {
  const home = safe(match.home_possession, NaN);
  const away = safe(match.away_possession, NaN);
  if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  const homeShots = safe(match.home_shots, 11.2);
  const awayShots = safe(match.away_shots, 10.4);
  const share = homeShots / Math.max(1, homeShots + awayShots);
  const estimatedHome = clamp(50 + 38 * (share - 0.5), 33, 67);
  return { home: estimatedHome, away: 100 - estimatedHome };
}

function marketExpectedPoints(match) {
  const odds = [safe(match.home_odds, NaN), safe(match.draw_odds, NaN), safe(match.away_odds, NaN)];
  if (!odds.every((value) => Number.isFinite(value) && value > 1)) return { home: 1.35, away: 1.35, actual: false };
  const raw = odds.map((value) => 1 / value);
  const total = raw.reduce((sum, value) => sum + value, 0);
  const probabilities = raw.map((value) => value / total);
  return { home: 3 * probabilities[0] + probabilities[1], away: 3 * probabilities[2] + probabilities[1], actual: true };
}

function emptyState() {
  return { elo: 1500, matches: [], homeMatches: [], awayMatches: [], lastDate: null };
}

function weightedAverage(records, key, fallback, halfLifeMatches = 3.2) {
  const selected = records.filter((record) => Number.isFinite(record[key]));
  if (!selected.length) return fallback;
  let numerator = 0;
  let denominator = 0;
  selected.slice().reverse().forEach((record, index) => {
    const weight = Math.pow(0.5, index / halfLifeMatches) * safe(record.importance, 1);
    numerator += record[key] * weight;
    denominator += weight;
  });
  return numerator / denominator;
}

const recent = (records, count) => records.slice(-count);

function applyMatch(states, match) {
  const homeState = states.get(match.home_team) || emptyState();
  const awayState = states.get(match.away_team) || emptyState();
  states.set(match.home_team, homeState);
  states.set(match.away_team, awayState);
  const homeGoals = safe(match.home_goals);
  const awayGoals = safe(match.away_goals);
  const homeXg = xgValue(match, "home");
  const awayXg = xgValue(match, "away");
  const possession = possessionValues(match);
  const market = marketExpectedPoints(match);
  const importance = clamp(safe(match.importance, match.competition_type === "europe" ? 1.16 : 1), 0.75, 1.35);
  const common = {
    date: match.date,
    importance,
    competitionId: match.competition_id || "",
    competitionType: match.competition_type || "domestic",
  };
  const homeRecord = {
    ...common,
    points: homeGoals > awayGoals ? 3 : homeGoals === awayGoals ? 1 : 0,
    gf: homeGoals, ga: awayGoals, xgFor: homeXg.value, xgAgainst: awayXg.value,
    possession: possession.home,
    shots: safe(match.home_shots, 11.2), shotsAgainst: safe(match.away_shots, 10.4),
    sot: safe(match.home_sot, 3.9), sotAgainst: safe(match.away_sot, 3.7),
    yellow: safe(match.home_yellow, 2.2), red: safe(match.home_red, 0.08),
    xgActual: homeXg.actual, marketExpectedPoints: market.home, marketActual: market.actual,
  };
  const awayRecord = {
    ...common,
    points: awayGoals > homeGoals ? 3 : homeGoals === awayGoals ? 1 : 0,
    gf: awayGoals, ga: homeGoals, xgFor: awayXg.value, xgAgainst: homeXg.value,
    possession: possession.away,
    shots: safe(match.away_shots, 10.4), shotsAgainst: safe(match.home_shots, 11.2),
    sot: safe(match.away_sot, 3.7), sotAgainst: safe(match.home_sot, 3.9),
    yellow: safe(match.away_yellow, 2.2), red: safe(match.away_red, 0.08),
    xgActual: awayXg.actual, marketExpectedPoints: market.away, marketActual: market.actual,
  };
  homeState.matches.push(homeRecord);
  homeState.homeMatches.push(homeRecord);
  awayState.matches.push(awayRecord);
  awayState.awayMatches.push(awayRecord);
  homeState.matches = homeState.matches.slice(-34);
  awayState.matches = awayState.matches.slice(-34);
  homeState.homeMatches = homeState.homeMatches.slice(-18);
  awayState.awayMatches = awayState.awayMatches.slice(-18);

  const homeAdvantage = match.competition_type === "europe" ? 38 : 52;
  const expectedHome = 1 / (1 + Math.pow(10, (awayState.elo - (homeState.elo + homeAdvantage)) / 400));
  const actualHome = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const margin = Math.min(1.8, 1 + 0.14 * Math.abs(homeGoals - awayGoals));
  const k = (match.competition_type === "europe" ? 22 : 17) * importance;
  const delta = k * margin * (actualHome - expectedHome);
  homeState.elo += delta;
  awayState.elo -= delta;
  homeState.lastDate = match.date;
  awayState.lastDate = match.date;
}

function neutralContext(team) {
  return {
    team, used: false, asOf: null, reliability: 0, externalElo: null,
    squadAttack: 1, squadCreativity: 1, squadContinuity: 0.85,
    newcomerImpact: 0, departureImpact: 0,
    availabilityAttack: 1, availabilityDefense: 1, lineupStrength: 1,
    promotionAttack: 1, promotionDefense: 1, managerChangeDays: null,
    topPlayers: [], newPlayers: [], source: "Contesto esterno non disponibile",
  };
}

function teamContextFor(contextMap, team, cutoffDate) {
  const raw = contextMap?.[team];
  if (!raw) return neutralContext(team);
  const asOf = String(raw.as_of || raw.updated_at || "").slice(0, 10);
  if (asOf && dateAtNoon(asOf) > cutoffDate) return neutralContext(team);
  const reliability = clamp(safe(raw.reliability, 0), 0, 1);
  return {
    team, used: true, asOf: asOf || null, reliability,
    externalElo: Number.isFinite(safe(raw.elo, NaN)) ? safe(raw.elo) : null,
    squadAttack: clamp(safe(raw.squad_attack, 1), 0.72, 1.30),
    squadCreativity: clamp(safe(raw.squad_creativity, 1), 0.72, 1.30),
    squadContinuity: clamp(safe(raw.squad_continuity, 0.85), 0.35, 1),
    newcomerImpact: clamp(safe(raw.newcomer_impact, 0), -0.25, 0.35),
    departureImpact: clamp(safe(raw.departure_impact, 0), 0, 0.40),
    availabilityAttack: clamp(safe(raw.availability_attack, 1), 0.70, 1.08),
    availabilityDefense: clamp(safe(raw.availability_defense, 1), 0.70, 1.08),
    lineupStrength: clamp(safe(raw.lineup_strength, 1), 0.75, 1.08),
    promotionAttack: clamp(safe(raw.promotion_attack, 1), 0.70, 1.18),
    promotionDefense: clamp(safe(raw.promotion_defense, 1), 0.82, 1.42),
    managerChangeDays: Number.isFinite(safe(raw.manager_change_days, NaN)) ? safe(raw.manager_change_days) : null,
    topPlayers: Array.isArray(raw.top_players) ? raw.top_players.slice(0, 5) : [],
    newPlayers: Array.isArray(raw.new_players) ? raw.new_players.slice(0, 5) : [],
    source: raw.source || "Elo europeo e risultati pubblici",
  };
}

function stateMetrics(state, venue, predictionDate, context) {
  const r3 = recent(state.matches, 3);
  const r5 = recent(state.matches, 5);
  const r10 = recent(state.matches, 10);
  const venue5 = recent(venue === "home" ? state.homeMatches : state.awayMatches, 5);
  const sampleReliability = clamp(state.matches.length / 10, 0, 1);
  const finishingRaw = weightedAverage(r10, "gf", 1.28) / Math.max(0.35, weightedAverage(r10, "xgFor", 1.28));
  const restDays = state.lastDate ? Math.max(1, Math.round((predictionDate - dateAtNoon(state.lastDate)) / DAY_MS)) : 8;
  const dynamicElo = blend(state.elo, 1500, sampleReliability);
  const contextWeight = context.externalElo === null ? 0 : 0.72 * context.reliability;
  return {
    ppg3: weightedAverage(r3, "points", 1.35), ppg5: weightedAverage(r5, "points", 1.35),
    ppg10: weightedAverage(r10, "points", 1.35, 5),
    gf5: weightedAverage(r5, "gf", 1.28), ga5: weightedAverage(r5, "ga", 1.28),
    xgFor5: weightedAverage(r5, "xgFor", 1.28), xgAgainst5: weightedAverage(r5, "xgAgainst", 1.28),
    possession5: weightedAverage(r5, "possession", 50),
    shots5: weightedAverage(r5, "shots", 11.2), shotsAgainst5: weightedAverage(r5, "shotsAgainst", 10.8),
    sot5: weightedAverage(r5, "sot", 3.9), sotAgainst5: weightedAverage(r5, "sotAgainst", 3.8),
    venuePpg5: weightedAverage(venue5, "points", 1.35),
    venueGf5: weightedAverage(venue5, "gf", 1.28), venueGa5: weightedAverage(venue5, "ga", 1.28),
    yellow5: weightedAverage(r5, "yellow", 2.2), red10: weightedAverage(r10, "red", 0.08, 5),
    marketPpg5: weightedAverage(r5, "marketExpectedPoints", 1.35),
    marketCoverage: r10.length ? r10.filter((item) => item.marketActual).length / r10.length : 0,
    finishing: blend(clamp(finishingRaw, 0.62, 1.42), 1, sampleReliability * 0.52),
    xgCoverage: r10.length ? r10.filter((item) => item.xgActual).length / r10.length : 0,
    elo: context.externalElo === null ? dynamicElo : blend(dynamicElo, context.externalElo, contextWeight),
    dynamicElo, externalElo: context.externalElo,
    matches: state.matches.length, sampleReliability, restDays,
    freshnessDays: state.lastDate ? restDays : 120,
  };
}

function selectBaselineTraining(training, competitionId) {
  const exact = training.filter((match) => match.competition_id === competitionId);
  if (exact.length >= 55) return { matches: exact, source: "competition" };
  const european = training.filter((match) => match.competition_type === "europe");
  if (european.length >= 100) return { matches: european, source: "europe" };
  return { matches: training, source: "all" };
}

function weightedCompetitionAverages(matches, cutoffDate, halfLifeDays) {
  let weightTotal = 0;
  const sums = { homeGoals: 0, awayGoals: 0, homeXg: 0, awayXg: 0, homeShots: 0, awayShots: 0, homeSot: 0, awaySot: 0 };
  matches.forEach((match) => {
    const age = Math.max(0, (cutoffDate - dateAtNoon(match.date)) / DAY_MS);
    const weight = (0.04 + Math.exp(-LN2 * age / halfLifeDays)) * clamp(safe(match.importance, 1), 0.75, 1.35);
    const homeExpected = xgValue(match, "home").value;
    const awayExpected = xgValue(match, "away").value;
    weightTotal += weight;
    sums.homeGoals += weight * safe(match.home_goals, 1.35);
    sums.awayGoals += weight * safe(match.away_goals, 1.10);
    sums.homeXg += weight * homeExpected;
    sums.awayXg += weight * awayExpected;
    sums.homeShots += weight * safe(match.home_shots, 11.2);
    sums.awayShots += weight * safe(match.away_shots, 10.4);
    sums.homeSot += weight * safe(match.home_sot, 3.9);
    sums.awaySot += weight * safe(match.away_sot, 3.7);
  });
  if (!weightTotal) return { homeGoals: 1.38, awayGoals: 1.18, homeXg: 1.38, awayXg: 1.18, homeShots: 11.2, awayShots: 10.4, homeSot: 3.9, awaySot: 3.7 };
  return Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, value / weightTotal]));
}

function restFactor(days) {
  if (days <= 3) return 0.91;
  if (days === 4) return 0.955;
  if (days === 5) return 0.985;
  if (days > 20) return 0.98;
  return 1;
}

function squadAttackFactor(context) {
  const continuity = Math.exp(clamp((context.squadContinuity - 0.82) * 0.12, -0.06, 0.025));
  const transferNet = Math.exp(clamp(0.10 * context.newcomerImpact - 0.12 * context.departureImpact, -0.08, 0.05));
  return Math.pow(context.squadAttack, 0.34) * Math.pow(context.squadCreativity, 0.22)
    * continuity * transferNet * context.availabilityAttack * context.lineupStrength;
}

function squadDefenseFactor(context) {
  const continuity = Math.exp(clamp((context.squadContinuity - 0.82) * -0.08, -0.025, 0.05));
  return continuity * Math.exp(clamp(0.10 * context.departureImpact, 0, 0.05)) / context.availabilityDefense;
}

function applyManagerUncertainty(lambda, baseline, context) {
  if (context.managerChangeDays === null || context.managerChangeDays >= 90) return lambda;
  const uncertainty = 0.10 * Math.exp(-Math.max(0, context.managerChangeDays) / 38);
  return baseline + (lambda - baseline) * (1 - uncertainty);
}

function dataQuality(home, away, trainingMatches, baselineMatches, homeContext, awayContext) {
  const depth = clamp((home.matches + away.matches) / 22, 0, 1);
  const totalDepth = clamp(trainingMatches / 450, 0, 1);
  const baselineDepth = clamp(baselineMatches / 150, 0, 1);
  const xg = (home.xgCoverage + away.xgCoverage) / 2;
  const freshness = Math.exp(-Math.max(0, Math.max(home.freshnessDays, away.freshnessDays) - 21) / 75);
  const context = (homeContext.reliability + awayContext.reliability) / 2;
  const score = clamp(0.28 * depth + 0.16 * totalDepth + 0.16 * baselineDepth + 0.16 * freshness + 0.14 * (0.4 + 0.6 * xg) + 0.10 * context, 0, 1);
  return { score, label: score >= 0.78 ? "Alta" : score >= 0.58 ? "Media" : "Bassa" };
}

function outcomeName(probabilities, homeTeam, awayTeam) {
  return [
    { key: "1", name: homeTeam, probability: probabilities.homeWin },
    { key: "X", name: "Pareggio", probability: probabilities.draw },
    { key: "2", name: awayTeam, probability: probabilities.awayWin },
  ].sort((left, right) => right.probability - left.probability)[0];
}

export function predictFromMatches(matches, rawOptions) {
  const options = {
    windowDays: 540, halfLifeDays: 120,
    homeAttackAbsence: 0, homeDefenseAbsence: 0, awayAttackAbsence: 0, awayDefenseAbsence: 0,
    homeLineup: 1, awayLineup: 1, teamContext: {}, competitionId: "", ...rawOptions,
  };
  const predictionDate = dateAtNoon(options.date);
  const cutoffDate = dateAtNoon(options.cutoffDate || options.date);
  const windowStart = new Date(cutoffDate.getTime() - options.windowDays * DAY_MS);
  const warmupStart = new Date(windowStart.getTime() - 480 * DAY_MS);
  const chronological = matches.filter((match) => {
    const matchDate = dateAtNoon(match.date);
    return matchDate < cutoffDate && matchDate >= warmupStart
      && match.home_goals !== null && match.home_goals !== undefined
      && match.away_goals !== null && match.away_goals !== undefined;
  }).sort((left, right) => left.date.localeCompare(right.date));
  const training = chronological.filter((match) => dateAtNoon(match.date) >= windowStart);
  if (training.length < 120) throw new Error("Dati recenti insufficienti per questa competizione e finestra temporale.");

  const baselineSelection = selectBaselineTraining(training, options.competitionId);
  const baselineTraining = baselineSelection.matches;
  const homeContext = teamContextFor(options.teamContext, options.homeTeam, cutoffDate);
  const awayContext = teamContextFor(options.teamContext, options.awayTeam, cutoffDate);
  const states = new Map();
  chronological.forEach((match) => applyMatch(states, match));
  const home = stateMetrics(states.get(options.homeTeam) || emptyState(), "home", predictionDate, homeContext);
  const away = stateMetrics(states.get(options.awayTeam) || emptyState(), "away", predictionDate, awayContext);
  const league = weightedCompetitionAverages(baselineTraining, cutoffDate, options.halfLifeDays);

  const homeGf = blend(home.gf5, league.homeGoals, home.sampleReliability);
  const homeXg = blend(home.xgFor5, league.homeXg, home.sampleReliability);
  const homeSot = blend(home.sot5, league.homeSot, home.sampleReliability);
  const homeShots = blend(home.shots5, league.homeShots, home.sampleReliability);
  const homeVenueGf = blend(home.venueGf5, league.homeGoals, home.sampleReliability * 0.72);
  const awayGa = blend(away.ga5, league.homeGoals, away.sampleReliability);
  const awayXga = blend(away.xgAgainst5, league.homeXg, away.sampleReliability);
  const awaySotAgainst = blend(away.sotAgainst5, league.homeSot, away.sampleReliability);
  const awayShotsAgainst = blend(away.shotsAgainst5, league.homeShots, away.sampleReliability);

  const awayGf = blend(away.gf5, league.awayGoals, away.sampleReliability);
  const awayXg = blend(away.xgFor5, league.awayXg, away.sampleReliability);
  const awaySot = blend(away.sot5, league.awaySot, away.sampleReliability);
  const awayShots = blend(away.shots5, league.awayShots, away.sampleReliability);
  const awayVenueGf = blend(away.venueGf5, league.awayGoals, away.sampleReliability * 0.72);
  const homeGa = blend(home.ga5, league.awayGoals, home.sampleReliability);
  const homeXga = blend(home.xgAgainst5, league.awayXg, home.sampleReliability);
  const homeSotAgainst = blend(home.sotAgainst5, league.awaySot, home.sampleReliability);
  const homeShotsAgainst = blend(home.shotsAgainst5, league.awayShots, home.sampleReliability);

  const homeAttack = Math.pow(clamp(homeGf / league.homeGoals, 0.48, 1.82), 0.25)
    * Math.pow(clamp(homeXg / league.homeXg, 0.48, 1.82), 0.36)
    * Math.pow(clamp(homeSot / league.homeSot, 0.58, 1.62), 0.15)
    * Math.pow(clamp(homeShots / league.homeShots, 0.62, 1.52), 0.08)
    * Math.pow(clamp(homeVenueGf / league.homeGoals, 0.55, 1.68), 0.08)
    * Math.pow(home.finishing, 0.08);
  const awayDefense = Math.pow(clamp(awayGa / league.homeGoals, 0.48, 1.88), 0.31)
    * Math.pow(clamp(awayXga / league.homeXg, 0.48, 1.88), 0.38)
    * Math.pow(clamp(awaySotAgainst / league.homeSot, 0.58, 1.68), 0.18)
    * Math.pow(clamp(awayShotsAgainst / league.homeShots, 0.62, 1.58), 0.08)
    * Math.pow(clamp(away.venueGa5 / league.homeGoals, 0.58, 1.70), 0.05);
  const awayAttack = Math.pow(clamp(awayGf / league.awayGoals, 0.48, 1.86), 0.25)
    * Math.pow(clamp(awayXg / league.awayXg, 0.48, 1.86), 0.36)
    * Math.pow(clamp(awaySot / league.awaySot, 0.58, 1.66), 0.15)
    * Math.pow(clamp(awayShots / league.awayShots, 0.62, 1.54), 0.08)
    * Math.pow(clamp(awayVenueGf / league.awayGoals, 0.55, 1.72), 0.08)
    * Math.pow(away.finishing, 0.08);
  const homeDefense = Math.pow(clamp(homeGa / league.awayGoals, 0.48, 1.88), 0.31)
    * Math.pow(clamp(homeXga / league.awayXg, 0.48, 1.88), 0.38)
    * Math.pow(clamp(homeSotAgainst / league.awaySot, 0.58, 1.68), 0.18)
    * Math.pow(clamp(homeShotsAgainst / league.awayShots, 0.62, 1.58), 0.08)
    * Math.pow(clamp(home.venueGa5 / league.awayGoals, 0.58, 1.70), 0.05);

  const eloDiff = home.elo - away.elo;
  const eloHome = Math.exp(clamp(eloDiff / 1050, -0.36, 0.36));
  const eloAway = Math.exp(clamp(-eloDiff / 1050, -0.36, 0.36));
  const momentum = (0.65 * home.ppg3 + 0.35 * home.ppg10) - (0.65 * away.ppg3 + 0.35 * away.ppg10);
  const marketMomentum = home.marketPpg5 - away.marketPpg5;
  const formHome = Math.exp(clamp(momentum * 0.052 + marketMomentum * 0.03, -0.17, 0.17));
  const formAway = Math.exp(clamp(-momentum * 0.052 - marketMomentum * 0.03, -0.17, 0.17));
  const possessionHome = Math.exp(clamp((home.possession5 - away.possession5) / 260, -0.09, 0.09));
  const possessionAway = Math.exp(clamp((away.possession5 - home.possession5) / 260, -0.09, 0.09));
  const disciplineHome = Math.exp(clamp(-0.014 * (home.yellow5 - 2.2) - 0.12 * (home.red10 - 0.08), -0.065, 0.035));
  const disciplineAway = Math.exp(clamp(-0.014 * (away.yellow5 - 2.2) - 0.12 * (away.red10 - 0.08), -0.065, 0.035));

  let lambdaHome = league.homeGoals * homeAttack * awayDefense * eloHome * formHome * possessionHome;
  let lambdaAway = league.awayGoals * awayAttack * homeDefense * eloAway * formAway * possessionAway;
  lambdaHome *= restFactor(home.restDays) * disciplineHome * squadAttackFactor(homeContext) * squadDefenseFactor(awayContext);
  lambdaAway *= restFactor(away.restDays) * disciplineAway * squadAttackFactor(awayContext) * squadDefenseFactor(homeContext);
  lambdaHome *= (1 - options.homeAttackAbsence) * (1 + 0.72 * options.awayDefenseAbsence) * options.homeLineup;
  lambdaAway *= (1 - options.awayAttackAbsence) * (1 + 0.72 * options.homeDefenseAbsence) * options.awayLineup;
  lambdaHome = applyManagerUncertainty(lambdaHome, league.homeGoals, homeContext);
  lambdaAway = applyManagerUncertainty(lambdaAway, league.awayGoals, awayContext);
  lambdaHome = clamp(lambdaHome, 0.16, 4.2);
  lambdaAway = clamp(lambdaAway, 0.14, 4.0);

  const probabilities = matrixProbabilities(scoreMatrix(lambdaHome, lambdaAway, 8));
  const quality = dataQuality(home, away, training.length, baselineTraining.length, homeContext, awayContext);
  return {
    lambdaHome, lambdaAway, probabilities, home, away, homeContext, awayContext, league, quality,
    mostLikelyOutcome: outcomeName(probabilities, options.homeTeam, options.awayTeam),
    trainingMatches: training.length, baselineMatches: baselineTraining.length, baselineSource: baselineSelection.source,
    firstTrainingDate: training[0].date, lastTrainingDate: training.at(-1).date,
    cutoffDate: String(options.cutoffDate || options.date).slice(0, 10),
    xgCoverage: (home.xgCoverage + away.xgCoverage) / 2,
    competitionId: options.competitionId,
    modelVersion: "3.0-europe-context",
  };
}

export function predictMatchdayFromMatches(matches, fixtures, options = {}) {
  if (!fixtures?.length) throw new Error("Il turno selezionato non contiene partite.");
  const ordered = fixtures.slice().sort((left, right) => left.date.localeCompare(right.date));
  const cutoffDate = ordered[0].date;
  const predictions = ordered.map((fixture) => ({
    fixture,
    result: predictFromMatches(matches, {
      ...options,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      date: fixture.date,
      cutoffDate,
      competitionId: fixture.competition_id || options.competitionId || "",
    }),
  }));
  return { cutoffDate, predictions, competitionId: ordered[0].competition_id || options.competitionId || "" };
}
