import { generateSlip, getStoredOddsApiKey, setStoredOddsApiKey, fetchLeagueOdds, matchOddsToFixtures, buildCandidates, bestAccumulator } from "./schedina.js";
import { buildMatchdays } from "./matchdays.js";
import { predictMatchdayFromMatches } from "./model.js";

const $ = (id) => document.getElementById(id);
const number = (value, digits = 2) => Number(value).toFixed(digits);
const percent = (value, digits = 0) => `${(Number(value) * 100).toFixed(digits)}%`;
const signedPercent = (value, digits = 1) => `${Number(value) >= 0 ? "+" : ""}${percent(value, digits)}`;
const signedPoints = (value) => `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(1)} pp`;

let payload = null;

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
  const bookmaker = leg.bookmaker ? ` · ${leg.bookmaker}` : "";
  const market = Number.isFinite(leg.marketProbability) ? percent(leg.marketProbability, 1) : "n/d";
  const edge = Number.isFinite(leg.edge) ? signedPoints(leg.edge) : "n/d";
  return `<div class="schedina-leg">
    <span class="schedina-leg__match">${leg.fixtureLabel}</span>
    <span class="schedina-leg__pick">${leg.label}</span>
    <span class="schedina-leg__odds">@${number(leg.odds)}${bookmaker}</span>
    <span class="schedina-leg__prob">Modello ${percent(leg.probability, 1)}</span>
    <span class="schedina-leg__edge">Mercato ${market} · edge ${edge}</span>
  </div>`;
}

function renderSlip(slip, coverageNote) {
  const section = $("schedina-result");
  if (!slip) {
    section.hidden = true;
    setStatus(`Nessuna combinazione trovata con i filtri scelti. ${coverageNote} Prova una quota diversa, un edge minimo più basso o una soglia di probabilità meno restrittiva.`, "warn");
    return;
  }
  const marketEdge = Number.isFinite(slip.combinedMarketEdge)
    ? ` · edge combinato ${signedPoints(slip.combinedMarketEdge)}`
    : "";
  $("schedina-summary").textContent = `${slip.legs.length} selezioni · quota ${number(slip.combinedOdds)} · probabilità modello ${percent(slip.combinedProbability, 1)} · valore atteso teorico ${signedPercent(slip.combinedExpectedValue, 1)}${marketEdge}. ${coverageNote}`;
  $("schedina-legs").innerHTML = slip.legs.map(legRow).join("");
  section.hidden = false;
  setStatus("Schedina calcolata.", "ok");
}

function coverageNote(entries) {
  const total = entries.length;
  const matched = entries.filter((entry) => entry.matched).length;
  return matched === total
    ? `Quote trovate per tutte le ${total} partite del turno.`
    : `Quote trovate per ${matched} partite su ${total}; le altre sono state escluse.`;
}

function readOptions() {
  const minEdgeRaw = $("schedina-min-edge").value;
  return {
    apiKey: $("schedina-api-key").value.trim(),
    competitionId: $("schedina-competition").value,
    targetOdds: Number($("schedina-target").value),
    minLegProbability: Number($("schedina-min-probability").value),
    minEdge: minEdgeRaw === "" ? null : Number(minEdgeRaw),
    strategy: $("schedina-strategy").value,
    maxLegs: Number($("schedina-max-legs").value),
  };
}

async function runGeneration(sportKeyOverride) {
  const options = readOptions();
  if (!options.apiKey) { setStatus("Serve una chiave API di the-odds-api.com.", "warn"); return; }
  if (!options.competitionId) { setStatus("Seleziona una lega.", "warn"); return; }
  if (!Number.isFinite(options.targetOdds) || options.targetOdds <= 1) { setStatus("Inserisci una quota target valida (> 1).", "warn"); return; }
  if (!Number.isInteger(options.maxLegs) || options.maxLegs < 1) { setStatus("Il numero massimo di selezioni non è valido.", "warn"); return; }

  setStoredOddsApiKey(options.apiKey);
  $("schedina-result").hidden = true;
  $("schedina-manual").hidden = true;
  setStatus("Richiedo le quote in tempo reale e confronto modello/mercato…", "info");

  try {
    if (sportKeyOverride) {
      const calendar = buildMatchdays(payload, options.competitionId);
      const matchday = calendar.firstUpcoming || calendar.matchdays?.[0];
      if (!matchday) throw new Error("Nessun turno futuro trovato per questa lega.");
      const { predictions } = predictMatchdayFromMatches(payload.matches, matchday.fixtures, { competitionId: options.competitionId });
      const oddsEvents = await fetchLeagueOdds(options.apiKey, sportKeyOverride);
      const entries = matchOddsToFixtures(predictions, oddsEvents);
      const candidates = buildCandidates(entries, options.minLegProbability, { minEdge: options.minEdge });
      const slip = bestAccumulator(candidates, options.targetOdds, 0.15, options.maxLegs, { objective: options.strategy });
      renderSlip(slip, coverageNote(entries));
      return;
    }

    const { entries, slip } = await generateSlip({
      apiKey: options.apiKey,
      payload,
      competitionId: options.competitionId,
      targetOdds: options.targetOdds,
      minLegProbability: options.minLegProbability,
      minEdge: options.minEdge,
      strategy: options.strategy,
      maxLegs: options.maxLegs,
    });
    renderSlip(slip, coverageNote(entries));
  } catch (error) {
    if (error.candidates) {
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
