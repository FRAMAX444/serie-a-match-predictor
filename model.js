const LN2 = Math.log(2);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const safe = (value, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= k; i += 1) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

export function scoreMatrix(lambdaHome, lambdaAway, maxGoals = 8) {
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    const row = [];
    for (let a = 0; a <= maxGoals; a += 1) {
      const probability = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
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
  matrix.forEach((row, h) => row.forEach((probability, a) => {
    if (h > a) homeWin += probability;
    else if (h === a) draw += probability;
    else awayWin += probability;
    if (h + a >= 3) over25 += probability;
    if (h > 0 && a > 0) bothScore += probability;
    scores.push({ home: h, away: a, probability });
  }));
  scores.sort((left, right) => right.probability - left.probability);
  return { homeWin, draw, awayWin, over25, bothScore, scores };
}

function xgValue(match, side) {
  const explicit = safe(match[`${side}_xg`], NaN);
  if (Number.isFinite(explicit)) return { value: explicit, actual: true };
  const shots = safe(match[`${side}_shots`], 11.5);
  const sot = safe(match[`${side}_sot`], 4.0);
  return { value: clamp(0.12 + 0.025 * shots + 0.19 * sot, 0.25, 3.8), actual: false };
}

function possessionValues(match) {
  const homeExplicit = safe(match.home_possession, NaN);
  const awayExplicit = safe(match.away_possession, NaN);
  if (Number.isFinite(homeExplicit) && Number.isFinite(awayExplicit)) {
    return { home: homeExplicit, away: awayExplicit, actual: true };
  }
  const homeActivity = safe(match.home_shots, 11.5) + 0.65 * safe(match.home_corners, 5);
  const awayActivity = safe(match.away_shots, 11.5) + 0.65 * safe(match.away_corners, 5);
  const share = homeActivity / Math.max(1, homeActivity + awayActivity);
  const home = clamp(50 + 42 * (share - 0.5), 31, 69);
  return { home, away: 100 - home, actual: false };
}

function emptyState() {
  return { elo: 1500, matches: [], homeMatches: [], awayMatches: [], lastDate: null };
}

function weightedAverage(records, key, fallback, halfLifeMatches = 3.0) {
  const selected = records.filter((record) => Number.isFinite(record[key]));
  if (!selected.length) return fallback;
  let numerator = 0;
  let denominator = 0;
  selected.slice().reverse().forEach((record, index) => {
    const weight = Math.pow(0.5, index / halfLifeMatches);
    numerator += record[key] * weight;
    denominator += weight;
  });
  return numerator / denominator;
}

function recent(records, n) { return records.slice(-n); }

function applyMatch(states, match) {
  const homeState = states.get(match.home_team) || emptyState();
  const awayState = states.get(match.away_team) || emptyState();
  states.set(match.home_team, homeState);
  states.set(match.away_team, awayState);

  const homeGoals = safe(match.home_goals);
  const awayGoals = safe(match.away_goals);
  const homePoints = homeGoals > awayGoals ? 3 : homeGoals === awayGoals ? 1 : 0;
  const awayPoints = awayGoals > homeGoals ? 3 : homeGoals === awayGoals ? 1 : 0;
  const homeXg = xgValue(match, "home");
  const awayXg = xgValue(match, "away");
  const possession = possessionValues(match);
  const homeRecord = {
    points: homePoints, gf: homeGoals, ga: awayGoals, xgFor: homeXg.value, xgAgainst: awayXg.value,
    possession: possession.home, shots: safe(match.home_shots, 11.5), shotsAgainst: safe(match.away_shots, 11.5),
    sot: safe(match.home_sot, 4), sotAgainst: safe(match.away_sot, 4), xgActual: homeXg.actual,
  };
  const awayRecord = {
    points: awayPoints, gf: awayGoals, ga: homeGoals, xgFor: awayXg.value, xgAgainst: homeXg.value,
    possession: possession.away, shots: safe(match.away_shots, 11.5), shotsAgainst: safe(match.home_shots, 11.5),
    sot: safe(match.away_sot, 4), sotAgainst: safe(match.home_sot, 4), xgActual: awayXg.actual,
  };
  homeState.matches.push(homeRecord); homeState.homeMatches.push(homeRecord);
  awayState.matches.push(awayRecord); awayState.awayMatches.push(awayRecord);
  homeState.matches = homeState.matches.slice(-20); homeState.homeMatches = homeState.homeMatches.slice(-12);
  awayState.matches = awayState.matches.slice(-20); awayState.awayMatches = awayState.awayMatches.slice(-12);

  const expectedHome = 1 / (1 + Math.pow(10, (awayState.elo - (homeState.elo + 58)) / 400));
  const actualHome = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const margin = Math.min(1.65, 1 + 0.13 * Math.abs(homeGoals - awayGoals));
  const delta = 19 * margin * (actualHome - expectedHome);
  homeState.elo += delta; awayState.elo -= delta;
  homeState.lastDate = match.date; awayState.lastDate = match.date;
}

function stateMetrics(state, venue) {
  const r3 = recent(state.matches, 3);
  const r5 = recent(state.matches, 5);
  const r10 = recent(state.matches, 10);
  const venue5 = recent(venue === "home" ? state.homeMatches : state.awayMatches, 5);
  return {
    ppg3: weightedAverage(r3, "points", 1.35), ppg5: weightedAverage(r5, "points", 1.35),
    gf5: weightedAverage(r5, "gf", 1.30), ga5: weightedAverage(r5, "ga", 1.30),
    xgFor5: weightedAverage(r5, "xgFor", 1.30), xgAgainst5: weightedAverage(r5, "xgAgainst", 1.30),
    possession5: weightedAverage(r5, "possession", 50), sot5: weightedAverage(r5, "sot", 4.1),
    sotAgainst5: weightedAverage(r5, "sotAgainst", 4.1), venuePpg5: weightedAverage(venue5, "points", 1.35),
    venueGf5: weightedAverage(venue5, "gf", 1.30), venueGa5: weightedAverage(venue5, "ga", 1.30),
    xgCoverage: r10.length ? r10.filter((item) => item.xgActual).length / r10.length : 0,
    elo: state.elo, matches: state.matches.length,
  };
}

function weightedLeagueAverages(matches, predictionDate, halfLifeDays) {
  let weightTotal = 0, homeGoals = 0, awayGoals = 0, homeXg = 0, awayXg = 0, homeSot = 0, awaySot = 0;
  matches.forEach((match) => {
    const age = Math.max(0, (predictionDate - new Date(`${match.date}T12:00:00Z`)) / 86400000);
    const weight = 0.04 + Math.exp(-LN2 * age / halfLifeDays);
    const hx = xgValue(match, "home").value, ax = xgValue(match, "away").value;
    weightTotal += weight;
    homeGoals += weight * safe(match.home_goals); awayGoals += weight * safe(match.away_goals);
    homeXg += weight * hx; awayXg += weight * ax;
    homeSot += weight * safe(match.home_sot, 4.2); awaySot += weight * safe(match.away_sot, 4.0);
  });
  return {
    homeGoals: homeGoals / weightTotal, awayGoals: awayGoals / weightTotal,
    homeXg: homeXg / weightTotal, awayXg: awayXg / weightTotal,
    homeSot: homeSot / weightTotal, awaySot: awaySot / weightTotal,
  };
}

export function predictFromMatches(matches, options) {
  const predictionDate = new Date(`${options.date}T12:00:00Z`);
  const windowStart = new Date(predictionDate.getTime() - options.windowDays * 86400000);
  const warmupStart = new Date(windowStart.getTime() - 420 * 86400000);
  const chronological = matches
    .filter((match) => new Date(`${match.date}T12:00:00Z`) < predictionDate && new Date(`${match.date}T12:00:00Z`) >= warmupStart)
    .sort((a, b) => a.date.localeCompare(b.date));
  const training = chronological.filter((match) => new Date(`${match.date}T12:00:00Z`) >= windowStart);
  if (training.length < 120) throw new Error("Dati recenti insufficienti per questa data e finestra temporale.");

  const states = new Map();
  chronological.forEach((match) => applyMatch(states, match));
  const homeState = states.get(options.homeTeam);
  const awayState = states.get(options.awayTeam);
  if (!homeState || !awayState || homeState.matches.length < 3 || awayState.matches.length < 3) {
    throw new Error("Una delle squadre non ha abbastanza partite precedenti nel dataset.");
  }
  const home = stateMetrics(homeState, "home");
  const away = stateMetrics(awayState, "away");
  const league = weightedLeagueAverages(training, predictionDate, options.halfLifeDays);

  const homeAttack = Math.pow(clamp(home.gf5 / league.homeGoals, 0.45, 1.85), 0.34)
    * Math.pow(clamp(home.xgFor5 / league.homeXg, 0.45, 1.85), 0.42)
    * Math.pow(clamp(home.sot5 / league.homeSot, 0.55, 1.65), 0.16)
    * Math.pow(clamp(home.venueGf5 / league.homeGoals, 0.50, 1.75), 0.08);
  const awayDefense = Math.pow(clamp(away.ga5 / league.homeGoals, 0.45, 1.90), 0.42)
    * Math.pow(clamp(away.xgAgainst5 / league.homeXg, 0.45, 1.90), 0.42)
    * Math.pow(clamp(away.sotAgainst5 / league.homeSot, 0.55, 1.70), 0.16);
  const awayAttack = Math.pow(clamp(away.gf5 / league.awayGoals, 0.45, 1.90), 0.34)
    * Math.pow(clamp(away.xgFor5 / league.awayXg, 0.45, 1.90), 0.42)
    * Math.pow(clamp(away.sot5 / league.awaySot, 0.55, 1.70), 0.16)
    * Math.pow(clamp(away.venueGf5 / league.awayGoals, 0.50, 1.80), 0.08);
  const homeDefense = Math.pow(clamp(home.ga5 / league.awayGoals, 0.45, 1.90), 0.42)
    * Math.pow(clamp(home.xgAgainst5 / league.awayXg, 0.45, 1.90), 0.42)
    * Math.pow(clamp(home.sotAgainst5 / league.awaySot, 0.55, 1.70), 0.16);

  const eloDiff = home.elo - away.elo;
  const eloHome = Math.exp(clamp(eloDiff / 1150, -0.30, 0.30));
  const eloAway = Math.exp(clamp(-eloDiff / 1150, -0.30, 0.30));
  const formHome = Math.exp(clamp((home.ppg5 - away.ppg5) * 0.07, -0.16, 0.16));
  const formAway = Math.exp(clamp((away.ppg5 - home.ppg5) * 0.07, -0.16, 0.16));
  const possessionHome = Math.exp(clamp((home.possession5 - away.possession5) / 240, -0.10, 0.10));
  const possessionAway = Math.exp(clamp((away.possession5 - home.possession5) / 240, -0.10, 0.10));

  let lambdaHome = league.homeGoals * homeAttack * awayDefense * eloHome * formHome * possessionHome;
  let lambdaAway = league.awayGoals * awayAttack * homeDefense * eloAway * formAway * possessionAway;
  lambdaHome *= (1 - options.homeAttackAbsence) * (1 + 0.72 * options.awayDefenseAbsence) * options.homeLineup;
  lambdaAway *= (1 - options.awayAttackAbsence) * (1 + 0.72 * options.homeDefenseAbsence) * options.awayLineup;
  lambdaHome = clamp(lambdaHome, 0.18, 4.25);
  lambdaAway = clamp(lambdaAway, 0.15, 4.0);

  const probabilities = matrixProbabilities(scoreMatrix(lambdaHome, lambdaAway, 8));
  return {
    lambdaHome, lambdaAway, probabilities, home, away, league,
    trainingMatches: training.length,
    firstTrainingDate: training[0].date,
    lastTrainingDate: training[training.length - 1].date,
    xgCoverage: (home.xgCoverage + away.xgCoverage) / 2,
  };
}
