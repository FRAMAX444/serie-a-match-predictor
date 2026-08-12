import { predictFromMatches } from "./model.js";

const DAY_MS = 86400000;
const ITALY_COMPETITION_ID = "ita.1";

const dateOnly = (value) => String(value || "").slice(0, 10);
const hasValue = (value) => value !== null && value !== undefined && value !== "";
const hasScore = (fixture) => hasValue(fixture?.home_goals)
  && hasValue(fixture?.away_goals)
  && Number.isFinite(Number(fixture.home_goals))
  && Number.isFinite(Number(fixture.away_goals));

function addDays(value, days) {
  const date = new Date(`${dateOnly(value)}T12:00:00Z`);
  date.setTime(date.getTime() + days * DAY_MS);
  return date.toISOString().slice(0, 10);
}

function fixturesFromCalendar(calendar) {
  return (calendar?.matchdays || []).flatMap((matchday) =>
    (matchday.fixtures || []).map((fixture) => ({ ...fixture, round: fixture.round ?? matchday.round })),
  );
}

export function deriveSnapshotDate(calendar) {
  const fixtures = fixturesFromCalendar(calendar);
  const completedDates = fixtures.filter(hasScore).map((fixture) => dateOnly(fixture.date)).filter(Boolean).sort();
  if (completedDates.length) return addDays(completedDates.at(-1), 1);
  const upcomingDates = fixtures.filter((fixture) => !hasScore(fixture)).map((fixture) => dateOnly(fixture.date)).filter(Boolean).sort();
  return upcomingDates[0] || new Date().toISOString().slice(0, 10);
}

function emptyRow(team) {
  return {
    team,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    points: 0,
    currentPlayed: 0,
    currentPoints: 0,
    predictedPlayed: 0,
    predictedPoints: 0,
  };
}

function applyResult(table, fixture, homeGoals, awayGoals, predicted) {
  const home = table.get(fixture.home_team) || emptyRow(fixture.home_team);
  const away = table.get(fixture.away_team) || emptyRow(fixture.away_team);
  table.set(fixture.home_team, home);
  table.set(fixture.away_team, away);

  home.played += 1;
  away.played += 1;
  home.goalsFor += homeGoals;
  home.goalsAgainst += awayGoals;
  away.goalsFor += awayGoals;
  away.goalsAgainst += homeGoals;

  let homePoints = 0;
  let awayPoints = 0;
  if (homeGoals > awayGoals) {
    home.wins += 1;
    away.losses += 1;
    homePoints = 3;
  } else if (homeGoals < awayGoals) {
    away.wins += 1;
    home.losses += 1;
    awayPoints = 3;
  } else {
    home.draws += 1;
    away.draws += 1;
    homePoints = 1;
    awayPoints = 1;
  }

  home.points += homePoints;
  away.points += awayPoints;
  if (predicted) {
    home.predictedPlayed += 1;
    away.predictedPlayed += 1;
    home.predictedPoints += homePoints;
    away.predictedPoints += awayPoints;
  } else {
    home.currentPlayed += 1;
    away.currentPlayed += 1;
    home.currentPoints += homePoints;
    away.currentPoints += awayPoints;
  }
}

export function buildProjectedStandings(calendar, predictions = []) {
  const table = new Map((calendar?.teams || []).map((team) => [team, emptyRow(team)]));
  fixturesFromCalendar(calendar).filter(hasScore).forEach((fixture) => {
    applyResult(table, fixture, Number(fixture.home_goals), Number(fixture.away_goals), false);
  });
  predictions.forEach((prediction) => {
    applyResult(table, prediction.fixture, Number(prediction.homeGoals), Number(prediction.awayGoals), true);
  });

  return [...table.values()]
    .map((row) => ({ ...row, goalDifference: row.goalsFor - row.goalsAgainst }))
    .sort((left, right) =>
      right.points - left.points
      || right.goalDifference - left.goalDifference
      || right.goalsFor - left.goalsFor
      || left.team.localeCompare(right.team, "it"),
    )
    .map((row, index) => ({ ...row, position: index + 1 }));
}

export function projectSeasonSnapshot(matches, calendar, rawOptions = {}, predictor = predictFromMatches) {
  if (!calendar?.competition || calendar.competition.id !== ITALY_COMPETITION_ID) {
    throw new Error("La proiezione stagionale è disponibile per la Serie A.");
  }

  const fixtures = fixturesFromCalendar(calendar);
  const remaining = fixtures.filter((fixture) => !hasScore(fixture));
  if (!remaining.length) {
    return {
      snapshotDate: deriveSnapshotDate(calendar),
      predictions: [],
      standings: buildProjectedStandings(calendar, []),
      playedMatches: fixtures.filter(hasScore).length,
      remainingMatches: 0,
    };
  }

  const { snapshotDate: requestedSnapshotDate, ...modelOptions } = rawOptions;
  const snapshotDate = dateOnly(requestedSnapshotDate) || deriveSnapshotDate(calendar);
  const predictions = remaining
    .slice()
    .sort((left, right) => dateOnly(left.date).localeCompare(dateOnly(right.date)) || Number(left.round || 0) - Number(right.round || 0))
    .map((fixture) => {
      const result = predictor(matches, {
        ...modelOptions,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team,
        date: snapshotDate,
        cutoffDate: snapshotDate,
        competitionId: ITALY_COMPETITION_ID,
      });
      const bestScore = result?.probabilities?.scores?.[0];
      if (!bestScore) throw new Error(`Risultato esatto non disponibile per ${fixture.home_team} - ${fixture.away_team}.`);
      return {
        fixture,
        result,
        homeGoals: Number(bestScore.home),
        awayGoals: Number(bestScore.away),
      };
    });

  return {
    snapshotDate,
    predictions,
    standings: buildProjectedStandings(calendar, predictions),
    playedMatches: fixtures.filter(hasScore).length,
    remainingMatches: remaining.length,
  };
}
