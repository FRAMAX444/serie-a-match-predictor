const LN2 = Math.log(2);
const DAY_MS = 86400000;
const DOMESTIC_COMPETITION_IDS = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const EUROPE_COMPETITION_IDS = new Set(["ucl", "uel", "uecl"]);
const SUPPORTED_COMPETITION_IDS = new Set([...DOMESTIC_COMPETITION_IDS, ...EUROPE_COMPETITION_IDS]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const safe = (value, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const dateAtNoon = (value) => new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
const blend = (observed, baseline, reliability) => baseline + reliability * (observed - baseline);
const mean = (left, right) => Math.max(0.01, (left + right) / 2);

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
  const shotsOnTarget = safe(match[`${side}_sot`], NaN);
  if (Number.isFinite(shots) && Number.isFinite(shotsOnTarget)) {
    return {
      value: clamp(0.16 + 0.026 * shots + 0.19 * shotsOnTarget, 0.3, 3.8),
      actual: false,
    };
  }
  if (Number.isFinite(shots)) {
    // Calibrated on the supplied 949-match benchmark when only total shots are available.
    return { value: clamp(0.056 + 0.111 * shots, 0.3, 3.8), actual: false };
  }
  if (Number.isFinite(shotsOnTarget)) {
    return { value: clamp(0.446 + 0.19 * shotsOnTarget, 0.3, 3.8), actual: false };
  }
  return { value: clamp(0.9 + 0.22 * safe(match[`${side}_goals`], 1.2), 0.4, 3.2), actual: false };
}

function weightedAverageByDate(records, key, fallback, predictionDate, halfLifeDays, maxRecords) {
  const selected = records
    .slice(-maxRecords)
    .filter((record) => Number.isFinite(record[key]));
  if (!selected.length) return fallback;

  let numerator = 0;
  let denominator = 0;
  selected.forEach((record) => {
    const ageDays = Math.max(0, (predictionDate - dateAtNoon(record.date)) / DAY_MS);
    const weight = Math.exp(-LN2 * ageDays / halfLifeDays);
    numerator += record[key] * weight;
    denominator += weight;
  });
  return denominator > 0 ? numerator / denominator : fallback;
}

function emptyState(initialElo = 1500) {
  return {
    elo: initialElo,
    baselineElo: initialElo,
    matches: [],
    homeMatches: [],
    awayMatches: [],
    lastDate: null,
  };
}

function decayInactiveElo(state, matchDate) {
  if (!state.lastDate) return;
  const gapDays = Math.max(0, (dateAtNoon(matchDate) - dateAtNoon(state.lastDate)) / DAY_MS);
  if (gapDays <= 45) return;
  const retention = Math.exp(-(gapDays - 45) / 900);
  state.elo = state.baselineElo + (state.elo - state.baselineElo) * retention;
}

function applyMatch(states, match, crossCompetition = false) {
  const initialElo = crossCompetition ? safe(match.league_strength, 1500) : 1500;
  const homeState = states.get(match.home_team) || emptyState(initialElo);
  const awayState = states.get(match.away_team) || emptyState(initialElo);
  states.set(match.home_team, homeState);
  states.set(match.away_team, awayState);

  decayInactiveElo(homeState, match.date);
  decayInactiveElo(awayState, match.date);

  const homeGoals = safe(match.home_goals);
  const awayGoals = safe(match.away_goals);
  const homeXg = xgValue(match, "home");
  const awayXg = xgValue(match, "away");
  const common = { date: match.date, competitionId: match.competition_id || "" };

  const homeRecord = {
    ...common,
    points: homeGoals > awayGoals ? 3 : homeGoals === awayGoals ? 1 : 0,
    gf: homeGoals,
    ga: awayGoals,
    xgFor: homeXg.value,
    xgAgainst: awayXg.value,
    shots: safe(match.home_shots, 11),
    shotsAgainst: safe(match.away_shots, 10.5),
    sot: safe(match.home_sot, 3.8),
    sotAgainst: safe(match.away_sot, 3.6),
    xgActual: homeXg.actual,
  };
  const awayRecord = {
    ...common,
    points: awayGoals > homeGoals ? 3 : homeGoals === awayGoals ? 1 : 0,
    gf: awayGoals,
    ga: homeGoals,
    xgFor: awayXg.value,
    xgAgainst: homeXg.value,
    shots: safe(match.away_shots, 10.5),
    shotsAgainst: safe(match.home_shots, 11),
    sot: safe(match.away_sot, 3.6),
    sotAgainst: safe(match.home_sot, 3.8),
    xgActual: awayXg.actual,
  };

  homeState.matches.push(homeRecord);
  homeState.homeMatches.push(homeRecord);
  awayState.matches.push(awayRecord);
  awayState.awayMatches.push(awayRecord);
  homeState.matches = homeState.matches.slice(-40);
  awayState.matches = awayState.matches.slice(-40);
  homeState.homeMatches = homeState.homeMatches.slice(-20);
  awayState.awayMatches = awayState.awayMatches.slice(-20);

  const isEuropeanMatch = EUROPE_COMPETITION_IDS.has(String(match.competition_id))
    || String(match.competition_type || "").toLowerCase() === "europe";
  const homeAdvantage = crossCompetition && isEuropeanMatch ? 38 : 48;
  const expectedHome = 1 / (1 + Math.pow(10, (awayState.elo - (homeState.elo + homeAdvantage)) / 400));
  const resultPerformance = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const xgPerformance = 1 / (1 + Math.exp(-1.15 * (homeXg.value - awayXg.value)));
  const actualHome = homeXg.actual && awayXg.actual
    ? 0.55 * resultPerformance + 0.45 * xgPerformance
    : resultPerformance;
  const margin = Math.min(1.75, 1 + 0.13 * Math.abs(homeGoals - awayGoals));
  const importance = crossCompetition ? clamp(safe(match.importance, isEuropeanMatch ? 1.16 : 1), 0.8, 1.3) : 1;
  const k = crossCompetition ? (isEuropeanMatch ? 21 : 17) * importance : 18;
  const delta = k * margin * (actualHome - expectedHome);
  homeState.elo += delta;
  awayState.elo -= delta;
  homeState.lastDate = match.date;
  awayState.lastDate = match.date;
}

function stateMetrics(state, venue, predictionDate) {
  const venueMatches = venue === "home" ? state.homeMatches : state.awayMatches;
  const recentTen = state.matches.slice(-10);
  const sampleReliability = clamp(1 - Math.exp(-state.matches.length / 6.5), 0, 1);
  const restDays = state.lastDate ? Math.max(1, Math.round((predictionDate - dateAtNoon(state.lastDate)) / DAY_MS)) : 8;
  const eloRetention = restDays <= 45 ? 1 : Math.exp(-(restDays - 45) / 900);
  const currentElo = state.baselineElo + (state.elo - state.baselineElo) * eloRetention;
  return {
    ppg3: weightedAverageByDate(state.matches, "points", 1.35, predictionDate, 18, 6),
    ppg5: weightedAverageByDate(state.matches, "points", 1.35, predictionDate, 35, 10),
    ppg10: weightedAverageByDate(state.matches, "points", 1.35, predictionDate, 90, 20),
    gf5: weightedAverageByDate(state.matches, "gf", 1.3, predictionDate, 70, 16),
    ga5: weightedAverageByDate(state.matches, "ga", 1.3, predictionDate, 70, 16),
    xgFor5: weightedAverageByDate(state.matches, "xgFor", 1.3, predictionDate, 70, 16),
    xgAgainst5: weightedAverageByDate(state.matches, "xgAgainst", 1.3, predictionDate, 70, 16),
    shots5: weightedAverageByDate(state.matches, "shots", 11, predictionDate, 70, 16),
    shotsAgainst5: weightedAverageByDate(state.matches, "shotsAgainst", 10.5, predictionDate, 70, 16),
    sot5: weightedAverageByDate(state.matches, "sot", 3.8, predictionDate, 70, 16),
    sotAgainst5: weightedAverageByDate(state.matches, "sotAgainst", 3.6, predictionDate, 70, 16),
    venueGf5: weightedAverageByDate(venueMatches, "gf", 1.3, predictionDate, 100, 10),
    venueGa5: weightedAverageByDate(venueMatches, "ga", 1.3, predictionDate, 100, 10),
    xgCoverage: recentTen.length ? recentTen.filter((item) => item.xgActual).length / recentTen.length : 0,
    elo: blend(currentElo, state.baselineElo, sampleReliability),
    matches: state.matches.length,
    sampleReliability,
    restDays,
    freshnessDays: state.lastDate ? restDays : 120,
  };
}

function selectBaselineTraining(training, competitionId) {
  const exact = training.filter((match) => match.competition_id === competitionId);
  if (exact.length >= 60) return { matches: exact, source: "competition" };
  if (EUROPE_COMPETITION_IDS.has(competitionId)) {
    const european = training.filter((match) => EUROPE_COMPETITION_IDS.has(String(match.competition_id)));
    if (european.length >= 60) return { matches: european, source: "europe" };
    return { matches: training, source: "europe-support" };
  }
  return { matches: training, source: "top5" };
}

function weightedCompetitionAverages(matches, cutoffDate, halfLifeDays) {
  let weightTotal = 0;
  const sums = { homeGoals: 0, awayGoals: 0, homeXg: 0, awayXg: 0, homeShots: 0, awayShots: 0, homeSot: 0, awaySot: 0 };
  matches.forEach((match) => {
    const age = Math.max(0, (cutoffDate - dateAtNoon(match.date)) / DAY_MS);
    const weight = Math.exp(-LN2 * age / halfLifeDays);
    const homeExpected = xgValue(match, "home").value;
    const awayExpected = xgValue(match, "away").value;
    weightTotal += weight;
    sums.homeGoals += weight * safe(match.home_goals, 1.4);
    sums.awayGoals += weight * safe(match.away_goals, 1.15);
    sums.homeXg += weight * homeExpected;
    sums.awayXg += weight * awayExpected;
    sums.homeShots += weight * safe(match.home_shots, 11);
    sums.awayShots += weight * safe(match.away_shots, 10.5);
    sums.homeSot += weight * safe(match.home_sot, 3.8);
    sums.awaySot += weight * safe(match.away_sot, 3.6);
  });
  if (!weightTotal) {
    return { homeGoals: 1.42, awayGoals: 1.18, homeXg: 1.42, awayXg: 1.18, homeShots: 11, awayShots: 10.5, homeSot: 3.8, awaySot: 3.6 };
  }
  return Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, value / weightTotal]));
}

