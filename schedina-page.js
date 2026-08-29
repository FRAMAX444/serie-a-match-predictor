import {
  generateSlip,
  getStoredOddsApiKey,
  setStoredOddsApiKey,
  DEFAULT_MARKET_GROUPS,
  DEFAULT_MIN_LEG_ODDS,
} from "./schedina.js";
import { buildCompetitionCatalog } from "./matchdays.js";
import { saveSlipSeries } from "./slip-history.js";

// Se un id non esiste, il messaggio deve dire QUALE. Senza questo controllo la pagina mostrava
// "Errore: Cannot set properties of null (setting 'innerHTML')", che non nomina l'elemento
// mancante e soprattutto non dice che la causa piu' probabile non e' nel codice: schedina.html e
// schedina-page.js devono essere della STESSA versione, e l'id del contenitore dei risultati e'
// cambiato il 28/08/2026 (schedina-legs -> schedina-selections, difetto 8). Una pagina rimasta in
// cache con lo script nuovo produce esattamente quel TypeError. Vedi MISTAKES.md 17.
const $ = (id) => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(
      `elemento #${id} assente nella pagina. Ricarica forzando l'aggiornamento (Ctrl+F5 o `
      + "Cmd+Shift+R): la pagina caricata e lo script che la pilota devono essere della stessa "
      + "versione.",
    );
  }
  return node;
};
const number = (value, digits = 2) => Number(value).toFixed(digits);
const percent = (value) => `${Math.round(value * 100)}%`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));

let payload = null;

function setStatus(message, tone = "info") {
  const node = $("schedina-status");
  node.textContent = message;
  node.dataset.tone = tone;
}

