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

// Ogni valore qui è esattamente la costante che prima era scritta a mano nel corpo delle
// funzioni sotto: usare DEFAULT_HYPERPARAMETERS (il default di predictFromMatches) produce
// output identico bit per bit a prima di questo refactor. Esposti cosi' perché
// scripts/tune_hyperparameters.mjs possa cercarne una combinazione migliore contro il
// backtest, invece di lasciarli numeri magici irraggiungibili dall'esterno.
export const DEFAULT_HYPERPARAMETERS = Object.freeze({
  rho: -0.07,
  eloDivisor: 1100,
  eloClamp: 0.34,
  momentumShortWeight: 0.65,
  momentumScale: 0.055,
  momentumClamp: 0.16,
  attackExponents: Object.freeze({ goals: 0.22, xg: 0.43, sot: 0.18, shots: 0.07, venue: 0.10 }),
  defenseExponents: Object.freeze({ goals: 0.27, xg: 0.45, sot: 0.18, shots: 0.05, venue: 0.05 }),
  restFactor: Object.freeze({ veryShort: 0.92, short: 0.965, moderate: 0.99, long: 0.985 }),
  // Non è una costante "estratta" dal codice preesistente: prima le neopromosse partivano
  // da un Elo piatto 1500 senza alcun prior. Default 0 (nessun effetto): come teamContext e
  // refereeHomeBias, è opt-in finché non validi un valore diverso da zero via backtest — un
  // numero non fittato sui dati non deve cambiare in automatico il comportamento calibrato
  // esistente. Per provarlo: hyperparameters: { newcomerEloDiscount: -65 } (o altro valore).
  newcomerEloDiscount: 0,
});

function mergeHyperparameters(overrides) {
  if (!overrides) return DEFAULT_HYPERPARAMETERS;
  return {
    ...DEFAULT_HYPERPARAMETERS,
    ...overrides,
    attackExponents: { ...DEFAULT_HYPERPARAMETERS.attackExponents, ...overrides.attackExponents },
    defenseExponents: { ...DEFAULT_HYPERPARAMETERS.defenseExponents, ...overrides.defenseExponents },
    restFactor: { ...DEFAULT_HYPERPARAMETERS.restFactor, ...overrides.restFactor },
  };
}

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

// !states.has(team) da solo tratterebbe ogni squadra come "nuova" al bordo di OGNI
// finestra di previsione, perché chronological è già filtrato da warmupStart in poi: una
// big al suo 15° anno di massima serie sembrerebbe "nuova" solo perché la sua partita più
// vecchia dentro la finestra è anche la prima che applyMatch() vede. Una squadra è
// genuinamente nuova solo se la sua prima partita nella finestra coincide con la sua prima
// partita nell'intero dataset non filtrato (nessuna storia da nessuna parte, prima di lì).
function newcomerTeams(matches, chronological) {
  const earliestOverall = new Map();
  for (const match of matches) {
    for (const team of [match.home_team, match.away_team]) {
      if (!team) continue;
      const current = earliestOverall.get(team);
      if (!current || match.date < current) earliestOverall.set(team, match.date);
    }
  }
  const earliestInWindow = new Map();
  for (const match of chronological) {
    for (const team of [match.home_team, match.away_team]) {
      if (!team || earliestInWindow.has(team)) continue;
      earliestInWindow.set(team, match.date);
    }
  }
  const newcomers = new Set();
  for (const [team, windowDate] of earliestInWindow) {
    if (earliestOverall.get(team) === windowDate) newcomers.add(team);
  }
  return newcomers;
}

