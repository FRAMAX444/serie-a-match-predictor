import { firebasePaths, getFirebaseServices } from "./firebase-client.js";
import { isFirebaseConfigured } from "./firebase-config.js";
import { DEFAULT_SITE_SETTINGS, normalizeSiteSettings } from "./site-settings.js";

const $ = (id) => document.getElementById(id);
const form = $("settings-form");
let services;
let currentUser;
let currentSettings = { ...DEFAULT_SITE_SETTINGS };

function setLoginError(message = "") {
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
}

function setSaveStatus(message, tone = "neutral") {
  const element = $("save-status");
  element.textContent = message;
  element.dataset.tone = tone;
}

function populateForm(settings) {
  currentSettings = normalizeSiteSettings(settings);
  Object.entries(currentSettings).forEach(([key, value]) => {
    const input = form.elements.namedItem(key);
    if (!input) return;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  });
  updatePreview();
}

function settingsFromForm() {
  const data = new FormData(form);
  return normalizeSiteSettings({
    siteTitle: data.get("siteTitle"),
    heroTitle: data.get("heroTitle"),
    heroHighlight: data.get("heroHighlight"),
    heroDescription: data.get("heroDescription"),
    announcement: data.get("announcement"),
    featuredTeam: data.get("featuredTeam"),
    accentColor: data.get("accentColor"),
    accentDarkColor: data.get("accentDarkColor"),
    goldColor: data.get("goldColor"),
    pageBackgroundColor: data.get("pageBackgroundColor"),
    heroStartColor: data.get("heroStartColor"),
    heroMiddleColor: data.get("heroMiddleColor"),
    heroEndColor: data.get("heroEndColor"),
    backgroundImageUrl: data.get("backgroundImageUrl"),
    backgroundOverlay: data.get("backgroundOverlay"),
    defaultWindowDays: data.get("defaultWindowDays"),
    defaultHalfLifeDays: data.get("defaultHalfLifeDays"),
    showDataQuality: form.elements.showDataQuality.checked,
    showFairOdds: form.elements.showFairOdds.checked,
  });
}

function updatePreview() {
  const settings = settingsFromForm();
  const preview = $("settings-preview");
  const imageLayer = settings.backgroundImageUrl
    ? `linear-gradient(rgba(22,17,20,${settings.backgroundOverlay}), rgba(22,17,20,${settings.backgroundOverlay})), url(${JSON.stringify(settings.backgroundImageUrl)}) center / cover`
    : `linear-gradient(135deg, ${settings.heroStartColor}, ${settings.heroMiddleColor} 58%, ${settings.heroEndColor})`;
  preview.style.background = imageLayer;
  $("preview-title").textContent = settings.heroTitle;
  $("preview-highlight").textContent = settings.heroHighlight;
  $("preview-highlight").style.color = settings.goldColor;
  $("preview-description").textContent = settings.heroDescription;
  const announcement = $("preview-announcement");
  announcement.textContent = settings.announcement;
  announcement.hidden = !settings.announcement;
  $("overlay-output").value = `${Math.round(settings.backgroundOverlay * 100)}%`;
}

async function loadSettings() {
  const reference = services.firestoreApi.doc(
    services.db,
    firebasePaths.settingsCollection,
    firebasePaths.settingsDocument,
  );
  const snapshot = await services.firestoreApi.getDoc(reference);
  populateForm(snapshot.exists() ? snapshot.data() : DEFAULT_SITE_SETTINGS);
  setSaveStatus(snapshot.exists() ? "Configurazione globale caricata." : "Documento non ancora creato: salva per pubblicare i valori iniziali.");
}

async function verifyAdmin(user) {
  const reference = services.firestoreApi.doc(services.db, firebasePaths.adminsCollection, user.uid);
  const snapshot = await services.firestoreApi.getDoc(reference);
  return snapshot.exists() && snapshot.data().enabled === true;
}

function showLogin() {
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

async function handleAuthenticatedUser(user) {
  if (!user) {
    currentUser = null;
    showLogin();
    return;
  }
  try {
    if (!(await verifyAdmin(user))) {
      await services.authApi.signOut(services.auth);
      setLoginError("Account valido, ma non autorizzato come amministratore.");
      return;
    }
    await showEditor(user);
  } catch {
    await services.authApi.signOut(services.auth);
    setLoginError("Impossibile verificare i permessi amministratore.");
  }
}

async function init() {
  if (!isFirebaseConfigured()) {
    $("setup-panel").hidden = false;
    $("login-panel").hidden = true;
    return;
  }
  try {
    services = await getFirebaseServices({ includeAuth: true });
    services.authApi.onAuthStateChanged(services.auth, handleAuthenticatedUser);
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
  setSaveStatus("Modifiche non ancora salvate.");
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
    currentSettings = settings;
    setSaveStatus("Configurazione pubblicata per tutti gli utenti.", "success");
  } catch (error) {
    setSaveStatus(error.code === "permission-denied"
      ? "Salvataggio negato: verifica UID amministratore e regole Firestore."
      : "Errore durante il salvataggio. Riprova.", "error");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Salva per tutti";
  }
});

$("reset-button").addEventListener("click", () => {
  populateForm(DEFAULT_SITE_SETTINGS);
  setSaveStatus("Valori iniziali caricati nel form. Premi Salva per pubblicarli.");
});

$("logout-button").addEventListener("click", () => services?.authApi.signOut(services.auth));
$("toggle-password").addEventListener("click", () => {
  const input = $("login-password");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  $("toggle-password").textContent = visible ? "Mostra" : "Nascondi";
});

populateForm(DEFAULT_SITE_SETTINGS);
init();
