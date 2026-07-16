const DAY_MS = 86400000;
const toDate = (value) => new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
const validRound = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

export const SUPPORTED_COMPETITIONS = Object.freeze([
  { id: "ucl", name: "UEFA Champions League", country: "Europe", type: "europe" },
  { id: "uel", name: "UEFA Europa League", country: "Europe", type: "europe" },
  { id: "uecl", name: "UEFA Conference League", country: "Europe", type: "europe" },
  { id: "eng.1", name: "Premier League", country: "England", type: "domestic" },
  { id: "esp.1", name: "LaLiga", country: "Spain", type: "domestic" },
  { id: "ita.1", name: "Serie A", country: "Italy", type: "domestic" },
  { id: "ger.1", name: "Bundesliga", country: "Germany", type: "domestic" },
  { id: "fra.1", name: "Ligue 1", country: "France", type: "domestic" },
]);

export const SUPPORTED_LEAGUES = Object.freeze(
  SUPPORTED_COMPETITIONS.filter((competition) => competition.type === "domestic"),
);

const COMPETITION_BY_ID = new Map(
  SUPPORTED_COMPETITIONS.map((competition, index) => [competition.id, { ...competition, order: index }]),
);

function normalizeFixture(item, index = 0, competition = {}) {
  const homeTeam = item.home_team ?? item.homeTeam;
  const awayTeam = item.away_team ?? item.awayTeam;
  return {
    id: item.id ?? `${competition.id ?? item.competition_id ?? "competition"}-${item.season ?? "season"}-${item.round ?? "r"}-${index}`,
    competition_id: item.competition_id ?? competition.id ?? "",
    competition_name: item.competition_name ?? competition.name ?? "",
    competition_type: item.competition_type ?? competition.type ?? "",
    season: String(item.season ?? competition.season ?? ""),
    round: validRound(item.round) ? Number(item.round) : null,
    round_label: String(item.round_label ?? "").trim(),
    date: String(item.date ?? item.kickoff ?? "").slice(0, 10),
    kickoff: item.kickoff ?? null,
    home_team: homeTeam,
    away_team: awayTeam,
    home_team_id: item.home_team_id ?? null,
    away_team_id: item.away_team_id ?? null,
    home_team_logo: item.home_team_logo ?? null,
    away_team_logo: item.away_team_logo ?? null,
    source: item.source ?? competition.source ?? "",
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

function groupRounds(fixtures) {
  const grouped = new Map();
  fixtures.forEach((fixture) => {
    if (!validRound(fixture.round)) return;
    const round = Number(fixture.round);
    if (!grouped.has(round)) grouped.set(round, []);
    grouped.get(round).push(fixture);
  });
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([round, roundFixtures]) => {
    const labels = roundFixtures.map((fixture) => fixture.round_label).filter(Boolean);
    return {
      round,
      label: labels[0] || `Turno ${round}`,
      fixtures: roundFixtures.sort((a, b) => a.date.localeCompare(b.date) || a.sourceIndex - b.sourceIndex),
      ...dateRange(roundFixtures),
    };
  });
}

function inferRounds(fixtures) {
  const ordered = fixtures.slice().sort((a, b) => a.date.localeCompare(b.date) || a.sourceIndex - b.sourceIndex);
  const groups = [];
  ordered.forEach((fixture) => {
    const current = groups.at(-1);
    if (!current) {
      groups.push([fixture]);
      return;
    }
    const gap = Math.round((toDate(fixture.date) - toDate(current.at(-1).date)) / DAY_MS);
    const usedTeams = new Set(current.flatMap((item) => [item.home_team, item.away_team]));
    if (gap > 3 || usedTeams.has(fixture.home_team) || usedTeams.has(fixture.away_team)) groups.push([fixture]);
    else current.push(fixture);
  });
  return groups.map((roundFixtures, index) => ({
    round: index + 1,
    label: roundFixtures.find((fixture) => fixture.round_label)?.round_label || `Turno ${index + 1}`,
    fixtures: roundFixtures,
    ...dateRange(roundFixtures),
  }));
}

export function buildCompetitionCatalog(payload) {
  if (!Array.isArray(payload.competitions)) return [];
  return payload.competitions
    .filter((competition) => competition && COMPETITION_BY_ID.has(String(competition.id)))
    .map((competition) => {
      const supported = COMPETITION_BY_ID.get(String(competition.id));
      const fixtures = Array.isArray(competition.fixtures) ? competition.fixtures : [];
      return {
        id: supported.id,
        name: supported.name,
        season: String(competition.season || payload.target_season || ""),
        fixtures,
        available: fixtures.length > 0,
        defaultRound: Number(competition.default_round) || 1,
        source: competition.source || "",
        type: supported.type,
        country: supported.country,
        logo: String(competition.logo || competition.logo_url || ""),
        order: supported.order,
      };
    })
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...competition }) => competition);
}

export function buildMatchdays(payload, competitionId = null) {
  const catalog = buildCompetitionCatalog(payload);
  const selected = catalog.find((competition) => competition.id === competitionId)
    || catalog.find((competition) => competition.id === payload.default_competition)
    || catalog.find((competition) => competition.available)
    || catalog[0];
  if (!selected) return { competition: null, season: "", teams: [], matchdays: [], defaultRound: 1, inferred: false };
  const fixtures = selected.fixtures
    .map((item, index) => normalizeFixture(item, index, selected))
    .filter((fixture) => fixture.home_team && fixture.away_team && fixture.date);
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team]))].sort((a, b) => a.localeCompare(b, "it"));
  const explicitCount = fixtures.filter((fixture) => validRound(fixture.round)).length;
  const matchdays = explicitCount === fixtures.length && fixtures.length ? groupRounds(fixtures) : inferRounds(fixtures);
  const firstUpcoming = matchdays.find((matchday) => matchday.fixtures.some((fixture) => !fixture.completed));
  const configuredRound = matchdays.some((matchday) => matchday.round === Number(selected.defaultRound))
    ? Number(selected.defaultRound)
    : null;
  const defaultRound = configuredRound || firstUpcoming?.round || matchdays.at(-1)?.round || 1;
  return {
    competition: selected,
    season: selected.season,
    teams,
    matchdays,
    defaultRound,
    inferred: explicitCount !== fixtures.length,
  };
}

export function nextFixtureForTeam(calendar, team, now = new Date()) {
  if (!calendar?.matchdays?.length || !team) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fixtures = calendar.matchdays.flatMap((matchday) => matchday.fixtures.map((fixture) => ({ fixture, matchday })));
  const matching = fixtures.filter(({ fixture }) => fixture.home_team === team || fixture.away_team === team);
  return matching
    .filter(({ fixture }) => !fixture.completed && toDate(fixture.date) >= today)
    .sort((left, right) => left.fixture.date.localeCompare(right.fixture.date))[0]
    || matching.filter(({ fixture }) => !fixture.completed).sort((left, right) => left.fixture.date.localeCompare(right.fixture.date))[0]
    || null;
}

export function matchdayLabel(matchday) {
  if (!matchday) return "Turno";
  const formatter = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short" });
  const start = matchday.startDate ? formatter.format(toDate(matchday.startDate)) : "";
  const end = matchday.endDate ? formatter.format(toDate(matchday.endDate)) : "";
  const range = start && end ? (start === end ? start : `${start} – ${end}`) : "date da definire";
  return `${matchday.label || `Turno ${matchday.round}`} · ${range}`;
}

export function daysBetween(first, second) {
  return Math.round((toDate(second) - toDate(first)) / DAY_MS);
}
