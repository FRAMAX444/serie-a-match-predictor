import { predictMatchdayFromMatches } from "./model.js";
import { buildCompetitionCatalog, buildMatchdays, matchdayLabel } from "./matchdays.js";
import { DEFAULT_GLOBAL_SETTINGS, applyGlobalSettings, initializeGlobalSettings } from "./global-settings.js";
import {
  FAVORITE_STORAGE_KEY,
  applyStoredAppearance,
  applyTeamPalette,
  getModelSettings,
  setFavoriteTeam,
} from "./preferences.js";

const $ = (id) => document.getElementById(id);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
const number = (value, digits = 2) => Number(value).toFixed(digits);
const fairOdds = (value) => value > 0 ? number(1 / value, 2) : "—";
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));
const formatDate = (value) => new Intl.DateTimeFormat("it-IT", {
  weekday: "short", day: "numeric", month: "short",
}).format(new Date(`${value}T12:00:00Z`));

let payload;
let competitionCatalog = [];
let calendar;
let lastMatchday;
let lastBatch;
let globalSettings = { ...DEFAULT_GLOBAL_SETTINGS };

function unpackMatches(data) {
  if (data.columns && data.matches?.length && Array.isArray(data.matches[0])) {
    data.matches = data.matches.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
  }
  return data;
}

function teamInitials(team) {
  return team.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function competitionInitials(name) {
  return String(name).split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
}

function updateCompetitionLogo() {
  const container = $("competition-logo");
  if (!container) return;
  const competition = competitionCatalog.find((item) => item.id === selectedCompetitionId());
  container.replaceChildren();
  container.title = competition?.name || "Competizione";
  if (!competition?.logo) {
    container.textContent = competitionInitials(competition?.name || "C");
    return;
  }
  const image = document.createElement("img");
  image.src = competition.logo;
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    container.replaceChildren();
    container.textContent = competitionInitials(competition.name);
  }, { once: true });
  container.append(image);
}

function qualityClass(label) {
  return `quality--${String(label).toLowerCase()}`;
}

function favoriteTeam() {
  return $("favorite-team-select").value;
}

function selectedCompetitionId() {
  return $("competition-select").value;
}

function populateCompetitions() {
  const requested = new URLSearchParams(window.location.search).get("competition");
  const preferred = competitionCatalog.some((competition) => competition.id === requested)
    ? requested
    : competitionCatalog.some((competition) => competition.id === payload.default_competition)
      ? payload.default_competition
      : competitionCatalog[0]?.id;
  $("competition-select").innerHTML = competitionCatalog
    .map((competition) => `<option value="${escapeHtml(competition.id)}">${escapeHtml(competition.name)}</option>`)
    .join("");
  $("competition-select").value = preferred;
  updateCompetitionLogo();
}

function populateFavoriteTeams() {
  const teams = calendar?.teams || [];
  const stored = localStorage.getItem(FAVORITE_STORAGE_KEY);
  const configured = teams.includes(globalSettings.featuredTeam) ? globalSettings.featuredTeam : null;
  const fallback = configured || (teams.includes("Roma") ? "Roma" : teams[0]);
  const selected = globalSettings.forceFeaturedTeam
    ? fallback
    : (teams.includes(stored) ? stored : "");
  $("favorite-team-select").innerHTML = [
    '<option value="">Nessuna squadra evidenziata</option>',
    ...teams.map((team) => `<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`),
  ].join("");
  $("favorite-team-select").value = selected || "";
  $("favorite-team-select").disabled = !teams.length || globalSettings.forceFeaturedTeam;
  applyTeamPalette(selected || stored || fallback);
  if (globalSettings.forceAppearance) applyGlobalSettings(globalSettings);
}

function populateMatchdays() {
  const select = $("matchday-select");
  select.innerHTML = calendar.matchdays
    .map((matchday) => `<option value="${matchday.round}">${escapeHtml(matchdayLabel(matchday))}</option>`)
    .join("");
  const requested = Number(new URLSearchParams(window.location.search).get("round"));
  const valid = calendar.matchdays.some((matchday) => matchday.round === requested);
  select.value = String(valid ? requested : calendar.defaultRound);
  select.disabled = !calendar.matchdays.length;
}

