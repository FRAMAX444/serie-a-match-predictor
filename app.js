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

const ROMA_LATEST_LOGO = "./assets/team-logos/roma-2026.svg";

let payload;
let competitionCatalog = [];
let calendar;
let lastMatchday;
let lastBatch;
let previousModalFocus = null;
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

function teamLogoUrl(fixture, side) {
  const team = fixture[`${side}_team`];
  if (team === "Roma") return ROMA_LATEST_LOGO;

  const explicit = fixture[`${side}_team_logo`] || payload?.team_logos?.[team];
  if (explicit) return explicit;

  const teamId = String(fixture[`${side}_team_id`] || "").trim();
  if (fixture.competition_type === "domestic" && teamId) {
    return `https://a.espncdn.com/i/teamlogos/soccer/500/${encodeURIComponent(teamId)}.png`;
  }
  return "";
}

function teamBadgeMarkup(fixture, side) {
  const team = fixture[`${side}_team`];
  const logo = teamLogoUrl(fixture, side);
  const fallback = `<span class="team-badge__fallback">${teamInitials(team)}</span>`;
  if (!logo) return `<span class="team-badge team-badge--fallback">${fallback}</span>`;
  return `
    <span class="team-badge">
      <img class="team-badge__image" src="${escapeHtml(logo)}" alt="Stemma ${escapeHtml(team)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      <span class="team-badge__fallback" hidden>${teamInitials(team)}</span>
    </span>
  `;
}

function hydrateTeamBadges(root = document) {
  root.querySelectorAll(".team-badge__image").forEach((image) => {
    const badge = image.closest(".team-badge");
    const fallback = badge?.querySelector(".team-badge__fallback");
    const showFallback = () => {
      image.hidden = true;
      if (fallback) fallback.hidden = false;
      badge?.classList.add("team-badge--fallback");
    };
    image.addEventListener("error", showFallback, { once: true });
    if (image.complete && !image.naturalWidth) showFallback();
  });
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
    // Popolato da enrich_competitions_players.py (formazione probabile, disponibilità,
    // neopromosse). Se lo script non è ancora stato eseguito payload.team_context è
    // undefined: predictFromMatches tratta questo caso come "nessun aggiustamento",
    // comportamento identico a prima dell'introduzione della feature.
    teamContext: payload?.team_context || null,
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

// Media sulle ultime `count` partite giocate da `team` (in qualsiasi competizione tracciata)
// per una coppia di campi home/away — usata per corner/cartellini/possesso, che non sono
// (ancora) un input del modello: solo contesto storico mostrato nella tab "Dati extra".
// null se non ci sono abbastanza dati (i campi sono popolati solo dopo che la pipeline è
// stata rigenerata con MATCH_FIELDS esteso).
function recentTeamAverage(matches, team, homeField, awayField, count = 5) {
  const rows = (matches || [])
    .filter((match) => match.home_team === team || match.away_team === team)
    .filter((match) => {
      const value = match.home_team === team ? match[homeField] : match[awayField];
      return value !== null && value !== undefined;
    })
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))
    .slice(0, count);
  if (!rows.length) return null;
  const total = rows.reduce((sum, match) => sum + Number(match.home_team === team ? match[homeField] : match[awayField]), 0);
  return total / rows.length;
}

function qualityBadgeMarkup(result) {
  return globalSettings.showDataQuality
    ? `<span class="quality ${qualityClass(result.quality.label)}">${escapeHtml(result.quality.label)}</span>`
    : "";
}

function fixtureDetailsMarkup(fixture, result) {
  const probabilities = result.probabilities;
  const comparison = [
    comparisonRow(result.home.ppg5, "Forma (PPG)", result.away.ppg5),
    comparisonRow(result.home.xgFor5, "xG ultime 5", result.away.xgFor5),
    comparisonRow(result.home.xgAgainst5, "xGA ultime 5", result.away.xgAgainst5),
    comparisonRow(result.home.sot5, "Tiri in porta", result.away.sot5),
    comparisonRow(result.home.elo, "Elo", result.away.elo, (value) => number(value, 0)),
    comparisonRow(result.home.restDays, "Giorni di riposo", result.away.restDays, (value) => number(value, 0)),
  ].join("");
  const fairOddsMetrics = globalSettings.showFairOdds ? `
    <div><span>Quota 1</span><strong>${fairOdds(probabilities.homeWin)}</strong></div>
    <div><span>Quota X</span><strong>${fairOdds(probabilities.draw)}</strong></div>
    <div><span>Quota 2</span><strong>${fairOdds(probabilities.awayWin)}</strong></div>
  ` : "";

  return `
    <div class="fixture-details fixture-modal__details" data-modal-panel="overview" id="fixture-modal-panel-overview" role="tabpanel" aria-labelledby="fixture-modal-tab-overview">
      <div class="detail-column">
        <div class="detail-heading"><h3>Risultati esatti</h3><span>${escapeHtml(result.cutoffDate)}</span></div>
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
  `;
}

