import { predictMatchdayFromMatches } from "./model.js";
import { buildMatchdays, matchdayLabel } from "./matchdays.js";

const $ = (id) => document.getElementById(id);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
const number = (value, digits = 2) => Number(value).toFixed(digits);
const fairOdds = (value) => value > 0 ? number(1 / value, 2) : "—";
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));
const formatDate = (value) => new Intl.DateTimeFormat("it-IT", {
  weekday: "short",
  day: "numeric",
  month: "short",
}).format(new Date(`${value}T12:00:00Z`));

const FAVORITE_STORAGE_KEY = "serie-a-predictor-favorite-team";
const OPENING_ROUND_2627 = [
  ["Inter", "Monza"],
  ["Roma", "Fiorentina"],
  ["Napoli", "Genoa"],
  ["Como", "Udinese"],
  ["Atalanta", "Sassuolo"],
  ["Bologna", "Lazio"],
  ["Frosinone", "Juventus"],
  ["Parma", "Cagliari"],
  ["Torino", "Milan"],
  ["Venezia", "Lecce"],
];

let payload;
let calendar;
let lastMatchday;
let lastBatch;

function unpackMatches(data) {
  if (data.columns && data.matches?.length && Array.isArray(data.matches[0])) {
    data.matches = data.matches.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
  }
  return data;
}

function teamInitials(team) {
  return team.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function outcomeClass(key) {
  if (key === "1") return "outcome--home";
  if (key === "2") return "outcome--away";
  return "outcome--draw";
}

function qualityClass(label) {
  return `quality--${label.toLowerCase()}`;
}

function favoriteTeam() {
  return $("favorite-team-select").value;
}

function openingRoundFallback(data) {
  const season = String(data.target_season || data.latest_season || "2627");
  if (season !== "2627") return null;
  const fixtures = OPENING_ROUND_2627.map(([homeTeam, awayTeam], index) => ({
    id: `2627-r1-${index + 1}`,
    season: "2627",
    round: 1,
    date: "2026-08-23",
    kickoff: null,
    home_team: homeTeam,
    away_team: awayTeam,
    completed: false,
    source: "Calendario pubblico 2026/27",
  }));
  return {
    season: "2627",
    teams: [...new Set(fixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team]))].sort(),
    matchdays: [{ round: 1, fixtures, startDate: "2026-08-23", endDate: "2026-08-23" }],
    defaultRound: 1,
    inferred: false,
    fallback: true,
  };
}

function populateFavoriteTeams() {
  const teams = calendar?.teams?.length ? calendar.teams : payload.teams || [];
  const stored = localStorage.getItem(FAVORITE_STORAGE_KEY);
  const fallback = teams.includes("Roma") ? "Roma" : teams[0];
  const selected = teams.includes(stored) ? stored : fallback;
  $("favorite-team-select").innerHTML = teams
    .map((team) => `<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`)
    .join("");
  $("favorite-team-select").value = selected || "";
  $("favorite-team-select").disabled = !teams.length;
}

function populateMatchdays() {
  const select = $("matchday-select");
  select.innerHTML = calendar.matchdays.map((matchday) => `
    <option value="${matchday.round}">${matchdayLabel(matchday)}</option>
  `).join("");
  const params = new URLSearchParams(window.location.search);
  const requested = Number(params.get("round"));
  const validRound = calendar.matchdays.some((matchday) => matchday.round === requested);
  select.value = String(validRound ? requested : calendar.defaultRound);
  select.disabled = false;
  $("season-label").textContent = `${calendar.season.slice(0, 2)}/${calendar.season.slice(2)}`;
  syncSelectedMatchday();
}

function selectedMatchday() {
  const round = Number($("matchday-select").value);
  return calendar.matchdays.find((matchday) => matchday.round === round);
}

function syncSelectedMatchday() {
  const matchday = selectedMatchday();
  if (!matchday) {
    $("selected-round-summary").textContent = "Calendario in aggiornamento";
    return;
  }
  const dateLabel = matchdayLabel(matchday).replace(`Giornata ${matchday.round} · `, "");
  $("selected-round-summary").textContent = calendar.fallback
    ? `${matchday.fixtures.length} partite · ${dateLabel} · calendario completo in aggiornamento`
    : `${matchday.fixtures.length} partite · ${dateLabel}`;
}

function predictionOptions() {
  return {
    windowDays: Number($("window-days").value),
    halfLifeDays: Number($("half-life").value),
    teamContext: payload.team_context || {},
  };
}

function exactScoreRows(scores) {
  const maximum = scores[0]?.probability || 1;
  return scores.slice(0, 6).map((score) => `
    <li>
      <b>${score.home}–${score.away}</b>
      <span class="score-bar"><i style="width:${100 * score.probability / maximum}%"></i></span>
      <span>${percent(score.probability)}</span>
    </li>
  `).join("");
}

