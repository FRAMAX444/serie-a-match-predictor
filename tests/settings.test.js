import assert from "node:assert/strict";
import { DEFAULT_SITE_SETTINGS, normalizeSiteSettings } from "../site-settings.js";

const normalized = normalizeSiteSettings({
  siteTitle: "  Predictor personalizzato  ",
  accentColor: "#ABCDEF",
  backgroundImageUrl: "javascript:alert(1)",
  backgroundOverlay: 4,
  defaultWindowDays: 999,
  defaultHalfLifeDays: 75,
  showDataQuality: false,
});

assert.equal(normalized.siteTitle, "Predictor personalizzato");
assert.equal(normalized.accentColor, "#abcdef");
assert.equal(normalized.backgroundImageUrl, "");
assert.equal(normalized.backgroundOverlay, 0.95);
assert.equal(normalized.defaultWindowDays, DEFAULT_SITE_SETTINGS.defaultWindowDays);
assert.equal(normalized.defaultHalfLifeDays, 75);
assert.equal(normalized.showDataQuality, false);
console.log("OK: impostazioni globali validate");