// Tab "Dati extra": tutto ciò che non fa (ancora) parte del modello core mostrato sopra.
// - Contesto pre-partita: i moltiplicatori di team_context, se enrich_competitions_players.py
//   è stato eseguito e ha prodotto una voce per queste due squadre (altrimenti stato vuoto,
//   non un valore fittizio).
// - Corner/cartellini/possesso: media sulle ultime 5 partite disponibili per squadra, dati
//   storici conservati dalla pipeline ma NON un input del modello — mostrati come contesto,
//   etichettati come tali, non come "ciò che ha determinato questo pronostico".
// Le quote di mercato non compaiono qui: nessuna fonte usata da questa pipeline fornisce le
// quote di una partita futura non ancora giocata (Football-Data.co.uk è post-partita). Il
// confronto con il mercato resta disponibile solo in backtest (npm run backtest:market).
function playerStatsRow(player) {
  const cards = player.red_cards > 0
    ? `${player.yellow_cards}🟨 ${player.red_cards}🟥`
    : player.yellow_cards > 0 ? `${player.yellow_cards}🟨` : "—";
  return `<div class="player-row">
    <span class="player-row__name">${escapeHtml(player.name)}<small>${escapeHtml(player.position || "")}</small></span>
    <span class="player-row__stat" title="Gol nelle partite campionate">${player.goals}g</span>
    <span class="player-row__stat" title="Assist nelle partite campionate">${player.assists}a</span>
    <span class="player-row__stat" title="Tiri totali nelle partite campionate">${player.shots}t</span>
    <span class="player-row__stat player-row__cards" title="Cartellini nelle partite campionate">${cards}</span>
  </div>`;
}

// player_context (da enrich_competitions_players.py) contiene, per squadra, i 5 giocatori
// più impattanti tra le partite campionate di recente (non l'intera stagione): un indice
// composito di minuti/gol/assist/rating, non un ranking dedicato a cartellini o tiri — quei
// due sono mostrati come colonne aggiuntive sugli STESSI giocatori chiave, non come una
// classifica separata "più ammoniti" o "più tiri". Assente finché enrich_competitions_players.py
// non è stato eseguito, o se una squadra non ha formazioni recenti campionate.
function playersSectionMarkup(fixture) {
  const homePlayers = payload?.player_context?.[fixture.home_team]?.top_players || [];
  const awayPlayers = payload?.player_context?.[fixture.away_team]?.top_players || [];
  if (!homePlayers.length && !awayPlayers.length) {
    return `
      <div class="detail-column detail-column--wide">
        <div class="detail-heading"><h3>Giocatori chiave</h3><span>gol, assist, tiri, cartellini</span></div>
        <p class="fixture-modal__empty">Non disponibile per questa previsione</p>
      </div>
    `;
  }
  return `
    <div class="detail-column detail-column--wide">
      <div class="detail-heading"><h3>Giocatori chiave</h3><span>ultime formazioni campionate · gol, assist, tiri, cartellini</span></div>
      <div class="players-columns">
        <div class="players-team">
          <h4>${escapeHtml(fixture.home_team)}</h4>
          ${homePlayers.length ? homePlayers.map(playerStatsRow).join("") : `<p class="fixture-modal__empty">Nessun dato</p>`}
        </div>
        <div class="players-team">
          <h4>${escapeHtml(fixture.away_team)}</h4>
          ${awayPlayers.length ? awayPlayers.map(playerStatsRow).join("") : `<p class="fixture-modal__empty">Nessun dato</p>`}
        </div>
      </div>
    </div>
  `;
}

