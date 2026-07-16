import { firebasePaths, getFirebaseServices } from "./firebase-client.js";
import { isFirebaseConfigured } from "./firebase-config.js";

const CACHE_KEY = "serie-a-predictor-site-settings-v1";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const HTTPS_URL = /^https:\/\//i;

export const DEFAULT_SITE_SETTINGS = Object.freeze({
  siteTitle: "Serie A Matchday Predictor",
  heroTitle: "Una giornata.",
  heroHighlight: "Dieci pronostici.",
  heroDescription: "Seleziona solo la giornata: il modello calcola tutte le partite con lo stesso cutoff pre-giornata e mostra probabilità, xG e risultati esatti.",
  announcement: "",
  featuredTeam: "Roma",
  accentColor: "#8d1d2c",
  accentDarkColor: "#5d101a",
  goldColor: "#d5ad3b",
  pageBackgroundColor: "#f4f1eb",
  heroStartColor: "#161114",
  heroMiddleColor: "#451019",
  heroEndColor: "#7c1928",
  backgroundImageUrl: "",
  backgroundOverlay: 0.78,
  defaultWindowDays: 540,
  defaultHalfLifeDays: 120,
  showDataQuality: true,
  showFairOdds: true,
});

const text = (value, fallback, maxLength) => {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maxLength);
};
const optionalText = (value, maxLength) => String(value ?? "").trim().slice(0, maxLength);
const color = (value, fallback) => HEX_COLOR.test(String(value || "")) ? String(value).toLowerCase() : fallback;
const choice = (value, allowed, fallback) => allowed.includes(Number(value)) ? Number(value) : fallback;
const boolean = (value, fallback) => typeof value === "boolean" ? value : fallback;
const opacity = (value) => Math.max(0.1, Math.min(0.95, Number(value) || DEFAULT_SITE_SETTINGS.backgroundOverlay));
const imageUrl = (value) => {
  const normalized = String(value ?? "").trim().slice(0, 1200);
  return !normalized || HTTPS_URL.test(normalized) ? normalized : "";
};

export function normalizeSiteSettings(raw = {}) {
  return {
    siteTitle: text(raw.siteTitle, DEFAULT_SITE_SETTINGS.siteTitle, 80),
    heroTitle: text(raw.heroTitle, DEFAULT_SITE_SETTINGS.heroTitle, 80),
    heroHighlight: text(raw.heroHighlight, DEFAULT_SITE_SETTINGS.heroHighlight, 80),
    heroDescription: text(raw.heroDescription, DEFAULT_SITE_SETTINGS.heroDescription, 260),
    announcement: optionalText(raw.announcement, 220),
    featuredTeam: text(raw.featuredTeam, DEFAULT_SITE_SETTINGS.featuredTeam, 50),
    accentColor: color(raw.accentColor, DEFAULT_SITE_SETTINGS.accentColor),
    accentDarkColor: color(raw.accentDarkColor, DEFAULT_SITE_SETTINGS.accentDarkColor),
    goldColor: color(raw.goldColor, DEFAULT_SITE_SETTINGS.goldColor),
    pageBackgroundColor: color(raw.pageBackgroundColor, DEFAULT_SITE_SETTINGS.pageBackgroundColor),
    heroStartColor: color(raw.heroStartColor, DEFAULT_SITE_SETTINGS.heroStartColor),
    heroMiddleColor: color(raw.heroMiddleColor, DEFAULT_SITE_SETTINGS.heroMiddleColor),
    heroEndColor: color(raw.heroEndColor, DEFAULT_SITE_SETTINGS.heroEndColor),
    backgroundImageUrl: imageUrl(raw.backgroundImageUrl),
    backgroundOverlay: opacity(raw.backgroundOverlay),
    defaultWindowDays: choice(raw.defaultWindowDays, [365, 540, 730], DEFAULT_SITE_SETTINGS.defaultWindowDays),
    defaultHalfLifeDays: choice(raw.defaultHalfLifeDays, [75, 120, 180], DEFAULT_SITE_SETTINGS.defaultHalfLifeDays),
    showDataQuality: boolean(raw.showDataQuality, DEFAULT_SITE_SETTINGS.showDataQuality),
    showFairOdds: boolean(raw.showFairOdds, DEFAULT_SITE_SETTINGS.showFairOdds),
  };
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

export function applySiteSettings(rawSettings) {
  const settings = normalizeSiteSettings(rawSettings);
  const root = document.documentElement;
  root.style.setProperty("--accent", settings.accentColor);
  root.style.setProperty("--accent-dark", settings.accentDarkColor);
  root.style.setProperty("--gold", settings.goldColor);
  root.style.setProperty("--bg", settings.pageBackgroundColor);

  const hero = document.querySelector(".hero");
  if (hero) {
    hero.style.background = `linear-gradient(135deg, ${settings.heroStartColor} 0%, ${settings.heroMiddleColor} 58%, ${settings.heroEndColor} 100%)`;
  }

  const body = document.body;
  if (body) {
    if (settings.backgroundImageUrl) {
      const overlay = settings.backgroundOverlay;
      body.style.background = `linear-gradient(rgba(244, 241, 235, ${overlay}), rgba(244, 241, 235, ${overlay})), url(${JSON.stringify(settings.backgroundImageUrl)}) center / cover fixed, ${settings.pageBackgroundColor}`;
    } else {
      body.style.background = `radial-gradient(circle at top right, color-mix(in srgb, ${settings.goldColor} 16%, transparent), transparent 28rem), linear-gradient(180deg, #f8f5ef 0%, ${settings.pageBackgroundColor} 100%)`;
    }
  }

  document.title = settings.siteTitle;
  setText("site-title-line", settings.heroTitle);
  setText("site-title-highlight", settings.heroHighlight);
  setText("site-description", settings.heroDescription);
  setText("featured-team-kicker", `Focus ${settings.featuredTeam}`);

  const announcement = document.getElementById("site-announcement");
  if (announcement) {
    announcement.textContent = settings.announcement;
    announcement.hidden = !settings.announcement;
  }

  return settings;
}

function cachedSettings() {
  try {
    return normalizeSiteSettings(JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_SITE_SETTINGS };
  }
}

function cacheSettings(settings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // Il blocco dello storage non deve impedire l'avvio del sito.
  }
}

export async function initializePublicSettings(onChange = () => {}) {
  let current = applySiteSettings(cachedSettings());
  onChange(current, { connected: false, source: "cache" });

  if (!isFirebaseConfigured()) {
    return { settings: current, connected: false, unsubscribe: () => {} };
  }

  try {
    const { db, firestoreApi } = await getFirebaseServices();
    const reference = firestoreApi.doc(db, firebasePaths.settingsCollection, firebasePaths.settingsDocument);
    const firstSnapshot = await firestoreApi.getDoc(reference);
    if (firstSnapshot.exists()) {
      current = applySiteSettings(normalizeSiteSettings(firstSnapshot.data()));
      cacheSettings(current);
      onChange(current, { connected: true, source: "firestore" });
    }
    const unsubscribe = firestoreApi.onSnapshot(reference, (snapshot) => {
      if (!snapshot.exists()) return;
      current = applySiteSettings(normalizeSiteSettings(snapshot.data()));
      cacheSettings(current);
      onChange(current, { connected: true, source: "realtime" });
    }, () => {
      onChange(current, { connected: false, source: "cache" });
    });
    return { settings: current, connected: true, unsubscribe };
  } catch {
    return { settings: current, connected: false, unsubscribe: () => {} };
  }
}
