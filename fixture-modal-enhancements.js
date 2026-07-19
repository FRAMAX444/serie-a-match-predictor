import { paletteForTeam } from "./preferences.js";

const modalContent = document.getElementById("fixture-modal-content");
const probabilityLayoutObservers = new WeakMap();

function safeHex(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function textProbabilityFromCell(cell) {
  const match = cell?.textContent?.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const value = Number.parseFloat(match?.[1]?.replace(",", ".") || "0");
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

export function probabilityFromCell(cell) {
  const rawProbability = Number.parseFloat(cell?.dataset?.probability || "");
  if (Number.isFinite(rawProbability)) return Math.max(rawProbability * 100, 0);
  return textProbabilityFromCell(cell);
}

export function displayedProbabilityFromCell(cell, fallbackProbability = 0) {
  const explicit = String(cell?.dataset?.displayPercentage || "").trim();
  const explicitMatch = explicit.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
  if (explicitMatch) return `${explicitMatch[1].replace(",", ".")}%`;

  const textMatch = cell?.textContent?.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (textMatch) return `${textMatch[1].replace(",", ".")}%`;

  const safeFallback = Number.isFinite(fallbackProbability) ? Math.max(fallbackProbability, 0) : 0;
  return `${safeFallback.toFixed(1)}%`;
}

export function normalizedProbabilities(cells) {
  const values = cells.map(probabilityFromCell);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return cells.map(() => 100 / Math.max(cells.length, 1));
  return values.map((value) => (value / total) * 100);
}

function probabilityValue(label, displayedPercentage, position) {
  const item = document.createElement("span");
  item.className = "fixture-modal__probability-value";
  item.dataset.probabilityPosition = position.toFixed(6);

  const outcome = document.createElement("b");
  outcome.textContent = label;

  const percentage = document.createElement("small");
  percentage.textContent = displayedPercentage;

  item.append(outcome, percentage);
  return item;
}

function measuredProbabilityItems(values, containerWidth) {
  return [...values.querySelectorAll(".fixture-modal__probability-value")].map((item) => {
    const width = Math.min(Math.ceil(item.getBoundingClientRect().width), containerWidth);
    const position = Number.parseFloat(item.dataset.probabilityPosition || "50");
    const desiredCenter = (Math.min(100, Math.max(0, position)) / 100) * containerWidth;

    return {
      item,
      width,
      desiredCenter,
      desiredLeft: desiredCenter - width / 2,
    };
  });
}

function resolveSingleRowPositions(measurements, containerWidth, minimumGap) {
  if (!measurements.length) return [];

  const positions = measurements.map(({ desiredLeft }) => desiredLeft);
  const lastIndex = measurements.length - 1;

  positions[0] = Math.max(0, positions[0]);
  for (let index = 1; index <= lastIndex; index += 1) {
    const previousEnd = positions[index - 1] + measurements[index - 1].width;
    positions[index] = Math.max(positions[index], previousEnd + minimumGap);
  }

  positions[lastIndex] = Math.min(
    positions[lastIndex],
    Math.max(0, containerWidth - measurements[lastIndex].width),
  );
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const latestAllowed = positions[index + 1] - minimumGap - measurements[index].width;
    positions[index] = Math.min(positions[index], latestAllowed);
  }

  if (positions[0] < 0) {
    const shift = -positions[0];
    for (let index = 0; index <= lastIndex; index += 1) positions[index] += shift;
  }

  const finalOverflow = positions[lastIndex] + measurements[lastIndex].width - containerWidth;
  if (finalOverflow > 0) {
    for (let index = 0; index <= lastIndex; index += 1) positions[index] -= finalOverflow;
  }

  return positions;
}

function layoutProbabilityValues(values) {
  const items = [...values.querySelectorAll(".fixture-modal__probability-value")];
  const containerWidth = values.getBoundingClientRect().width;
  if (!items.length || containerWidth <= 0) return;

  items.forEach((item) => {
    item.style.left = "0px";
    item.style.setProperty("--anchor-offset", "0px");
  });

  values.classList.remove("fixture-modal__probability-values--compact");
  let measurements = measuredProbabilityItems(values, containerWidth);
  let minimumGap = containerWidth < 420 ? 6 : 10;
  let requiredWidth = measurements.reduce((sum, measurement) => sum + measurement.width, 0)
    + minimumGap * Math.max(0, measurements.length - 1);

  if (requiredWidth > containerWidth) {
    values.classList.add("fixture-modal__probability-values--compact");
    measurements = measuredProbabilityItems(values, containerWidth);
    minimumGap = 4;
    requiredWidth = measurements.reduce((sum, measurement) => sum + measurement.width, 0)
      + minimumGap * Math.max(0, measurements.length - 1);
  }

  const positions = requiredWidth <= containerWidth
    ? resolveSingleRowPositions(measurements, containerWidth, minimumGap)
    : measurements.map((measurement, index) => {
      const equalSlot = containerWidth / measurements.length;
      return Math.max(0, Math.min(
        index * equalSlot + (equalSlot - measurement.width) / 2,
        containerWidth - measurement.width,
      ));
    });

  measurements.forEach(({ item, width, desiredCenter }, index) => {
    const adjustedCenter = positions[index] + width / 2;
    item.style.left = `${adjustedCenter}px`;
    item.style.setProperty("--anchor-offset", `${desiredCenter - adjustedCenter}px`);
  });
}

function watchProbabilityValues(values) {
  let animationFrame = 0;
  const scheduleLayout = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      layoutProbabilityValues(values);
    });
  };

  scheduleLayout();

  if (typeof ResizeObserver === "function" && !probabilityLayoutObservers.has(values)) {
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(values);
    probabilityLayoutObservers.set(values, observer);
  }
}

