const ROMA_LATEST_LOGO = new URL("./assets/team-logos/roma-2026.svg", import.meta.url).href;
const crestCandidates = new Map();

function teamKey(team) {
  return String(team || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedUrl(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    return new URL(source, document.baseURI).href;
  } catch {
    return source;
  }
}

function isRomaTeam(team) {
  return ["roma", "as roma", "a s roma", "roma fc", "as roma fc", "a s roma fc"].includes(teamKey(team));
}

function addCandidate(team, url, prioritize = false) {
  const key = teamKey(team);
  const source = String(url || "").trim();
  if (!key) return;

  if (isRomaTeam(team)) {
    crestCandidates.set(key, [ROMA_LATEST_LOGO]);
    return;
  }
  if (!source) return;

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
  if (!badge || !team) return;

  const roma = isRomaTeam(team);
  badge.classList.toggle("team-badge--roma", roma);

  let image = badge.querySelector(".team-badge__image");
  const existingSource = String(image?.getAttribute("src") || "").trim();
  const alreadyCorrect = roma && normalizedUrl(existingSource) === ROMA_LATEST_LOGO;
  if (badge.dataset.crestHydrated === "true" && (!roma || alreadyCorrect)) return;

  const catalogCandidates = crestCandidates.get(teamKey(team)) || [];
  const candidates = roma
    ? [ROMA_LATEST_LOGO]
    : [...new Set([existingSource, ...catalogCandidates].filter(Boolean))];
  if (!candidates.length) return;

  badge.dataset.crestHydrated = "true";
  const fallback = badge.querySelector(".team-badge__fallback");
  let candidateIndex = existingSource && normalizedUrl(candidates[0]) === normalizedUrl(existingSource) ? 1 : 0;

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

  if (roma && !alreadyCorrect) {
    image.hidden = true;
    loadCandidate();
  } else if (!existingSource) {
    loadCandidate();
  } else if (image.complete) {
    if (image.naturalWidth) showCrest(badge, image, fallback);
    else loadCandidate();
  }
}

function inferredImageTeam(image) {
  const teamName = image.closest(".team")?.querySelector("strong")?.textContent?.trim();
  if (teamName) return teamName;

  const label = [
    image.alt,
    image.title,
    image.getAttribute("aria-label"),
    image.dataset.team,
  ].filter(Boolean).join(" ");
  const match = label.match(/(?:stemma|logo|crest)\s+(?:della\s+|di\s+)?(.+)/i);
  return match?.[1]?.trim() || "";
}

function enforceRomaImages(root = document) {
  const images = [];
  if (root instanceof HTMLImageElement) images.push(root);
  root.querySelectorAll?.("img").forEach((image) => images.push(image));

  for (const image of images) {
    if (!isRomaTeam(inferredImageTeam(image))) continue;
    image.closest(".team-badge")?.classList.add("team-badge--roma");
    if (normalizedUrl(image.getAttribute("src")) !== ROMA_LATEST_LOGO) image.src = ROMA_LATEST_LOGO;
  }
}

function hydrateCrests(root = document) {
  root.querySelectorAll?.(".team").forEach(attachCrest);
  if (root instanceof Element && root.matches(".team")) attachCrest(root);
  enforceRomaImages(root);
}

async function initTeamCrests() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buildCrestCatalog(await response.json());
    hydrateCrests();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target instanceof HTMLImageElement) {
          enforceRomaImages(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          hydrateCrests(node);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "alt", "title", "aria-label", "data-team"],
    });
  } catch (error) {
    console.warn("Stemmi squadre non disponibili", error);
  }
}

initTeamCrests();
