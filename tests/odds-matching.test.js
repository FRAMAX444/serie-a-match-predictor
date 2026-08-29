import assert from "node:assert/strict";
import { discoverSportKey, matchOddsToFixtures } from "../schedina.js";

// Il collo di bottiglia delle quote reali sono due abbinamenti, entrambi fra NOMI scritti da
// due parti che non si parlano: il campionato (nostro id -> sport_key di the-odds-api) e le
// squadre (nome canonico della pipeline -> nome del bookmaker). Nessuno dei due e' verificabile
// dal vivo da qui, quindi il test fissa il catalogo e i nomi *documentati* dell'API e verifica
// che il codice li regga. Se the-odds-api cambiasse i suoi nomi, questo test resterebbe verde e
// la produzione no: e' il limite dichiarato, non un dettaglio dimenticato.

// --- Catalogo /v4/sports, forma e valori documentati -----------------------------------------
const CATALOG = [
  { key: "soccer_epl", group: "Soccer", title: "EPL", description: "English Premier League", active: true },
  { key: "soccer_efl_champ", group: "Soccer", title: "Championship", description: "EFL Championship", active: true },
  { key: "soccer_england_league1", group: "Soccer", title: "League 1", description: "England League 1", active: true },
  { key: "soccer_england_league2", group: "Soccer", title: "League 2", description: "England League 2", active: true },
  { key: "soccer_spain_la_liga", group: "Soccer", title: "La Liga - Spain", description: "Spanish La Liga", active: true },
  { key: "soccer_spain_segunda_division", group: "Soccer", title: "La Liga 2 - Spain", description: "Spanish Segunda Division", active: true },
  { key: "soccer_italy_serie_a", group: "Soccer", title: "Serie A - Italy", description: "Italian Serie A", active: true },
  { key: "soccer_italy_serie_b", group: "Soccer", title: "Serie B - Italy", description: "Italian Serie B", active: true },
  { key: "soccer_germany_bundesliga", group: "Soccer", title: "Bundesliga - Germany", description: "German Bundesliga", active: true },
  { key: "soccer_germany_bundesliga2", group: "Soccer", title: "Bundesliga 2 - Germany", description: "German Bundesliga 2", active: true },
  // Esiste, e' attiva negli stessi mesi ed e' anch'essa una "Bundesliga": e' la ragione per cui
  // la ricerca per parola chiave non basta.
  { key: "soccer_austria_bundesliga", group: "Soccer", title: "Austrian Football Bundesliga", description: "Austrian Bundesliga", active: true },
  { key: "soccer_france_ligue_one", group: "Soccer", title: "Ligue 1 - France", description: "French Ligue 1", active: true },
  { key: "soccer_france_ligue_two", group: "Soccer", title: "Ligue 2 - France", description: "French Ligue 2", active: true },
  // Accentata come la scrive l'API. Senza accento collide con "serie a": la ricerca testuale
  // dipende quindi da un dettaglio ortografico di un catalogo che non controlliamo.
  { key: "soccer_brazil_campeonato", group: "Soccer", title: "Brazil Série A", description: "Brasileirão Série A", active: true },
  { key: "soccer_uefa_champs_league", group: "Soccer", title: "UEFA Champions League", description: "European Champions League", active: true },
  { key: "americanfootball_nfl", group: "American Football", title: "NFL", description: "US Football", active: true },
];

globalThis.fetch = async (url) => {
  assert.ok(String(url).includes("/sports/"), `chiamata inattesa: ${url}`);
  return { ok: true, status: 200, json: async () => CATALOG };
};

const EXPECTED_KEYS = {
  "eng.1": "soccer_epl",
  "esp.1": "soccer_spain_la_liga",
  "ita.1": "soccer_italy_serie_a",
  "ger.1": "soccer_germany_bundesliga",
  "fra.1": "soccer_france_ligue_one",
};

for (const [competitionId, expected] of Object.entries(EXPECTED_KEYS)) {
  const discovery = await discoverSportKey("chiave-finta", competitionId);
  assert.equal(
    discovery.key, expected,
    `${competitionId}: atteso ${expected}, ottenuto ${discovery.key}. `
    + "Con key null la pagina chiede la scelta manuale del campionato, che dall'utente si legge "
    + "come «non trova le quote».",
  );
}

