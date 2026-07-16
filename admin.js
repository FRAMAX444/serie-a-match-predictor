import { firebasePaths, getFirebaseServices } from "./firebase-client.js";
import { isFirebaseConfigured } from "./firebase-config.js";
import { DEFAULT_GLOBAL_SETTINGS, normalizeGlobalSettings } from "./global-settings.js";
import { TEAM_NAMES } from "./preferences.js";

const $ = (id) => document.getElementById(id);
const form = $("admin-settings-form");
let services;
let currentUser;
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

async function verifyAdmin(user) {
  const reference = services.firestoreApi.doc(services.db, firebasePaths.adminsCollection, user.uid);
  const snapshot = await services.firestoreApi.getDoc(reference);
  return snapshot.exists() && snapshot.data().enabled === true;
}

async function loadSettings() {
  const reference = services.firestoreApi.doc(
    services.db,
    firebasePaths.settingsCollection,
    firebasePaths.settingsDocument,
  );
  const snapshot = await services.firestoreApi.getDoc(reference);
  populateForm(snapshot.exists() ? snapshot.data() : DEFAULT_GLOBAL_SETTINGS);
  setSaveStatus(snapshot.exists()
    ? "Configurazione globale caricata."
    : "Documento non ancora creato: salva per pubblicare la configurazione iniziale.");
}

function showLogin() {
  currentUser = null;
  $("login-panel").hidden = false;
  $("editor-panel").hidden = true;
}

async function showEditor(user) {
  currentUser = user;
  $("login-panel").hidden = true;
  $("editor-panel").hidden = false;
  $("admin-identity").textContent = `Accesso effettuato come ${user.email}`;
  await loadSettings();
}

async function handleAuthState(user) {
  if (!user) {
    showLogin();
    return;
  }
  try {
    if (!(await verifyAdmin(user))) {
      await services.authApi.signOut(services.auth);
      setLoginError("Account riconosciuto, ma non autorizzato come amministratore.");
      return;
    }
    await showEditor(user);
  } catch {
    await services.authApi.signOut(services.auth);
    setLoginError("Impossibile verificare i permessi dell'account.");
  }
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

  if (!isFirebaseConfigured()) {
    $("setup-panel").hidden = false;
    $("login-panel").hidden = true;
    return;
  }

  try {
    services = await getFirebaseServices({ includeAuth: true });
    services.authApi.onAuthStateChanged(services.auth, handleAuthState);
  } catch (error) {
    $("setup-panel").hidden = false;
    $("setup-panel").querySelector("p").textContent = `Configurazione Firebase non utilizzabile: ${error.message}`;
    $("login-panel").hidden = true;
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginError();
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "Accesso…";
  try {
    await services.authApi.signInWithEmailAndPassword(
      services.auth,
      $("login-email").value.trim(),
      $("login-password").value,
    );
  } catch {
    setLoginError("Credenziali non valide oppure accesso temporaneamente non disponibile.");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Accedi";
  }
});

form.addEventListener("input", () => {
  updatePreview();
  setSaveStatus("Modifiche non ancora pubblicate.");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return;
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "Salvataggio…";
  try {
    const settings = settingsFromForm();
    const reference = services.firestoreApi.doc(
      services.db,
      firebasePaths.settingsCollection,
      firebasePaths.settingsDocument,
    );
    await services.firestoreApi.setDoc(reference, {
      ...settings,
      updatedAt: services.firestoreApi.serverTimestamp(),
    });
    lastSavedSettings = settings;
    setSaveStatus("Configurazione pubblicata per tutti gli utenti.");
  } catch (error) {
    setSaveStatus(error.code === "permission-denied"
      ? "Salvataggio negato: controlla UID amministratore e Security Rules."
      : "Errore durante il salvataggio. Riprova.");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Salva per tutti";
  }
});

$("reset-button").addEventListener("click", () => {
  populateForm(lastSavedSettings);
  setSaveStatus("Form ripristinato all'ultima configurazione caricata.");
});

$("logout-button").addEventListener("click", () => services?.authApi.signOut(services.auth));
$("toggle-password").addEventListener("click", () => {
  const input = $("login-password");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  $("toggle-password").textContent = visible ? "Mostra" : "Nascondi";
});

init();
