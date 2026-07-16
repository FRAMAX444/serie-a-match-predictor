export const FAVORITE_STORAGE_KEY = "serie-a-predictor-favorite-team";
export const PALETTE_STORAGE_KEY = "serie-a-predictor-team-palettes";
export const BACKGROUND_STORAGE_KEY = "serie-a-predictor-background";
export const MODEL_STORAGE_KEY = "serie-a-predictor-model-settings";

export const DEFAULT_PALETTE = { primary: "#1f4f8f", secondary: "#172033" };
export const DEFAULT_MODEL_SETTINGS = { windowDays: 540, halfLifeDays: 120 };

export const TEAM_PALETTES = {
  Atalanta: { primary: "#1e71b8", secondary: "#101820" },
  Bologna: { primary: "#9b1b30", secondary: "#14213d" },
  Cagliari: { primary: "#a71930", secondary: "#17365d" },
  Como: { primary: "#1d5ca8", secondary: "#ffffff" },
  Fiorentina: { primary: "#5b2a86", secondary: "#ffffff" },
  Frosinone: { primary: "#f4c300", secondary: "#174a8b" },
  Genoa: { primary: "#a71930", secondary: "#17365d" },
  Inter: { primary: "#0057b8", secondary: "#111111" },
  Juventus: { primary: "#111111", secondary: "#ffffff" },
  Lazio: { primary: "#75bde0", secondary: "#ffffff" },
  Lecce: { primary: "#d9ad00", secondary: "#b51f2e" },
  Milan: { primary: "#c8102e", secondary: "#111111" },
  Monza: { primary: "#d71920", secondary: "#ffffff" },
  Napoli: { primary: "#12a0d7", secondary: "#ffffff" },
  Parma: { primary: "#f2c300", secondary: "#1d4f91" },
  Roma: { primary: "#8e1f2f", secondary: "#f0bc42" },
  Sassuolo: { primary: "#2eaa50", secondary: "#111111" },
  Torino: { primary: "#7a263a", secondary: "#ffffff" },
  Udinese: { primary: "#111111", secondary: "#ffffff" },
  Venezia: { primary: "#e86f21", secondary: "#0b6b4f" },
};

export const TEAM_NAMES = Object.keys(TEAM_PALETTES).sort((a, b) => a.localeCompare(b, "it"));

function safeJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function hexToRgb(hex) {
  const normalized = String(hex).replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mixColors(color, target, amount) {
  const sourceRgb = hexToRgb(color) || hexToRgb(DEFAULT_PALETTE.primary);
  const targetRgb = hexToRgb(target) || { r: 255, g: 255, b: 255 };
  return rgbToHex({
    r: sourceRgb.r + (targetRgb.r - sourceRgb.r) * amount,
    g: sourceRgb.g + (targetRgb.g - sourceRgb.g) * amount,
    b: sourceRgb.b + (targetRgb.b - sourceRgb.b) * amount,
  });
}

function readableText(color) {
  const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
    const channel = value / 255;
    return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return luminance > .56 ? "#172033" : "#ffffff";
}

export function getFavoriteTeam(fallback = "Roma") {
  return localStorage.getItem(FAVORITE_STORAGE_KEY) || fallback;
}

export function setFavoriteTeam(team) {
  if (team) localStorage.setItem(FAVORITE_STORAGE_KEY, team);
}

export function getStoredPalettes() {
  return safeJson(PALETTE_STORAGE_KEY, {});
}

export function paletteForTeam(team) {
  return getStoredPalettes()[team] || TEAM_PALETTES[team] || DEFAULT_PALETTE;
}

export function savePalette(team, palette) {
  const palettes = getStoredPalettes();
  palettes[team] = palette;
  localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
}

export function resetPalette(team) {
  const palettes = getStoredPalettes();
  delete palettes[team];
  localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
}

export function applyPalette(palette) {
  const primary = palette.primary || DEFAULT_PALETTE.primary;
  const secondary = palette.secondary || DEFAULT_PALETTE.secondary;
  const primaryRgb = hexToRgb(primary) || hexToRgb(DEFAULT_PALETTE.primary);
  const root = document.documentElement.style;
  root.setProperty("--primary", primary);
  root.setProperty("--primary-rgb", `${primaryRgb.r} ${primaryRgb.g} ${primaryRgb.b}`);
  root.setProperty("--primary-dark", mixColors(primary, "#000000", .28));
  root.setProperty("--primary-soft", mixColors(primary, "#ffffff", .89));
  root.setProperty("--on-primary", readableText(primary));
  root.setProperty("--accent", secondary);
  root.setProperty("--on-accent", readableText(secondary));
  return { primary, secondary };
}

export function applyTeamPalette(team) {
  return applyPalette(paletteForTeam(team));
}

export function getModelSettings() {
  const saved = safeJson(MODEL_STORAGE_KEY, DEFAULT_MODEL_SETTINGS);
  const windowDays = Number(saved.windowDays);
  const halfLifeDays = Number(saved.halfLifeDays);
  return {
    windowDays: [365, 540, 730].includes(windowDays) ? windowDays : DEFAULT_MODEL_SETTINGS.windowDays,
    halfLifeDays: [75, 120, 180].includes(halfLifeDays) ? halfLifeDays : DEFAULT_MODEL_SETTINGS.halfLifeDays,
  };
}

export function saveModelSettings(settings) {
  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({
    windowDays: Number(settings.windowDays),
    halfLifeDays: Number(settings.halfLifeDays),
  }));
}

export function applyBackgroundSource(source, overlay = .78) {
  if (!source) {
    document.body.classList.remove("has-custom-background");
    document.body.style.removeProperty("--custom-background-image");
    document.body.style.removeProperty("background-image");
    return false;
  }
  const safeOverlay = Math.max(.1, Math.min(.95, Number(overlay) || .78));
  const endingOverlay = Math.min(.99, safeOverlay + .13);
  document.body.style.setProperty("--custom-background-image", `url(${JSON.stringify(source)})`);
  document.body.style.backgroundImage = `linear-gradient(rgba(243, 245, 247, ${safeOverlay}), rgba(243, 245, 247, ${endingOverlay})), url(${JSON.stringify(source)})`;
  document.body.classList.add("has-custom-background");
  return true;
}

export function applyBackground(dataUrl = localStorage.getItem(BACKGROUND_STORAGE_KEY)) {
  return applyBackgroundSource(dataUrl, .78);
}

export function removeBackground() {
  localStorage.removeItem(BACKGROUND_STORAGE_KEY);
  applyBackgroundSource("");
}

export function resizeBackground(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Impossibile leggere l'immagine."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Formato immagine non supportato."));
      image.onload = () => {
        const maxWidth = 1920;
        const maxHeight = 1200;
        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Impossibile elaborare l'immagine."));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .84));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function storeBackground(dataUrl) {
  localStorage.setItem(BACKGROUND_STORAGE_KEY, dataUrl);
  applyBackground(dataUrl);
}

export function applyStoredAppearance(team = getFavoriteTeam()) {
  applyTeamPalette(team);
  applyBackground();
}