function loadSelectedCompetition() {
  updateCompetitionLogo();
  calendar = buildMatchdays(payload, selectedCompetitionId());
  if (!calendar.competition || !calendar.matchdays.length) {
    $("matchday-select").innerHTML = '<option value="">Calendario non disponibile</option>';
    $("matchday-select").disabled = true;
    $("favorite-team-select").innerHTML = '<option value="">Squadre non disponibili</option>';
    $("favorite-team-select").disabled = true;
    $("predict-button").disabled = true;
    return;
  }
  populateMatchdays();
  populateFavoriteTeams();
  $("predict-button").disabled = false;
}

function selectedMatchday() {
  const round = Number($("matchday-select").value);
  return calendar?.matchdays.find((matchday) => matchday.round === round);
}

function predictionOptions() {
  const personal = getModelSettings();
  const model = globalSettings.forceModelSettings ? {
    windowDays: globalSettings.defaultWindowDays,
    halfLifeDays: globalSettings.defaultHalfLifeDays,
  } : personal;
  return {
    windowDays: model.windowDays,
    halfLifeDays: model.halfLifeDays,
    competitionId: selectedCompetitionId(),
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

function renderFixtureCard(item, index) {
  const { fixture, result } = item;
  const probabilities = result.probabilities;
  const top = probabilities.scores[0];
  const preferred = favoriteTeam();
  const isFavoriteMatch = fixture.home_team === preferred || fixture.away_team === preferred;
  const cardId = `fixture-${index}`;
  const comparison = [
    comparisonRow(result.home.ppg5, "Forma (PPG)", result.away.ppg5),
    comparisonRow(result.home.xgFor5, "xG ultime 5", result.away.xgFor5),
    comparisonRow(result.home.xgAgainst5, "xGA ultime 5", result.away.xgAgainst5),
    comparisonRow(result.home.sot5, "Tiri in porta", result.away.sot5),
    comparisonRow(result.home.elo, "Elo", result.away.elo, (value) => number(value, 0)),
    comparisonRow(result.home.restDays, "Giorni di riposo", result.away.restDays, (value) => number(value, 0)),
  ].join("");
  const qualityBadge = globalSettings.showDataQuality
    ? `<span class="quality ${qualityClass(result.quality.label)}">${result.quality.label}</span>`
    : "";
  const fairOddsMetrics = globalSettings.showFairOdds ? `
    <div><span>Quota 1</span><strong>${fairOdds(probabilities.homeWin)}</strong></div>
    <div><span>Quota X</span><strong>${fairOdds(probabilities.draw)}</strong></div>
    <div><span>Quota 2</span><strong>${fairOdds(probabilities.awayWin)}</strong></div>
  ` : "";

  return `
    <article class="fixture-card ${isFavoriteMatch ? "fixture-card--favorite" : ""}">
      <button class="fixture-toggle" type="button" aria-expanded="false" aria-controls="${cardId}">
        <div class="fixture-meta">
          <span>${formatDate(fixture.date)}</span>
          ${qualityBadge}
        </div>
        <div class="fixture-main">
          <div class="team team--home ${fixture.home_team === preferred ? "team--favorite" : ""}">
            <span class="team-badge">${teamInitials(fixture.home_team)}</span>
            <strong>${escapeHtml(fixture.home_team)}</strong>
          </div>
          <div class="predicted-score"><strong>${top.home}–${top.away}</strong><small>${percent(top.probability)}</small></div>
          <div class="team team--away ${fixture.away_team === preferred ? "team--favorite" : ""}">
            <strong>${escapeHtml(fixture.away_team)}</strong>
            <span class="team-badge">${teamInitials(fixture.away_team)}</span>
          </div>
        </div>
        <div class="probability-strip">
          <span><b>1</b>${percent(probabilities.homeWin)}</span>
          <span><b>X</b>${percent(probabilities.draw)}</span>
          <span><b>2</b>${percent(probabilities.awayWin)}</span>
        </div>
        <div class="fixture-footer">
          <span>${result.mostLikelyOutcome.key} · ${escapeHtml(result.mostLikelyOutcome.name)}</span>
          <span class="expand-label">Dettagli <i>⌄</i></span>
        </div>
      </button>
      <div id="${cardId}" class="fixture-details" hidden>
        <div class="detail-column">
          <div class="detail-heading"><h3>Risultati esatti</h3><span>${result.cutoffDate}</span></div>
          <ol class="score-list">${exactScoreRows(probabilities.scores)}</ol>
        </div>
        <div class="detail-column">
          <div class="detail-heading"><h3>Indicatori</h3><span>${result.baselineMatches} gare baseline</span></div>
          <div class="metric-grid">
            <div><span>xG ${escapeHtml(fixture.home_team)}</span><strong>${number(result.lambdaHome)}</strong></div>
            <div><span>xG ${escapeHtml(fixture.away_team)}</span><strong>${number(result.lambdaAway)}</strong></div>
            <div><span>Over 2.5</span><strong>${percent(probabilities.over25)}</strong></div>
            <div><span>BTTS</span><strong>${percent(probabilities.bothScore)}</strong></div>
            ${fairOddsMetrics}
          </div>
        </div>
        <div class="detail-column detail-column--wide">
          <div class="detail-heading"><h3>Indicatori usati dal modello</h3><span>${result.trainingMatches} partite</span></div>
          <div class="comparison-table">${comparison}</div>
          <p class="context-line">Modello core: xG/gol, tiri, forma recente, Elo, rendimento casa/trasferta e riposo.</p>
        </div>
      </div>
    </article>
  `;
}

function renderMatchday(matchday, batch, shouldScroll = true) {
  lastMatchday = matchday;
  lastBatch = batch;
  $("results").hidden = false;
  $("fixtures-grid").innerHTML = batch.predictions.map(renderFixtureCard).join("");
  const url = new URL(window.location.href);
  url.searchParams.set("competition", selectedCompetitionId());
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
    error.textContent = "Nessuna partita disponibile per questo turno.";
    error.hidden = false;
    return;
  }
  button.disabled = true;
  button.querySelector("span").textContent = "…";
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const batch = predictMatchdayFromMatches(payload.matches, matchday.fixtures, predictionOptions());
    renderMatchday(matchday, batch);
  } catch (caught) {
    error.textContent = caught.message || "Errore durante il calcolo.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Calcola";
  }
}

