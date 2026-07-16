import { buildCompetitionCatalog, buildMatchdays, nextFixtureForTeam } from "./matchdays.js";
import { getFavoriteTeam } from "./preferences.js";
import { rankCompetitions, storeCompetition } from "./competition-preference.js";

const $ = (id) => document.getElementById(id);
let payload;
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
  image.alt = `Logo ${competition.name}`;
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
  picker.hidden = false;
  document.body.classList.add("league-picker-open");
  picker.querySelector(".league-card")?.focus();
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

  const favorite = getFavoriteTeam("");
  const calendar = buildMatchdays(payload, competition.id);
  const next = nextFixtureForTeam(calendar, favorite);
  if (!next) return;

  const matchdaySelect = $("matchday-select");
  await waitForSelectOptions(matchdaySelect);
  if ([...matchdaySelect.options].some((option) => Number(option.value) === next.matchday.round)) {
    matchdaySelect.value = String(next.matchday.round);
    $("predict-button")?.click();
  }
}

function competitionCard(competition, index) {
  const favorite = getFavoriteTeam("");
  const calendar = buildMatchdays(payload, competition.id);
  const next = nextFixtureForTeam(calendar, favorite);
  const card = document.createElement("button");
  card.type = "button";
  card.className = "league-card";
  card.setAttribute("role", "listitem");
  if (index === 0) card.classList.add("league-card--preferred");
  card.append(logoNode(competition));

  const copy = document.createElement("span");
  copy.className = "league-card__copy";
  const title = document.createElement("strong");
  title.textContent = competition.name;
  const meta = document.createElement("small");
  meta.textContent = [competition.country || (competition.type === "europe" ? "Europa" : "Campionato"), competition.season]
    .filter(Boolean).join(" · ");
  copy.append(title, meta);
  if (next) {
    const fixture = document.createElement("em");
    fixture.textContent = `${favorite}: ${next.fixture.home_team} – ${next.fixture.away_team}`;
    copy.append(fixture);
  }
  card.append(copy);

  const arrow = document.createElement("span");
  arrow.className = "league-card__arrow";
  arrow.textContent = "→";
  card.append(arrow);
  card.addEventListener("click", () => chooseCompetition(competition));
  return card;
}

function renderPicker() {
  const grid = $("league-picker-grid");
  if (!grid) return;
  competitions = rankCompetitions(competitions, getFavoriteTeam(""));
  grid.replaceChildren(...competitions.map(competitionCard));
  const favorite = getFavoriteTeam("");
  $("league-picker-description").textContent = favorite
    ? `Le competizioni sono ordinate usando le preferenze salvate. Se ${favorite} partecipa, apriamo direttamente la sua prossima partita.`
    : "Le competizioni sono ordinate usando le preferenze salvate nel browser.";
}

async function init() {
  const picker = $("league-picker");
  if (!picker) return;
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
    competitions = buildCompetitionCatalog(payload);
    renderPicker();
    openPicker();
  } catch {
    $("league-picker-description").textContent = "Impossibile caricare il catalogo delle competizioni.";
  }
}

$("close-league-picker")?.addEventListener("click", closePicker);
$("open-league-picker")?.addEventListener("click", openPicker);
$("league-picker")?.addEventListener("click", (event) => {
  if (event.target === $("league-picker")) closePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("league-picker")?.hidden) closePicker();
});

init();