// --- Abbinamento delle squadre ---------------------------------------------------------------
// Nomi dell'API a sinistra della freccia solo dove differiscono dai nostri; le tre righe con il
// commento sono i casi che il contenimento di sottostringa sbagliava.
const ROUNDS = {
  "ita.1": [
    ["Inter", "Inter Milan", "Milan", "AC Milan"],
    ["Roma", "AS Roma", "Atalanta", "Atalanta BC"],
    ["Napoli", "Napoli", "Juventus", "Juventus"],
  ],
  "eng.1": [
    ["Brighton", "Brighton and Hove Albion", "Man United", "Manchester United"],
    ["Tottenham", "Tottenham Hotspur", "Bournemouth", "AFC Bournemouth"],
    ["Newcastle", "Newcastle United", "Nottingham Forest", "Nottingham Forest"],
  ],
  "ger.1": [
    // M'gladbach: nessuna sottostringa in comune con "Borussia Monchengladbach".
    ["M'gladbach", "Borussia Monchengladbach", "Bayern Monaco", "Bayern Munich"],
    ["Dortmund", "Borussia Dortmund", "Lipsia", "RB Leipzig"],
    ["Francoforte", "Eintracht Frankfurt", "Hamburg", "Hamburger SV"],
  ],
  "fra.1": [
    // Paris (= Paris FC) e PSG: due club diversi, e "Paris" e' sottostringa di entrambi.
    ["Paris", "Paris FC", "Marsiglia", "Olympique Marseille"],
    ["PSG", "Paris Saint Germain", "Lione", "Olympique Lyonnais"],
    // Rennes: l'API scrive il nome dello stadio-club, "Stade Rennais".
    ["Rennes", "Stade Rennais", "Brest", "Stade Brestois"],
  ],
  "esp.1": [
    ["Atletico Madrid", "Atletico Madrid", "Athletic Bilbao", "Athletic Bilbao"],
    ["Málaga", "Malaga", "Deportivo La Coruna", "Deportivo La Coruna"],
    ["Celta Vigo", "Celta Vigo", "Rayo Vallecano", "Rayo Vallecano"],
  ],
};

const DATE = "2026-08-29";
const bookmaker = (home, away) => ({
  bookmakers: [{
    markets: [{
      key: "h2h",
      outcomes: [
        { name: home, price: 2.10 }, { name: "Draw", price: 3.40 }, { name: away, price: 3.20 },
      ],
    }],
  }],
});

for (const [competitionId, round] of Object.entries(ROUNDS)) {
  const predictions = round.map(([home, , away]) => ({
    fixture: { home_team: home, away_team: away, date: DATE },
    result: {},
  }));
  // L'ordine degli eventi dell'API non e' quello del nostro turno: invertirlo e' il modo piu'
  // semplice per accorgersi di un abbinamento che dipende dall'ordine di scansione.
  const events = round.map(([, apiHome, , apiAway]) => ({
    id: `${apiHome}-${apiAway}`,
    commence_time: `${DATE}T18:45:00Z`,
    home_team: apiHome,
    away_team: apiAway,
    ...bookmaker(apiHome, apiAway),
  })).reverse();

  const entries = matchOddsToFixtures(predictions, events);
  entries.forEach((entry, index) => {
    const [home, apiHome, away, apiAway] = round[index];
    assert.ok(
      entry.matched,
      `${competitionId}: "${home} - ${away}" non abbinata a "${apiHome} - ${apiAway}". `
      + "La partita resta senza quote di mercato e ripiega sulla quota equa del modello, "
      + "senza che nulla dica che il nome non e' stato riconosciuto.",
    );
    assert.equal(
      entry.oddsEventId, `${apiHome}-${apiAway}`,
      `${competitionId}: "${home} - ${away}" abbinata all'evento sbagliato (${entry.oddsEventId}). `
      + "Quote di un'altra partita sono peggio di nessuna quota: la schedina le userebbe come vere.",
    );
    assert.equal(entry.odds.home, 2.10);
    assert.equal(entry.odds.away, 3.20);
  });
}

