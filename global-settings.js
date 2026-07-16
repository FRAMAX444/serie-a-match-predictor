import { firebasePaths, getFirebaseServices } from "./firebase-client.js";
import { isFirebaseConfigured } from "./firebase-config.js";
import { applyBackgroundSource, applyPalette } from "./preferences.js";

const CACHE_KEY = "serie-a-predictor-global-settings-v1";
const HEX = /^#[0-9a-f]{6}$/i;
const HTTPS = /^https:\/\//i;

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  siteTitle: "European Cups Predictor",
  announcement: "",
  featuredTeam: "Roma",
  primaryColor: "#1f4f8f",
  secondaryColor: "#172033",
  backgroundImageUrl: "",
  backgroundOverlay: 0.78,
  defaultWindowDays: 540,
  defaultHalfLifeDays: 120,
  showDataQuality: true,
  showFairOdds: true,
  forceAppearance: false,
  forceModelSettings: false,
  forceFeaturedTeam: false,
});

const text = (value, fallback, length) => (String(value ?? "").trim() || fallback).slice(0, length);
const optionalText = (value, length) => String(value ?? "").trim().slice(0, length);
const color = (value, fallback) => HEX.test(String(value || "")) ? String(value).toLowerCase() : fallback;
const bool = (value, fallback) => typeof value === "boolean" ? value : fallback;
const option = (value, allowed, fallback) => allowed.includes(Number(value)) ? Number(value) : fallback;
const overlay = (value) => Math.max(0.1, Math.min(0.95, Number(value) || DEFAULT_GLOBAL_SETTINGS.backgroundOverlay));
const imageUrl = (value) => {
  const normalized = String(value ?? "").trim().slice(0, 1200);
  return !normalized || HTTPS.test(normalized) ? normalized : "";
};

export function normalizeGlobalSettings(raw = {}) {
  return {
    siteTitle: text(raw.siteTitle, DEFAULT_GLOBAL_SETTINGS.siteTitle, 80),
    announcement: optionalText(raw.announcement, 220),
    featuredTeam: text(raw.featuredTeam, DEFAULT_GLOBAL_SETTINGS.featuredTeam, 50),
    primaryColor: color(raw.primaryColor, DEFAULT_GLOBAL_SETTINGS.primaryColor),
    secondaryColor: color(raw.secondaryColor, DEFAULT_GLOBAL_SETTINGS.secondaryColor),
    backgroundImageUrl: imageUrl(raw.backgroundImageUrl),
    backgroundOverlay: overlay(raw.backgroundOverlay),
    defaultWindowDays: option(raw.defaultWindowDays, [365, 540, 730], DEFAULT_GLOBAL_SETTINGS.defaultWindowDays),
    defaultHalfLifeDays: option(raw.defaultHalfLifeDays, [75, 120, 180], DEFAULT_GLOBAL_SETTINGS.defaultHalfLifeDays),
    showDataQuality: bool(raw.showDataQuality, DEFAULT_GLOBAL_SETTINGS.showDataQuality),
    showFairOdds: bool(raw.showFairOdds, DEFAULT_GLOBAL_SETTINGS.showFairOdds),
    forceAppearance: bool(raw.forceAppearance, DEFAULT_GLOBAL_SETTINGS.forceAppearance),
    forceModelSettings: bool(raw.forceModelSettings, DEFAULT_GLOBAL_SETTINGS.forceModelSettings),
    forceFeaturedTeam: bool(raw.forceFeaturedTeam, DEFAULT_GLOBAL_SETTINGS.forceFeaturedTeam),
  };
}

function cachedSettings() {
  try {
    return normalizeGlobalSettings(JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_GLOBAL_SETTINGS };
  }
}

function cacheSettings(settings) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)); } catch { /* storage facoltativo */ }
}

export function applyGlobalSettings(rawSettings) {
  const settings = normalizeGlobalSettings(rawSettings);
  document.title = settings.siteTitle;
  const announcement = document.getElementById("global-announcement");
  if (announcement) {
    announcement.textContent = settings.announcement;
    announcement.hidden = !settings.announcement;
  }
  if (settings.forceAppearance) {
    applyPalette({ primary: settings.primaryColor, secondary: settings.secondaryColor });
    applyBackgroundSource(settings.backgroundImageUrl, settings.backgroundOverlay);
  }
  return settings;
}

export async function initializeGlobalSettings(onChange = () => {}) {
  let current = applyGlobalSettings(cachedSettings());
  onChange(current, { connected: false, source: "cache" });
  if (!isFirebaseConfigured()) return { settings: current, connected: false, unsubscribe: () => {} };

  try {
    const { db, firestoreApi } = await getFirebaseServices();
    const reference = firestoreApi.doc(db, firebasePaths.settingsCollection, firebasePaths.settingsDocument);
    const snapshot = await firestoreApi.getDoc(reference);
    if (snapshot.exists()) {
      current = applyGlobalSettings(snapshot.data());
      cacheSettings(current);
      onChange(current, { connected: true, source: "firestore" });
    }
    const unsubscribe = firestoreApi.onSnapshot(reference, (next) => {
      if (!next.exists()) return;
      current = applyGlobalSettings(next.data());
      cacheSettings(current);
      onChange(current, { connected: true, source: "realtime" });
    }, () => onChange(current, { connected: false, source: "cache" }));
    return { settings: current, connected: true, unsubscribe };
  } catch {
    return { settings: current, connected: false, unsubscribe: () => {} };
  }
}
