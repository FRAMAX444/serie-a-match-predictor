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

  if (settings.forceFeaturedTeam && TEAM_NAMES.includes(settings.featuredTeam)) {
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

async function init() {
  applyStoredAppearance();
  const favorite = getFavoriteTeam(TEAM_NAMES[0]);
  $("settings-team").innerHTML = TEAM_NAMES
    .map((team) => `<option value="${team}">${team}</option>`)
    .join("");
  $("settings-team").value = TEAM_NAMES.includes(favorite) ? favorite : TEAM_NAMES[0];
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
