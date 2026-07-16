import { buildCompetitionCatalog } from "./matchdays.js";
import { getFavoriteTeam } from "./preferences.js";

export const COMPETITION_STORAGE_KEY = "european-cups-predictor-competition";
export const COMPETITION_ORDER_STORAGE_KEY = "multi-league-predictor-competition-order";

function safeStorageGet(key, fallback = "") {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Il predictor continua a funzionare anche quando lo storage è disabilitato.
  }
}

export function getStoredCompetition() {
  return safeStorageGet(COMPETITION_STORAGE_KEY);
}

export function getStoredCompetitionOrder() {
  try {
    const parsed = JSON.parse(safeStorageGet(COMPETITION_ORDER_STORAGE_KEY, "[]"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item) : [];
  } catch {
    return [];
  }
}

export function storeCompetitionOrder(order) {
  const unique = [...new Set(order.filter(Boolean))];
  safeStorageSet(COMPETITION_ORDER_STORAGE_KEY, JSON.stringify(unique));
  if (unique[0]) safeStorageSet(COMPETITION_STORAGE_KEY, unique[0]);
}

export function storeCompetition(competitionId) {
  if (!competitionId) return;
  const order = getStoredCompetitionOrder().filter((id) => id !== competitionId);
  storeCompetitionOrder([competitionId, ...order]);
}

function includesTeam(competition, team) {
  return Boolean(team) && competition.fixtures.some((fixture) =>
    fixture.home_team === team || fixture.away_team === team || fixture.homeTeam === team || fixture.awayTeam === team);
}

export function rankCompetitions(competitions, favoriteTeam = getFavoriteTeam("")) {
  const order = getStoredCompetitionOrder();
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return competitions.slice().sort((left, right) => {
    const leftIndex = orderIndex.has(left.id) ? orderIndex.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.has(right.id) ? orderIndex.get(right.id) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    const favoriteDelta = Number(includesTeam(right, favoriteTeam)) - Number(includesTeam(left, favoriteTeam));
    if (favoriteDelta) return favoriteDelta;
    const typeDelta = Number(right.type === "europe") - Number(left.type === "europe");
    if (typeDelta) return typeDelta;
    return left.name.localeCompare(right.name, "it");
  });
}

function availableIds(select) {
  return [...select.options].map((option) => option.value).filter(Boolean);
}

function reorderSelect(select) {
  const order = getStoredCompetitionOrder();
  if (!order.length || !select.options.length) return;
  const selected = select.value;
  const options = [...select.options];
  const index = new Map(order.map((id, position) => [id, position]));
  options.sort((left, right) => {
    const leftIndex = index.has(left.value) ? index.get(left.value) : Number.MAX_SAFE_INTEGER;
    const rightIndex = index.has(right.value) ? index.get(right.value) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.text.localeCompare(right.text, "it");
  });
  select.replaceChildren(...options);
  if (availableIds(select).includes(selected)) select.value = selected;
}

function initPredictorPreference() {
  const select = document.getElementById("competition-select");
  if (!select) return;

  let applyingPreference = false;
  const applyStoredPreference = () => {
    if (applyingPreference) return;
    reorderSelect(select);
    const ids = availableIds(select);
    if (!ids.length) return;

    const requested = new URLSearchParams(window.location.search).get("competition");
    const stored = getStoredCompetition();
    if (ids.includes(requested) || !ids.includes(stored) || select.value === stored) return;

    applyingPreference = true;
    select.value = stored;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    applyingPreference = false;
  };

  new MutationObserver(applyStoredPreference).observe(select, { childList: true });
  select.addEventListener("change", () => storeCompetition(select.value));
  applyStoredPreference();
}

function setSettingsStatus(message) {
  const status = document.getElementById("settings-status");
  if (status) status.textContent = message;
}

function leagueLogo(competition) {
  if (!competition.logo) {
    const fallback = document.createElement("span");
    fallback.className = "league-order__fallback";
    fallback.textContent = competition.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
    return fallback;
  }
  const image = document.createElement("img");
  image.src = competition.logo;
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.replaceWith(leagueLogo({ ...competition, logo: "" })), { once: true });
  return image;
}

function renderLeagueOrder(container, competitions) {
  const ordered = rankCompetitions(competitions);
  const currentOrder = ordered.map((competition) => competition.id);
  container.replaceChildren(...ordered.map((competition, index) => {
    const row = document.createElement("div");
    row.className = "league-order__row";
    row.dataset.competitionId = competition.id;

    const identity = document.createElement("div");
    identity.className = "league-order__identity";
    identity.append(leagueLogo(competition));
    const label = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = competition.name;
    const detail = document.createElement("small");
    detail.textContent = competition.country || (competition.type === "europe" ? "Europa" : "Campionato");
    label.append(name, detail);
    identity.append(label);

    const actions = document.createElement("div");
    actions.className = "league-order__actions";
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "secondary-button";
    primary.textContent = index === 0 ? "★ Preferita" : "☆ Preferita";
    primary.addEventListener("click", () => {
      storeCompetitionOrder([competition.id, ...currentOrder.filter((id) => id !== competition.id)]);
      renderLeagueOrder(container, competitions);
      const select = document.getElementById("settings-competition");
      if (select) select.value = competition.id;
      setSettingsStatus(`Lega preferita: ${competition.name}.`);
    });

    const up = document.createElement("button");
    up.type = "button";
    up.className = "icon-button";
    up.textContent = "↑";
    up.title = "Sposta su";
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      [currentOrder[index - 1], currentOrder[index]] = [currentOrder[index], currentOrder[index - 1]];
      storeCompetitionOrder(currentOrder);
      renderLeagueOrder(container, competitions);
    });

    const down = document.createElement("button");
    down.type = "button";
    down.className = "icon-button";
    down.textContent = "↓";
    down.title = "Sposta giù";
    down.disabled = index === ordered.length - 1;
    down.addEventListener("click", () => {
      [currentOrder[index + 1], currentOrder[index]] = [currentOrder[index], currentOrder[index + 1]];
      storeCompetitionOrder(currentOrder);
      renderLeagueOrder(container, competitions);
    });

    actions.append(primary, up, down);
    row.append(identity, actions);
    return row;
  }));
}

async function initSettingsPreference() {
  const select = document.getElementById("settings-competition");
  if (!select) return;

  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const competitions = rankCompetitions(buildCompetitionCatalog(payload));
    if (!competitions.length) throw new Error("Nessuna competizione disponibile");

    select.replaceChildren(...competitions.map((competition) => new Option(competition.name, competition.id)));
    const ids = competitions.map((competition) => competition.id);
    const stored = getStoredCompetition();
    const fallback = ids.includes(payload.default_competition) ? payload.default_competition : competitions[0].id;
    select.value = ids.includes(stored) ? stored : fallback;
    select.disabled = false;

    const orderContainer = document.getElementById("settings-league-order");
    if (orderContainer) renderLeagueOrder(orderContainer, competitions);

    select.addEventListener("change", () => {
      storeCompetition(select.value);
      if (orderContainer) renderLeagueOrder(orderContainer, competitions);
      const selectedLabel = select.options[select.selectedIndex]?.textContent || select.value;
      setSettingsStatus(`Competizione predefinita salvata: ${selectedLabel}.`);
    });
  } catch {
    select.replaceChildren(new Option("Competizioni non disponibili", ""));
    select.disabled = true;
  }
}

if (typeof document !== "undefined") {
  initPredictorPreference();
  initSettingsPreference();
}
