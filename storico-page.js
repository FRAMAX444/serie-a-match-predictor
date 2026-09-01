import {
  clearSlipHistory, settleSeries, indexMatches, historyCalibration,
  loadArchive, saveArchive, collectWins, mergeWins,
} from "./slip-history.js";

const $ = (id) => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(
      `elemento #${id} assente nella pagina. Ricarica forzando l'aggiornamento (Ctrl+F5 o `
      + "Cmd+Shift+R): la pagina caricata e lo script che la pilota devono essere della stessa versione.",
    );
  }
  return node;
};

const percent = (value) => (value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`);
const number = (value, digits = 2) => Number(value).toFixed(digits);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));

const STATUS_LABEL = {
  vinta: "vinta", persa: "persa", "in corso": "in corso", "non verificabile": "non verificabile",
};

function summaryItem(label, value) {
  return `<div class="schedina-summary__item">
    <span class="schedina-summary__label">${escapeHtml(label)}</span>
    <span class="schedina-summary__value">${escapeHtml(value)}</span>
  </div>`;
}

function calibrationMarkup(calibration) {
  if (!calibration.decided) {
    return '<p class="schedina-summary__note">Nessuna schedina con esito ancora deciso. Le serie appena generate compaiono qui dopo che le partite sono state giocate e il dataset è stato aggiornato.</p>';
  }
  const rows = calibration.bands
    .filter((band) => band.n > 0)
    .map((band) => `<tr>
      <td>${escapeHtml(band.label)}</td>
      <td>${band.n}</td>
      <td>${percent(band.expected)}</td>
      <td>${percent(band.observed)}</td>
      <td>${band.won}</td>
    </tr>`)
    .join("");
  return [
    summaryItem("Schedine decise", `${calibration.decided}`),
    summaryItem("Vinte", `${calibration.won}`),
    summaryItem("Attese dal modello", number(calibration.expectedWins, 1)),
    summaryItem("Ritorno su 1€ per schedina", `${number(calibration.returned)}€ su ${calibration.staked}€ giocati`),
    `<div class="storico-table-wrap"><table class="storico-table">
      <thead><tr><th>fascia dichiarata</th><th>schedine</th><th>attesa</th><th>osservata</th><th>vinte</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  ].join("");
}

function legMarkup(leg) {
  const esito = leg.won === true ? "vinta" : leg.won === false ? "persa" : leg.played ? "non verificabile" : "in attesa";
  return `<div class="schedina-leg" data-outcome="${escapeHtml(esito)}">
    <span class="schedina-leg__match">${escapeHtml(`${leg.homeTeam} - ${leg.awayTeam}`)}${leg.score ? ` <strong>${escapeHtml(leg.score)}</strong>` : ""}</span>
    <span class="schedina-leg__pick">${escapeHtml(leg.label)}</span>
    <span class="schedina-leg__odds">@${number(leg.odds)}</span>
    <span class="schedina-leg__prob">${escapeHtml(esito)}</span>
  </div>`;
}

function seriesMarkup(record) {
  const decise = record.slips.filter((slip) => slip.status === "vinta" || slip.status === "persa");
  const vinte = record.slips.filter((slip) => slip.status === "vinta").length;
  const slips = record.slips.map((slip, index) => `<article class="schedina-card" data-status="${escapeHtml(slip.status)}">
    <header class="schedina-card__head">
      <span class="schedina-card__rank">Schedina ${index + 1}</span>
      <span class="schedina-card__odds">quota <strong>${number(slip.combinedOdds)}</strong></span>
      <span class="schedina-card__prob">${percent(slip.combinedProbability)} · ${escapeHtml(STATUS_LABEL[slip.status])}</span>
    </header>
    <div class="schedina-legs">${slip.legs.map(legMarkup).join("")}</div>
  </article>`).join("");

  return `<details class="storico-series">
    <summary>
      <strong>${escapeHtml(record.competitionName || record.competitionId)}</strong>
      · turno ${escapeHtml(String(record.round ?? "?"))}
      · generata il ${escapeHtml(new Date(record.generatedAt).toLocaleString("it-IT"))}
      · ${vinte}/${decise.length} decise vinte
    </summary>
    ${slips}
  </details>`;
}

