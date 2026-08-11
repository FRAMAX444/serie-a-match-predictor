import { generateSlip, getStoredOddsApiKey, setStoredOddsApiKey, fetchLeagueOdds, matchOddsToFixtures, buildCandidates, bestAccumulator } from "./schedina.js";
import { buildCompetitionCatalog, buildMatchdays } from "./matchdays.js";
import { predictMatchdayFromMatches } from "./model.js";

const $ = (id) => document.getElementById(id);
const number = (value, digits = 2) => Number(value).toFixed(digits);
const percent = (value) => `${Math.round(value * 100)}%`;

let payload = null;
let pendingCandidates = null; // usato dal percorso di scelta manuale del campionato

function setStatus(message, tone = "info") {
  const node = $("schedina-status");
  node.textContent = message;
  node.dataset.tone = tone;
}

async function loadDataset() {
  const response = await fetch("data/matches.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Dataset non raggiungibile (HTTP ${response.status})`);
  const data = await response.json();
  if (data.columns && data.matches?.length && Array.isArray(data.matches[0])) {
    data.matches = data.matches.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
  }
  return data;
}

function populateLeagues() {
  const select = $("schedina-competition");
  const leagues = Array.isArray(payload.domestic_leagues) ? payload.domestic_leagues : [];
  select.replaceChildren(...leagues.map((league) => new Option(league.name, league.id)));
  if (!leagues.length) select.replaceChildren(new Option("Nessuna lega disponibile nel dataset locale", ""));
}

function legRow(leg) {
  return `<div class="schedina-leg"><span class="schedina-leg__match">${leg.fixtureLabel}</span><span class="schedina-leg__pick">${leg.label}</span><span class="schedina-leg__odds">@${number(leg.odds)}</span><span class="schedina-leg__prob">${percent(leg.probability)}</span></div>`;
}

function renderSlip(slip, coverageNote) {
  const section = $("schedina-result");
  if (!slip) {
    section.hidden = true;
    setStatus(`Nessuna combinazione trovata entro la tolleranza per questa quota target. ${coverageNote} Prova una quota diversa o una soglia di probabilità più bassa.`, "warn");
    return;
  }
  $("schedina-summary").textContent = `${slip.legs.length} selezioni · quota combinata ${number(slip.combinedOdds)} · probabilità stimata ${percent(slip.combinedProbability)}. ${coverageNote}`;
  $("schedina-legs").innerHTML = slip.legs.map(legRow).join("");
  section.hidden = false;
  setStatus("Fatto.", "ok");
}

function coverageNote(entries) {
  const total = entries.length;
  const matched = entries.filter((entry) => entry.matched).length;
  return matched === total
    ? `Quote trovate per tutte le ${total} partite del turno.`
    : `Quote trovate per ${matched} partite su ${total} (le restanti non hanno un riscontro nelle quote live e sono state escluse).`;
}

async function runGeneration(sportKeyOverride) {
  const apiKey = $("schedina-api-key").value.trim();
  const competitionId = $("schedina-competition").value;
  const targetOdds = Number($("schedina-target").value);
  const minLegProbability = Number($("schedina-min-probability").value);

  if (!apiKey) { setStatus("Serve una chiave API di the-odds-api.com.", "warn"); return; }
  if (!competitionId) { setStatus("Seleziona una lega.", "warn"); return; }
  if (!Number.isFinite(targetOdds) || targetOdds <= 1) { setStatus("Inserisci una quota target valida (> 1).", "warn"); return; }

  setStoredOddsApiKey(apiKey);
  $("schedina-result").hidden = true;
  $("schedina-manual").hidden = true;
  setStatus("Richiedo le quote in tempo reale…", "info");

  try {
    if (sportKeyOverride) {
      // Percorso di conferma manuale: la scoperta automatica del campionato non ha
      // trovato un solo candidato, l'utente ha scelto a mano tra quelli disponibili.
      const calendar = buildMatchdays(payload, competitionId);
      const matchday = calendar.firstUpcoming || calendar.matchdays?.[0];
      if (!matchday) throw new Error("Nessun turno futuro trovato per questa lega.");
      const { predictions } = predictMatchdayFromMatches(payload.matches, matchday.fixtures, { competitionId });
      const oddsEvents = await fetchLeagueOdds(apiKey, sportKeyOverride);
      const entries = matchOddsToFixtures(predictions, oddsEvents);
      const candidates = buildCandidates(entries, minLegProbability);
      const slip = bestAccumulator(candidates, targetOdds, 0.15);
      renderSlip(slip, coverageNote(entries));
      return;
    }

    const { entries, slip } = await generateSlip({ apiKey, payload, competitionId, targetOdds, minLegProbability });
    renderSlip(slip, coverageNote(entries));
  } catch (error) {
    if (error.candidates) {
      pendingCandidates = { sportOptions: error.candidates, competitionId };
      const select = $("schedina-manual-select");
      select.replaceChildren(...error.candidates.map((sport) => new Option(`${sport.title || sport.key} (${sport.description || sport.key})`, sport.key)));
      $("schedina-manual").hidden = false;
      setStatus("Scegli il campionato corretto qui sotto.", "warn");
      return;
    }
    setStatus(`Errore: ${error.message}`, "error");
  }
}

async function init() {
  try {
    payload = await loadDataset();
  } catch (error) {
    setStatus(`Impossibile caricare il dataset locale: ${error.message}`, "error");
    return;
  }
  populateLeagues();
  $("schedina-api-key").value = getStoredOddsApiKey();
  setStatus("Pronto.", "info");

  $("schedina-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runGeneration();
  });

  $("schedina-manual-confirm").addEventListener("click", () => {
    const sportKey = $("schedina-manual-select").value;
    if (sportKey) runGeneration(sportKey);
  });
}

init();