async function loadDataset() {
  const response = await fetch("data/matches.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Dataset non raggiungibile (HTTP ${response.status})`);
  const data = await response.json();
  if (data.columns && data.matches?.length && Array.isArray(data.matches[0])) {
    data.matches = data.matches.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
  }
  return data;
}

function populateLeagues() {
  const select = $("schedina-competition");
  const catalog = buildCompetitionCatalog(payload).filter((competition) => competition.available);
  if (!catalog.length) {
    select.replaceChildren(new Option("Nessuna competizione disponibile nel dataset locale", ""));
    return;
  }
  select.replaceChildren(...catalog.map((competition) => new Option(competition.name, competition.id)));
  const preferred = catalog.find((competition) => competition.id === payload.default_competition);
  select.value = (preferred || catalog[0]).id;
}

function selectedMarketGroups() {
  const checked = [...document.querySelectorAll(".schedina-market:checked")].map((input) => input.value);
  return checked.length ? checked : [...DEFAULT_MARKET_GROUPS];
}

function legRow(leg) {
  // Una quota stimata dal modello e una quota di mercato non sono la stessa cosa e non vanno
  // mostrate allo stesso modo: la prima dice quanto l'esito varrebbe, la seconda quanto
  // qualcuno lo paga davvero.
  const badge = leg.source === "model"
    ? '<span class="schedina-leg__source" title="Quota equa stimata dal modello (1 ÷ probabilità): nessuna quota reale disponibile per questa selezione">stima</span>'
    : "";
  const weak = leg.reliability < 0.5
    ? '<span class="schedina-leg__source" title="Il modello ha pochi dati su questa selezione: stima meno solida delle altre">dati scarsi</span>'
    : "";
  return `<div class="schedina-leg">
    <span class="schedina-leg__match">${escapeHtml(leg.fixtureLabel)}</span>
    <span class="schedina-leg__pick">${escapeHtml(leg.label)}${badge}${weak}</span>
    <span class="schedina-leg__odds">@${number(leg.odds)}</span>
    <span class="schedina-leg__prob">${percent(leg.probability)}</span>
  </div>`;
}

function summaryItem(label, value, modifier = "") {
  return `<div class="schedina-summary__item">
    <span class="schedina-summary__label">${escapeHtml(label)}</span>
    <span class="schedina-summary__value${modifier}">${escapeHtml(value)}</span>
  </div>`;
}

function slipBlock(slip, index) {
  const vincita = slip.usesMarketOdds ? ` · vincita su 10€: ${number(slip.combinedOdds * 10)}€` : "";
  return `<article class="schedina-card">
    <header class="schedina-card__head">
      <span class="schedina-card__rank">Schedina ${index + 1}</span>
      <span class="schedina-card__odds">quota totale <strong>${number(slip.combinedOdds)}</strong></span>
      <span class="schedina-card__prob">${percent(slip.combinedProbability)}${escapeHtml(vincita)}</span>
    </header>
    <div class="schedina-legs">${slip.legs.map(legRow).join("")}</div>
  </article>`;
}

function renderSeries(slips, notes, context) {
  const section = $("schedina-result");
  const warnings = $("schedina-warnings");
  if (!slips.length) {
    section.hidden = true;
    setStatus(
      `Nessuna schedina componibile con questi parametri. ${notes.join(" ")} `
      + "Prova con meno partite, una sicurezza più bassa, una quota minima più bassa o più mercati attivi.",
      "warn",
    );
    return;
  }

  const best = slips[0];
  const odds = slips.map((slip) => slip.combinedOdds);
  const probabilities = slips.map((slip) => slip.combinedProbability);
  $("schedina-summary").innerHTML = [
    summaryItem("Quota totale (migliore)", number(Math.max(...odds)), " schedina-summary__value--total"),
    summaryItem("Quote della serie", `da ${number(Math.min(...odds))} a ${number(Math.max(...odds))}`),
    summaryItem("Probabilità", `da ${percent(Math.min(...probabilities))} a ${percent(Math.max(...probabilities))}`),
    summaryItem("Schedine", `${slips.length}`),
    summaryItem("Sicurezza richiesta", `${best.confidence.label} (${percent(best.targetProbability)})`),
    `<p class="schedina-summary__note">${best.usesMarketOdds
      ? `Ritorno atteso su 1€ giocato: <strong>${number(best.expectedReturn)}€</strong> sulla prima schedina, secondo il modello.`
      : "Quote eque del modello (1 ÷ probabilità), non quote di un banco: il ritorno atteso è 1 per costruzione."}
      <strong>Le dieci schedine sono le dieci migliori dello stesso turno, quindi condividono le
      partite e gli esiti: giocarle tutte non è diversificare, è la stessa scommessa moltiplicata.</strong></p>`,
  ].join("");

  $("schedina-selections").innerHTML = slips.map(slipBlock).join("");

  const allWarnings = [...best.relaxations, ...notes.filter(Boolean)];
  if (!best.targetMet) {
    allWarnings.unshift(
      `La sicurezza richiesta (${percent(best.targetProbability)}) non è raggiungibile con `
      + `${best.requestedLegs} partite in questo turno: la schedina mostrata è la più sicura possibile `
      + `(${percent(best.combinedProbability)}).`,
    );
  }
  warnings.hidden = allWarnings.length === 0;
  warnings.textContent = allWarnings.join(" ");
  section.hidden = false;

  // L'archivio serve a una cosa sola: verificare a posteriori che la probabilita' dichiarata sia
  // quella vera. Si salva subito, perche' una schedina non registrata al momento della
  // generazione non e' piu' verificabile dopo — la si ricostruirebbe sapendo gia' com'e' andata.
  const saved = saveSlipSeries({ ...context, slips });
  setStatus(
    saved
      ? `Fatto: ${slips.length} schedine generate e salvate nello storico.`
      : `Fatto: ${slips.length} schedine generate. Non è stato possibile salvarle nello storico (spazio del browser).`,
    "ok",
  );
}

function coverageNotes(result) {
  const notes = [];
  if (result.oddsError) notes.push(`Quote reali non disponibili (${result.oddsError}): usate le quote eque del modello.`);
  else if (result.oddsCoverage && result.oddsCoverage.matched < result.oddsCoverage.total) {
    notes.push(
      `Quote di mercato trovate per ${result.oddsCoverage.matched} partite su ${result.oddsCoverage.total}; `
      + "per le altre è stata usata la quota equa del modello.",
    );
  }
  if (result.eventOddsCoverage) {
    const coverage = result.eventOddsCoverage;
    // Il conteggio da solo non dice nulla di azionabile. Le due ragioni per cui una partita
    // resta scoperta hanno rimedi opposti: una partita non abbinata e' un problema di nomi o
    // date nostro, un mercato non offerto e' una scelta del bookmaker e non c'e' niente da
    // correggere.
    const reasons = [];
    if (coverage.unmatchedFixtures) {
      reasons.push(`${coverage.unmatchedFixtures} non abbinate al catalogo eventi`);
    }
    if (coverage.marketUnavailable) {
      reasons.push(`${coverage.marketUnavailable} senza mercato marcatori sui bookmaker ${coverage.region}`);
    }
    notes.push(
      `Mercati per singolo evento (${coverage.markets.join(", ")}) ottenuti per `
      + `${coverage.eventsWithLiveOdds}/${coverage.totalFixtures} partite sui bookmaker `
      + `${coverage.region}${reasons.length ? ` (${reasons.join(", ")})` : ""}.`,
    );
  }
  if (result.requestEstimate) {
    const cache = result.oddsCache || { fromCache: 0, fetched: 0, oldestMinutes: 0 };
    const rimaste = Number.isFinite(result.quota?.remaining)
      ? ` Richieste rimaste sul piano: ${result.quota.remaining}.`
      : "";
    // L'eta' della quota piu' vecchia servita dalla cache non e' un dettaglio: una quota vecchia
    // e' un prezzo sbagliato, non un prezzo mancante, e la schedina la userebbe come vera.
    const dallaCache = cache.fromCache
      ? ` ${cache.fromCache} risposte riusate dalla cache locale`
      + `${cache.oldestMinutes >= 1 ? ` (la più vecchia di ${Math.round(cache.oldestMinutes)} minuti)` : ""}`
      + ", quindi non riacquistate."
      : "";
    notes.push(
      `Costo pieno di questa generazione: ~${result.requestEstimate} richieste API; `
      + `effettivamente scaricate: ${cache.fetched}.${dallaCache}${rimaste}`,
    );
  }
  return notes;
}

async function runGeneration(sportKeyOverride) {
  const apiKey = $("schedina-api-key").value.trim();
  const competitionId = $("schedina-competition").value;
  const legs = Number($("schedina-legs").value);
  const confidence = $("schedina-confidence").value;
  // Quota minima per selezione: e' la leva contro le giocate che non pagano nulla. Un valore
  // illeggibile ricade sul default invece di propagare NaN dentro l'ottimizzatore.
  const minOddsRaw = Number($("schedina-min-odds").value);
  const minLegOdds = Number.isFinite(minOddsRaw) && minOddsRaw >= 1 ? minOddsRaw : DEFAULT_MIN_LEG_ODDS;
  const marketGroups = selectedMarketGroups();

  if (!competitionId) { setStatus("Seleziona una lega.", "warn"); return; }
  if (!Number.isInteger(legs) || legs < 1 || legs > 12) {
    setStatus("Il numero di partite deve essere un intero tra 1 e 12.", "warn");
    return;
  }

  setStoredOddsApiKey(apiKey);
  $("schedina-result").hidden = true;
  $("schedina-manual").hidden = true;
  setStatus(apiKey ? "Calcolo le previsioni e richiedo le quote in tempo reale…" : "Calcolo le previsioni del turno…", "info");
  // Un frame per far comparire lo stato prima del calcolo, che è sincrono e blocca il thread.
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const result = await generateSlip({
      payload, competitionId, legs, confidence, marketGroups, apiKey,
      sportKey: sportKeyOverride || null,
      forceRefresh: $("schedina-refresh-odds").checked,
      minLegOdds,
      seriesCount: 10,
      playerMarkets: marketGroups.includes("giocatori")
        ? ["goalscorer", "goal_assist", "shot", "shots_2", "shot_on_target"]
        : [],
    });
    renderSeries(result.slips, coverageNotes(result), {
      competitionId,
      competitionName: $("schedina-competition").selectedOptions?.[0]?.text || competitionId,
      round: result.matchday?.round ?? null,
      confidence,
      requestedLegs: legs,
      usesMarketOdds: Boolean(result.slip?.usesMarketOdds),
    });
  } catch (error) {
    if (error.candidates) {
      const select = $("schedina-manual-select");
      select.replaceChildren(...error.candidates.map((sport) => new Option(`${sport.title || sport.key} (${sport.description || sport.key})`, sport.key)));
      $("schedina-manual").hidden = false;
      setStatus("Non ho individuato un solo campionato corrispondente: scegli tu quale usare qui sotto.", "warn");
      return;
    }
    setStatus(`Errore: ${error.message}`, "error");
  }
}

async function init() {
  try {
    payload = await loadDataset();
  } catch (error) {
    setStatus(`Impossibile caricare il dataset locale: ${error.message}`, "error");
    return;
  }
  try {
    populateLeagues();
  } catch (error) {
    setStatus(`Elenco leghe non costruito: ${error.message}`, "error");
    return;
  }
  $("schedina-api-key").value = getStoredOddsApiKey();
  setStatus("Pronto. La schedina si genera solo quando premi il pulsante.", "info");
  // Segnale per il controllo in pagina: i moduli sono stati eseguiti. Senza, un fallimento del
  // grafo dei moduli e' indistinguibile da un caricamento lento.
  globalThis.__schedinaReady = true;

  $("schedina-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runGeneration();
  });

  $("schedina-manual-confirm").addEventListener("click", () => {
    const sportKey = $("schedina-manual-select").value;
    if (sportKey) runGeneration(sportKey);
  });
}

init();
