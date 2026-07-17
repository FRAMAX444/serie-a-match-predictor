import { paletteForTeam } from "./preferences.js";

const modalContent = document.getElementById("fixture-modal-content");

function safeHex(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function probabilityFromCell(cell) {
  const match = cell?.textContent?.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const value = Number.parseFloat(match?.[1]?.replace(",", ".") || "0");
  return Number.isFinite(value) ? Math.max(value, 1) : 1;
}

function enhanceFixtureModal() {
  const hero = modalContent?.querySelector(".fixture-modal__hero");
  if (!hero || hero.classList.contains("fixture-modal__hero--enhanced")) return;

  const headerTitle = modalContent.querySelector(".fixture-modal__header h2");
  const teams = [...hero.querySelectorAll(".team")];
  const homeName = teams[0]?.querySelector("strong")?.textContent?.trim();
  const awayName = teams[1]?.querySelector("strong")?.textContent?.trim();
  if (!headerTitle || !homeName || !awayName) return;

  const matchLabel = `${homeName} – ${awayName}`;
  headerTitle.textContent = "Statistiche partita";

  const meta = modalContent.querySelector(".fixture-modal__meta");
  if (meta && !meta.querySelector(".fixture-modal__match-label")) {
    const label = document.createElement("span");
    label.className = "fixture-modal__match-label";
    label.textContent = matchLabel;
    meta.prepend(label);
  }

  const homePalette = paletteForTeam(homeName);
  const awayPalette = paletteForTeam(awayName);
  hero.style.setProperty("--home-team-primary", safeHex(homePalette.primary, "#1f4f8f"));
  hero.style.setProperty("--home-team-secondary", safeHex(homePalette.secondary, "#172033"));
  hero.style.setProperty("--away-team-primary", safeHex(awayPalette.primary, "#7a263a"));
  hero.style.setProperty("--away-team-secondary", safeHex(awayPalette.secondary, "#ffffff"));

  const predictedScore = hero.querySelector(".predicted-score");
  if (predictedScore && !predictedScore.querySelector(".fixture-modal__vs")) {
    const versus = document.createElement("span");
    versus.className = "fixture-modal__vs";
    versus.textContent = "VS";
    predictedScore.prepend(versus);
  }

  const probabilityStrip = hero.querySelector(".probability-strip");
  if (probabilityStrip) {
    probabilityStrip.classList.add("probability-strip--modal");
    probabilityStrip.setAttribute("role", "img");
    probabilityStrip.setAttribute("aria-label", `Probabilità 1X2 per ${matchLabel}`);

    const cells = [...probabilityStrip.querySelectorAll("span")];
    const outcomeClasses = ["probability-strip__home", "probability-strip__draw", "probability-strip__away"];
    cells.forEach((cell, index) => {
      cell.classList.add(outcomeClasses[index]);
      cell.style.setProperty("--chance", String(probabilityFromCell(cell)));
    });

    if (!probabilityStrip.previousElementSibling?.classList.contains("fixture-modal__probability-heading")) {
      const heading = document.createElement("div");
      heading.className = "fixture-modal__probability-heading";
      heading.innerHTML = "<strong>Probabilità 1X2</strong><span>Le dimensioni mostrano le chance stimate</span>";
      probabilityStrip.before(heading);
    }
  }

  hero.classList.add("fixture-modal__hero--enhanced");
}

if (modalContent) {
  new MutationObserver(enhanceFixtureModal).observe(modalContent, { childList: true, subtree: true });
  enhanceFixtureModal();
}