// Una partita che il bookmaker non espone deve restare senza quote, non prendersi quelle di
// un'altra: e' il caso in cui un matcher troppo tollerante fa danni invece di aiutare.
const orphan = matchOddsToFixtures(
  [{ fixture: { home_team: "Como", away_team: "Venezia", date: DATE }, result: {} }],
  [{
    id: "altro", commence_time: `${DATE}T18:45:00Z`,
    home_team: "Cagliari", away_team: "Torino", ...bookmaker("Cagliari", "Torino"),
  }],
);
assert.equal(orphan[0].matched, false);
assert.equal(orphan[0].odds.home, null);

console.log("OK: quote — sport_key risolto per le cinque leghe e squadre abbinate senza scambi");

// --- Prezzi di mercato per OGNI mercato, non solo per 1X2 ------------------------------------
// Fino al 28/08/2026 solo 1, X e 2 potevano avere una quota reale: doppia chance, Over/Under e
// Gol/No gol usavano sempre la quota equa del modello. Non e' un dettaglio di completezza, e'
// un difetto dell'ottimizzatore: con la quota equa vale ln(quota) = -ln(p) esattamente, mentre
// una quota di mercato e' piu' bassa del margine del banco. A parita' di probabilita' una
// selezione "stima" sembrava quindi pagare piu' di una di mercato, e la ricerca — che
// massimizza la somma dei ln(quota) — le preferiva sistematicamente. La schedina finiva piena
// dei mercati per cui NON avevamo un prezzo vero, e mostrava una quota combinata non ottenibile.
const { scoreMatrix, matrixProbabilities } = await import("../model.js");
const { buildMarketCandidates, oddsMarketsFor, marketOddsForKey } = await import("../schedina.js");

const H2H = { home: 2.00, draw: 3.50, away: 4.00 };
const eventWithAllMarkets = {
  id: "evento-completo",
  commence_time: `${DATE}T18:45:00Z`,
  home_team: "Juventus",
  away_team: "Parma",
  bookmakers: [{
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: "Juventus", price: H2H.home }, { name: "Draw", price: H2H.draw },
          { name: "Parma", price: H2H.away },
        ],
      },
      {
        key: "totals",
        outcomes: [
          { name: "Over", price: 1.85, point: 2.5 }, { name: "Under", price: 1.95, point: 2.5 },
        ],
      },
      { key: "btts", outcomes: [{ name: "Yes", price: 1.80 }, { name: "No", price: 1.95 }] },
    ],
  }],
};

const probabilities = matrixProbabilities(scoreMatrix(1.55, 1.10));
const withOdds = matchOddsToFixtures(
  [{ fixture: { home_team: "Juventus", away_team: "Parma", date: DATE }, result: { probabilities, quality: { score: 0.8 } } }],
  [eventWithAllMarkets],
);
const candidates = buildMarketCandidates(withOdds, { groups: ["1X2", "doppia", "gol", "squadra"] });
const bySelection = new Map(candidates.map((candidate) => [candidate.key, candidate]));

const round4 = (value) => Math.round(value * 10000) / 10000;
// Due esiti che si escludono: la quota e' l'inverso della somma degli inversi, e il margine
// del banco resta dentro. Nessuna chiamata in piu' all'API: sono le stesse tre quote 1X2.
assert.equal(round4(bySelection.get("1X").odds), round4(1 / (1 / H2H.home + 1 / H2H.draw)));
assert.equal(round4(bySelection.get("12").odds), round4(1 / (1 / H2H.home + 1 / H2H.away)));
assert.equal(round4(bySelection.get("X2").odds), round4(1 / (1 / H2H.draw + 1 / H2H.away)));
for (const key of ["1", "X", "2", "1X", "12", "X2", "OVER25", "UNDER25"]) {
  assert.equal(
    bySelection.get(key).source, "market",
    `${key}: con h2h+totals+btts disponibili deve usare il prezzo di mercato, non la quota equa`,
  );
}
assert.equal(bySelection.get("OVER25").odds, 1.85);
assert.equal(bySelection.get("UNDER25").odds, 1.95);
// btts arriva solo dall'endpoint per singolo evento; la mappatura c'e' e regge se l'evento lo
// porta, ma nessuna richiesta di lega puo' contenerlo.
assert.equal(bySelection.get("GG").odds, 1.80);
assert.equal(bySelection.get("NG").odds, 1.95);

