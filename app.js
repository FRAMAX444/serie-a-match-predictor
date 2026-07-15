import { predictFromMatches } from "./model.js";

const $ = (id) => document.getElementById(id);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
const number = (value, digits = 2) => Number(value).toFixed(digits);
const fairOdds = (value) => value > 0 ? number(1 / value, 2) : "—";
let payload;

function setRangeOutput(inputId, outputId, suffix = "%") {
  const input = $(inputId), output = $(outputId);
  const render = () => { output.value = `${input.value}${suffix}`; };
  input.addEventListener("input", render); render();
}

function populateTeams(teams) {
  [$("home-team"), $("away-team")].forEach((select) => {
    select.innerHTML = teams.map((team) => `<option value="${team}">${team}</option>`).join("");
  });
  const preferredHome = teams.includes("Roma") ? "Roma" : teams[0];
  const preferredAway = teams.includes("Inter") ? "Inter" : teams.find((team) => team !== preferredHome);
  $("home-team").value = preferredHome;
  $("away-team").value = preferredAway;
  syncLabels();
}

function syncLabels() {
  $("home-adjustment-title").textContent = $("home-team").value || "Casa";
  $("away-adjustment-title").textContent = $("away-team").value || "Trasferta";
}

function predictionOptions() {
  return {
    homeTeam: $("home-team").value,
    awayTeam: $("away-team").value,
    date: $("match-date").value,
    windowDays: Number($("window-days").value),
    halfLifeDays: Number($("half-life").value),
    homeAttackAbsence: Number($("home-attack-absence").value) / 100,
    homeDefenseAbsence: Number($("home-defense-absence").value) / 100,
    awayAttackAbsence: Number($("away-attack-absence").value) / 100,
    awayDefenseAbsence: Number($("away-defense-absence").value) / 100,
    homeLineup: Number($("home-lineup").value) / 100,
    awayLineup: Number($("away-lineup").value) / 100,
  };
}

function outcomeSummary(result, options) {
  const outcomes = [
    { name: options.homeTeam, probability: result.probabilities.homeWin },
    { name: "pareggio", probability: result.probabilities.draw },
    { name: options.awayTeam, probability: result.probabilities.awayWin },
  ].sort((a, b) => b.probability - a.probability);
  return `Esito più probabile: ${outcomes[0].name} (${percent(outcomes[0].probability)}). Modello calibrato su ${result.trainingMatches} partite recenti.`;
}

function comparisonRow(home, label, away, formatter = (v) => number(v, 2)) {
  return `<div class="comparison-row"><strong>${formatter(home)}</strong><span>${label}</span><strong>${formatter(away)}</strong></div>`;
}