function restFactor(days) {
  if (days <= 3) return 0.92;
  if (days === 4) return 0.965;
  if (days === 5) return 0.99;
  if (days > 21) return 0.985;
  return 1;
}

function dataQuality(home, away, trainingMatches, baselineMatches) {
  const depth = clamp((home.matches + away.matches) / 20, 0, 1);
  const totalDepth = clamp(trainingMatches / 500, 0, 1);
  const baselineDepth = clamp(baselineMatches / 180, 0, 1);
  const xg = (home.xgCoverage + away.xgCoverage) / 2;
  const freshness = Math.exp(-Math.max(0, Math.max(home.freshnessDays, away.freshnessDays) - 21) / 75);
  const score = clamp(0.32 * depth + 0.22 * totalDepth + 0.18 * baselineDepth + 0.18 * freshness + 0.10 * (0.35 + 0.65 * xg), 0, 1);
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
  const options = { windowDays: 540, halfLifeDays: 120, competitionId: "", ...rawOptions };
  if (!SUPPORTED_COMPETITION_IDS.has(options.competitionId)) {
    throw new Error("Competizione non supportata: usa i Big Five o una delle tre coppe UEFA.");
  }

  const europeanTarget = EUROPE_COMPETITION_IDS.has(options.competitionId);
  const predictionDate = dateAtNoon(options.date);
  const cutoffDate = dateAtNoon(options.cutoffDate || options.date);
  const windowStart = new Date(cutoffDate.getTime() - options.windowDays * DAY_MS);
  const warmupStart = new Date(windowStart.getTime() - 420 * DAY_MS);
  const chronological = matches.filter((match) => {
    const matchDate = dateAtNoon(match.date);
    const competitionAllowed = europeanTarget
      ? true
      : DOMESTIC_COMPETITION_IDS.has(String(match.competition_id));
    return competitionAllowed
      && matchDate < cutoffDate
      && matchDate >= warmupStart
      && match.home_goals !== null && match.home_goals !== undefined
      && match.away_goals !== null && match.away_goals !== undefined;
  }).sort((left, right) => left.date.localeCompare(right.date));
  const training = chronological.filter((match) => dateAtNoon(match.date) >= windowStart);
  if (training.length < 100) throw new Error("Dati recenti insufficienti per questa competizione e finestra temporale.");

  const baselineSelection = selectBaselineTraining(training, options.competitionId);
  const baselineTraining = baselineSelection.matches;
  const states = new Map();
  chronological.forEach((match) => applyMatch(states, match, europeanTarget));
  const home = stateMetrics(states.get(options.homeTeam) || emptyState(), "home", predictionDate);
  const away = stateMetrics(states.get(options.awayTeam) || emptyState(), "away", predictionDate);
  const league = weightedCompetitionAverages(baselineTraining, cutoffDate, options.halfLifeDays);
  const neutralGoals = mean(league.homeGoals, league.awayGoals);
  const neutralXg = mean(league.homeXg, league.awayXg);
  const neutralShots = mean(league.homeShots, league.awayShots);
  const neutralSot = mean(league.homeSot, league.awaySot);

  // General team form is venue-neutral. Only venue-specific splits are compared with
  // home/away league baselines; this avoids systematically suppressing home attack
  // and inflating away attack when general metrics are used.
  const homeAttack = Math.pow(clamp(blend(home.gf5, neutralGoals, home.sampleReliability) / neutralGoals, 0.5, 1.8), 0.22)
    * Math.pow(clamp(blend(home.xgFor5, neutralXg, home.sampleReliability) / neutralXg, 0.5, 1.8), 0.43)
    * Math.pow(clamp(blend(home.sot5, neutralSot, home.sampleReliability) / neutralSot, 0.6, 1.6), 0.18)
    * Math.pow(clamp(blend(home.shots5, neutralShots, home.sampleReliability) / neutralShots, 0.65, 1.5), 0.07)
    * Math.pow(clamp(blend(home.venueGf5, league.homeGoals, home.sampleReliability * 0.7) / league.homeGoals, 0.55, 1.65), 0.10);
  const awayDefense = Math.pow(clamp(blend(away.ga5, neutralGoals, away.sampleReliability) / neutralGoals, 0.5, 1.9), 0.27)
    * Math.pow(clamp(blend(away.xgAgainst5, neutralXg, away.sampleReliability) / neutralXg, 0.5, 1.9), 0.45)
    * Math.pow(clamp(blend(away.sotAgainst5, neutralSot, away.sampleReliability) / neutralSot, 0.6, 1.7), 0.18)
    * Math.pow(clamp(blend(away.shotsAgainst5, neutralShots, away.sampleReliability) / neutralShots, 0.65, 1.6), 0.05)
    * Math.pow(clamp(blend(away.venueGa5, league.homeGoals, away.sampleReliability * 0.7) / league.homeGoals, 0.6, 1.7), 0.05);

  const awayAttack = Math.pow(clamp(blend(away.gf5, neutralGoals, away.sampleReliability) / neutralGoals, 0.5, 1.85), 0.22)
    * Math.pow(clamp(blend(away.xgFor5, neutralXg, away.sampleReliability) / neutralXg, 0.5, 1.85), 0.43)
    * Math.pow(clamp(blend(away.sot5, neutralSot, away.sampleReliability) / neutralSot, 0.6, 1.65), 0.18)
    * Math.pow(clamp(blend(away.shots5, neutralShots, away.sampleReliability) / neutralShots, 0.65, 1.55), 0.07)
    * Math.pow(clamp(blend(away.venueGf5, league.awayGoals, away.sampleReliability * 0.7) / league.awayGoals, 0.55, 1.7), 0.10);
  const homeDefense = Math.pow(clamp(blend(home.ga5, neutralGoals, home.sampleReliability) / neutralGoals, 0.5, 1.9), 0.27)
    * Math.pow(clamp(blend(home.xgAgainst5, neutralXg, home.sampleReliability) / neutralXg, 0.5, 1.9), 0.45)
    * Math.pow(clamp(blend(home.sotAgainst5, neutralSot, home.sampleReliability) / neutralSot, 0.6, 1.7), 0.18)
    * Math.pow(clamp(blend(home.shotsAgainst5, neutralShots, home.sampleReliability) / neutralShots, 0.65, 1.6), 0.05)
    * Math.pow(clamp(blend(home.venueGa5, league.awayGoals, home.sampleReliability * 0.7) / league.awayGoals, 0.6, 1.7), 0.05);

  const eloDiff = home.elo - away.elo;
  const eloHome = Math.exp(clamp(eloDiff / 1100, -0.34, 0.34));
  const eloAway = Math.exp(clamp(-eloDiff / 1100, -0.34, 0.34));
  const momentum = (0.65 * home.ppg3 + 0.35 * home.ppg10) - (0.65 * away.ppg3 + 0.35 * away.ppg10);
  const formHome = Math.exp(clamp(momentum * 0.055, -0.16, 0.16));
  const formAway = Math.exp(clamp(-momentum * 0.055, -0.16, 0.16));

  let lambdaHome = league.homeGoals * homeAttack * awayDefense * eloHome * formHome * restFactor(home.restDays);
  let lambdaAway = league.awayGoals * awayAttack * homeDefense * eloAway * formAway * restFactor(away.restDays);
  lambdaHome = clamp(lambdaHome, 0.18, 4.1);
  lambdaAway = clamp(lambdaAway, 0.16, 3.9);

  const probabilities = matrixProbabilities(scoreMatrix(lambdaHome, lambdaAway, 8));
  const quality = dataQuality(home, away, training.length, baselineTraining.length);
  return {
    lambdaHome,
    lambdaAway,
    probabilities,
    home,
    away,
    league,
    quality,
    mostLikelyOutcome: outcomeName(probabilities, options.homeTeam, options.awayTeam),
    trainingMatches: training.length,
    baselineMatches: baselineTraining.length,
    baselineSource: baselineSelection.source,
    firstTrainingDate: training[0].date,
    lastTrainingDate: training.at(-1).date,
    cutoffDate: String(options.cutoffDate || options.date).slice(0, 10),
    xgCoverage: (home.xgCoverage + away.xgCoverage) / 2,
    competitionId: options.competitionId,
    calibration: {
      neutralGeneralBaseline: true,
      metricHalfLifeDays: 70,
      xgEloBlend: 0.45,
    },
    modelVersion: "5.0-calibrated-recency-xg-elo",
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
