import { buildMatchdays, matchdayLabel } from "./matchdays.js";
import { projectSeasonSnapshot } from "./season-projection.js";
import { DEFAULT_GLOBAL_SETTINGS, initializeGlobalSettings } from "./global-settings.js";
import { applyStoredAppearance, getModelSettings } from "./preferences.js";

const $ = (id) => document.getElementById(id);
const percent = (value) => `${(100 * Number(value || 0)).toFixed(1)}%`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));
const formatDate = (value) => new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric" })
  .format(new Date(`${value}T12:00:00Z`));

let payload;
let calendar;
let globalSettings = { ...DEFAULT_GLOBAL_SETTINGS };

function unpackMatches(data) {
  if (data.columns && data.matches?.length && Array.isArray(data.matches[0])) {
    data.matches = data.matches.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
  }
  return data;
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
    teamContext: payload?.team_context || null,
  };
}

function renderStandingRow(row) {
  const zoneClass = row.position <= 4 ? " projection-row--champions"
    : row.position === 5 ? " projection-row--europe"
      : row.position >= 18 ? " projection-row--relegation" : "";
  const goalDifference = row.goalDifference > 0 ? `+${row.goalDifference}` : String(row.goalDifference);
  return `<tr class="${zoneClass.trim()}">
    <td class="projection-position">${row.position}</td>
    <th scope="row">${escapeHtml(row.team)}</th>
    <td>${row.currentPlayed}</td>
    <td>${row.currentPoints}</td>
    <td>${row.predictedPoints > 0 ? `+${row.predictedPoints}` : row.predictedPoints}</td>
    <td>${row.played}</td>
    <td>${row.wins}</td>
    <td>${row.draws}</td>
    <td>${row.losses}</td>
    <td>${row.goalsFor}</td>
    <td>${row.goalsAgainst}</td>
    <td>${goalDifference}</td>
    <td class="projection-points"><strong>${row.points}</strong></td>
  </tr>`;
}

function renderPrediction(prediction) {
  const p = prediction.result.probabilities;
  return `<div class="projection-fixture">
    <span class="projection-fixture__teams">${escapeHtml(prediction.fixture.home_team)} <strong>${prediction.homeGoals}–${prediction.awayGoals}</strong> ${escapeHtml(prediction.fixture.away_team)}</span>
    <span class="projection-fixture__probabilities">1 ${percent(p.homeWin)} · X ${percent(p.draw)} · 2 ${percent(p.awayWin)}</span>
  </div>`;
}

function renderRounds(projection) {
  const grouped = new Map();
  projection.predictions.forEach((prediction) => {
    const round = Number(prediction.fixture.round || 0);
    if (!grouped.has(round)) grouped.set(round, []);
    grouped.get(round).push(prediction);
  });

  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([round, predictions], index) => {
    const matchday = calendar.matchdays.find((item) => item.round === round);
    return `<details class="projection-round" ${index === 0 ? "open" : ""}>
      <summary><span>${escapeHtml(matchday ? matchdayLabel(matchday) : `Giornata ${round}`)}</span><strong>${predictions.length} partite previste</strong></summary>
      <div class="projection-round__fixtures">${predictions.map(renderPrediction).join("")}</div>
    </details>`;
  }).join("");
}

function renderProjection(projection) {
  $("projection-results").hidden = false;
  $("projection-summary").innerHTML = `
    <div><span>Stagione</span><strong>${escapeHtml(calendar.season || "Serie A")}</strong></div>
    <div><span>Snapshot modello</span><strong>${escapeHtml(formatDate(projection.snapshotDate))}</strong></div>
    <div><span>Già giocate</span><strong>${projection.playedMatches}</strong></div>
    <div><span>Da prevedere</span><strong>${projection.remainingMatches}</strong></div>`;
  $("projection-table-body").innerHTML = projection.standings.map(renderStandingRow).join("");
  $("projection-rounds").innerHTML = renderRounds(projection) || '<p class="projection-empty">Il campionato è già terminato: la tabella coincide con la classifica reale disponibile nel dataset.</p>';
}

async function runProjection() {
  const button = $("projection-button");
  const error = $("projection-error");
  error.hidden = true;
  button.disabled = true;
  button.textContent = "Calcolo…";
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const projection = projectSeasonSnapshot(payload.matches, calendar, predictionOptions());
    renderProjection(projection);
    $("projection-results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (caught) {
    error.textContent = caught.message || "Errore durante la proiezione del campionato.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Ricalcola proiezione";
  }
}

async function init() {
  applyStoredAppearance();
  await initializeGlobalSettings((settings) => { globalSettings = settings; });
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = unpackMatches(await response.json());
    calendar = buildMatchdays(payload, "ita.1");
    if (!calendar.competition || !calendar.matchdays.length) throw new Error("Calendario di Serie A non disponibile.");
    $("projection-season").textContent = calendar.season ? `Serie A ${calendar.season}` : "Serie A";
    $("projection-button").disabled = false;
  } catch (caught) {
    $("projection-error").textContent = caught.message || "Impossibile caricare i dati della Serie A.";
    $("projection-error").hidden = false;
  }
}

$("projection-button").addEventListener("click", runProjection);
init();