function comparisonRow(home, label, away, formatter = (value) => number(value, 2)) {
  return `<div class="comparison-row"><strong>${formatter(home)}</strong><span>${label}</span><strong>${formatter(away)}</strong></div>`;
}

function playerNames(context) {
  if (!context?.used) return "";
  const keyPlayers = context.topPlayers.map((item) => escapeHtml(item.name || item)).slice(0, 3);
  const newcomers = context.newPlayers.map((item) => escapeHtml(item.name || item)).slice(0, 2);
  const parts = [];
  if (keyPlayers.length) parts.push(`Chiave: ${keyPlayers.join(", ")}`);
  if (newcomers.length) parts.push(`Nuovi: ${newcomers.join(", ")}`);
  return parts.join(" · ");
}

function renderFixtureCard(item, index) {
  const { fixture, result } = item;
  const p = result.probabilities;
  const top = p.scores[0];
  const preferred = favoriteTeam();
  const isFavoriteMatch = fixture.home_team === preferred || fixture.away_team === preferred;
  const cardId = `fixture-${index}`;
  const homePlayers = playerNames(result.homeContext);
  const awayPlayers = playerNames(result.awayContext);
  const contextLine = [
    homePlayers ? `${escapeHtml(fixture.home_team)} — ${homePlayers}` : "",
    awayPlayers ? `${escapeHtml(fixture.away_team)} — ${awayPlayers}` : "",
  ].filter(Boolean).join(" | ");
  const comparison = [
    comparisonRow(result.home.ppg5, "Forma (PPG)", result.away.ppg5),
    comparisonRow(result.home.xgFor5, "xG ultime 5", result.away.xgFor5),
    comparisonRow(result.home.xgAgainst5, "xGA ultime 5", result.away.xgAgainst5),
    comparisonRow(result.home.elo, "Elo", result.away.elo, (value) => number(value, 0)),
    comparisonRow(result.home.marketPpg5, "Forza mercato", result.away.marketPpg5),
    comparisonRow(result.homeContext.squadAttack, "Attacco rosa", result.awayContext.squadAttack),
    comparisonRow(result.homeContext.squadContinuity, "Continuità", result.awayContext.squadContinuity, percent),
  ].join("");

  return `
    <article class="fixture-card ${isFavoriteMatch ? "fixture-card--favorite" : ""}">
      ${isFavoriteMatch ? `<div class="favorite-ribbon"><span>${escapeHtml(preferred)}</span><span>Squadra preferita</span></div>` : ""}
      <button class="fixture-toggle" type="button" aria-expanded="false" aria-controls="${cardId}">
        <div class="fixture-meta">
          <span>${formatDate(fixture.date)}</span>
          <span class="quality ${qualityClass(result.quality.label)}">Dati ${result.quality.label.toLowerCase()}</span>
        </div>
        <div class="fixture-main">
          <div class="team team--home ${fixture.home_team === preferred ? "team--favorite" : ""}">
            <span class="team-badge">${teamInitials(fixture.home_team)}</span>
            <strong>${escapeHtml(fixture.home_team)}</strong>
          </div>
          <div class="predicted-score">
            <span>Previsto</span>
            <strong>${top.home}–${top.away}</strong>
            <small>${percent(top.probability)}</small>
          </div>
          <div class="team team--away ${fixture.away_team === preferred ? "team--favorite" : ""}">
            <strong>${escapeHtml(fixture.away_team)}</strong>
            <span class="team-badge">${teamInitials(fixture.away_team)}</span>
          </div>
        </div>
        <div class="probability-strip">
          <span><b>1</b>${percent(p.homeWin)}</span>
          <span><b>X</b>${percent(p.draw)}</span>
          <span><b>2</b>${percent(p.awayWin)}</span>
        </div>
        <div class="fixture-footer">
          <span class="outcome ${outcomeClass(result.mostLikelyOutcome.key)}">${result.mostLikelyOutcome.key} · ${escapeHtml(result.mostLikelyOutcome.name)}</span>
          <span class="expand-label">Dettagli <i>⌄</i></span>
        </div>
      </button>
      <div id="${cardId}" class="fixture-details" hidden>
        <div class="detail-column">
          <div class="detail-heading"><h3>Risultati esatti</h3><span>${result.cutoffDate}</span></div>
          <ol class="score-list">${exactScoreRows(p.scores)}</ol>
        </div>
        <div class="detail-column">
          <div class="detail-heading"><h3>Indicatori</h3></div>
          <div class="metric-grid">
            <div><span>xG ${escapeHtml(fixture.home_team)}</span><strong>${number(result.lambdaHome)}</strong></div>
            <div><span>xG ${escapeHtml(fixture.away_team)}</span><strong>${number(result.lambdaAway)}</strong></div>
            <div><span>Over 2.5</span><strong>${percent(p.over25)}</strong></div>
            <div><span>BTTS</span><strong>${percent(p.bothScore)}</strong></div>
            <div><span>Quota 1</span><strong>${fairOdds(p.homeWin)}</strong></div>
            <div><span>Quota 2</span><strong>${fairOdds(p.awayWin)}</strong></div>
          </div>
        </div>
        <div class="detail-column detail-column--wide">
          <div class="detail-heading"><h3>Confronto</h3><span>${result.trainingMatches} partite</span></div>
          <div class="comparison-table">${comparison}</div>
          ${contextLine ? `<p class="context-line">${contextLine}</p>` : ""}
        </div>
      </div>
    </article>
  `;
}