function fixtureExtraDetailsMarkup(fixture, result) {
  const context = result.context;
  const contextRows = context?.applied ? [
    comparisonRow(context.homeAttack, "Attacco (contesto squadra)", context.awayAttack, (value) => `×${number(value, 2)}`),
    comparisonRow(context.homeDefense, "Difesa avversaria (contesto squadra)", context.awayDefense, (value) => `×${number(value, 2)}`),
  ].join("") : "";

  const recentStats = [
    ["home_corners", "away_corners", "Corner (ultime 5)", (value) => number(value, 1)],
    ["home_yellow", "away_yellow", "Cartellini gialli (ultime 5)", (value) => number(value, 1)],
    ["home_possession", "away_possession", "Possesso % (ultime 5)", (value) => `${number(value, 0)}%`],
  ];
  const recentRows = recentStats
    .map(([homeField, awayField, label, formatter]) => {
      const homeValue = recentTeamAverage(payload?.matches, fixture.home_team, homeField, awayField);
      const awayValue = recentTeamAverage(payload?.matches, fixture.away_team, homeField, awayField);
      return homeValue !== null && awayValue !== null ? comparisonRow(homeValue, label, awayValue, formatter) : "";
    })
    .join("");

  return `
    <div class="fixture-details fixture-modal__details" data-modal-panel="extra" id="fixture-modal-panel-extra" role="tabpanel" aria-labelledby="fixture-modal-tab-extra" hidden>
      <div class="detail-column detail-column--wide">
        <div class="detail-heading"><h3>Contesto pre-partita</h3><span>×1 = nessun aggiustamento · sopra = favorevole · sotto = sfavorevole</span></div>
        ${contextRows ? `<div class="comparison-table">${contextRows}</div>` : `<p class="fixture-modal__empty">Non disponibile per questa previsione</p>`}
      </div>
      <div class="detail-column detail-column--wide">
        <div class="detail-heading"><h3>Corner, cartellini, possesso</h3><span>non un input del modello</span></div>
        ${recentRows ? `<div class="comparison-table">${recentRows}</div>` : `<p class="fixture-modal__empty">Dati non ancora disponibili</p>`}
      </div>
      ${playersSectionMarkup(fixture)}
    </div>
  `;
}

function fixtureModalMarkup(item) {
  const { fixture, result } = item;
  const probabilities = result.probabilities;
  const top = probabilities.scores[0];
  const preferred = favoriteTeam();

  return `
    <header class="fixture-modal__header">
      <div>
        <div class="fixture-modal__meta">
          <span>${formatDate(fixture.date)}</span>
          ${qualityBadgeMarkup(result)}
        </div>
        <h2 id="fixture-modal-title">${escapeHtml(fixture.home_team)} – ${escapeHtml(fixture.away_team)}</h2>
      </div>
      <button class="icon-button fixture-modal__close" type="button" data-modal-close aria-label="Chiudi dettagli partita">×</button>
    </header>
    <div class="fixture-modal__hero">
      <div class="fixture-main">
        <div class="team team--home ${fixture.home_team === preferred ? "team--favorite" : ""}">
          ${teamBadgeMarkup(fixture, "home")}
          <strong>${escapeHtml(fixture.home_team)}</strong>
        </div>
        <div class="predicted-score"><strong>${top.home}–${top.away}</strong><small>${percent(top.probability)}</small></div>
        <div class="team team--away ${fixture.away_team === preferred ? "team--favorite" : ""}">
          <strong>${escapeHtml(fixture.away_team)}</strong>
          ${teamBadgeMarkup(fixture, "away")}
        </div>
      </div>
      <div class="probability-strip">
        <span><b>1</b>${percent(probabilities.homeWin)}</span>
        <span><b>X</b>${percent(probabilities.draw)}</span>
        <span><b>2</b>${percent(probabilities.awayWin)}</span>
      </div>
      <p class="fixture-modal__outcome">Esito più probabile: <strong>${result.mostLikelyOutcome.key} · ${escapeHtml(result.mostLikelyOutcome.name)}</strong></p>
    </div>
    <div class="fixture-modal__tabs">
      <div class="fixture-modal__tablist" role="tablist" aria-label="Sezioni analisi partita">
        <button class="fixture-modal__tab" type="button" role="tab" id="fixture-modal-tab-overview" aria-controls="fixture-modal-panel-overview" data-modal-tab="overview" aria-selected="true">Analisi</button>
        <button class="fixture-modal__tab" type="button" role="tab" id="fixture-modal-tab-extra" aria-controls="fixture-modal-panel-extra" data-modal-tab="extra" aria-selected="false">Dati extra</button>
      </div>
    </div>
    ${fixtureDetailsMarkup(fixture, result)}
    ${fixtureExtraDetailsMarkup(fixture, result)}
  `;
}

