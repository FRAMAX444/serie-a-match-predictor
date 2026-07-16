import { predictMatchdayFromMatches } from "./model.js";
import { buildMatchdays, matchdayLabel } from "./matchdays.js";

const $ = (id) => document.getElementById(id);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
const number = (value, digits = 2) => Number(value).toFixed(digits);
const fairOdds = (value) => value > 0 ? number(1 / value, 2) : "—";
const formatDate = (value) => new Intl.DateTimeFormat("it-IT", {
  weekday: "short",
  day: "numeric",
  month: "short",
}).format(new Date(`${value}T12:00:00Z`));

let payload;
let calendar;

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

function populateMatchdays() {
  const select = $("matchday-select");
  select.innerHTML = calendar.matchdays.map((matchday) => `
    <option value="${matchday.round}">${matchdayLabel(matchday)}</option>
  `).join("");
  const params = new URLSearchParams(window.location.search);
  const requested = Number(params.get("round"));
  const validRound = calendar.matchdays.some((matchday) => matchday.round === requested);
  select.value = String(validRound ? requested : calendar.defaultRound);
  $("season-label").textContent = `Stagione ${calendar.season.slice(0, 2)}/${calendar.season.slice(2)}`;
  $("schedule-status").textContent = calendar.inferred
    ? "Giornate ricostruite dal calendario disponibile"
    : "Calendario ufficiale importato nel dataset";
  syncSelectedMatchday();
}

function selectedMatchday() {
  const round = Number($("matchday-select").value);
  return calendar.matchdays.find((matchday) => matchday.round === round);
}

function syncSelectedMatchday() {
  const matchday = selectedMatchday();
  $("selected-round-summary").textContent = matchday
    ? `${matchday.fixtures.length} partite · ${matchdayLabel(matchday).replace(`Giornata ${matchday.round} · `, "")}`
    : "Nessuna partita disponibile";
}

function predictionOptions() {
  return {
    windowDays: Number($("window-days").value),
    halfLifeDays: Number($("half-life").value),
  };
}