// Una linea che il bookmaker non espone NON si estrapola: resta la quota equa, dichiarata come
// tale. Una linea estrapolata sarebbe di nuovo una stima travestita da prezzo di mercato.
assert.equal(bySelection.get("OVER35").source, "model");
assert.equal(bySelection.get("OVER35").odds, bySelection.get("OVER35").fairOdds);
// "Casa segna" non ha un mercato standard su the-odds-api.
assert.equal(bySelection.get("HOME_SCORES").source, "model");

// Ogni mercato x regione e' una richiesta sul piano gratuito: chi non gioca il gruppo "gol"
// non deve pagare i totals.
assert.deepEqual(oddsMarketsFor(["1X2", "doppia"]), ["h2h"]);
assert.deepEqual(oddsMarketsFor(["1X2", "gol"]), ["h2h", "totals"]);
assert.deepEqual(oddsMarketsFor(["squadra"]), ["h2h"]);
assert.equal(marketOddsForKey(null, "1"), null);

// L'endpoint di lega accetta solo i mercati "featured": uno non-featured non degrada la
// risposta, la fa fallire con HTTP 422 e lascia la schedina senza NESSUNA quota reale, comprese
// quelle 1X2 che erano disponibili. Misurato dal vivo il 28/08/2026 con `btts` (difetto 22).
const FEATURED = ["h2h", "spreads", "totals", "outrights"];
for (const groups of [["1X2"], ["doppia"], ["gol"], ["squadra"], ["giocatori"], ["1X2", "doppia", "gol", "squadra", "giocatori"]]) {
  for (const market of oddsMarketsFor(groups)) {
    assert.ok(
      FEATURED.includes(market),
      `mercato "${market}" chiesto all'endpoint di lega ma non featured: la richiesta fallirebbe `
      + "con INVALID_MARKET e la schedina resterebbe senza quote reali.",
    );
  }
}

console.log("OK: quote — doppia chance derivata dalle 1X2 e Over/Under dal mercato totals");

// La lista dei mercati deve arrivare davvero nella richiesta: e' l'unico punto in cui si decide
// quanto costa una generazione sul piano gratuito.
const { fetchLeagueOdds } = await import("../schedina.js");
let requestedUrl = "";
globalThis.fetch = async (url) => {
  requestedUrl = String(url);
  return { ok: true, status: 200, json: async () => [] };
};
await fetchLeagueOdds("chiave-finta", "soccer_italy_serie_a", oddsMarketsFor(["1X2", "gol"]));
assert.match(requestedUrl, /markets=h2h%2Ctotals/);
assert.match(requestedUrl, /regions=eu/);

console.log("OK: quote — i mercati richiesti all'API sono quelli dei gruppi selezionati");

// --- Mercati per singolo evento: tutto quello che il modello sa consumare ---------------------
const {
  eventMarketsFor, estimateOddsRequests, indexEventOutcomes, teamMarketsFromEventOdds,
  playerMarketPrice, EVENT_ODDS_REGIONS,
} = await import("../schedina.js");

assert.deepEqual(eventMarketsFor(["1X2", "doppia"]), [], "1X2 e doppia chance non costano nulla in piu': bastano le quote di lega");
assert.deepEqual(eventMarketsFor(["gol"]), ["alternate_totals", "btts"]);
assert.deepEqual(eventMarketsFor(["squadra"]), ["team_totals"]);
assert.deepEqual(
  eventMarketsFor(["giocatori"], ["goalscorer", "shot", "shots_2", "shot_on_target", "goal_assist"]),
  ["player_goal_scorer_anytime", "player_shots", "player_shots_on_target"],
  "shot e shots_2 leggono due linee dello stesso mercato: va chiesto una volta sola, non due",
);