function toggleFixture(button) {
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  panel.hidden = expanded;
}

function handleGlobalSettings(settings) {
  globalSettings = settings;
  if (!calendar) return;
  populateFavoriteTeams();
  if (lastMatchday && lastBatch) renderMatchday(lastMatchday, lastBatch, false);
}

async function init() {
  applyStoredAppearance();
  await initializeGlobalSettings(handleGlobalSettings);
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = unpackMatches(await response.json());
    competitionCatalog = buildCompetitionCatalog(payload);
    if (!competitionCatalog.length) throw new Error("Le competizioni supportate non sono disponibili nel dataset.");
    populateCompetitions();
    loadSelectedCompetition();
  } catch {
    $("error-message").textContent = "Impossibile caricare i dati dei campionati e delle coppe UEFA. Riprova tra poco.";
    $("error-message").hidden = false;
    $("predict-button").disabled = true;
  }
}

$("competition-select").addEventListener("change", () => {
  $("results").hidden = true;
  lastMatchday = null;
  lastBatch = null;
  loadSelectedCompetition();
});
$("favorite-team-select").addEventListener("change", () => {
  if (globalSettings.forceFeaturedTeam) return;
  if (favoriteTeam()) setFavoriteTeam(favoriteTeam());
  applyTeamPalette(favoriteTeam() || localStorage.getItem(FAVORITE_STORAGE_KEY));
  if (globalSettings.forceAppearance) applyGlobalSettings(globalSettings);
  if (lastMatchday && lastBatch) renderMatchday(lastMatchday, lastBatch, false);
});
$("predict-button").addEventListener("click", runMatchdayPrediction);
$("fixtures-grid").addEventListener("click", (event) => {
  const button = event.target.closest(".fixture-toggle");
  if (button) toggleFixture(button);
});

init();
