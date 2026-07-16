import assert from "node:assert/strict";
import { DEFAULT_GLOBAL_SETTINGS, normalizeGlobalSettings } from "../global-settings.js";

const settings = normalizeGlobalSettings({
  siteTitle: "  Predictor condiviso  ",
  primaryColor: "#ABCDEF",
  secondaryColor: "not-a-color",
  backgroundImageUrl: "javascript:alert(1)",
  backgroundOverlay: 4,
  defaultWindowDays: 999,
  defaultHalfLifeDays: 75,
  showDataQuality: false,
  forceAppearance: true,
});

assert.equal(settings.siteTitle, "Predictor condiviso");
assert.equal(settings.primaryColor, "#abcdef");
assert.equal(settings.secondaryColor, DEFAULT_GLOBAL_SETTINGS.secondaryColor);
assert.equal(settings.backgroundImageUrl, "");
assert.equal(settings.backgroundOverlay, 0.95);
assert.equal(settings.defaultWindowDays, DEFAULT_GLOBAL_SETTINGS.defaultWindowDays);
assert.equal(settings.defaultHalfLifeDays, 75);
assert.equal(settings.showDataQuality, false);
assert.equal(settings.forceAppearance, true);
assert.equal(DEFAULT_GLOBAL_SETTINGS.forceAppearance, false);
console.log("OK: configurazione globale validata");
