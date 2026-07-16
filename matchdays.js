const DAY_MS = 86400000;

const toDate = (value) => new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
const validRound = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

function normalizeFixture(item, index = 0) {
  const homeTeam = item.home_team ?? item.homeTeam;
  const awayTeam = item.away_team ?? item.awayTeam;
  return {
    id: item.id ?? `${item.season ?? "season"}-${item.round ?? "r"}-${index}-${homeTeam}-${awayTeam}`,
    season: String(item.season ?? ""),
    round: validRound(item.round) ? Number(item.round) : null,
    date: String(item.date ?? item.kickoff ?? "").slice(0, 10),
    kickoff: item.kickoff ?? null,
    home_team: homeTeam,
    away_team: awayTeam,
    completed: Boolean(item.completed ?? (item.home_goals !== null && item.home_goals !== undefined)),
    home_goals: item.home_goals ?? null,
    away_goals: item.away_goals ?? null,
    sourceIndex: index,
  };
}

function dateRange(fixtures) {
  const dates = fixtures.map((fixture) => fixture.date).filter(Boolean).sort();
  return { startDate: dates[0] ?? null, endDate: dates.at(-1) ?? null };
}

function groupExplicitRounds(fixtures) {
  const grouped = new Map();
  fixtures.forEach((fixture) => {
    if (!validRound(fixture.round)) return;
    const round = Number(fixture.round);
    if (!grouped.has(round)) grouped.set(round, []);
    grouped.get(round).push(fixture);
  });
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([round, roundFixtures]) => ({
    round,
    fixtures: roundFixtures.sort((a, b) => a.date.localeCompare(b.date) || a.sourceIndex - b.sourceIndex),
    ...dateRange(roundFixtures),
  }));
}

function inferRoundsByBlocks(fixtures, teams) {
  const matchesPerRound = Math.max(1, Math.floor(teams.length / 2) || 10);
  const ordered = fixtures.slice().sort((a, b) => a.date.localeCompare(b.date) || a.sourceIndex - b.sourceIndex);
  const rounds = [];
  for (let index = 0; index < ordered.length; index += matchesPerRound) {
    const roundFixtures = ordered.slice(index, index + matchesPerRound);
    rounds.push({ round: rounds.length + 1, fixtures: roundFixtures, ...dateRange(roundFixtures) });
  }
  return rounds;
}

export function buildMatchdays(payload) {
  const season = String(payload.target_season ?? "2627");
  const sourceFixtures = Array.isArray(payload.fixtures) && payload.fixtures.length
    ? payload.fixtures.filter((fixture) => !season || String(fixture.season) === season)
    : (payload.matches ?? []).filter((match) => String(match.season) === season);
  const fixtures = sourceFixtures.map(normalizeFixture).filter((fixture) => fixture.home_team && fixture.away_team && fixture.date);
  const teams = payload.teams?.length
    ? payload.teams.slice()
    : [...new Set(fixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team]))].sort();
  const explicitCount = fixtures.filter((fixture) => validRound(fixture.round)).length;
  const matchdays = explicitCount === fixtures.length && fixtures.length
    ? groupExplicitRounds(fixtures)
    : inferRoundsByBlocks(fixtures, teams);
  const inferred = explicitCount !== fixtures.length;
  const firstUpcoming = matchdays.find((matchday) => matchday.fixtures.some((fixture) => !fixture.completed));
  const defaultRound = Number(payload.default_round) || firstUpcoming?.round || matchdays.at(-1)?.round || 1;
  return { season, teams, matchdays, defaultRound, inferred };
}

export function matchdayLabel(matchday) {
  if (!matchday) return "Giornata";
  const formatter = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short" });
  const start = matchday.startDate ? formatter.format(toDate(matchday.startDate)) : "";
  const end = matchday.endDate ? formatter.format(toDate(matchday.endDate)) : "";
  const range = start && end ? (start === end ? start : `${start} – ${end}`) : "date da definire";
  return `Giornata ${matchday.round} · ${range}`;
}

export function daysBetween(first, second) {
  return Math.round((toDate(second) - toDate(first)) / DAY_MS);
}
