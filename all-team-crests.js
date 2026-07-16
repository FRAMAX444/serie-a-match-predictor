const ROMA_LATEST_LOGO = "https://upload.wikimedia.org/wikipedia/fr/thumb/b/b7/Logo_AS_Roma_2026.svg/240px-Logo_AS_Roma_2026.svg.png";
const crestCandidates = new Map();

function teamKey(team) {
  return String(team || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function addCandidate(team, url, prioritize = false) {
  const key = teamKey(team);
  const source = String(url || "").trim();
  if (!key || !source) return;

  const candidates = crestCandidates.get(key) || [];
  if (candidates.includes(source)) return;
  if (prioritize) candidates.unshift(source);
  else candidates.push(source);
  crestCandidates.set(key, candidates);
}

function providerLogos(fixture, side) {
  const teamId = String(fixture?.[`${side}_team_id`] || "").trim();
  if (!teamId) return [];

  const source = String(fixture?.source || "").toLowerCase();
  const competitionType = String(fixture?.competition_type || "").toLowerCase();
  const espn = `https://a.espncdn.com/i/teamlogos/soccer/500/${encodeURIComponent(teamId)}.png`;
  const uefa = `https://img.uefa.com/imgml/TP/teams/logos/240x240/${encodeURIComponent(teamId)}.png`;

  if (source.includes("uefa") || competitionType === "europe") return [uefa];
  if (source.includes("espn") || competitionType === "domestic") return [espn];
  return [espn, uefa];
}

function buildCrestCatalog(data) {
  Object.entries(data?.team_logos || {}).forEach(([team, url]) => addCandidate(team, url, true));
  addCandidate("Roma", ROMA_LATEST_LOGO, true);

  for (const competition of data?.competitions || []) {
    for (const fixture of competition?.fixtures || []) {
      const enrichedFixture = {
        ...fixture,
        competition_type: fixture?.competition_type || competition?.type,
        source: fixture?.source || competition?.source,
      };

      for (const side of ["home", "away"]) {
        const team = enrichedFixture?.[`${side}_team`];
        addCandidate(team, enrichedFixture?.[`${side}_team_logo`], true);
        providerLogos(enrichedFixture, side).forEach((url) => addCandidate(team, url));
      }
    }
  }
}

function showFallback(badge, image, fallback) {
  image?.remove();
  if (fallback) fallback.hidden = false;
  badge.classList.add("team-badge--fallback");
}

function showCrest(badge, image, fallback) {
  image.hidden = false;
  if (fallback) fallback.hidden = true;
  badge.classList.remove("team-badge--fallback");
}

function attachCrest(teamElement) {
  const badge = teamElement.querySelector(".team-badge");
  const team = teamElement.querySelector("strong")?.textContent?.trim();
  if (!badge || !team || badge.dataset.crestHydrated === "true") return;

  const catalogCandidates = crestCandidates.get(teamKey(team)) || [];
  let image = badge.querySelector(".team-badge__image");
  const existingSource = String(image?.getAttribute("src") || "").trim();
  const candidates = [...new Set([existingSource, ...catalogCandidates].filter(Boolean))];
  if (!candidates.length) return;

  badge.dataset.crestHydrated = "true";
  const fallback = badge.querySelector(".team-badge__fallback");
  let candidateIndex = existingSource ? 1 : 0;

  if (!image) {
    image = document.createElement("img");
    image.className = "team-badge__image";
    image.alt = `Stemma ${team}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.hidden = true;
    badge.prepend(image);
  }

  const loadCandidate = () => {
    if (candidateIndex >= candidates.length) {
      showFallback(badge, image, fallback);
      return;
    }
    image.src = candidates[candidateIndex];
    candidateIndex += 1;
  };

  image.addEventListener("load", () => showCrest(badge, image, fallback), { once: true });
  image.addEventListener("error", loadCandidate);

  if (!existingSource) {
    loadCandidate();
  } else if (image.complete) {
    if (image.naturalWidth) showCrest(badge, image, fallback);
    else loadCandidate();
  }
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