// Il preventivo è ciò che si dice all'utente prima di spendere: mercati di lega (una regione) +
// mercati per evento x regioni x partite.
assert.equal(estimateOddsRequests(10, ["h2h", "totals"], ["btts"], "eu"), 2 + 10);
assert.equal(estimateOddsRequests(10, ["h2h"], ["btts", "team_totals"], "eu,us"), 1 + 2 * 2 * 10);

const eventPayload = {
  bookmakers: [{
    markets: [
      {
        key: "alternate_totals",
        outcomes: [
          { name: "Over", price: 1.12, point: 0.5 }, { name: "Under", price: 6.50, point: 0.5 },
          { name: "Over", price: 3.90, point: 3.5 }, { name: "Under", price: 1.28, point: 3.5 },
        ],
      },
      { key: "btts", outcomes: [{ name: "Yes", price: 1.80 }, { name: "No", price: 1.95 }] },
      {
        key: "team_totals",
        outcomes: [
          { description: "Juventus", name: "Over", price: 1.25, point: 0.5 },
          { description: "Parma", name: "Over", price: 1.70, point: 0.5 },
        ],
      },
      {
        key: "player_shots",
        outcomes: [
          { description: "Federico Conceicao", name: "Over", price: 1.60, point: 0.5 },
          { description: "Federico Conceicao", name: "Over", price: 2.75, point: 1.5 },
          { description: "Marcus Thuram", name: "Over", price: 1.55, point: 0.5 },
          { description: "Khephren Thuram", name: "Over", price: 2.10, point: 0.5 },
        ],
      },
      {
        key: "player_shots_on_target",
        outcomes: [{ description: "Federico Conceicao", name: "Over", price: 2.30, point: 0.5 }],
      },
      {
        key: "player_goal_scorer_anytime",
        outcomes: [{ description: "Randal Kolo Muani", name: "Yes", price: 3.10 }],
      },
    ],
  }],
};

const index = indexEventOutcomes(eventPayload);
const teamMarkets = teamMarketsFromEventOdds(index, { home_team: "Juventus", away_team: "Parma" });
assert.equal(teamMarkets.totals[0.5].over, 1.12, "le linee che `totals` non copre arrivano da alternate_totals");
assert.equal(teamMarkets.totals[3.5].under, 1.28);
assert.equal(teamMarkets.btts.yes, 1.80);
// "la squadra segna" è il team total sopra 0.5: prima non aveva alcun prezzo di mercato.
assert.equal(teamMarkets.teamScores.home, 1.25);
assert.equal(teamMarkets.teamScores.away, 1.70);

// I nostri nomi sono abbreviati, quelli dell'API completi: con l'uguaglianza esatta si
// agganciavano solo i mononimi, cioè quasi nessuno.
assert.equal(playerMarketPrice(index, "F. Conceição", "shot"), 1.60);
assert.equal(playerMarketPrice(index, "F. Conceição", "shots_2"), 2.75, "shots_2 è la linea 1.5 dello stesso mercato");
assert.equal(playerMarketPrice(index, "F. Conceição", "shot_on_target"), 2.30);
assert.equal(playerMarketPrice(index, "R. Kolo Muani", "goalscorer"), 3.10, "un cognome di due parole resta un cognome");
// Due fratelli nella stessa partita: l'iniziale decide, e senza iniziale utile non si tira a
// indovinare — una quota attribuita al giocatore sbagliato è peggio di una quota mancante.
assert.equal(playerMarketPrice(index, "M. Thuram", "shot"), 1.55);
assert.equal(playerMarketPrice(index, "K. Thuram", "shot"), 2.10);
assert.equal(playerMarketPrice(index, "Thuram", "shot"), null);
// "gol o assist" non ha un mercato corrispondente: nessuna quota, non una quota inventata.
assert.equal(playerMarketPrice(index, "F. Conceição", "goal_assist"), null);
assert.equal(EVENT_ODDS_REGIONS, "eu,us");

console.log("OK: quote — mercati per evento (linee, btts, team total, giocatori per cognome) e preventivo richieste");
