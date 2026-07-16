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

function setStatus(message) {
  $("settings-status").textContent = message;
}

function showTeamPalette() {
  const team = $("settings-team").value;
  const palette = applyTeamPalette(team);
  $("primary-color").value = palette.primary;
  $("secondary-color").value = palette.secondary;
}

function init() {
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
}

$("settings-team").addEventListener("change", () => {
  setFavoriteTeam($("settings-team").value);
  showTeamPalette();
  setStatus(`Squadra preferita: ${$("settings-team").value}.`);
});

$("save-palette").addEventListener("click", () => {
  const team = $("settings-team").value;
  savePalette(team, {
    primary: $("primary-color").value,
    secondary: $("secondary-color").value,
  });
  applyTeamPalette(team);
  setStatus(`Colori salvati per ${team}.`);
});

$("reset-palette").addEventListener("click", () => {
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
    saveModelSettings({
      windowDays: $("window-days").value,
      halfLifeDays: $("half-life").value,
    });
    setStatus("Impostazioni del modello salvate.");
  });
}

$("background-image").addEventListener("change", async (event) => {
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
  removeBackground();
  $("remove-background").disabled = true;
  setStatus("Sfondo rimosso.");
});

init();
