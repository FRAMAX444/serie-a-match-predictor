import { buildCompetitionCatalog } from "./matchdays.js";
import { getFavoriteTeam } from "./preferences.js";
import { rankCompetitions, storeCompetition } from "./competition-preference.js";

const $ = (id) => document.getElementById(id);
let competitions = [];

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
}

function logoNode(competition) {
  if (!competition.logo) {
    const fallback = document.createElement("span");
    fallback.className = "league-card__fallback";
    fallback.textContent = initials(competition.name);
    return fallback;
  }
  const image = document.createElement("img");
  image.src = competition.logo;
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.replaceWith(logoNode({ ...competition, logo: "" })), { once: true });
  return image;
}

function closePicker() {
  const picker = $("league-picker");
  if (!picker) return;
  picker.hidden = true;
  document.body.classList.remove("league-picker-open");
  $("open-league-picker")?.focus();
}

function openPicker() {
  const picker = $("league-picker");
  if (!picker) return;
  renderPicker();
  picker.hidden = false;
  document.body.classList.add("league-picker-open");
  requestAnimationFrame(() => picker.querySelector(".league-card--active, .league-card")?.focus());
}

function waitForSelectOptions(select, minimum = 1) {
  if (select?.options.length >= minimum) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (select.options.length >= minimum) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(select, { childList: true });
    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 2500);
  });
}

async function chooseCompetition(competition) {
  const select = $("competition-select");
  if (!select) return;
  await waitForSelectOptions(select);
  if (![...select.options].some((option) => option.value === competition.id)) return;

  storeCompetition(competition.id);
  select.value = competition.id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  closePicker();
}

function competitionCard(competition) {
  const selectedId = $("competition-select")?.value;
  const active = selectedId === competition.id;
  const card = document.createElement("button");
  card.type = "button";
  card.className = `league-card${active ? " league-card--active" : ""}`;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-pressed", String(active));
  card.append(logoNode(competition));

  const copy = document.createElement("span");
  copy.className = "league-card__copy";
  const title = document.createElement("strong");
  title.textContent = competition.name;
  const meta = document.createElement("small");
  meta.textContent = competition.country || "Campionato";
  copy.append(title, meta);
  card.append(copy);

  const marker = document.createElement("span");
  marker.className = "league-card__arrow";
  marker.textContent = active ? "✓" : "›";
  marker.setAttribute("aria-hidden", "true");
  card.append(marker);
  card.addEventListener("click", () => chooseCompetition(competition));
  return card;
}

function renderPicker() {
  const grid = $("league-picker-grid");
  if (!grid || !competitions.length) return;
  competitions = rankCompetitions(competitions, getFavoriteTeam(""));
  grid.replaceChildren(...competitions.map(competitionCard));
  $("league-picker-description").textContent = `${competitions.length} campionati disponibili`;
}

async function init() {
  const picker = $("league-picker");
  if (!picker) return;
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    competitions = buildCompetitionCatalog(payload);
    renderPicker();
  } catch {
    $("league-picker-description").textContent = "Campionati non disponibili.";
  }
}

$("close-league-picker")?.addEventListener("click", closePicker);
$("open-league-picker")?.addEventListener("click", openPicker);
$("competition-select")?.addEventListener("change", renderPicker);
$("league-picker")?.addEventListener("click", (event) => {
  if (event.target === $("league-picker")) closePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("league-picker")?.hidden) closePicker();
});

init();
