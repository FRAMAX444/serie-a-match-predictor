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
const PALETTE_STORAGE_KEY = "serie-a-predictor-team-palettes";
const BACKGROUND_STORAGE_KEY = "serie-a-predictor-background";
const DEFAULT_PALETTE = { primary: "#1f4f8f", secondary: "#172033" };
const TEAM_PALETTES = {
  Atalanta: { primary: "#1e71b8", secondary: "#101820" },
  Bologna: { primary: "#9b1b30", secondary: "#14213d" },
  Cagliari: { primary: "#a71930", secondary: "#17365d" },
  Como: { primary: "#1d5ca8", secondary: "#ffffff" },
  Fiorentina: { primary: "#5b2a86", secondary: "#ffffff" },
  Frosinone: { primary: "#f4c300", secondary: "#174a8b" },
  Genoa: { primary: "#a71930", secondary: "#17365d" },
  Inter: { primary: "#0057b8", secondary: "#111111" },
  Juventus: { primary: "#111111", secondary: "#ffffff" },
  Lazio: { primary: "#75bde0", secondary: "#ffffff" },
  Lecce: { primary: "#d9ad00", secondary: "#b51f2e" },
  Milan: { primary: "#c8102e", secondary: "#111111" },
  Monza: { primary: "#d71920", secondary: "#ffffff" },
  Napoli: { primary: "#12a0d7", secondary: "#ffffff" },
  Parma: { primary: "#f2c300", secondary: "#1d4f91" },
  Roma: { primary: "#8e1f2f", secondary: "#f0bc42" },
  Sassuolo: { primary: "#2eaa50", secondary: "#111111" },
  Torino: { primary: "#7a263a", secondary: "#ffffff" },
  Udinese: { primary: "#111111", secondary: "#ffffff" },
  Venezia: { primary: "#e86f21", secondary: "#0b6b4f" },
};
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