// Una vincita e' una copia autonoma, non un puntatore alla serie: e' l'unico modo perche' resti
// leggibile quando la serie che la conteneva esce dalla rotazione delle ultime 40.
function winMarkup(win) {
  return `<article class="schedina-card" data-status="vinta">
    <header class="schedina-card__head">
      <span class="schedina-card__rank">${escapeHtml(win.competitionName || win.competitionId)} · turno ${escapeHtml(String(win.round ?? "?"))}</span>
      <span class="schedina-card__odds">quota <strong>${number(win.combinedOdds)}</strong></span>
      <span class="schedina-card__prob">${percent(win.combinedProbability)} · ${escapeHtml(new Date(win.generatedAt).toLocaleDateString("it-IT"))}</span>
    </header>
    <div class="schedina-legs">${win.legs.map(legMarkup).join("")}</div>
  </article>`;
}

function winsMarkup(wins) {
  if (!wins.length) {
    return '<p class="schedina-summary__note">Nessuna schedina vinta finora. Una schedina entra qui quando tutte le sue selezioni sono state giocate e sono risultate corrette, e da quel momento non esce più: né quando la serie che la conteneva esce dalla rotazione, né quando svuoti lo storico.</p>';
  }
  const totale = wins.reduce((sum, win) => sum + Number(win.combinedOdds || 0), 0);
  const migliore = wins.reduce((best, win) => (Number(win.combinedOdds) > Number(best.combinedOdds) ? win : best), wins[0]);
  return [
    '<div class="schedina-summary">',
    summaryItem("Schedine vinte", `${wins.length}`),
    summaryItem("Quota più alta vinta", number(migliore.combinedOdds)),
    summaryItem("Vincita totale su 1€ per schedina", `${number(totale)}€`),
    "</div>",
    wins.map(winMarkup).join(""),
  ].join("");
}

async function loadMatches() {
  try {
    const response = await fetch("data/matches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload : payload.matches || [];
  } catch (error) {
    // Senza dataset lo storico resta leggibile: gli esiti semplicemente non si calcolano, e la
    // pagina lo dice invece di mostrare tutto come "in corso" senza spiegazione.
    console.error(`Dataset non caricato: ${error.message}`);
    return null;
  }
}

// Dove vivono davvero i dati. E' la riga che mancava: finora la pagina prometteva che "le
// schedine restano qui" senza distinguere fra un archivio su disco e una cache del browser, che
// una pulizia di Chrome cancella per intero.
function storageNote(archive) {
  return archive.remote || archive.saved
    ? "Archivio su disco attivo (data/slip-history.json): le schedine sopravvivono alla pulizia della cache e al cambio di browser."
    : "Archivio su disco non raggiungibile: le schedine vivono solo in questo browser e una pulizia dei dati di Chrome le cancella. "
      + "Apri la pagina da `npm start` perché vengano scritte su disco.";
}

function render(settled, wins, archive, matches) {
  const status = $("storico-status");
  $("storico-wins").innerHTML = winsMarkup(wins);
  if (!settled.length) {
    status.textContent = `Nessuna serie salvata. Generane una dalla pagina Schedina. ${storageNote(archive)}`;
    $("storico-list").innerHTML = "";
    $("storico-calibration").innerHTML = calibrationMarkup({ decided: 0, bands: [] });
    return;
  }
  status.textContent = matches
    ? `${settled.length} serie salvate. ${storageNote(archive)}`
    : `${settled.length} serie salvate, ma il dataset dei risultati non è raggiungibile: gli esiti non sono calcolabili adesso. ${storageNote(archive)}`;
  $("storico-calibration").innerHTML = calibrationMarkup(historyCalibration(settled));
  $("storico-list").innerHTML = settled.map(seriesMarkup).join("");
}

async function init() {
  const matches = await loadMatches();
  // L'unione fra disco e browser va fatta prima di qualunque cosa: le due copie divergono appena
  // si genera una schedina da un browser e la si guarda da un altro.
  const archive = await loadArchive();
  const index = indexMatches(matches || []);
  const settled = archive.series.map((record) => settleSeries(record, index));
  const wins = mergeWins(archive.wins, collectWins(settled));
  const { saved } = await saveArchive({ series: archive.series, wins });
  render(settled, wins, { ...archive, saved }, matches);

  $("storico-clear").addEventListener("click", async () => {
    // Svuota le serie, non le vincite: sono due archivi con vite diverse, e la sezione permanente
    // non sarebbe permanente se un pulsante potesse azzerarla.
    clearSlipHistory();
    const { saved: archived } = await saveArchive({ series: [], wins });
    render([], wins, { remote: archive.remote, saved: archived }, matches);
  });
}

init();