function render(result, options) {
  const p = result.probabilities;
  const top = p.scores[0];
  $("fixture-label").textContent = `${options.homeTeam} — ${options.awayTeam}`;
  $("prediction-summary").textContent = outcomeSummary(result, options);
  $("top-score").textContent = `${top.home}–${top.away}`;
  $("top-score-probability").textContent = percent(top.probability);

  const outcomes = [
    ["home-win-probability", "home-win-meter", "home-fair-odds", p.homeWin],
    ["draw-probability", "draw-meter", "draw-fair-odds", p.draw],
    ["away-win-probability", "away-win-meter", "away-fair-odds", p.awayWin],
  ];
  outcomes.forEach(([probabilityId, meterId, oddsId, value]) => {
    $(probabilityId).textContent = percent(value);
    $(meterId).style.width = percent(value);
    $(oddsId).textContent = `Quota teorica ${fairOdds(value)}`;
  });
  $("home-win-label").textContent = `Vittoria ${options.homeTeam}`;
  $("away-win-label").textContent = `Vittoria ${options.awayTeam}`;
  $("home-xg-label").textContent = `Gol attesi ${options.homeTeam}`;
  $("away-xg-label").textContent = `Gol attesi ${options.awayTeam}`;
  $("home-lambda").textContent = number(result.lambdaHome);
  $("away-lambda").textContent = number(result.lambdaAway);
  $("over-probability").textContent = percent(p.over25);
  $("btts-probability").textContent = percent(p.bothScore);

  $("comparison-table").innerHTML = [
    comparisonRow(result.home.ppg5, "Punti/gara ultime 5", result.away.ppg5),
    comparisonRow(result.home.xgFor5, "xG ultime 5", result.away.xgFor5),
    comparisonRow(result.home.xgAgainst5, "xGA ultime 5", result.away.xgAgainst5),
    comparisonRow(result.home.possession5, "Possesso ultime 5", result.away.possession5, (v) => `${number(v, 1)}%`),
    comparisonRow(result.home.sot5, "Tiri in porta ultime 5", result.away.sot5),
    comparisonRow(result.home.elo, "Rating Elo", result.away.elo, (v) => number(v, 0)),
  ].join("");

  const maxScoreProbability = p.scores[0].probability;
  $("score-list").innerHTML = p.scores.slice(0, 10).map((score) => `
    <li><b>${score.home}–${score.away}</b><span class="score-bar"><i style="width:${100 * score.probability / maxScoreProbability}%"></i></span><span>${percent(score.probability)}</span></li>
  `).join("");

  const xgText = result.xgCoverage > 0.65
    ? "Gli xG delle due squadre hanno buona copertura reale nelle ultime gare."
    : "La copertura xG reale è parziale: dove manca, il sistema usa un proxy dichiarato basato su tiri e tiri in porta.";
  $("model-note").textContent = `${xgText} Finestra: ${result.firstTrainingDate} → ${result.lastTrainingDate}; emivita ${options.halfLifeDays} giorni. Gli aggiustamenti per assenze e formazione sono applicati dopo la stima base.`;
  $("results").hidden = false;
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });

  const url = new URL(window.location.href);
  url.searchParams.set("home", options.homeTeam); url.searchParams.set("away", options.awayTeam); url.searchParams.set("date", options.date);
  history.replaceState({}, "", url);
}

async function runPrediction() {
  const button = $("predict-button"), error = $("error-message");
  error.hidden = true;
  const options = predictionOptions();
  if (!options.date) { error.textContent = "Seleziona la data della partita."; error.hidden = false; return; }
  if (options.homeTeam === options.awayTeam) { error.textContent = "Scegli due squadre diverse."; error.hidden = false; return; }
  button.disabled = true; button.querySelector("span").textContent = "Ricalcolo modello…";
  await new Promise((resolve) => setTimeout(resolve, 30));
  try { render(predictFromMatches(payload.matches, options), options); }
  catch (caught) { error.textContent = caught.message || "Errore durante la previsione."; error.hidden = false; }
  finally { button.disabled = false; button.querySelector("span").textContent = "Ricalcola e pronostica"; }
}

async function init() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
    populateTeams(payload.teams);
    const params = new URLSearchParams(window.location.search);
    if (payload.teams.includes(params.get("home"))) $("home-team").value = params.get("home");
    if (payload.teams.includes(params.get("away"))) $("away-team").value = params.get("away");
    const defaultDate = params.get("date") || new Date().toISOString().slice(0, 10);
    $("match-date").value = defaultDate;
    syncLabels();
    $("data-status").textContent = `${payload.matches.length} partite · aggiornato ${payload.generated_at.slice(0, 10)}`;
    const actualXg = payload.coverage?.xg_actual_matches || 0;
    $("coverage-status").textContent = actualXg ? `xG reali: ${actualXg} gare` : "xG proxy + tiri · assenze manuali";
  } catch (error) {
    $("data-status").textContent = "Dati non disponibili";
    $("error-message").textContent = `Impossibile caricare il dataset: ${error.message}`;
    $("error-message").hidden = false;
    $("predict-button").disabled = true;
  }
}

setRangeOutput("home-attack-absence", "home-attack-output");
setRangeOutput("home-defense-absence", "home-defense-output");
setRangeOutput("away-attack-absence", "away-attack-output");
setRangeOutput("away-defense-absence", "away-defense-output");
setRangeOutput("home-lineup", "home-lineup-output");
setRangeOutput("away-lineup", "away-lineup-output");
$("home-team").addEventListener("change", syncLabels); $("away-team").addEventListener("change", syncLabels);
$("swap-button").addEventListener("click", () => { const home = $("home-team").value; $("home-team").value = $("away-team").value; $("away-team").value = home; syncLabels(); });
$("predict-button").addEventListener("click", runPrediction);
init();
