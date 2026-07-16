import { buildCompetitionCatalog } from "./matchdays.js";

const COMPETITION_STORAGE_KEY = "european-cups-predictor-competition";

function getStoredCompetition() {
  try {
    return localStorage.getItem(COMPETITION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeCompetition(competitionId) {
  if (!competitionId) return;
  try {
    localStorage.setItem(COMPETITION_STORAGE_KEY, competitionId);
  } catch {
    // Il predictor continua a funzionare anche quando lo storage è disabilitato.
  }
}

function availableIds(select) {
  return [...select.options].map((option) => option.value).filter(Boolean);
}

function initPredictorPreference() {
  const select = document.getElementById("competition-select");
  if (!select) return;

  let applyingPreference = false;
  const applyStoredPreference = () => {
    if (applyingPreference) return;
    const ids = availableIds(select);
    if (!ids.length) return;

    const requested = new URLSearchParams(window.location.search).get("competition");
    const stored = getStoredCompetition();
    if (ids.includes(requested) || !ids.includes(stored) || select.value === stored) return;

    applyingPreference = true;
    select.value = stored;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    applyingPreference = false;
  };

  new MutationObserver(applyStoredPreference).observe(select, { childList: true });
  select.addEventListener("change", () => storeCompetition(select.value));
  applyStoredPreference();
}

function setSettingsStatus(message) {
  const status = document.getElementById("settings-status");
  if (status) status.textContent = message;
}

async function initSettingsPreference() {
  const select = document.getElementById("settings-competition");
  if (!select) return;

  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const competitions = buildCompetitionCatalog(payload);
    if (!competitions.length) throw new Error("Nessuna competizione disponibile");

    select.replaceChildren(...competitions.map((competition) =>
      new Option(competition.name, competition.id)));

    const ids = competitions.map((competition) => competition.id);
    const stored = getStoredCompetition();
    const fallback = ids.includes(payload.default_competition)
      ? payload.default_competition
      : competitions[0].id;
    select.value = ids.includes(stored) ? stored : fallback;
    select.disabled = false;

    select.addEventListener("change", () => {
      storeCompetition(select.value);
      const selectedLabel = select.options[select.selectedIndex]?.textContent || select.value;
      setSettingsStatus(`Competizione predefinita salvata: ${selectedLabel}.`);
    });
  } catch {
    select.replaceChildren(new Option("Competizioni non disponibili", ""));
    select.disabled = true;
  }
}

initPredictorPreference();
initSettingsPreference();
