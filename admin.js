import { DEFAULT_GLOBAL_SETTINGS, applyGlobalSettings, normalizeGlobalSettings } from "./global-settings.js";
import { TEAM_NAMES } from "./preferences.js";

const ADMIN_USERNAME = "RC25M";
const ADMIN_PASSWORD_SHA256 = "ba8a8700eed325f42283bae17c64cff6957735c049991fb33ee2e3d4e5c59eb4";
const ADMIN_SESSION_KEY = "serie-a-predictor-local-admin-session";
const SETTINGS_STORAGE_KEY = "serie-a-predictor-global-settings-v1";

const $ = (id) => document.getElementById(id);
const form = $("admin-settings-form");
let authenticated = false;
let lastSavedSettings = { ...DEFAULT_GLOBAL_SETTINGS };

function setLoginError(message = "") {
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
}

function setSaveStatus(message) {
  $("save-status").textContent = message;
}

function settingsFromForm() {
  const data = new FormData(form);
  return normalizeGlobalSettings({
    siteTitle: data.get("siteTitle"),
    announcement: data.get("announcement"),
    featuredTeam: data.get("featuredTeam"),
    primaryColor: data.get("primaryColor"),
    secondaryColor: data.get("secondaryColor"),
    backgroundImageUrl: data.get("backgroundImageUrl"),
    backgroundOverlay: data.get("backgroundOverlay"),
    defaultWindowDays: data.get("defaultWindowDays"),
    defaultHalfLifeDays: data.get("defaultHalfLifeDays"),
    showDataQuality: form.elements.showDataQuality.checked,
    showFairOdds: form.elements.showFairOdds.checked,
    forceAppearance: form.elements.forceAppearance.checked,
    forceModelSettings: form.elements.forceModelSettings.checked,
    forceFeaturedTeam: form.elements.forceFeaturedTeam.checked,
  });
}

function populateForm(rawSettings) {
  const settings = normalizeGlobalSettings(rawSettings);
  const teamSelect = form.elements.featuredTeam;
  if (![...teamSelect.options].some((option) => option.value === settings.featuredTeam)) {
    teamSelect.add(new Option(settings.featuredTeam, settings.featuredTeam));
  }
  lastSavedSettings = settings;
  Object.entries(settings).forEach(([name, value]) => {
    const input = form.elements.namedItem(name);
    if (!input) return;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  });
  updatePreview();
}

function updatePreview() {
  const settings = settingsFromForm();
  const preview = $("admin-preview");
  const overlayEnd = Math.min(.99, settings.backgroundOverlay + .13);
  preview.style.color = "#ffffff";
  preview.style.background = settings.backgroundImageUrl
    ? `linear-gradient(rgba(23,32,51,${settings.backgroundOverlay}), rgba(23,32,51,${overlayEnd})), url(${JSON.stringify(settings.backgroundImageUrl)}) center / cover`
    : settings.primaryColor;
  $("preview-team").textContent = settings.featuredTeam;
  $("preview-team").style.background = settings.secondaryColor;
  $("preview-title").textContent = settings.siteTitle;
  $("preview-announcement").textContent = settings.announcement || "Nessun avviso globale";
  $("overlay-output").value = `${Math.round(settings.backgroundOverlay * 100)}%`;
}

function readLocalSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return DEFAULT_GLOBAL_SETTINGS;
  }
}

function loadSettings() {
  const stored = readLocalSettings();
  const hasStoredSettings = Object.keys(stored).length > 0;
  populateForm(hasStoredSettings ? stored : DEFAULT_GLOBAL_SETTINGS);
  setSaveStatus(hasStoredSettings
    ? "Configurazione locale caricata da questo browser."
    : "Nessuna configurazione locale salvata.");
}

function showLogin() {
  authenticated = false;
  $("login-panel").hidden = false;
  $("editor-panel").hidden = true;
  $("login-password").value = "";
}

function showEditor() {
  authenticated = true;
  $("login-panel").hidden = true;
  $("editor-panel").hidden = false;
  $("admin-identity").textContent = `Accesso locale effettuato come ${ADMIN_USERNAME}`;
  loadSettings();
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Hash non disponibile");
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function availableTeams() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const fixtureTeams = (data.schedule || data.fixtures || [])
      .flatMap((fixture) => [fixture.home_team, fixture.away_team])
      .filter(Boolean);
    return [...new Set([...(data.teams || []), ...fixtureTeams, ...TEAM_NAMES])]
      .sort((left, right) => left.localeCompare(right, "it"));
  } catch {
    return TEAM_NAMES;
  }
}

async function init() {
  const teams = await availableTeams();
  form.elements.featuredTeam.innerHTML = teams
    .map((team) => `<option value="${team}">${team}</option>`)
    .join("");
  populateForm(DEFAULT_GLOBAL_SETTINGS);

  try {
    if (sessionStorage.getItem(ADMIN_SESSION_KEY) === "1") showEditor();
    else showLogin();
  } catch {
    showLogin();
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginError();
  const button = event.submitter || $("login-form").querySelector("button[type='submit']");
  button.disabled = true;
  button.querySelector("span").textContent = "Accesso…";
  try {
    const usernameMatches = $("login-email").value.trim().toLowerCase() === ADMIN_USERNAME.toLowerCase();
    const suppliedHash = await sha256($("login-password").value);
    const passwordMatches = safeEqual(suppliedHash, ADMIN_PASSWORD_SHA256);
    if (!usernameMatches || !passwordMatches) {
      setLoginError("Username o password non validi.");
      return;
    }
    try { sessionStorage.setItem(ADMIN_SESSION_KEY, "1"); } catch { /* sessione valida solo in memoria */ }
    showEditor();
  } catch {
    setLoginError("Accesso locale non disponibile in questo browser.");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Accedi";
  }
});

form.addEventListener("input", () => {
  updatePreview();
  setSaveStatus("Modifiche locali non ancora salvate.");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!authenticated) return;
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "Salvataggio…";
  try {
    const settings = settingsFromForm();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    lastSavedSettings = settings;
    applyGlobalSettings(settings);
    setSaveStatus("Configurazione salvata solo su questo browser.");
  } catch {
    setSaveStatus("Impossibile salvare nel browser.");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Salva su questo browser";
  }
});

$("reset-button").addEventListener("click", () => {
  populateForm(lastSavedSettings);
  setSaveStatus("Form ripristinato all'ultima configurazione locale.");
});

$("logout-button").addEventListener("click", () => {
  try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch { /* nessuna sessione persistente */ }
  showLogin();
});

$("toggle-password").addEventListener("click", () => {
  const input = $("login-password");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  $("toggle-password").textContent = visible ? "Mostra" : "Nascondi";
});

init();
