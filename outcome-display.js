// Selezione dell'esito mostrato in UI: le probabilità 1/X/2 restano quelle pure del modello.
// Il correttivo interviene solo quando il pareggio è nominalmente primo per pochi punti ma
// una delle due squadre è chiaramente favorita rispetto all'altra. In questo modo evitiamo
// che un 38% X / 36% 1 / 26% 2 venga presentato come "Pareggio" ignorando il netto vantaggio
// relativo della squadra di casa, senza però forzare 1/2 nelle partite realmente equilibrate.
export function chooseDisplayedOutcome(probabilities, homeTeam, awayTeam) {
  const home = { key: "1", name: homeTeam, probability: Number(probabilities?.homeWin) || 0 };
  const draw = { key: "X", name: "Pareggio", probability: Number(probabilities?.draw) || 0 };
  const away = { key: "2", name: awayTeam, probability: Number(probabilities?.awayWin) || 0 };
  const rawTop = [home, draw, away].sort((left, right) => right.probability - left.probability)[0];

  if (rawTop.key !== "X") return rawTop;

  const favorite = home.probability >= away.probability ? home : away;
  const underdog = favorite.key === "1" ? away : home;
  const favoriteEdge = favorite.probability - underdog.probability;
  const drawLead = draw.probability - favorite.probability;

  const clearFavorite = favorite.probability >= 0.34 && favoriteEdge >= 0.12;
  const drawOnlySlightlyAhead = drawLead <= 0.06;
  return clearFavorite && drawOnlySlightlyAhead ? favorite : draw;
}

function readProbabilities(strip) {
  const values = {};
  strip?.querySelectorAll("span").forEach((item) => {
    const key = item.querySelector("b")?.textContent?.trim();
    const match = item.textContent.match(/([0-9]+(?:[.,][0-9]+)?)%/);
    if (key && match) values[key] = Number(match[1].replace(",", ".")) / 100;
  });
  return {
    homeWin: values["1"] || 0,
    draw: values.X || 0,
    awayWin: values["2"] || 0,
  };
}

function setOutcomeText(target, outcome) {
  if (!target || !outcome) return;
  const next = `${outcome.key} · ${outcome.name}`;
  if (target.textContent !== next) target.textContent = next;
}

function refreshCard(card) {
  const strip = card.querySelector(".probability-strip");
  const homeTeam = card.querySelector(".team--home strong")?.textContent?.trim();
  const awayTeam = card.querySelector(".team--away strong")?.textContent?.trim();
  if (!strip || !homeTeam || !awayTeam) return;
  const outcome = chooseDisplayedOutcome(readProbabilities(strip), homeTeam, awayTeam);
  setOutcomeText(card.querySelector(".fixture-footer > span:first-child"), outcome);
}

function refreshModal(container) {
  const strip = container.querySelector(".probability-strip");
  const homeTeam = container.querySelector(".team--home strong")?.textContent?.trim();
  const awayTeam = container.querySelector(".team--away strong")?.textContent?.trim();
  if (!strip || !homeTeam || !awayTeam) return;
  const outcome = chooseDisplayedOutcome(readProbabilities(strip), homeTeam, awayTeam);
  setOutcomeText(container.querySelector(".fixture-modal__outcome strong"), outcome);
}

function initializeOutcomeDisplay() {
  const grid = document.getElementById("fixtures-grid");
  const modal = document.getElementById("fixture-modal-content");
  if (grid) {
    const refresh = () => grid.querySelectorAll(".fixture-card").forEach(refreshCard);
    new MutationObserver(refresh).observe(grid, { childList: true, subtree: true });
    refresh();
  }
  if (modal) {
    const refresh = () => refreshModal(modal);
    new MutationObserver(refresh).observe(modal, { childList: true, subtree: true });
    refresh();
  }
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeOutcomeDisplay, { once: true });
  else initializeOutcomeDisplay();
}