function renderFixtureCard(item, index) {
  const { fixture, result } = item;
  const probabilities = result.probabilities;
  const top = probabilities.scores[0];
  const preferred = favoriteTeam();
  const isFavoriteMatch = fixture.home_team === preferred || fixture.away_team === preferred;

  return `
    <article class="fixture-card ${isFavoriteMatch ? "fixture-card--favorite" : ""}">
      <button class="fixture-toggle" type="button" data-fixture-index="${index}" aria-haspopup="dialog" aria-label="Apri analisi ${escapeHtml(fixture.home_team)} contro ${escapeHtml(fixture.away_team)}">
        <div class="fixture-meta">
          <span>${formatDate(fixture.date)}</span>
          ${qualityBadgeMarkup(result)}
        </div>
        <div class="fixture-main">
          <div class="team team--home ${fixture.home_team === preferred ? "team--favorite" : ""}">
            ${teamBadgeMarkup(fixture, "home")}
            <strong>${escapeHtml(fixture.home_team)}</strong>
          </div>
          <div class="predicted-score"><strong>${top.home}–${top.away}</strong><small>${percent(top.probability)}</small></div>
          <div class="team team--away ${fixture.away_team === preferred ? "team--favorite" : ""}">
            <strong>${escapeHtml(fixture.away_team)}</strong>
            ${teamBadgeMarkup(fixture, "away")}
          </div>
        </div>
        <div class="probability-strip">
          <span><b>1</b>${percent(probabilities.homeWin)}</span>
          <span><b>X</b>${percent(probabilities.draw)}</span>
          <span><b>2</b>${percent(probabilities.awayWin)}</span>
        </div>
        <div class="fixture-footer">
          <span>${result.mostLikelyOutcome.key} · ${escapeHtml(result.mostLikelyOutcome.name)}</span>
          <span class="expand-label">Apri analisi <i>↗</i></span>
        </div>
      </button>
    </article>
  `;
}

function modalFocusableElements() {
  const panel = $("fixture-modal-panel");
  if (!panel) return [];
  return [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && element.offsetParent !== null);
}

function openFixtureModal(index, trigger) {
  const item = lastBatch?.predictions?.[index];
  const modal = $("fixture-modal");
  const content = $("fixture-modal-content");
  if (!item || !modal || !content) return;

  previousModalFocus = trigger || document.activeElement;
  content.innerHTML = fixtureModalMarkup(item);
  hydrateTeamBadges(content);
  modal.hidden = false;
  document.body.classList.add("fixture-modal-open");
  content.querySelector("[data-modal-close]")?.focus();
}

function switchFixtureModalTab(tabName) {
  const content = $("fixture-modal-content");
  if (!content) return;
  content.querySelectorAll("[data-modal-tab]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.modalTab === tabName));
  });
  content.querySelectorAll("[data-modal-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.modalPanel !== tabName;
  });
}

function closeFixtureModal(restoreFocus = true) {
  const modal = $("fixture-modal");
  if (!modal || modal.hidden) return;

  modal.hidden = true;
  document.body.classList.remove("fixture-modal-open");
  $("fixture-modal-content").replaceChildren();
  if (restoreFocus && previousModalFocus instanceof HTMLElement && document.contains(previousModalFocus)) {
    previousModalFocus.focus();
  }
  previousModalFocus = null;
}

function renderMatchday(matchday, batch, shouldScroll = true) {
  closeFixtureModal(false);
  lastMatchday = matchday;
  lastBatch = batch;
  $("results").hidden = false;
  $("fixtures-grid").innerHTML = batch.predictions.map(renderFixtureCard).join("");
  hydrateTeamBadges($("fixtures-grid"));
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
  closeFixtureModal(false);
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
  if (!button) return;
  openFixtureModal(Number(button.dataset.fixtureIndex), button);
});
$("fixture-modal").addEventListener("click", (event) => {
  if (event.target === $("fixture-modal") || event.target.closest("[data-modal-close]")) {
    closeFixtureModal();
    return;
  }
  const tabButton = event.target.closest("[data-modal-tab]");
  if (tabButton) switchFixtureModalTab(tabButton.dataset.modalTab);
});
document.addEventListener("keydown", (event) => {
  const modal = $("fixture-modal");
  if (!modal || modal.hidden) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeFixtureModal();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = modalFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    $("fixture-modal-panel").focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

init();