function applyMatch(states, match, crossCompetition = false, hyperparameters = DEFAULT_HYPERPARAMETERS, newcomers = null) {
  const leagueBaseline = safe(match.league_strength, 1500);
  const homeIsNewcomer = !crossCompetition && Boolean(newcomers?.has(match.home_team)) && !states.has(match.home_team);
  const awayIsNewcomer = !crossCompetition && Boolean(newcomers?.has(match.away_team)) && !states.has(match.away_team);
  const homeInitialElo = crossCompetition ? leagueBaseline : 1500 + (homeIsNewcomer ? hyperparameters.newcomerEloDiscount : 0);
  const awayInitialElo = crossCompetition ? leagueBaseline : 1500 + (awayIsNewcomer ? hyperparameters.newcomerEloDiscount : 0);
  const homeState = states.get(match.home_team) || emptyState(homeInitialElo);
  const awayState = states.get(match.away_team) || emptyState(awayInitialElo);
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

// Fattori pre-partita opzionali (formazione probabile/infortuni/neopromosse), prodotti da
// enrich_competitions_players.py in team_context e assenti finché quello script non gira
// nella pipeline. Senza options.teamContext (o senza una voce per la squadra) ogni fattore
// resta 1 e la formula del lambda è identica a prima di questa modifica: nessun rischio per
// le previsioni esistenti finché non lo passi esplicitamente.
function contextFactor(teamContext, team, key, min, max) {
  const entry = teamContext && team ? teamContext[team] : null;
  const value = entry ? safe(entry[key], 1) : 1;
  return clamp(value, min, max);
}

// lineup_strength è già clampato [0.82, 1.12] alla fonte e riflette la formazione
// probabile corrente: si applica per intero. availability_attack/promotion_attack sono
// popolati solo via override manuale in context_overrides.json (default 1 = nessun
// aggiustamento): riclampati qui per difesa, nel caso in un override manuale finisca un
// valore fuori scala.
function attackContext(teamContext, team) {
  const lineup = contextFactor(teamContext, team, "lineup_strength", 0.8, 1.15);
  const availability = contextFactor(teamContext, team, "availability_attack", 0.75, 1.2);
  const promotion = contextFactor(teamContext, team, "promotion_attack", 0.75, 1.2);
  return clamp(lineup * availability * promotion, 0.7, 1.3);
}

function defenseContext(teamContext, team) {
  const availability = contextFactor(teamContext, team, "availability_defense", 0.75, 1.2);
  const promotion = contextFactor(teamContext, team, "promotion_defense", 0.75, 1.2);
  return clamp(availability * promotion, 0.7, 1.3);
}

function restFactor(days, hyperparameters = DEFAULT_HYPERPARAMETERS) {
  const { veryShort, short, moderate, long } = hyperparameters.restFactor;
  if (days <= 3) return veryShort;
  if (days === 4) return short;
  if (days === 5) return moderate;
  if (days > 21) return long;
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

// Proietta probabilità per-partita (non medie storiche grezze) per un singolo giocatore, a
// partire dai tassi per-90 minuti già calcolati in player_context (enrich_competitions_players.py)
// e dal lambda/gf5 che predictFromMatches calcola comunque per la squadra. Il gol è ancorato
// al lambda SPECIFICO di questa partita (tramite la quota storica di gol-squadra del
// giocatore): una squadra che affronta un avversario debole alza il lambda, e con esso la
// probabilità di gol del giocatore, in coerenza col resto del modello — non una stima isolata
// che ignora il contesto della partita. Gli assist scalano con lo stesso rapporto
// lambda-di-oggi/media-storica, senza inventare un secondo canale scollegato. I cartellini
// usano solo il tasso storico del giocatore: nessun collegamento al lambda gol, e
// refereeHomeBias (se noto) resta un canale separato non ancora incrociato con questo.
//
// Limiti onesti: assume che il tasso storico per-90 resti stabile, non sa se il giocatore
// partirà titolare in QUESTA partita specifica, non regola per il ruolo dell'avversario
// nella fase difensiva contro questo giocatore in particolare, e minutesShare (minuti medi
// per presenza) è una proxy grezza dei minuti attesi, non una previsione di formazione.
export function estimatePlayerMarkets(player, teamLambda, teamRecentGoalsFor) {
  const minutesShare = player.appearances > 0 ? clamp(player.minutes / (player.appearances * 90), 0, 1) : 0;
  const expectedMinutes = 90 * minutesShare;
  const minutesFactor = expectedMinutes / 90;

  const share = teamRecentGoalsFor > 0 ? clamp(safe(player.goals_per90, 0) / teamRecentGoalsFor, 0, 0.85) : 0;
  const expectedGoals = Math.max(0, teamLambda) * share * minutesFactor;

  const teamScaling = teamRecentGoalsFor > 0 ? clamp(teamLambda / teamRecentGoalsFor, 0.4, 2.2) : 1;
  const expectedAssists = Math.max(0, safe(player.assists_per90, 0)) * minutesFactor * teamScaling;

  const expectedCards = Math.max(0, safe(player.yellow_per90, 0) + safe(player.red_per90, 0)) * minutesFactor;

  // I tiri seguono l'intensità offensiva della squadra in QUESTA partita tanto quanto gli
  // assist (riusa lo stesso teamScaling): una squadra che il modello prevede più pericolosa
  // del solito genera più occasioni da tiro per i suoi giocatori offensivi, non solo più
  // gol. A differenza di gol/assist non c'è un tetto storico sul "team recent" (i tiri non
  // sono limitati al numero di gol segnati), quindi qui teamScaling agisce come moltiplicatore
  // puro sul tasso storico del giocatore. Calibrazione Monte Carlo in
  // scripts/validate_player_probabilities.py e docs/player-probability-study.md.
  const expectedShots = Math.max(0, safe(player.shots_per90, 0)) * minutesFactor * teamScaling;
  const zeroShotProbability = poissonPmf(0, expectedShots);
  const oneShotProbability = poissonPmf(1, expectedShots);

  return {
    expectedMinutes: Math.round(expectedMinutes),
    expectedShots: Math.round(expectedShots * 100) / 100,
    anytimeScorerProbability: clamp(1 - Math.exp(-expectedGoals), 0, 0.95),
    assistProbability: clamp(1 - Math.exp(-expectedAssists), 0, 0.9),
    cardProbability: clamp(1 - Math.exp(-expectedCards), 0, 0.85),
    // shotProbability: almeno 1 tiro nella partita (P(X>=1) = 1 - P(X=0)).
    shotProbability: clamp(1 - zeroShotProbability, 0, 0.97),
    // multiShotProbability: almeno 2 tiri (P(X>=2) = 1 - P(X=0) - P(X=1)), utile per mercati
    // "Over 1.5 tiri" del giocatore.
    multiShotProbability: clamp(1 - zeroShotProbability - oneShotProbability, 0, 0.97),
  };
}

export function predictFromMatches(matches, rawOptions) {
  const options = { windowDays: 540, halfLifeDays: 120, competitionId: "", teamContext: null, hyperparameters: null, refereeHomeBias: 0, ...rawOptions };
  if (!SUPPORTED_COMPETITION_IDS.has(options.competitionId)) {
    throw new Error("Competizione non supportata: usa i Big Five o una delle tre coppe UEFA.");
  }
  const hyperparameters = mergeHyperparameters(options.hyperparameters);

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
  const newcomers = newcomerTeams(matches, chronological);
  chronological.forEach((match) => applyMatch(states, match, europeanTarget, hyperparameters, newcomers));
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
  const ae = hyperparameters.attackExponents;
  const de = hyperparameters.defenseExponents;
  const homeAttack = Math.pow(clamp(blend(home.gf5, neutralGoals, home.sampleReliability) / neutralGoals, 0.5, 1.8), ae.goals)
    * Math.pow(clamp(blend(home.xgFor5, neutralXg, home.sampleReliability) / neutralXg, 0.5, 1.8), ae.xg)
    * Math.pow(clamp(blend(home.sot5, neutralSot, home.sampleReliability) / neutralSot, 0.6, 1.6), ae.sot)
    * Math.pow(clamp(blend(home.shots5, neutralShots, home.sampleReliability) / neutralShots, 0.65, 1.5), ae.shots)
    * Math.pow(clamp(blend(home.venueGf5, league.homeGoals, home.sampleReliability * 0.7) / league.homeGoals, 0.55, 1.65), ae.venue);
  const awayDefense = Math.pow(clamp(blend(away.ga5, neutralGoals, away.sampleReliability) / neutralGoals, 0.5, 1.9), de.goals)
    * Math.pow(clamp(blend(away.xgAgainst5, neutralXg, away.sampleReliability) / neutralXg, 0.5, 1.9), de.xg)
    * Math.pow(clamp(blend(away.sotAgainst5, neutralSot, away.sampleReliability) / neutralSot, 0.6, 1.7), de.sot)
    * Math.pow(clamp(blend(away.shotsAgainst5, neutralShots, away.sampleReliability) / neutralShots, 0.65, 1.6), de.shots)
    * Math.pow(clamp(blend(away.venueGa5, league.homeGoals, away.sampleReliability * 0.7) / league.homeGoals, 0.6, 1.7), de.venue);

  const awayAttack = Math.pow(clamp(blend(away.gf5, neutralGoals, away.sampleReliability) / neutralGoals, 0.5, 1.85), ae.goals)
    * Math.pow(clamp(blend(away.xgFor5, neutralXg, away.sampleReliability) / neutralXg, 0.5, 1.85), ae.xg)
    * Math.pow(clamp(blend(away.sot5, neutralSot, away.sampleReliability) / neutralSot, 0.6, 1.65), ae.sot)
    * Math.pow(clamp(blend(away.shots5, neutralShots, away.sampleReliability) / neutralShots, 0.65, 1.55), ae.shots)
    * Math.pow(clamp(blend(away.venueGf5, league.awayGoals, away.sampleReliability * 0.7) / league.awayGoals, 0.55, 1.7), ae.venue);
  const homeDefense = Math.pow(clamp(blend(home.ga5, neutralGoals, home.sampleReliability) / neutralGoals, 0.5, 1.9), de.goals)
    * Math.pow(clamp(blend(home.xgAgainst5, neutralXg, home.sampleReliability) / neutralXg, 0.5, 1.9), de.xg)
    * Math.pow(clamp(blend(home.sotAgainst5, neutralSot, home.sampleReliability) / neutralSot, 0.6, 1.7), de.sot)
    * Math.pow(clamp(blend(home.shotsAgainst5, neutralShots, home.sampleReliability) / neutralShots, 0.65, 1.6), de.shots)
    * Math.pow(clamp(blend(home.venueGa5, league.awayGoals, home.sampleReliability * 0.7) / league.awayGoals, 0.6, 1.7), de.venue);

  const eloDiff = home.elo - away.elo;
  // Scostamento storico (regolarizzato) del tasso di vittorie casalinghe sotto uno
  // specifico arbitro rispetto alla media di lega, calcolato da compute_referee_stats()
  // in update_europe_data.py (payload.referee_stats). Nessuna fonte usata da questa
  // pipeline (ESPN/UEFA/Football-Data) espone l'arbitro di una partita futura prima
  // dell'annuncio ufficiale: resta 0 (nessun effetto) finché non lo passi esplicitamente
  // per una partita specifica, es. quando lo apprendi a ridosso del match.
  const refereeBias = clamp(safe(options.refereeHomeBias, 0), -0.12, 0.12);
  const eloHome = Math.exp(clamp(eloDiff / hyperparameters.eloDivisor, -hyperparameters.eloClamp, hyperparameters.eloClamp) + refereeBias);
  const eloAway = Math.exp(clamp(-eloDiff / hyperparameters.eloDivisor, -hyperparameters.eloClamp, hyperparameters.eloClamp) - refereeBias);
  const momentum = (hyperparameters.momentumShortWeight * home.ppg3 + (1 - hyperparameters.momentumShortWeight) * home.ppg10)
    - (hyperparameters.momentumShortWeight * away.ppg3 + (1 - hyperparameters.momentumShortWeight) * away.ppg10);
  const formHome = Math.exp(clamp(momentum * hyperparameters.momentumScale, -hyperparameters.momentumClamp, hyperparameters.momentumClamp));
  const formAway = Math.exp(clamp(-momentum * hyperparameters.momentumScale, -hyperparameters.momentumClamp, hyperparameters.momentumClamp));

  const homeContextAttack = attackContext(options.teamContext, options.homeTeam);
  const awayContextAttack = attackContext(options.teamContext, options.awayTeam);
  const homeContextDefense = defenseContext(options.teamContext, options.homeTeam);
  const awayContextDefense = defenseContext(options.teamContext, options.awayTeam);

  let lambdaHome = league.homeGoals * homeAttack * awayDefense * eloHome * formHome * restFactor(home.restDays, hyperparameters)
    * homeContextAttack / awayContextDefense;
  let lambdaAway = league.awayGoals * awayAttack * homeDefense * eloAway * formAway * restFactor(away.restDays, hyperparameters)
    * awayContextAttack / homeContextDefense;
  lambdaHome = clamp(lambdaHome, 0.18, 4.1);
  lambdaAway = clamp(lambdaAway, 0.16, 3.9);

  const probabilities = matrixProbabilities(scoreMatrix(lambdaHome, lambdaAway, 8, hyperparameters.rho));
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
    context: {
      applied: Boolean(options.teamContext),
      homeAttack: homeContextAttack,
      awayAttack: awayContextAttack,
      homeDefense: homeContextDefense,
      awayDefense: awayContextDefense,
    },
    refereeBias,
    hyperparameters,
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
