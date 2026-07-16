import { DEFAULT_GLOBAL_SETTINGS, applyGlobalSettings, initializeGlobalSettings } from "./global-settings.js";
import {
  BACKGROUND_STORAGE_KEY,
  TEAM_NAMES,
  applyStoredAppearance,
  applyTeamPalette,
  getFavoriteTeam,
  getModelSettings,
  paletteForTeam,
  removeBackground,
  resetPalette,
  resizeBackground,
  saveModelSettings,
  savePalette,
  setFavoriteTeam,
  storeBackground,
} from "./preferences.js";

const $ = (id) => document.getElementById(id);
let globalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
let availableTeams = TEAM_NAMES.slice();

function setStatus(message) {
  $("settings-status").textContent = message;
}

function showTeamPalette() {
  if (globalSettings.forceAppearance) {
    $("primary-color").value = globalSettings.primaryColor;
    $("secondary-color").value = globalSettings.secondaryColor;
    applyGlobalSettings(globalSettings);
    return;
  }
  const team = $("settings-team").value;
  const palette = applyTeamPalette(team);
  $("primary-color").value = palette.primary;
  $("secondary-color").value = palette.secondary;
}

function setDisabled(ids, disabled) {
  ids.forEach((id) => { $(id).disabled = disabled; });
}

function ensureTeamOption(team) {
  if (!team || [...$("settings-team").options].some((option) => option.value === team)) return;
  $("settings-team").add(new Option(team, team));
}

function renderGlobalPolicy(settings, meta = {}) {
  globalSettings = settings;
  const locks = [];
  if (settings.forceAppearance) locks.push("Aspetto e sfondo globali");
  if (settings.forceModelSettings) locks.push("Parametri modello globali");
  if (settings.forceFeaturedTeam) locks.push(`Squadra fissata: ${settings.featuredTeam}`);
  $("global-policy-list").innerHTML = (locks.length ? locks : ["Nessuna preferenza personale bloccata"])
    .map((label) => `<span class="global-policy-chip">${label}</span>`)
    .join("");
  $("global-policy-status").textContent = meta.connected
    ? "Policy globali sincronizzate con il pannello amministratore."
    : "Uso della configurazione globale disponibile in cache o dei valori iniziali.";

  if (settings.forceFeaturedTeam) {
    ensureTeamOption(settings.featuredTeam);
    $("settings-team").value = settings.featuredTeam;
  }
  $("settings-team").disabled = settings.forceFeaturedTeam || settings.forceAppearance;
  setDisabled(["primary-color", "secondary-color", "save-palette", "reset-palette", "background-image", "remove-background"], settings.forceAppearance);
  setDisabled(["window-days", "half-life"], settings.forceModelSettings);

  if (settings.forceModelSettings) {
    $("window-days").value = String(settings.defaultWindowDays);
    $("half-life").value = String(settings.defaultHalfLifeDays);
  } else {
    const model = getModelSettings();
    $("window-days").value = String(model.windowDays);
    $("half-life").value = String(model.halfLifeDays);
  }

  showTeamPalette();
  if (!settings.forceAppearance) {
    $("remove-background").disabled = !localStorage.getItem(BACKGROUND_STORAGE_KEY);
  }
}

async function loadAvailableTeams() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const fixtureTeams = Array.isArray(data.competitions)
      ? data.competitions.flatMap((competition) => Array.isArray(competition.fixtures)
        ? competition.fixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team])
        : [])
      : [];
    availableTeams = [...new Set([
      ...(Array.isArray(data.teams) ? data.teams : []),
      ...fixtureTeams,
      ...Object.keys(data.team_context || {}),
      ...TEAM_NAMES,
    ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "it"));
  } catch {
    availableTeams = TEAM_NAMES.slice();
  }
}

async function init() {
  applyStoredAppearance();
  await loadAvailableTeams();
  const favorite = getFavoriteTeam(availableTeams[0]);
  $("settings-team").replaceChildren(...availableTeams.map((team) => new Option(team, team)));
  ensureTeamOption(favorite);
  $("settings-team").value = favorite || availableTeams[0] || "";
  showTeamPalette();

  const model = getModelSettings();
  $("window-days").value = String(model.windowDays);
  $("half-life").value = String(model.halfLifeDays);
  $("remove-background").disabled = !localStorage.getItem(BACKGROUND_STORAGE_KEY);

  await initializeGlobalSettings(renderGlobalPolicy);
}

$("settings-team").addEventListener("change", () => {
  if (globalSettings.forceFeaturedTeam || globalSettings.forceAppearance) return;
  setFavoriteTeam($("settings-team").value);
  showTeamPalette();
  setStatus(`Squadra preferita: ${$("settings-team").value}.`);
});

$("save-palette").addEventListener("click", () => {
  if (globalSettings.forceAppearance) return;
  const team = $("settings-team").value;
  savePalette(team, {
    primary: $("primary-color").value,
    secondary: $("secondary-color").value,
  });
  applyTeamPalette(team);
  setStatus(`Colori salvati per ${team}.`);
});

$("reset-palette").addEventListener("click", () => {
  if (globalSettings.forceAppearance) return;
  const team = $("settings-team").value;
  resetPalette(team);
  const palette = paletteForTeam(team);
  $("primary-color").value = palette.primary;
  $("secondary-color").value = palette.secondary;
  applyTeamPalette(team);
  setStatus(`Colori predefiniti ripristinati per ${team}.`);
});

for (const id of ["window-days", "half-life"]) {
  $(id).addEventListener("change", () => {
    if (globalSettings.forceModelSettings) return;
    saveModelSettings({
      windowDays: $("window-days").value,
      halfLifeDays: $("half-life").value,
    });
    setStatus("Impostazioni del modello salvate.");
  });
}

$("background-image").addEventListener("change", async (event) => {
  if (globalSettings.forceAppearance) return;
  const [file] = event.target.files;
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("Seleziona un file immagine.");
    event.target.value = "";
    return;
  }

  setStatus("Preparazione dello sfondo…");
  try {
    const dataUrl = await resizeBackground(file);
    storeBackground(dataUrl);
    $("remove-background").disabled = false;
    setStatus("Sfondo salvato in questo browser.");
  } catch (error) {
    setStatus(error.name === "QuotaExceededError"
      ? "Immagine troppo grande. Prova un file più leggero."
      : error.message || "Impossibile impostare lo sfondo.");
  } finally {
    event.target.value = "";
  }
});

$("remove-background").addEventListener("click", () => {
  if (globalSettings.forceAppearance) return;
  removeBackground();
  $("remove-background").disabled = true;
  setStatus("Sfondo rimosso.");
});

init();
