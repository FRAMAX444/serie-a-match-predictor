const ROMA_LATEST_LOGO = "https://upload.wikimedia.org/wikipedia/fr/thumb/b/b7/Logo_AS_Roma_2026.svg/240px-Logo_AS_Roma_2026.svg.png";
const crestCandidates = new Map();

function addCandidate(team, url, prioritize = false) {
  const name = String(team || "").trim();
  const source = String(url || "").trim();
  if (!name || !source) return;

  const candidates = crestCandidates.get(name) || [];
  if (candidates.includes(source)) return;
  if (prioritize) candidates.unshift(source);
  else candidates.push(source);
  crestCandidates.set(name, candidates);
}

function providerLogo(fixture, side) {
  const teamId = String(fixture?.[`${side}_team_id`] || "").trim();
  if (!teamId) return "";

  const source = String(fixture?.source || "").toLowerCase();
  if (source.includes("uefa")) {
    return `https://img.uefa.com/imgml/TP/teams/logos/240x240/${encodeURIComponent(teamId)}.png`;
  }
  return `https://a.espncdn.com/i/teamlogos/soccer/500/${encodeURIComponent(teamId)}.png`;
}

function buildCrestCatalog(data) {
  Object.entries(data?.team_logos || {}).forEach(([team, url]) => addCandidate(team, url, true));
  addCandidate("Roma", ROMA_LATEST_LOGO, true);

  for (const competition of data?.competitions || []) {
    for (const fixture of competition?.fixtures || []) {
      for (const side of ["home", "away"]) {
        const team = fixture?.[`${side}_team`];
        addCandidate(team, fixture?.[`${side}_team_logo`], true);
        addCandidate(team, providerLogo(fixture, side));
      }
    }
  }
}

function showFallback(badge, image, fallback) {
  image?.remove();
  if (fallback) fallback.hidden = false;
  badge.classList.add("team-badge--fallback");
}

function attachCrest(teamElement) {
  const badge = teamElement.querySelector(".team-badge");
  const team = teamElement.querySelector("strong")?.textContent?.trim();
  if (!badge || !team || badge.dataset.crestHydrated === "true") return;

  const candidates = crestCandidates.get(team) || [];
  const existing = badge.querySelector(".team-badge__image");
  if (existing) {
    badge.dataset.crestHydrated = "true";
    return;
  }
  if (!candidates.length) return;

  badge.dataset.crestHydrated = "true";
  const fallback = badge.querySelector(".team-badge__fallback");
  let candidateIndex = 0;
  const image = document.createElement("img");
  image.className = "team-badge__image";
  image.alt = `Stemma ${team}`;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.hidden = true;

  const loadCandidate = () => {
    if (candidateIndex >= candidates.length) {
      showFallback(badge, image, fallback);
      return;
    }
    image.src = candidates[candidateIndex];
    candidateIndex += 1;
  };

  image.addEventListener("load", () => {
    image.hidden = false;
    if (fallback) fallback.hidden = true;
    badge.classList.remove("team-badge--fallback");
  }, { once: true });
  image.addEventListener("error", loadCandidate);
  badge.prepend(image);
  loadCandidate();
}

function hydrateCrests(root = document) {
  root.querySelectorAll(".team").forEach(attachCrest);
}

async function initTeamCrests() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buildCrestCatalog(await response.json());
    hydrateCrests();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".team")) attachCrest(node);
          hydrateCrests(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (error) {
    console.warn("Stemmi squadre non disponibili", error);
  }
}

initTeamCrests();