function updateFavoriteSummary(batch) {
  const preferred = favoriteTeam();
  const prediction = batch.predictions.find(({ fixture }) => fixture.home_team === preferred || fixture.away_team === preferred);
  const box = $("favorite-summary");
  if (!prediction) {
    box.hidden = true;
    return;
  }
  const score = prediction.result.probabilities.scores[0];
  box.querySelector("strong").textContent = `${prediction.fixture.home_team}–${prediction.fixture.away_team} · ${score.home}–${score.away}`;
  box.hidden = false;
}

function renderMatchday(matchday, batch, shouldScroll = true) {
  lastMatchday = matchday;
  lastBatch = batch;
  $("results").hidden = false;
  $("round-title").textContent = `Giornata ${matchday.round}`;
  $("round-subtitle").textContent = `${matchdayLabel(matchday).replace(`Giornata ${matchday.round} · `, "")} · dati fino al ${batch.cutoffDate}`;
  updateFavoriteSummary(batch);
  $("fixtures-grid").innerHTML = batch.predictions.map(renderFixtureCard).join("");
  const url = new URL(window.location.href);
  url.searchParams.set("round", String(matchday.round));
  history.replaceState({}, "", url);
  if (shouldScroll) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runMatchdayPrediction() {
  const button = $("predict-button");
  const error = $("error-message");
  error.hidden = true;
  const matchday = selectedMatchday();
  if (!matchday?.fixtures.length) {
    error.textContent = "Nessuna partita disponibile per questa giornata.";
    error.hidden = false;
    return;
  }
  button.disabled = true;
  button.querySelector("span").textContent = "Calcolo…";
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const batch = predictMatchdayFromMatches(payload.matches, matchday.fixtures, predictionOptions());
    renderMatchday(matchday, batch);
  } catch (caught) {
    error.textContent = caught.message || "Errore durante il calcolo.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Calcola pronostici";
  }
}

function toggleFixture(button) {
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  panel.hidden = expanded;
}

function showPendingCalendar() {
  populateFavoriteTeams();
  $("matchday-select").innerHTML = '<option value="">Calendario in aggiornamento</option>';
  $("matchday-select").disabled = true;
  $("selected-round-summary").textContent = "Dati storici pronti";
  $("predict-button").disabled = true;
  $("data-status").textContent = `Aggiornato ${String(payload.generated_at || "").slice(0, 10) || "—"}`;
  $("coverage-status").textContent = "Calendario in aggiornamento";
  $("error-message").hidden = true;
}

async function init() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = unpackMatches(await response.json());
    calendar = buildMatchdays(payload);
    if (!calendar.matchdays.length) calendar = openingRoundFallback(payload);
    if (!calendar?.matchdays?.length) {
      showPendingCalendar();
      return;
    }
    populateFavoriteTeams();
    populateMatchdays();
    const actualXg = payload.coverage?.xg_actual_matches || 0;
    $("data-status").textContent = `Aggiornato ${payload.generated_at.slice(0, 10)}`;
    $("coverage-status").textContent = calendar.fallback
      ? "1ª giornata disponibile · calendario in aggiornamento"
      : `${payload.matches.length} partite · ${actualXg ? "xG + Elo" : "Elo + xG stimati"}`;
  } catch (error) {
    $("data-status").textContent = "Dati non disponibili";
    $("coverage-status").textContent = "—";
    $("error-message").textContent = "Impossibile caricare i dati. Riprova tra poco.";
    $("error-message").hidden = false;
    $("predict-button").disabled = true;
  }
}

$("matchday-select").addEventListener("change", syncSelectedMatchday);
$("favorite-team-select").addEventListener("change", () => {
  localStorage.setItem(FAVORITE_STORAGE_KEY, favoriteTeam());
  if (lastMatchday && lastBatch) renderMatchday(lastMatchday, lastBatch, false);
});
$("predict-button").addEventListener("click", runMatchdayPrediction);
$("fixtures-grid").addEventListener("click", (event) => {
  const button = event.target.closest(".fixture-toggle");
  if (button) toggleFixture(button);
});

init();