function normalizeModalTeamPresentation(hero) {
  hero.querySelectorAll(".team--favorite").forEach((team) => {
    team.classList.remove("team--favorite");
  });
}

function enhanceFixtureModal() {
  const hero = modalContent?.querySelector(".fixture-modal__hero");
  if (!hero) return;

  normalizeModalTeamPresentation(hero);
  if (hero.classList.contains("fixture-modal__hero--enhanced")) return;

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
  modalContent.style.setProperty("--home-team-primary", safeHex(homePalette.primary, "#1f4f8f"));
  modalContent.style.setProperty("--home-team-secondary", safeHex(homePalette.secondary, "#172033"));
  modalContent.style.setProperty("--away-team-primary", safeHex(awayPalette.primary, "#7a263a"));
  modalContent.style.setProperty("--away-team-secondary", safeHex(awayPalette.secondary, "#ffffff"));

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
    probabilityStrip.style.removeProperty("--probability-columns");

    const cells = [...probabilityStrip.querySelectorAll("span")];
    const probabilities = normalizedProbabilities(cells);
    const displayedPercentages = cells.map((cell, index) => (
      displayedProbabilityFromCell(cell, probabilities[index])
    ));
    const outcomeClasses = ["probability-strip__home", "probability-strip__draw", "probability-strip__away"];
    const outcomeLabels = ["1", "X", "2"];

    probabilityStrip.setAttribute("role", "img");
    probabilityStrip.setAttribute(
      "aria-label",
      `Probabilità 1X2 per ${matchLabel}: ${outcomeLabels.map((label, index) => `${label} ${displayedPercentages[index]}`).join(", ")}`,
    );

    cells.forEach((cell, index) => {
      const chance = `${probabilities[index].toFixed(6)}%`;
      cell.classList.add(outcomeClasses[index]);
      cell.style.setProperty("--chance", chance);
      cell.style.flexBasis = chance;
      cell.style.width = chance;
      cell.replaceChildren();
      cell.setAttribute("aria-hidden", "true");
    });

    let values = hero.querySelector(".fixture-modal__probability-values");
    if (!values) {
      values = document.createElement("div");
      values.className = "fixture-modal__probability-values";
      values.setAttribute("aria-hidden", "true");
      probabilityStrip.after(values);
    }

    let cumulativeProbability = 0;
    const probabilityItems = outcomeLabels.map((label, index) => {
      const probability = probabilities[index];
      const center = cumulativeProbability + probability / 2;
      cumulativeProbability += probability;
      return probabilityValue(label, displayedPercentages[index], center);
    });
    values.replaceChildren(...probabilityItems);
    watchProbabilityValues(values);

    if (!probabilityStrip.previousElementSibling?.classList.contains("fixture-modal__probability-heading")) {
      const heading = document.createElement("div");
      heading.className = "fixture-modal__probability-heading";
      heading.innerHTML = "<strong>Probabilità 1X2</strong>";
      probabilityStrip.before(heading);
    }
  }

  hero.classList.add("fixture-modal__hero--enhanced");
}

if (modalContent) {
  new MutationObserver(enhanceFixtureModal).observe(modalContent, { childList: true, subtree: true });
  enhanceFixtureModal();
}