function exactScoreRows(scores) {
  const maximum = scores[0]?.probability || 1;
  return scores.slice(0, 8).map((score) => `
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
  const p = result.probabilities;
  const top = p.scores[0];
  const romaMatch = fixture.home_team === "Roma" || fixture.away_team === "Roma";
  const cardId = `fixture-${index}`;
  const comparison = [
    comparisonRow(result.home.ppg5, "Punti/gara ultime 5", result.away.ppg5),
    comparisonRow(result.home.xgFor5, "xG ultime 5", result.away.xgFor5),
    comparisonRow(result.home.xgAgainst5, "xGA ultime 5", result.away.xgAgainst5),
    comparisonRow(result.home.sot5, "Tiri in porta", result.away.sot5),
    comparisonRow(result.home.possession5, "Possesso", result.away.possession5, (value) => `${number(value, 1)}%`),
    comparisonRow(result.home.elo, "Rating Elo", result.away.elo, (value) => number(value, 0)),
  ].join("");
  return `
    <article class="fixture-card ${romaMatch ? "fixture-card--roma" : ""}">
      ${romaMatch ? '<div class="roma-ribbon">ROMA IN EVIDENZA</div>' : ""}
      <button class="fixture-toggle" type="button" aria-expanded="false" aria-controls="${cardId}">
        <div class="fixture-meta">
          <span>${formatDate(fixture.date)}</span>
          <span class="quality ${qualityClass(result.quality.label)}">Qualità dati ${result.quality.label}</span>
        </div>
        <div class="fixture-main">
          <div class="team team--home ${fixture.home_team === "Roma" ? "team--roma" : ""}">
            <span class="team-badge">${teamInitials(fixture.home_team)}</span>
            <strong>${fixture.home_team}</strong>
          </div>
          <div class="predicted-score">
            <span>Pronostico</span>
            <strong>${top.home}–${top.away}</strong>
            <small>${percent(top.probability)}</small>
          </div>
          <div class="team team--away ${fixture.away_team === "Roma" ? "team--roma" : ""}">
            <strong>${fixture.away_team}</strong>
            <span class="team-badge">${teamInitials(fixture.away_team)}</span>
          </div>
        </div>
        <div class="probability-strip">
          <span><b>1</b>${percent(p.homeWin)}</span>
          <span><b>X</b>${percent(p.draw)}</span>
          <span><b>2</b>${percent(p.awayWin)}</span>
        </div>
        <div class="fixture-footer">
          <span class="outcome ${outcomeClass(result.mostLikelyOutcome.key)}">Esito: ${result.mostLikelyOutcome.key} · ${result.mostLikelyOutcome.name}</span>
          <span class="expand-label">Risultati esatti e dettagli <i>⌄</i></span>
        </div>
      </button>
      <div id="${cardId}" class="fixture-details" hidden>
        <div class="detail-column">
          <div class="detail-heading">
            <div><p class="kicker">RISULTATI ESATTI</p><h3>Top punteggi previsti</h3></div>
            <span>Cutoff ${result.cutoffDate}</span>
          </div>
          <ol class="score-list">${exactScoreRows(p.scores)}</ol>
        </div>
        <div class="detail-column">
          <div class="detail-heading"><div><p class="kicker">MODELLO</p><h3>Indicatori chiave</h3></div></div>
          <div class="metric-grid">
            <div><span>xG ${fixture.home_team}</span><strong>${number(result.lambdaHome)}</strong></div>
            <div><span>xG ${fixture.away_team}</span><strong>${number(result.lambdaAway)}</strong></div>
            <div><span>Over 2.5</span><strong>${percent(p.over25)}</strong></div>
            <div><span>Goal / BTTS</span><strong>${percent(p.bothScore)}</strong></div>
            <div><span>Quota teorica 1</span><strong>${fairOdds(p.homeWin)}</strong></div>
            <div><span>Quota teorica 2</span><strong>${fairOdds(p.awayWin)}</strong></div>
          </div>
        </div>
        <div class="detail-column detail-column--wide">
          <div class="detail-heading"><div><p class="kicker">CONFRONTO</p><h3>Forma e forza pre-partita</h3></div></div>
          <div class="comparison-table">${comparison}</div>
          <p class="model-note">Riposo: ${result.home.restDays} giorni ${fixture.home_team}, ${result.away.restDays} giorni ${fixture.away_team}. Modello allenato su ${result.trainingMatches} partite (${result.firstTrainingDate} → ${result.lastTrainingDate}). Correzione Dixon–Coles applicata ai punteggi bassi.</p>
        </div>
      </div>
    </article>
  `;
}

function renderMatchday(matchday, batch) {
  $("results").hidden = false;
  $("round-title").textContent = `Giornata ${matchday.round}`;
  $("round-subtitle").textContent = `${matchdayLabel(matchday).replace(`Giornata ${matchday.round} · `, "")} · cutoff comune ${batch.cutoffDate}`;
  const romaPrediction = batch.predictions.find(({ fixture }) => fixture.home_team === "Roma" || fixture.away_team === "Roma");
  $("roma-summary").textContent = romaPrediction
    ? `Roma: ${romaPrediction.fixture.home_team}–${romaPrediction.fixture.away_team}, risultato più probabile ${romaPrediction.result.probabilities.scores[0].home}–${romaPrediction.result.probabilities.scores[0].away}`
    : "La Roma non gioca in questa giornata.";
  $("fixtures-grid").innerHTML = batch.predictions.map(renderFixtureCard).join("");
  $("method-note").textContent = `Tutte le ${batch.predictions.length} previsioni usano dati antecedenti al ${batch.cutoffDate}: nessuna gara della stessa giornata entra nell'allenamento delle altre. Le probabilità sono stime statistiche, non risultati garantiti.`;
  const url = new URL(window.location.href);
  url.searchParams.set("round", String(matchday.round));
  history.replaceState({}, "", url);
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runMatchdayPrediction() {
  const button = $("predict-button");
  const error = $("error-message");
  error.hidden = true;
  const matchday = selectedMatchday();
  if (!matchday?.fixtures.length) {
    error.textContent = "La giornata selezionata non contiene partite.";
    error.hidden = false;
    return;
  }
  button.disabled = true;
  button.querySelector("span").textContent = "Calcolo delle 10 partite…";
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const batch = predictMatchdayFromMatches(payload.matches, matchday.fixtures, predictionOptions());
    renderMatchday(matchday, batch);
  } catch (caught) {
    error.textContent = caught.message || "Errore durante il calcolo della giornata.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Calcola tutta la giornata";
  }
}

function toggleFixture(button) {
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  panel.hidden = expanded;
  if (!expanded && window.matchMedia("(max-width: 720px)").matches) {
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function init() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = unpackMatches(await response.json());
    calendar = buildMatchdays(payload);
    if (!calendar.matchdays.length) throw new Error("Calendario non disponibile nel dataset.");
    populateMatchdays();
    $("data-status").textContent = `${payload.matches.length} partite storiche · aggiornato ${payload.generated_at.slice(0, 10)}`;
    const actualXg = payload.coverage?.xg_actual_matches || 0;
    $("coverage-status").textContent = actualXg ? `xG reali: ${actualXg} gare` : "xG proxy da tiri e tiri in porta";
  } catch (error) {
    $("data-status").textContent = "Dati non disponibili";
    $("error-message").textContent = `Impossibile caricare il dataset: ${error.message}`;
    $("error-message").hidden = false;
    $("predict-button").disabled = true;
  }
}

$("matchday-select").addEventListener("change", syncSelectedMatchday);
$("predict-button").addEventListener("click", runMatchdayPrediction);
$("fixtures-grid").addEventListener("click", (event) => {
  const button = event.target.closest(".fixture-toggle");
  if (button) toggleFixture(button);
});

init();