function hexToRgb(hex) {
  const normalized = String(hex).replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mixColors(color, target, amount) {
  const sourceRgb = hexToRgb(color) || hexToRgb(DEFAULT_PALETTE.primary);
  const targetRgb = hexToRgb(target) || { r: 255, g: 255, b: 255 };
  return rgbToHex({
    r: sourceRgb.r + (targetRgb.r - sourceRgb.r) * amount,
    g: sourceRgb.g + (targetRgb.g - sourceRgb.g) * amount,
    b: sourceRgb.b + (targetRgb.b - sourceRgb.b) * amount,
  });
}

function readableText(color) {
  const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
    const channel = value / 255;
    return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return luminance > .56 ? "#172033" : "#ffffff";
}

function storedPalettes() {
  try {
    return JSON.parse(localStorage.getItem(PALETTE_STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function paletteForTeam(team) {
  const custom = storedPalettes()[team];
  return custom || TEAM_PALETTES[team] || DEFAULT_PALETTE;
}

function applyPalette(palette) {
  const primary = palette.primary || DEFAULT_PALETTE.primary;
  const secondary = palette.secondary || DEFAULT_PALETTE.secondary;
  const primaryRgb = hexToRgb(primary) || hexToRgb(DEFAULT_PALETTE.primary);
  const root = document.documentElement.style;
  root.setProperty("--primary", primary);
  root.setProperty("--primary-rgb", `${primaryRgb.r} ${primaryRgb.g} ${primaryRgb.b}`);
  root.setProperty("--primary-dark", mixColors(primary, "#000000", .28));
  root.setProperty("--primary-soft", mixColors(primary, "#ffffff", .89));
  root.setProperty("--on-primary", readableText(primary));
  root.setProperty("--accent", secondary);
  root.setProperty("--accent-dark", mixColors(secondary, "#000000", .25));
  root.setProperty("--on-accent", readableText(secondary));
  root.setProperty("--favorite-bg", mixColors(primary, "#ffffff", .91));
  root.setProperty("--favorite-bg-strong", mixColors(primary, "#ffffff", .82));
  root.setProperty("--favorite-border", mixColors(primary, "#ffffff", .55));
  $("primary-color").value = primary;
  $("secondary-color").value = secondary;
}

function applyFavoritePalette() {
  applyPalette(paletteForTeam(favoriteTeam()));
}

function savePaletteForFavorite() {
  const team = favoriteTeam();
  if (!team) return;
  const palettes = storedPalettes();
  palettes[team] = {
    primary: $("primary-color").value,
    secondary: $("secondary-color").value,
  };
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
    applyPalette(palettes[team]);
    $("customization-status").textContent = `Colori personalizzati salvati per ${team}.`;
  } catch {
    $("customization-status").textContent = "Impossibile salvare la palette nel browser.";
  }
}

function resetFavoritePalette() {
  const team = favoriteTeam();
  const palettes = storedPalettes();
  delete palettes[team];
  localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
  applyFavoritePalette();
  $("customization-status").textContent = `Ripristinati i colori predefiniti di ${team}.`;
}

function applyBackground(dataUrl) {
  if (!dataUrl) {
    document.body.classList.remove("has-custom-background");
    document.body.style.removeProperty("--custom-background-image");
    $("remove-background").disabled = true;
    return;
  }
  document.body.style.setProperty("--custom-background-image", `url("${dataUrl}")`);
  document.body.classList.add("has-custom-background");
  $("remove-background").disabled = false;
}

function resizeBackground(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Impossibile leggere l'immagine."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Formato immagine non supportato."));
      image.onload = () => {
        const maxWidth = 1920;
        const maxHeight = 1200;
        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .84));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function updateBackground(event) {
  const [file] = event.target.files;
  if (!file) return;
  const status = $("customization-status");
  if (!file.type.startsWith("image/")) {
    status.textContent = "Seleziona un file immagine.";
    event.target.value = "";
    return;
  }
  status.textContent = "Preparazione dello sfondo…";
  try {
    const dataUrl = await resizeBackground(file);
    localStorage.setItem(BACKGROUND_STORAGE_KEY, dataUrl);
    applyBackground(dataUrl);
    status.textContent = "Immagine di sfondo salvata su questo browser.";
  } catch (error) {
    status.textContent = error.name === "QuotaExceededError"
      ? "Immagine troppo grande per essere salvata. Prova un file più leggero."
      : error.message || "Impossibile impostare lo sfondo.";
  } finally {
    event.target.value = "";
  }
}

function removeBackground() {
  localStorage.removeItem(BACKGROUND_STORAGE_KEY);
  applyBackground("");
  $("customization-status").textContent = "Sfondo personalizzato rimosso.";
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
  applyFavoritePalette();
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
  $("error-message").hidden = true;
}

async function init() {
  applyBackground(localStorage.getItem(BACKGROUND_STORAGE_KEY));
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
  } catch (error) {
    $("error-message").textContent = "Impossibile caricare i dati. Riprova tra poco.";
    $("error-message").hidden = false;
    $("predict-button").disabled = true;
  }
}

$("matchday-select").addEventListener("change", syncSelectedMatchday);
$("favorite-team-select").addEventListener("change", () => {
  localStorage.setItem(FAVORITE_STORAGE_KEY, favoriteTeam());
  applyFavoritePalette();
  $("customization-status").textContent = `Palette aggiornata per ${favoriteTeam()}.`;
  if (lastMatchday && lastBatch) renderMatchday(lastMatchday, lastBatch, false);
});
$("primary-color").addEventListener("input", savePaletteForFavorite);
$("secondary-color").addEventListener("input", savePaletteForFavorite);
$("reset-palette").addEventListener("click", resetFavoritePalette);
$("background-image").addEventListener("change", updateBackground);
$("remove-background").addEventListener("click", removeBackground);
$("predict-button").addEventListener("click", runMatchdayPrediction);
$("fixtures-grid").addEventListener("click", (event) => {
  const button = event.target.closest(".fixture-toggle");
  if (button) toggleFixture(button);
});

init();
