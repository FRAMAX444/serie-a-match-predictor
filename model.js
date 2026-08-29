const LN2 = Math.log(2);
const DAY_MS = 86400000;
const DOMESTIC_COMPETITION_IDS = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const EUROPE_COMPETITION_IDS = new Set(["ucl", "uel", "uecl"]);
const SUPPORTED_COMPETITION_IDS = new Set([...DOMESTIC_COMPETITION_IDS, ...EUROPE_COMPETITION_IDS]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const safe = (value, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
// Memoizzata perché è la funzione più chiamata del modulo: il profilo CPU di 60 previsioni
// le attribuiva il 27% del tempo totale. Costruire un Date da stringa è caro, e le date
// distinte in un dataset di quattro stagioni sono ~1500 — ogni chiamata successiva alla
// prima per la stessa data ricostruiva lo stesso oggetto da capo.
//
// L'oggetto è condiviso fra i chiamanti: nessuno lo muta (si usa solo per differenze e
// getTime()), e restituire una copia annullerebbe il guadagno. La cache è limitata dal
// numero di date distinte, quindi non cresce con il numero di previsioni.
const dateCache = new Map();
const dateAtNoon = (value) => {
  const key = String(value).slice(0, 10);
  let cached = dateCache.get(key);
  if (cached === undefined) {
    cached = new Date(`${key}T12:00:00Z`);
    dateCache.set(key, cached);
  }
  return cached;
};
const blend = (observed, baseline, reliability) => baseline + reliability * (observed - baseline);
const mean = (left, right) => Math.max(0.01, (left + right) / 2);

// --- Calibrazione dei lambda -------------------------------------------------------------
// Correzione di secondo ordine applicata ai due lambda PRIMA di costruire la matrice dei
// punteggi. Nasce da un difetto misurato, non da un'intuizione: la diagnostica
// (scripts/diagnose_calibration.mjs, 3000 gare) mostrava una curva di affidabilità più piatta
// della diagonale su entrambi i lati — quando il modello dava 74% a una vittoria esterna
// succedeva il 54% delle volte, quando dava 15% a una vittoria casalinga succedeva il 23%.
// È sovra-sicurezza: i rapporti di forza prodotti dal prodotto di potenze erano troppo
// estremi. L'errore era sull'ASIMMETRIA (chi è più forte), non sul LIVELLO (quanti gol si
// segnano in totale): il bias su Over 2.5 era già solo -0.5pp.
//
// In coordinate logaritmiche rispetto alla baseline di competizione i due effetti si separano
// esattamente, ed è per questo che la correzione agisce qui e non sulle probabilità finali:
//     sH = ln(lambdaHome / league.homeGoals)     sA = ln(lambdaAway / league.awayGoals)
//     level = (sH + sA)/2                        asymmetry = (sH - sA)/2
// Comprimendo `asymmetry` le probabilità 1X2 si avvicinano alla frequenza osservata mentre i
// gol attesi restano quelli di prima. Ricalibrare invece le tre probabilità finali (temperature
// scaling, il rimedio da manuale) avrebbe lasciato Over 2.5, BTTS e risultati esatti — che
// derivano dalla stessa matrice — incoerenti con l'1X2 mostrato loro accanto.
//
// I valori sono stimati da scripts/fit_calibration.mjs su una finestra di training e validati
// su una finestra successiva mai usata per la stima (vedi README, sezione Calibrazione).
export const DEFAULT_CALIBRATION = Object.freeze({
  // Compressione dell'asimmetria quando i dati sono di buona qualità (dataQuality ≈ 1).
  // Stimata tra 0.706 e 0.716 su tre split train/holdout diversi: il segnale di forza relativa
  // prodotto dal prodotto di potenze va preso a circa il 70% del suo valore nominale.
  asymmetryShrink: 0.71,
  // ...e quando sono scarsi (dataQuality ≈ 0): inizio stagione, squadre con poche gare, coppe
  // con avversari mai visti. Lì il segnale è più rumoroso e va compresso di più; il modello
  // interpola linearmente tra i due in base a quality.score. La ricerca senza vincoli sceglieva
  // 0 (a qualità nulla, nessuna differenziazione tra le squadre): plausibile come principio ma
  // è un'estrapolazione, perché nel dataset la qualità non scende mai vicino a zero (5°
  // percentile 0.74).
  //
  // Aggiornamento 25/08/2026, dopo la correzione dei dati di Task 1: quel 5° percentile è
  // ancora 0.743 in aggregato, ma è la media di due regimi che non si somigliano —
  //     Big Five : p05 0.995, mediana 1.000, solo lo 0.1% delle gare sotto 0.75
  //     coppe    : p05 0.597, mediana 0.935, il 13.9% delle gare sotto 0.75
  // Questo parametro è quindi INERTE sui campionati e ATTIVO su un terzo delle gare di coppa.
  // Non è codice morto e non va ritirato: ritirarlo cambierebbe in silenzio le previsioni di
  // coppa. Vedi docs/misure-riferimento.md §15.
  //
  // 0.30 è il valore vincolato dentro l'intervallo effettivamente osservato
  // e sul sottoinsieme a bassa qualità rende praticamente quanto lo 0 (log loss 1.0590 contro
  // 1.0571 su 857 gare, differenza dentro il rumore campionario).
  asymmetryShrinkLowQuality: 0.30,
  // Livello dei gol totali: moltiplicatore sul log-scostamento dalla baseline e traslazione.
  // 0.45 dice che lo scostamento dei gol TOTALI attesi dalla media di competizione va preso a
  // meno di metà: la previsione squadra-specifica sul numero di gol contiene molta meno
  // informazione di quella sul chi-vince. È lo stesso motivo per cui il mercato Over/Under è
  // notoriamente più efficiente dell'1X2. Il parametro è debolmente identificato (la ricerca lo
  // trova tra 0.32 e 0.60 secondo lo split, con log loss praticamente identico): 0.45 è il
  // centro di quell'intervallo, non un ottimo puntuale da prendere alla lettera.
  levelShrink: 0.45,
  levelShift: -0.02,
  // Residuo casa/trasferta non catturato dalle baseline di competizione (positivo = sposta
  // gol attesi verso la squadra di casa). Stimato tra 0.016 e 0.019 su tre split diversi.
  venueTilt: 0.018,
});

// Ogni valore qui è esattamente la costante che prima era scritta a mano nel corpo delle
// funzioni sotto: usare DEFAULT_HYPERPARAMETERS (il default di predictFromMatches) produce
// output identico bit per bit a prima di questo refactor. Esposti cosi' perché
// scripts/tune_hyperparameters.mjs possa cercarne una combinazione migliore contro il
// backtest, invece di lasciarli numeri magici irraggiungibili dall'esterno.
export const DEFAULT_HYPERPARAMETERS = Object.freeze({
  // Ristimato insieme ai parametri di calibrazione (era -0.07, scelto a mano). Una volta
  // corretta l'asimmetria, la ricerca libera lo porta a ~0: gran parte di quel -0.07 stava
  // compensando a mano la scarsità di pareggi che ora corregge asymmetryShrink. Non lo
  // portiamo però a zero né al +0.01 che la ricerca preferisce di un soffio: un rho positivo
  // sarebbe il contrario di quanto Dixon-Coles documenta empiricamente sui punteggi bassi, e a
  // quel livello la differenza di log loss è nella quarta cifra decimale — cioè rumore. -0.04
  // resta dalla parte teoricamente corretta e, a parità di log loss, è la scelta che lascia il
  // bias residuo sui pareggi più vicino a zero (-0.4pp contro -1.4pp con rho = 0).
  rho: -0.04,
  // Varianza del fattore di prolificità CONDIVISO fra le due squadre della stessa partita
  // (Q4). 0 = nessun fattore, cioè la Poisson indipendente di sempre: la neutralità passa da
  // un ramo separato in scoreMatrix, non da un limite numerico.
  //
  // Neutro a 0 e non a 1 come suggeriva il prompt sessione 3: la quantità naturale è la
  // VARIANZA del fattore, e un fattore di varianza nulla è un fattore assente. Parametrizzarlo
  // come un moltiplicatore neutro a 1 avrebbe richiesto una trasformazione senza significato
  // (la media del fattore è fissata a 1 dalla costruzione, non è libera).
  //
  // RESPINTO il 27/08/2026, decimo rifiuto, con soglia pre-registrata (R15). Train 2324+2425
  // monotono verso il basso su tutta la griglia (φ 0.02 -> -0.0001, φ 0.35 -> -0.0096): l'ottimo
  // è φ = 0, cioè questo valore. Holdout 2526 dello stesso segno (φ 0.12 -> -0.0017 ± 0.0008).
  //
  // La ragione non è il rumore. Il difetto che il meccanismo doveva correggere ha SEGNO OPPOSTO
  // nelle due popolazioni: nei Big Five il modello prevede troppo pochi pareggi (-1.30pp, -2.14σ),
  // nelle coppe UEFA troppi (+4.52pp, +5.76σ), stabilmente in tre stagioni. Una leva globale sul
  // tasso di pareggi è quindi un compromesso perdente, e la stessa cosa spiega il rifiuto di
  // `rho` in C1. Vedi docs/misure-riferimento.md §20.
  sharedDispersion: 0,
  eloDivisor: 1100,
  eloClamp: 0.34,
  momentumShortWeight: 0.65,
  momentumScale: 0.055,
  // Peso delle partite decise da un cartellino rosso quando alimentano le medie (Task 9).
  // 1 = nessun effetto. Il guadagno atteso è piccolo, quindi il criterio del brief è "non
  // peggiora su nessun segmento", non "migliora significativamente".
  redCardMatchWeight: 1,
  momentumClamp: 0.16,
  attackExponents: Object.freeze({ goals: 0.22, xg: 0.43, sot: 0.18, shots: 0.07, venue: 0.10 }),
  defenseExponents: Object.freeze({ goals: 0.27, xg: 0.45, sot: 0.18, shots: 0.05, venue: 0.05 }),
  restFactor: Object.freeze({
    veryShort: 0.92,
    short: 0.965,
    moderate: 0.99,
    long: 0.985,
    // Impegno europeo 2-5 giorni prima e terza partita in otto giorni: tutti neutri finché
    // non validati (vedi restFactor per la misura di direzione).
    afterEuropeAway: 1,
    afterEuropeHome: 1,
    thirdInEight: 1,
  }),
  // Non è una costante "estratta" dal codice preesistente: prima le neopromosse partivano
  // da un Elo piatto 1500 senza alcun prior. Default 0 (nessun effetto): come teamContext e
  // refereeHomeBias, è opt-in finché non validi un valore diverso da zero via backtest — un
  // numero non fittato sui dati non deve cambiare in automatico il comportamento calibrato
  // esistente. Per provarlo: hyperparameters: { newcomerEloDiscount: -65 } (o altro valore).
  newcomerEloDiscount: 0,
  // Dove sta l'ancora del prior da neopromossa: 0 = il 1500 storico, 1 = la media della lega
  // di destinazione (1520-1570 secondo il campionato, §2.3). Default 0 = comportamento
  // precedente bit per bit.
  newcomerEloAnchor: 0,
  // Quota di Elo che una squadra rientrata conserva PER OGNI stagione di assenza. 1 =
  // nessuna regressione, quindi neutro; 0.5 con due stagioni fuori conserva il 25%.
  newcomerEloRetention: 1,
  // Quota di scostamento dalla media di lega che la squadra CONSERVA al cambio di stagione
  // (vedi regressSeasonBoundaryElo per il difetto che corregge). 1 = nessun effetto, quindi
  // output identico bit per bit al comportamento precedente; la letteratura sui sistemi Elo
  // calcistici indica ~0.70. Come newcomerEloDiscount resta opt-in finché una stima su
  // 2324+2425 validata sull'holdout 2526 non lo giustifica: vedi docs/misure-riferimento.md.
  seasonEloRegression: 1,
  // Peso della freschezza di stagione dentro dataQuality (vedi il commento su dataQuality
  // per il difetto che corregge). A 0 riproduce l'output precedente bit per bit; il valore
  // in produzione è stimato sulle stagioni 2324+2425 e validato sull'holdout 2526, mai usato
  // per la stima. Vedi docs/misure-riferimento.md.
  seasonQualityWeight: 0,
  calibration: DEFAULT_CALIBRATION,
});

function mergeHyperparameters(overrides) {
  if (!overrides) return DEFAULT_HYPERPARAMETERS;
  return {
    ...DEFAULT_HYPERPARAMETERS,
    ...overrides,
    attackExponents: { ...DEFAULT_HYPERPARAMETERS.attackExponents, ...overrides.attackExponents },
    defenseExponents: { ...DEFAULT_HYPERPARAMETERS.defenseExponents, ...overrides.defenseExponents },
    restFactor: { ...DEFAULT_HYPERPARAMETERS.restFactor, ...overrides.restFactor },
    calibration: { ...DEFAULT_CALIBRATION, ...overrides.calibration },
  };
}

const LAMBDA_HOME_BOUNDS = Object.freeze([0.18, 4.1]);
const LAMBDA_AWAY_BOUNDS = Object.freeze([0.16, 3.9]);

// Vedi il commento su DEFAULT_CALIBRATION per il perché. Esportata perché
// scripts/fit_calibration.mjs stimi i parametri sugli STESSI lambda grezzi che il modello
// produce, senza reimplementare la trasformazione (una seconda copia della formula
// divergerebbe in silenzio dalla prima alla prima modifica).
export function applyCalibration(rawHome, rawAway, baselineHome, baselineAway, quality, overrides) {
  const parameters = { ...DEFAULT_CALIBRATION, ...overrides };
  const anchorHome = Math.max(0.05, safe(baselineHome, 1.42));
  const anchorAway = Math.max(0.05, safe(baselineAway, 1.18));
  const logHome = Math.log(Math.max(1e-6, rawHome) / anchorHome);
  const logAway = Math.log(Math.max(1e-6, rawAway) / anchorAway);
  const level = (logHome + logAway) / 2;
  const asymmetry = (logHome - logAway) / 2;
  const shrink = parameters.asymmetryShrinkLowQuality
    + (parameters.asymmetryShrink - parameters.asymmetryShrinkLowQuality) * clamp(safe(quality, 1), 0, 1);
  const calibratedLevel = level * parameters.levelShrink + parameters.levelShift;
  const calibratedAsymmetry = asymmetry * shrink + parameters.venueTilt;
  return {
    lambdaHome: clamp(anchorHome * Math.exp(calibratedLevel + calibratedAsymmetry), ...LAMBDA_HOME_BOUNDS),
    lambdaAway: clamp(anchorAway * Math.exp(calibratedLevel - calibratedAsymmetry), ...LAMBDA_AWAY_BOUNDS),
  };
}

export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let index = 2; index <= k; index += 1) factorial *= index;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function dixonColesTau(homeGoals, awayGoals, lambdaHome, lambdaAway, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

const LOG_FACTORIAL = (() => {
  const table = [0];
  for (let index = 1; index <= 40; index += 1) table.push(table[index - 1] + Math.log(index));
  return table;
})();
const logFactorial = (value) => LOG_FACTORIAL[value];

// Densità congiunta dei due punteggi quando un fattore moltiplicativo CONDIVISO agisce su
// entrambi i lambda della stessa partita: X|Z ~ Poisson(Z·λcasa), Y|Z ~ Poisson(Z·λtrasferta),
// con Z ~ Gamma di media 1 e varianza `sharedDispersion`. Z è la parte di prolificità della
// partita che il modello non sa prevedere — ritmo, arbitro largo, campo, nervi — e che agisce
// sulle due squadre nello STESSO verso.
//
// È un meccanismo diverso da tutto ciò che è stato respinto in tre sessioni. Non avvicina le
// due squadre (è la compressione dell'asimmetria, respinta tre volte) e non tocca solo le celle
// a punteggio basso (è `rho`, respinto in C1): rende la PARTITA più o meno prolifica nel suo
// insieme, quindi alza P(X=Y) su tutta la diagonale invece che solo in fondo.
//
// Integrando Z fuori si ottiene la binomiale negativa bivariata. In logaritmi, con k = 1/φ
// (forma della Gamma) e S = λcasa + λtrasferta:
//
//   log P(x,y) = x·log λcasa + y·log λtrasferta − log x! − log y!
//                + Σ_{i=0}^{x+y−1} log(k+i) − k·log1p(S/k) − (x+y)·log(S+k)
//
// La somma è esatta per x+y interi piccoli (qui al massimo 16), quindi non serve una funzione
// gamma e non c'è perdita di precisione per k grande: per φ → 0 i tre termini tendono a
// −λcasa − λtrasferta e si ricade sulla Poisson indipendente.
//
// Le marginali restano di media λ (E[Z] = 1): il fattore non sposta il livello dei gol
// previsti, che è calibrato altrove, e agisce solo sulla forma della congiunta.
function sharedDispersionLogPmf(homeGoals, awayGoals, lambdaHome, lambdaAway, shape) {
  const total = homeGoals + awayGoals;
  const sum = lambdaHome + lambdaAway;
  let logProbability = -logFactorial(homeGoals) - logFactorial(awayGoals);
  if (homeGoals > 0) logProbability += homeGoals * Math.log(lambdaHome);
  if (awayGoals > 0) logProbability += awayGoals * Math.log(lambdaAway);
  for (let index = 0; index < total; index += 1) logProbability += Math.log(shape + index);
  return logProbability - shape * Math.log1p(sum / shape) - total * Math.log(sum + shape);
}

export function scoreMatrix(
  lambdaHome,
  lambdaAway,
  maxGoals = 8,
  rho = DEFAULT_HYPERPARAMETERS.rho,
  sharedDispersion = DEFAULT_HYPERPARAMETERS.sharedDispersion,
) {
  // A φ = 0 si passa dal ramo Poisson di sempre, non da un limite numerico: la neutralità
  // deve essere esatta bit per bit, non approssimata (R1).
  const dispersed = Number.isFinite(sharedDispersion) && sharedDispersion > 0;
  const shape = dispersed ? 1 / sharedDispersion : Infinity;
  const matrix = [];
  let total = 0;
  for (let home = 0; home <= maxGoals; home += 1) {
    const row = [];
    for (let away = 0; away <= maxGoals; away += 1) {
      const joint = dispersed
        ? Math.exp(sharedDispersionLogPmf(home, away, lambdaHome, lambdaAway, shape))
        : poissonPmf(home, lambdaHome) * poissonPmf(away, lambdaAway);
      const probability = Math.max(0, joint * dixonColesTau(home, away, lambdaHome, lambdaAway, rho));
      row.push(probability);
      total += probability;
    }
    matrix.push(row);
  }
  return matrix.map((row) => row.map((value) => value / total));
}

export function matrixProbabilities(matrix) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let bothScore = 0;
  const scores = [];
  matrix.forEach((row, home) => row.forEach((probability, away) => {
    if (home > away) homeWin += probability;
    else if (home === away) draw += probability;
    else awayWin += probability;
    if (home + away >= 3) over25 += probability;
    if (home > 0 && away > 0) bothScore += probability;
    scores.push({ home, away, probability });
  }));
  scores.sort((left, right) => right.probability - left.probability);
  return { homeWin, draw, awayWin, over25, bothScore, scores };
}

// Tutti i mercati che si possono leggere dalla stessa matrice dei punteggi, con la stessa
// coerenza interna dell'1X2: doppie chance, over/under, gol/no gol, squadra segna. Derivarli
// qui — una sola volta, dalla matrice — invece che ricalcolarli in schedina.js garantisce che
// non possano contraddirsi tra loro (P(1X) = P(1) + P(X) per costruzione, non per convenzione)
// e che una modifica al modello li aggiorni tutti insieme.
//
// `probability` è la probabilità dell'esito; `fairOdds` la quota equa corrispondente (1/p), che
// è la quota alla quale la scommessa avrebbe valore atteso nullo. Non è una quota di mercato e
// non va mai mostrata come tale.
export function deriveMarkets(probabilities) {
  const { homeWin, draw, awayWin, scores } = probabilities;
  const totalAtLeast = (goals) => scores.reduce(
    (sum, score) => sum + (score.home + score.away >= goals ? score.probability : 0),
    0,
  );
  const homeScores = scores.reduce((sum, score) => sum + (score.home > 0 ? score.probability : 0), 0);
  const awayScores = scores.reduce((sum, score) => sum + (score.away > 0 ? score.probability : 0), 0);
  const bothScore = probabilities.bothScore;

  const entries = [
    { key: "1", label: "1 (casa)", group: "1X2", probability: homeWin },
    { key: "X", label: "X (pareggio)", group: "1X2", probability: draw },
    { key: "2", label: "2 (trasferta)", group: "1X2", probability: awayWin },
    { key: "1X", label: "1X (casa o pareggio)", group: "doppia", probability: homeWin + draw },
    { key: "12", label: "12 (nessun pareggio)", group: "doppia", probability: homeWin + awayWin },
    { key: "X2", label: "X2 (pareggio o trasferta)", group: "doppia", probability: draw + awayWin },
    { key: "OVER05", label: "Over 0.5", group: "gol", probability: totalAtLeast(1) },
    { key: "OVER15", label: "Over 1.5", group: "gol", probability: totalAtLeast(2) },
    { key: "OVER25", label: "Over 2.5", group: "gol", probability: totalAtLeast(3) },
    { key: "OVER35", label: "Over 3.5", group: "gol", probability: totalAtLeast(4) },
    { key: "UNDER15", label: "Under 1.5", group: "gol", probability: 1 - totalAtLeast(2) },
    { key: "UNDER25", label: "Under 2.5", group: "gol", probability: 1 - totalAtLeast(3) },
    { key: "UNDER35", label: "Under 3.5", group: "gol", probability: 1 - totalAtLeast(4) },
    { key: "GG", label: "Gol (entrambe segnano)", group: "gol", probability: bothScore },
    { key: "NG", label: "No gol", group: "gol", probability: 1 - bothScore },
    { key: "HOME_SCORES", label: "Casa segna", group: "squadra", probability: homeScores },
    { key: "AWAY_SCORES", label: "Trasferta segna", group: "squadra", probability: awayScores },
  ];
  return entries.map((entry) => ({
    ...entry,
    probability: clamp(entry.probability, 0, 1),
    fairOdds: entry.probability > 1e-6 ? 1 / entry.probability : Infinity,
  }));
}

function xgValue(match, side) {
  const explicit = safe(match[`${side}_xg`], NaN);
  if (Number.isFinite(explicit)) return { value: explicit, actual: true };

  const shots = safe(match[`${side}_shots`], NaN);
  const shotsOnTarget = safe(match[`${side}_sot`], NaN);
  if (Number.isFinite(shots) && Number.isFinite(shotsOnTarget)) {
    return {
      value: clamp(0.16 + 0.026 * shots + 0.19 * shotsOnTarget, 0.3, 3.8),
      actual: false,
    };
  }
  if (Number.isFinite(shots)) {
    // Calibrated on the supplied 949-match benchmark when only total shots are available.
    return { value: clamp(0.056 + 0.111 * shots, 0.3, 3.8), actual: false };
  }
  if (Number.isFinite(shotsOnTarget)) {
    return { value: clamp(0.446 + 0.19 * shotsOnTarget, 0.3, 3.8), actual: false };
  }
  return { value: clamp(0.9 + 0.22 * safe(match[`${side}_goals`], 1.2), 0.4, 3.2), actual: false };
}

function weightedAverageByDate(records, key, fallback, predictionDate, halfLifeDays, maxRecords) {
  const selected = records
    .slice(-maxRecords)
    .filter((record) => Number.isFinite(record[key]));
  if (!selected.length) return fallback;

  let numerator = 0;
  let denominator = 0;
  selected.forEach((record) => {
    const ageDays = Math.max(0, (predictionDate - dateAtNoon(record.date)) / DAY_MS);
    // `record.weight` vale 1 salvo che la partita sia stata falsata da un cartellino rosso
    // (vedi applyMatch). Moltiplicare per 1 è esatto in virgola mobile, quindi finché
    // redCardMatchWeight resta 1 questa media è identica bit per bit a prima.
    const weight = Math.exp(-LN2 * ageDays / halfLifeDays) * (record.weight === undefined ? 1 : record.weight);
    numerator += record[key] * weight;
    denominator += weight;
  });
  return denominator > 0 ? numerator / denominator : fallback;
}

function emptyState(initialElo = 1500) {
  return {
    elo: initialElo,
    baselineElo: initialElo,
    matches: [],
    homeMatches: [],
    awayMatches: [],
    lastDate: null,
    // Ultima stagione vista e forza dell'ultima LEGA domestica in cui la squadra ha giocato:
    // servono a regressSeasonBoundaryElo(). La forza di lega va presa dalle gare domestiche
    // e non da quelle di coppa, che portano tutte league_strength 1500: regredire verso 1500
    // una squadra di Premier al cambio stagione perché la sua prima gara nuova è un turno
    // preliminare significherebbe puntare all'ancora sbagliata.
    lastSeason: "",
    leagueStrength: initialElo,
  };
}

function decayInactiveElo(state, matchDate) {
  if (!state.lastDate) return;
  const gapDays = Math.max(0, (dateAtNoon(matchDate) - dateAtNoon(state.lastDate)) / DAY_MS);
  if (gapDays <= 45) return;
  const retention = Math.exp(-(gapDays - 45) / 900);
  state.elo = state.baselineElo + (state.elo - state.baselineElo) * retention;
}

// Il secondo dei due fenomeni che prima decayInactiveElo() copriva da solo, e che con esso
// non ha nulla in comune.
//
// Il difetto misurato (§2.3 del brief): la pausa estiva dura ~95 giorni, quindi
// retention = exp(-(95-45)/900) = 0.946 e una squadra a 1700 riapre a 1689 — il 5.4% di
// regressione, contro il 20-35% verso la media di lega che è la pratica consolidata nei
// sistemi Elo calcistici. E regredisce verso baselineElo, che vale 1500, mentre le medie di
// lega vere stanno fra 1520 e 1570 (campo league_strength): l'ancora è sbagliata sia in
// ampiezza sia in destinazione.
//
// Due scelte di progetto, entrambe vincolate dai dati e non dall'eleganza:
//
// · il confine si rileva dal campo `season`, non da "sono passati N giorni". Una regola per
//   giorni non sa distinguere la sosta invernale (~20 giorni in Serie A, ~30 in Bundesliga)
//   dal cambio stagione, e soprattutto sbaglia sulle squadre impegnate nei preliminari di
//   coppa a fine giugno, che giocano la stagione nuova senza che sia passata nessuna pausa;
//
// · la destinazione è la media della lega in cui la squadra gioca ORA, non quella in cui
//   giocava prima. Una promossa deve regredire verso la media della lega di destinazione,
//   che è il caso in cui il valore dell'ancora conta di più.
//
// Composizione con il decadimento per inattività: al confine estivo scattano entrambi, e
// puntano ad ancore diverse (baselineElo il primo, media di lega il secondo). È voluto e va
// letto così: `seasonEloRegression` misura la regressione AGGIUNTIVA rispetto a quella che
// il decadimento produce già. Su una squadra a 1700 in una lega da 1550, con k = 0.7:
// 1500 + 200·0.946 = 1689.2, poi 1550 + 139.2·0.7 = 1647.4, cioè il 26% totale — dentro
// l'intervallo 20-35% della letteratura. A k = 1 il secondo passo è l'identità e il
// comportamento resta identico bit per bit a prima di questa modifica (R1).
function regressSeasonBoundaryElo(state, season, leagueMean, factor) {
  if (!season || !state.lastSeason || season === state.lastSeason) return;
  if (factor === 1) return;
  const anchor = safe(leagueMean, state.baselineElo);
  state.elo = anchor + (state.elo - anchor) * clamp(safe(factor, 1), 0, 1);
}

// Chi, in questa competizione e in questa stagione, NON c'era nella stagione precedente.
//
// La definizione precedente era "prima apparizione nell'intero dataset", e sbagliava per
// costruzione su ogni squadra rientrata: il Frosinone era in Serie A nel 2324, quindi è nel
// dataset, quindi non risultava mai neopromosso — qualunque valore avesse
// newcomerEloDiscount. Misura di §2.4 del brief, riprodotta: con lo sconto a -65 la variante
// cambiava qualcosa in 87 gare su 768, e quasi tutte nella fascia 20+ invece che a inizio
// stagione. Il gancio esisteva, era documentato, era testato, ed era inerte.
//
// La definizione corretta usa due campi che ogni partita porta già, competition_id e season,
// e distingue tre casi con conseguenze diverse:
//   · seasonsAway = 1        rientrata dopo una stagione (Monza, Venezia in ita.1 2627);
//   · seasonsAway = 2, 3...  rientrata dopo più stagioni: l'Elo esiste ma è vecchio di anni
//                            (Frosinone, fuori dal 2324) — e decayInactiveElo() dopo 800
//                            giorni lascia ancora il 43% dello scostamento, quindi da sola
//                            non lo tratta come stale;
//   · seasonsAway = Infinity mai vista in questa competizione: nessun Elo da conservare.
//
// Ritorna una Map perché il numero di stagioni di assenza serve al chiamante: "assente" e
// "assente da tre anni" richiedono regressioni diverse, e collassarle in un Set le
// confonderebbe.
export function competitionNewcomers(matches, competitionId, season) {
  const target = String(season);
  const seasonsByTeam = new Map();
  const knownSeasons = new Set();
  for (const match of matches) {
    if (String(match.competition_id) !== String(competitionId)) continue;
    const matchSeason = String(match.season || "");
    if (!matchSeason) continue;
    knownSeasons.add(matchSeason);
    for (const team of [match.home_team, match.away_team]) {
      if (!team) continue;
      const seen = seasonsByTeam.get(team) || new Set();
      seen.add(matchSeason);
      seasonsByTeam.set(team, seen);
    }
  }
  // Le etichette di stagione ("2324", "2425", ...) si ordinano lessicograficamente nello
  // stesso ordine cronologico, quindi contare le stagioni di assenza è contare le posizioni
  // in questa lista — e non serve interpretare l'etichetta come intervallo di date.
  const ordered = [...knownSeasons].sort();
  const targetIndex = ordered.indexOf(target);
  const newcomers = new Map();
  if (targetIndex <= 0) return newcomers; // nessuna stagione precedente da confrontare
  const previous = ordered[targetIndex - 1];
  for (const [team, seen] of seasonsByTeam) {
    if (!seen.has(target) || seen.has(previous)) continue;
    // Stagioni SALTATE, non distanza fra le due apparizioni: chi rientra dopo un anno di
    // assenza ha seasonsAway = 1, chi rientra dopo due ne ha 2. Una squadra continua avrebbe
    // 0 ed è già esclusa sopra, quindi qui il valore è sempre >= 1.
    let seasonsAway = Infinity;
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      if (seen.has(ordered[index])) {
        seasonsAway = targetIndex - index - 1;
        break;
      }
    }
    newcomers.set(team, { seasonsAway });
  }
  return newcomers;
}

// Stessa definizione di competitionNewcomers(), ma per TUTTE le coppie (competizione,
// stagione) in una sola passata sull'array. competitionNewcomers() rifatta per ogni coppia
// costerebbe ~30 passate a ogni chiamata di predictFromMatches, cioè ~250k operazioni per
// previsione: in un backtest da 3500 gare diventa il termine dominante del tempo di calcolo.
const newcomerIndex = memoizeByMatches((matches) => {
  const seenByTeam = new Map();      // "comp|team" -> Set(stagioni)
  const seasonsByCompetition = new Map(); // comp -> Set(stagioni)
  for (const match of matches) {
    const competition = String(match.competition_id || "");
    const season = String(match.season || "");
    if (!competition || !season) continue;
    const seasons = seasonsByCompetition.get(competition) || new Set();
    seasons.add(season);
    seasonsByCompetition.set(competition, seasons);
    for (const team of [match.home_team, match.away_team]) {
      if (!team) continue;
      const key = `${competition}|${team}`;
      const seen = seenByTeam.get(key) || new Set();
      seen.add(season);
      seenByTeam.set(key, seen);
    }
  }
  const index = new Map(); // "comp|season|team" -> seasonsAway
  const orderedByCompetition = new Map();
  for (const [competition, seasons] of seasonsByCompetition) {
    orderedByCompetition.set(competition, [...seasons].sort());
  }
  for (const [key, seen] of seenByTeam) {
    const separator = key.indexOf("|");
    const competition = key.slice(0, separator);
    const team = key.slice(separator + 1);
    const ordered = orderedByCompetition.get(competition) || [];
    for (let position = 1; position < ordered.length; position += 1) {
      const season = ordered[position];
      if (!seen.has(season) || seen.has(ordered[position - 1])) continue;
      let seasonsAway = Infinity;
      for (let back = position - 1; back >= 0; back -= 1) {
        if (seen.has(ordered[back])) {
          seasonsAway = position - back - 1;
          break;
        }
      }
      index.set(`${competition}|${season}|${team}`, seasonsAway);
    }
  }
  return index;
});

// Prior di Elo per una squadra che entra in una competizione dopo un'assenza.
//
// Tre gradi di libertà, tutti neutri di default, perché sono tre domande distinte e il brief
// (§7) mette in guardia dal rispondere a domande distinte con un parametro solo:
//   · dove sta l'ancora  -> newcomerEloAnchor, 0 = il 1500 storico, 1 = la media della lega
//     di destinazione. §2.3 misura che quelle medie valgono 1520-1570, quindi 1500 non è
//     "la media": in Ligue 1 è 20 punti sotto, in Premier 70;
//   · quanto sotto l'ancora -> newcomerEloDiscount, invariato;
//   · quanto della propria storia una rientrata conserva -> newcomerEloRetention, elevato
//     alle stagioni di assenza. Una squadra fuori due anni conserva retention^2, che è il
//     modo naturale di dire "ogni stagione di assenza rende l'Elo più vecchio della stessa
//     frazione". A retention = 1 vale 1 per qualunque esponente, Infinity compreso
//     (Math.pow(1, Infinity) === 1), quindi la neutralità regge anche per chi non ha storia.
// `newcomerEloDiscount` accetta un numero (uguale per tutte le leghe) oppure un oggetto
// indicizzato per competizione. La seconda forma serve perché le stime per lega, misurate
// sulle 14 neopromosse della stagione 2425, vanno da -117 a -151 dopo lo shrinkage verso il
// valore comune -128 — e stimarle indipendentemente su 2-3 squadre per lega sarebbe
// overfitting garantito, mentre ignorare del tutto la differenza fra Premier (-151) e Serie A
// (-117) butta via l'unica struttura che i dati mostrano.
function newcomerDiscountFor(hyperparameters, competitionId) {
  const value = hyperparameters.newcomerEloDiscount;
  if (value && typeof value === "object") {
    return safe(value[competitionId], safe(value.default, 0));
  }
  return safe(value, 0);
}

function newcomerAnchor(leagueMean, hyperparameters, competitionId) {
  const weight = clamp(safe(hyperparameters.newcomerEloAnchor, 0), 0, 1);
  return 1500 + weight * (safe(leagueMean, 1500) - 1500) + newcomerDiscountFor(hyperparameters, competitionId);
}

function applyNewcomerPrior(state, seasonsAway, leagueMean, hyperparameters, competitionId) {
  if (seasonsAway === undefined || seasonsAway === null) return;
  const retention = clamp(safe(hyperparameters.newcomerEloRetention, 1), 0, 1);
  const anchor = newcomerAnchor(leagueMean, hyperparameters, competitionId);
  const kept = Math.pow(retention, seasonsAway);
  // A ritenzione piena la formula è l'identità in algebra ma non in virgola mobile:
  // (x - a) + a non torna x bit per bit. L'uscita anticipata rende la neutralità di R1
  // esatta invece che "entro epsilon", e non è una scorciatoia — con kept = 1 la squadra
  // conserva tutto il proprio scostamento dall'ancora, quindi dove sia l'ancora non conta.
  if (kept === 1) return;
  state.elo = anchor + (state.elo - anchor) * kept;
}

function applyMatch(states, match, crossCompetition = false, hyperparameters = DEFAULT_HYPERPARAMETERS, newcomers = null) {
  const leagueBaseline = safe(match.league_strength, 1500);
  const newcomerKey = `${String(match.competition_id || "")}|${String(match.season || "")}|`;
  const homeAway = newcomers?.get(`${newcomerKey}${match.home_team}`);
  const awayAway = newcomers?.get(`${newcomerKey}${match.away_team}`);
  const homeIsNewcomer = !crossCompetition && homeAway !== undefined && !states.has(match.home_team);
  const awayIsNewcomer = !crossCompetition && awayAway !== undefined && !states.has(match.away_team);
  const homeInitialElo = crossCompetition ? leagueBaseline : (homeIsNewcomer ? newcomerAnchor(leagueBaseline, hyperparameters, String(match.competition_id || "")) : 1500);
  const awayInitialElo = crossCompetition ? leagueBaseline : (awayIsNewcomer ? newcomerAnchor(leagueBaseline, hyperparameters, String(match.competition_id || "")) : 1500);
  const homeState = states.get(match.home_team) || emptyState(homeInitialElo);
  const awayState = states.get(match.away_team) || emptyState(awayInitialElo);
  states.set(match.home_team, homeState);
  states.set(match.away_team, awayState);

  decayInactiveElo(homeState, match.date);
  decayInactiveElo(awayState, match.date);

  // La forza di lega da usare come ancora è quella della competizione domestica: le gare di
  // coppa portano tutte league_strength 1500 e falserebbero la destinazione.
  const matchSeason = String(match.season || "");
  const isDomesticRow = !EUROPE_COMPETITION_IDS.has(String(match.competition_id))
    && String(match.competition_type || "").toLowerCase() !== "europe";
  regressSeasonBoundaryElo(homeState, matchSeason, isDomesticRow ? leagueBaseline : homeState.leagueStrength, hyperparameters.seasonEloRegression);
  regressSeasonBoundaryElo(awayState, matchSeason, isDomesticRow ? leagueBaseline : awayState.leagueStrength, hyperparameters.seasonEloRegression);
  // Il prior da neopromossa al CONFINE di stagione, non solo al cold start: una squadra
  // rientrata dopo un anno ha già uno stato — con l'Elo di due stagioni fa — quindi la
  // condizione `!states.has(team)` da sola non la intercetterebbe mai. È la seconda metà del
  // difetto di §2.4, quella che una definizione corretta da sola non basta a chiudere.
  if (!crossCompetition && matchSeason && homeState.lastSeason && homeState.lastSeason !== matchSeason) {
    applyNewcomerPrior(homeState, homeAway, leagueBaseline, hyperparameters, String(match.competition_id || ""));
  }
  if (!crossCompetition && matchSeason && awayState.lastSeason && awayState.lastSeason !== matchSeason) {
    applyNewcomerPrior(awayState, awayAway, leagueBaseline, hyperparameters, String(match.competition_id || ""));
  }
  if (matchSeason) {
    homeState.lastSeason = matchSeason;
    awayState.lastSeason = matchSeason;
  }
  if (isDomesticRow) {
    homeState.leagueStrength = leagueBaseline;
    awayState.leagueStrength = leagueBaseline;
  }

  const homeGoals = safe(match.home_goals);
  const awayGoals = safe(match.away_goals);
  const homeXg = xgValue(match, "home");
  const awayXg = xgValue(match, "away");
  // `season` serve a dataQuality per sapere quale parte delle medie viene dalla stagione
  // in corso e quale attraversa la pausa estiva. Va presa dal campo del dataset e non
  // dedotta dalla data: una regola per mesi confonde le qualificazioni di coppa di fine
  // giugno, che appartengono alla stagione successiva, con la coda di quella precedente.
  const common = { date: match.date, competitionId: match.competition_id || "", season: String(match.season || "") };

  const homeRecord = {
    ...common,
    points: homeGoals > awayGoals ? 3 : homeGoals === awayGoals ? 1 : 0,
    gf: homeGoals,
    ga: awayGoals,
    xgFor: homeXg.value,
    xgAgainst: awayXg.value,
    shots: safe(match.home_shots, 11),
    shotsAgainst: safe(match.away_shots, 10.5),
    sot: safe(match.home_sot, 3.8),
    sotAgainst: safe(match.away_sot, 3.6),
    xgActual: homeXg.actual,
  };
  const awayRecord = {
    ...common,
    points: awayGoals > homeGoals ? 3 : homeGoals === awayGoals ? 1 : 0,
    gf: awayGoals,
    ga: homeGoals,
    xgFor: awayXg.value,
    xgAgainst: homeXg.value,
    shots: safe(match.away_shots, 10.5),
    shotsAgainst: safe(match.home_shots, 11),
    sot: safe(match.away_sot, 3.6),
    sotAgainst: safe(match.home_sot, 3.8),
    xgActual: awayXg.actual,
  };

  // Rossi: una squadra rimasta in dieci produce dati che non descrivono il suo livello, e
  // nemmeno quelli dell'avversaria, che gioca il resto della partita in superiorità. Il
  // dataset ha i cartellini rossi al 100% dopo la correzione della pipeline (era il 64.1%),
  // ma NON il minuto: non si può quindi distinguere un rosso al 20' da uno al 90'+3, e
  // l'unica cosa onesta è pesare meno l'intera partita invece di inventare una soglia.
  // Nessun parametro libero oltre il peso stesso, che a 1 è neutro. Riguarda il 16.5% delle
  // gare (875 su 5295).
  const matchWeight = (safe(match.home_red, 0) + safe(match.away_red, 0)) > 0
    ? clamp(safe(hyperparameters.redCardMatchWeight, 1), 0, 1)
    : 1;
  if (matchWeight !== 1) {
    homeRecord.weight = matchWeight;
    awayRecord.weight = matchWeight;
  }

  homeState.matches.push(homeRecord);
  homeState.homeMatches.push(homeRecord);
  awayState.matches.push(awayRecord);
  awayState.awayMatches.push(awayRecord);
  homeState.matches = homeState.matches.slice(-40);
  awayState.matches = awayState.matches.slice(-40);
  homeState.homeMatches = homeState.homeMatches.slice(-20);
  awayState.awayMatches = awayState.awayMatches.slice(-20);

  const isEuropeanMatch = EUROPE_COMPETITION_IDS.has(String(match.competition_id))
    || String(match.competition_type || "").toLowerCase() === "europe";
  const homeAdvantage = crossCompetition && isEuropeanMatch ? 38 : 48;
  const expectedHome = 1 / (1 + Math.pow(10, (awayState.elo - (homeState.elo + homeAdvantage)) / 400));
  const resultPerformance = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const xgPerformance = 1 / (1 + Math.exp(-1.15 * (homeXg.value - awayXg.value)));
  const actualHome = homeXg.actual && awayXg.actual
    ? 0.55 * resultPerformance + 0.45 * xgPerformance
    : resultPerformance;
  // Residui di rendimento: quanto la squadra ha reso IN PIÙ o IN MENO rispetto a ciò che il
  // suo livello faceva attendere in quella partita. `expectedHome` è la logistica sulla
  // differenza di Elo calcolata PRIMA dell'aggiornamento, quindi è una previsione vera e non
  // c'è circolarità.
  //
  // Sono la materia prima di una forma ortogonale al livello (§2.5 del brief: il momentum
  // attuale, costruito sui punti assoluti, è correlato 0.75 con la differenza di Elo, quindi
  // il modello conta la forza due volte). Un residuo, per costruzione, ha media zero per una
  // squadra che rende come il suo Elo dice: l'Inter a 2.1 punti a partita non è
  // "permanentemente in forma", è semplicemente forte.
  //
  // Il residuo della squadra in trasferta è l'opposto esatto di quello di casa: è una
  // partita sola e ciò che uno prende in più l'altro lo prende in meno.
  const resultResidual = resultPerformance - expectedHome;
  const xgResidual = xgPerformance - expectedHome;
  homeRecord.resultResidual = resultResidual;
  awayRecord.resultResidual = -resultResidual;
  homeRecord.xgResidual = xgResidual;
  awayRecord.xgResidual = -xgResidual;

  const margin = Math.min(1.75, 1 + 0.13 * Math.abs(homeGoals - awayGoals));
  const importance = crossCompetition ? clamp(safe(match.importance, isEuropeanMatch ? 1.16 : 1), 0.8, 1.3) : 1;
  const k = crossCompetition ? (isEuropeanMatch ? 21 : 17) * importance : 18;
  const delta = k * margin * (actualHome - expectedHome);
  homeState.elo += delta;
  awayState.elo -= delta;
  homeState.lastDate = match.date;
  awayState.lastDate = match.date;
}

// Quale stagione è "in corso" alla data della previsione, letta dal calendario del dataset
// invece che da una regola sui mesi.
//
// La tolleranza in avanti serve al caso normale: si prevede la prossima partita, quindi la
// data cade DOPO l'ultima gara registrata della stagione. Senza tolleranza ogni previsione
// del turno successivo risulterebbe "fuori stagione". Con 45 giorni — la stessa soglia che
// decayInactiveElo usa già per distinguere inattività da calendario — la sosta invernale
// (~20 giorni in Serie A, ~30 in Bundesliga) resta dentro la stagione, mentre la pausa
// estiva (~95 giorni) no. È il caso che conta: alla prima giornata nessuna gara della nuova
// stagione è ancora nel dataset, la data supera di oltre 45 giorni l'ultima della stagione
// precedente, e la funzione risponde correttamente "nessuna" — cioè: nulla di ciò che il
// modello ha in mano appartiene alla stagione che sta per cominciare.
// Le tre strutture che seguono (confini di stagione, indice delle neopromosse, calendario
// per squadra) dipendono SOLO dall'array `matches` e non dalla partita che si sta prevedendo.
// Ricalcolarle a ogni chiamata costava una passata completa sulle 8403 righe per previsione:
// nel backtest da 1000 gare il tempo era passato da ~40 secondi a quasi quattro minuti. La
// memoizzazione le calcola una volta per array.
//
// La chiave è l'identità dell'array (WeakMap, quindi niente perdite di memoria) più la sua
// lunghezza: se un chiamante aggiunge partite, la lunghezza cambia e la cache si invalida da
// sola. È la sola mutazione plausibile in questo codice — i campi usati (date, season,
// competition_id, squadre) non vengono mai riscritti in corsa.
function memoizeByMatches(compute) {
  const cache = new WeakMap();
  return (matches, ...rest) => {
    const entry = cache.get(matches);
    if (entry && entry.length === matches.length) return entry.value;
    const value = compute(matches, ...rest);
    cache.set(matches, { length: matches.length, value });
    return value;
  };
}

const SEASON_FORWARD_TOLERANCE_DAYS = 45;

// Etichetta per "stagione nuova, di cui il dataset non contiene ancora nessuna partita".
// Serve a distinguerla dal caso "non lo so", che è una risposta diversa e produrrebbe la
// decisione opposta: alla prima giornata assoluta di una stagione — quando ancora nessun
// risultato nuovo è stato registrato — il modello deve sapere che la stagione È cambiata,
// altrimenti la regressione dell'Elo di confine non si applica proprio nel momento in cui
// serve. La stringa non coincide con nessuna etichetta di stagione reale, quindi come
// stagione "corrente" non aggancia nessun record: la freschezza vale 0 e il confine risulta
// attraversato, che è esattamente ciò che vale in quel momento.
const SEASON_NOT_YET_RECORDED = "\u0000nuova";

const seasonBounds = memoizeByMatches((matches) => {
  const bounds = new Map();
  for (const match of matches) {
    const season = String(match.season || "");
    if (!season) continue;
    const date = String(match.date).slice(0, 10);
    const current = bounds.get(season);
    if (!current) bounds.set(season, { first: date, last: date });
    else {
      if (date < current.first) current.first = date;
      if (date > current.last) current.last = date;
    }
  }
  return bounds;
});

function resolveCurrentSeason(matches, predictionDate) {
  const bounds = seasonBounds(matches);
  if (!bounds.size) return "";
  const target = predictionDate.toISOString().slice(0, 10);
  let best = "";
  let bestLast = "";
  let latestEnd = "";
  for (const [season, range] of bounds) {
    if (target >= range.first && target <= range.last) return season;
    if (range.last > latestEnd) latestEnd = range.last;
    if (target > range.last) {
      const gapDays = (dateAtNoon(target) - dateAtNoon(range.last)) / DAY_MS;
      if (gapDays <= SEASON_FORWARD_TOLERANCE_DAYS && range.last > bestLast) {
        best = season;
        bestLast = range.last;
      }
    }
  }
  if (best) return best;
  // Oltre l'ultima stagione registrata e oltre la tolleranza: è una stagione nuova che il
  // dataset non ha ancora. Prima di ogni altra stagione registrata: idem, il dataset comincia
  // dopo. In entrambi i casi nulla di ciò che il modello ha in mano appartiene alla stagione
  // corrente, ed è un'informazione, non un'incertezza.
  return target > latestEnd ? SEASON_NOT_YET_RECORDED : "";
}

// Quota della MASSA DI PESO delle medie che proviene dalla stagione in corso, con la stessa
// half-life e la stessa profondità dei termini che costruiscono metà del lambda (gf5,
// xgFor5, shots5, sot5: 70 giorni, ultime 16 gare). Non è il numero di partite giocate ma il
// peso che quelle partite hanno davvero nelle medie, che è la quantità di cui dataQuality ha
// bisogno: alla 2ª giornata una sola gara nuova pesa poco contro quindici della stagione
// scorsa ancora al 39% ciascuna, e contare le partite direbbe 1/16 invece del ~20% vero.
function seasonWeightShare(records, predictionDate, currentSeason, halfLifeDays, maxRecords) {
  if (!currentSeason) return 0;
  const selected = records.slice(-maxRecords);
  let currentWeight = 0;
  let totalWeight = 0;
  for (const record of selected) {
    const ageDays = Math.max(0, (predictionDate - dateAtNoon(record.date)) / DAY_MS);
    const weight = Math.exp(-LN2 * ageDays / halfLifeDays);
    totalWeight += weight;
    if (record.season === currentSeason) currentWeight += weight;
  }
  return totalWeight > 0 ? currentWeight / totalWeight : 0;
}

// `seasonContext` raccoglie tutto ciò che riguarda il confine di stagione: sono quattro
// parametri che viaggiano sempre insieme e che da soli renderebbero la firma illeggibile.
function stateMetrics(state, venue, predictionDate, seasonContext = {}) {
  const {
    currentSeason = "",
    leagueMean = null,
    seasonEloRegression = 1,
    newcomerSeasonsAway,
    trueRestDays,
    hyperparameters = DEFAULT_HYPERPARAMETERS,
  } = seasonContext;
  const venueMatches = venue === "home" ? state.homeMatches : state.awayMatches;
  const recentTen = state.matches.slice(-10);
  const sampleReliability = clamp(1 - Math.exp(-state.matches.length / 6.5), 0, 1);
  // Riposo REALE, coppe incluse. Per una previsione domestica `state.lastDate` è la data
  // dell'ultima partita DI CAMPIONATO, perché chronological è filtrato: una squadra che ha
  // giocato in Champions il mercoledì risulterebbe riposata da sette giorni invece che da
  // tre. Misurato sul dataset: il riposo creduto supera quello vero di 5.1 giorni in media
  // per chi ha giocato in coppa 2-5 giorni prima, 6.0 dopo una trasferta europea.
  //
  // È una correzione del CALENDARIO, non della storia sportiva: Elo e medie continuano a
  // costruirsi sulle sole competizioni pertinenti, come prima. Cambia solo "quando questa
  // squadra ha giocato l'ultima volta", che è un fatto e non un'ipotesi.
  const domesticRestDays = state.lastDate ? Math.max(1, Math.round((predictionDate - dateAtNoon(state.lastDate)) / DAY_MS)) : 8;
  const restDays = Number.isFinite(trueRestDays)
    ? Math.max(1, Math.min(domesticRestDays, Math.round(trueRestDays)))
    : domesticRestDays;
  const eloRetention = restDays <= 45 ? 1 : Math.exp(-(restDays - 45) / 900);
  const decayedElo = state.baselineElo + (state.elo - state.baselineElo) * eloRetention;
  // Stessa dualità che il codice ha già fra decayInactiveElo() (applicato quando la partita
  // entra nello stato) ed eloRetention qui (applicato quando si guarda avanti alla data
  // della previsione): la regressione di confine va rifatta anche in avanti, altrimenti alla
  // PRIMA giornata di una stagione nuova non si applicherebbe mai — nessuna gara di quella
  // stagione è ancora nello stato, quindi applyMatch() non ha ancora visto nessun confine.
  // È esattamente il momento in cui serve di più.
  // Stessa dualità di sopra, applicata ai due effetti di confine: se la stagione corrente
  // non è quella dell'ultima partita vista, il confine non è ancora passato per applyMatch()
  // e va attraversato qui. Vale per la regressione di confine (Task 3) e per il prior da
  // neopromossa (Task 4), nell'ordine in cui applyMatch() li applica — prima la regressione
  // generale, poi il prior specifico, così che il secondo veda l'Elo già regredito e i due
  // non si scavalchino a seconda di dove vengono valutati.
  const crossesBoundary = Boolean(currentSeason) && Boolean(state.lastSeason) && currentSeason !== state.lastSeason;
  let currentElo = decayedElo;
  if (crossesBoundary && seasonEloRegression !== 1) {
    const anchor = safe(leagueMean, state.baselineElo);
    currentElo = anchor + (currentElo - anchor) * clamp(safe(seasonEloRegression, 1), 0, 1);
  }
  if (crossesBoundary && newcomerSeasonsAway !== undefined) {
    const kept = Math.pow(clamp(safe(hyperparameters.newcomerEloRetention, 1), 0, 1), newcomerSeasonsAway);
    if (kept !== 1) {
      const anchor = newcomerAnchor(leagueMean, hyperparameters, seasonContext.competitionId || "");
      currentElo = anchor + (currentElo - anchor) * kept;
    }
  }
  return {
    // Residui di rendimento, esposti come DIAGNOSTICA e non usati nel lambda.
    //
    // Servono a scripts/diag_form_orthogonality.mjs, che misura quanto il termine di forma
    // duplichi l'Elo. La misura, su 590 gare di Serie A:
    //
    //   momentum in punti assoluti   sd 0.890   corr con Elo 0.743   corr con l'esito 0.323
    //   residuo sul risultato        sd 0.211   corr con Elo 0.311   corr con l'esito 0.126
    //   residuo sugli xG             sd 0.093   corr con Elo 0.139   corr con l'esito 0.120
    //   blend 50/50                  sd 0.177   corr con Elo 0.267   corr con l'esito 0.146
    //
    // Sostituire il momentum in punti con il blend ortogonale è stato implementato e
    // MISURATO: peggiora, in modo monotono nel peso e significativamente fuori campione
    // (holdout 2526: -0.0011 a peso 0.5, -0.0025 a peso 1.0, IC che escludono lo zero).
    // La terza colonna spiega perché: il momentum in punti correla con l'esito 0.323, il
    // blend ortogonale 0.146. Renderlo ortogonale all'Elo gli ha tolto più segnale di quanta
    // ridondanza gli abbia tolto — le due misure non sono una copia l'una dell'altra, sono
    // la stessa quantità con rumore indipendente, e mediarle è ciò che conviene fare.
    //
    // Non riattivare senza evidenza nuova: è uno dei cinque meccanismi che scontano la forza
    // ereditata e peggiorano tutti (vedi docs/misure-riferimento.md).
    resultResidual3: weightedAverageByDate(state.matches, "resultResidual", 0, predictionDate, 18, 6),
    resultResidual10: weightedAverageByDate(state.matches, "resultResidual", 0, predictionDate, 90, 20),
    xgResidual5: weightedAverageByDate(state.matches, "xgResidual", 0, predictionDate, 70, 16),
    ppg3: weightedAverageByDate(state.matches, "points", 1.35, predictionDate, 18, 6),
    ppg5: weightedAverageByDate(state.matches, "points", 1.35, predictionDate, 35, 10),
    ppg10: weightedAverageByDate(state.matches, "points", 1.35, predictionDate, 90, 20),
    gf5: weightedAverageByDate(state.matches, "gf", 1.3, predictionDate, 70, 16),
    ga5: weightedAverageByDate(state.matches, "ga", 1.3, predictionDate, 70, 16),
    xgFor5: weightedAverageByDate(state.matches, "xgFor", 1.3, predictionDate, 70, 16),
    xgAgainst5: weightedAverageByDate(state.matches, "xgAgainst", 1.3, predictionDate, 70, 16),
    shots5: weightedAverageByDate(state.matches, "shots", 11, predictionDate, 70, 16),
    shotsAgainst5: weightedAverageByDate(state.matches, "shotsAgainst", 10.5, predictionDate, 70, 16),
    sot5: weightedAverageByDate(state.matches, "sot", 3.8, predictionDate, 70, 16),
    sotAgainst5: weightedAverageByDate(state.matches, "sotAgainst", 3.6, predictionDate, 70, 16),
    venueGf5: weightedAverageByDate(venueMatches, "gf", 1.3, predictionDate, 100, 10),
    venueGa5: weightedAverageByDate(venueMatches, "ga", 1.3, predictionDate, 100, 10),
    xgCoverage: recentTen.length ? recentTen.filter((item) => item.xgActual).length / recentTen.length : 0,
    seasonFreshness: seasonWeightShare(state.matches, predictionDate, currentSeason, 70, 16),
    elo: blend(currentElo, state.baselineElo, sampleReliability),
    matches: state.matches.length,
    sampleReliability,
    restDays,
    freshnessDays: state.lastDate ? restDays : 120,
  };
}

function selectBaselineTraining(training, competitionId) {
  const exact = training.filter((match) => match.competition_id === competitionId);
  if (exact.length >= 60) return { matches: exact, source: "competition" };
  if (EUROPE_COMPETITION_IDS.has(competitionId)) {
    const european = training.filter((match) => EUROPE_COMPETITION_IDS.has(String(match.competition_id)));
    if (european.length >= 60) return { matches: european, source: "europe" };
    return { matches: training, source: "europe-support" };
  }
  return { matches: training, source: "top5" };
}

function weightedCompetitionAverages(matches, cutoffDate, halfLifeDays) {
  let weightTotal = 0;
  const sums = { homeGoals: 0, awayGoals: 0, homeXg: 0, awayXg: 0, homeShots: 0, awayShots: 0, homeSot: 0, awaySot: 0 };
  matches.forEach((match) => {
    const age = Math.max(0, (cutoffDate - dateAtNoon(match.date)) / DAY_MS);
    const weight = Math.exp(-LN2 * age / halfLifeDays);
    const homeExpected = xgValue(match, "home").value;
    const awayExpected = xgValue(match, "away").value;
    weightTotal += weight;
    sums.homeGoals += weight * safe(match.home_goals, 1.4);
    sums.awayGoals += weight * safe(match.away_goals, 1.15);
    sums.homeXg += weight * homeExpected;
    sums.awayXg += weight * awayExpected;
    sums.homeShots += weight * safe(match.home_shots, 11);
    sums.awayShots += weight * safe(match.away_shots, 10.5);
    sums.homeSot += weight * safe(match.home_sot, 3.8);
    sums.awaySot += weight * safe(match.away_sot, 3.6);
  });
  if (!weightTotal) {
    return { homeGoals: 1.42, awayGoals: 1.18, homeXg: 1.42, awayXg: 1.18, homeShots: 11, awayShots: 10.5, homeSot: 3.8, awaySot: 3.6 };
  }
  return Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, value / weightTotal]));
}

// Fattori pre-partita opzionali (formazione probabile/infortuni/neopromosse), prodotti da
// enrich_competitions_players.py in team_context e assenti finché quello script non gira
// nella pipeline. Senza options.teamContext (o senza una voce per la squadra) ogni fattore
// resta 1 e la formula del lambda è identica a prima di questa modifica: nessun rischio per
// le previsioni esistenti finché non lo passi esplicitamente.
function contextFactor(teamContext, team, key, min, max) {
  const entry = teamContext && team ? teamContext[team] : null;
  const value = entry ? safe(entry[key], 1) : 1;
  return clamp(value, min, max);
}

// lineup_strength è già clampato [0.82, 1.12] alla fonte e riflette la formazione
// probabile corrente: si applica per intero. availability_attack/promotion_attack sono
// popolati solo via override manuale in context_overrides.json (default 1 = nessun
// aggiustamento): riclampati qui per difesa, nel caso in un override manuale finisca un
// valore fuori scala.
function attackContext(teamContext, team) {
  const lineup = contextFactor(teamContext, team, "lineup_strength", 0.8, 1.15);
  const availability = contextFactor(teamContext, team, "availability_attack", 0.75, 1.2);
  const promotion = contextFactor(teamContext, team, "promotion_attack", 0.75, 1.2);
  return clamp(lineup * availability * promotion, 0.7, 1.3);
}

function defenseContext(teamContext, team) {
  const availability = contextFactor(teamContext, team, "availability_defense", 0.75, 1.2);
  const promotion = contextFactor(teamContext, team, "promotion_defense", 0.75, 1.2);
  return clamp(availability * promotion, 0.7, 1.3);
}

// Carico recente di una squadra letto dal calendario COMPLETO, coppe incluse.
//
// Serve perché per una previsione domestica predictFromMatches() filtra `chronological`
// alle sole competizioni domestiche: le partite di coppa non sono prive di etichetta, sono
// invisibili. Misura del 25/08/2026 su 7088 osservazioni squadra-partita: per una squadra
// con una gara europea 2-5 giorni prima, il riposo che il modello crede di vedere supera
// quello vero di 5.1 giorni in media, e di 6.0 se la trasferta europea era fuori casa. Non è
// un fattore mancante: è un input sbagliato.
//
// Restituisce la distanza dall'ultima gara europea, se fosse in trasferta, e quante partite
// la squadra ha giocato negli 8 giorni precedenti — "terza partita in otto giorni" significa
// due precedenti, ed è il 15.9% delle osservazioni.
const teamCalendar = memoizeByMatches((matches) => {
  const calendar = new Map();
  for (const match of matches) {
    const when = dateAtNoon(match.date).getTime();
    const european = EUROPE_COMPETITION_IDS.has(String(match.competition_id));
    for (const [team, away] of [[match.home_team, false], [match.away_team, true]]) {
      if (!team) continue;
      const list = calendar.get(team) || [];
      list.push({ when, european, away });
      calendar.set(team, list);
    }
  }
  // Ordine decrescente: recentLoad guarda solo indietro e può fermarsi appena esce dalla
  // finestra utile, invece di scorrere l'intera storia della squadra.
  for (const list of calendar.values()) list.sort((left, right) => right.when - left.when);
  return calendar;
});

function recentLoad(matches, team, cutoffDate) {
  const cutoff = cutoffDate.getTime();
  const list = teamCalendar(matches).get(team) || [];
  let europeGapDays = Infinity;
  let europeAway = false;
  let priorInEight = 0;
  let lastMatchGapDays = Infinity;
  for (const entry of list) {
    if (entry.when >= cutoff) continue;
    const gapDays = (cutoff - entry.when) / DAY_MS;
    if (gapDays < lastMatchGapDays) lastMatchGapDays = gapDays;
    if (gapDays <= 8) priorInEight += 1;
    if (entry.european && gapDays < europeGapDays) {
      europeGapDays = gapDays;
      europeAway = entry.away;
    }
    // La lista è ordinata dal più recente: oltre 400 giorni non c'è più niente da trovare né
    // per la finestra a 8 giorni né per l'ultima gara europea utile (che al massimo interessa
    // fino a 5 giorni prima).
    if (gapDays > 400) break;
  }
  return { europeGapDays, europeAway, priorInEight, lastMatchGapDays };
}

// I tre moltiplicatori nuovi sono tutti 1 di default, quindi il prodotto è esattamente il
// valore di prima: moltiplicare per 1.0 è esatto in virgola mobile e la neutralità di R1 è
// bit per bit (verificata da tests/rest-congestion.test.js).
//
// Direzione attesa e verificata PRIMA di guardare il log loss (R6): un impegno europeo non
// può aumentare il rendimento successivo. Misurato: -0.045 ± 0.023 sulla probabilità di
// vittoria dopo una TRASFERTA europea 2-5 giorni prima, contro +0.021 ± 0.024 dopo una gara
// europea in casa. Il segno separa i due casi, ed è il motivo per cui sono due parametri e
// non uno solo.
function restFactor(days, hyperparameters = DEFAULT_HYPERPARAMETERS, load = null) {
  const { veryShort, short, moderate, long, afterEuropeAway, afterEuropeHome, thirdInEight } = hyperparameters.restFactor;
  let base = 1;
  if (days <= 3) base = veryShort;
  else if (days === 4) base = short;
  else if (days === 5) base = moderate;
  else if (days > 21) base = long;
  if (!load) return base;
  const europeRecent = Number.isFinite(load.europeGapDays) && load.europeGapDays >= 2 && load.europeGapDays <= 5;
  const european = europeRecent ? (load.europeAway ? safe(afterEuropeAway, 1) : safe(afterEuropeHome, 1)) : 1;
  const congestion = load.priorInEight >= 2 ? safe(thirdInEight, 1) : 1;
  return base * european * congestion;
}

// Il difetto che seasonQualityWeight corregge, misurato su 3544 gare dei Big Five:
//
//   fascia   |    n | logLoss | quality
//   01-03    |  330 |  1.004  |  0.947
//   20+      | 1672 |  0.994  |  1.000
//
// Alla prima giornata il modello era sicuro quanto alla trentesima. Non per un errore di
// stima ma perché nessuna delle cinque componenti sapeva che stagione fosse: `depth` conta
// `home.matches + away.matches`, cioè la coda di 40 gare che ATTRAVERSA L'ESTATE, quindi
// venti partite della stagione scorsa valevano quanto venti di questa. `freshness` misura i
// giorni dall'ultima partita, che a fine agosto sono di nuovo pochi. E `xgCoverage`, dopo la
// correzione della pipeline (Task 1), è satura a ~1 ovunque e non varia più: lo spread fra
// inizio e fine stagione si è ANZI compresso da 0.074 a 0.053.
//
// Il costo di questa cecità non è teorico. applyCalibration interpola `shrink` fra
// asymmetryShrinkLowQuality (0.30) e asymmetryShrink (0.71) proprio su questo score: con uno
// score che non scende sotto 0.94 la compressione passa da 0.710 a 0.694, cioè il meccanismo
// di prudenza esiste, è calibrato, e non si accende mai.
//
// La componente nuova è la quota di massa di peso delle medie che viene dalla stagione in
// corso: 0 alla prima giornata per costruzione, ~1 da metà stagione in poi. Entra come
// miscela e non come sesto addendo, così a peso 0 l'espressione torna a essere esattamente
// la precedente — moltiplicare per 1.0 è esatto in virgola mobile, quindi la neutralità di
// R1 è bit per bit e non "entro epsilon" (verificata da tests/season-freshness.test.js).
function dataQuality(home, away, trainingMatches, baselineMatches, seasonQualityWeight = 0) {
  const depth = clamp((home.matches + away.matches) / 20, 0, 1);
  const totalDepth = clamp(trainingMatches / 500, 0, 1);
  const baselineDepth = clamp(baselineMatches / 180, 0, 1);
  const xg = (home.xgCoverage + away.xgCoverage) / 2;
  const freshness = Math.exp(-Math.max(0, Math.max(home.freshnessDays, away.freshnessDays) - 21) / 75);
  const legacy = clamp(0.32 * depth + 0.22 * totalDepth + 0.18 * baselineDepth + 0.18 * freshness + 0.10 * (0.35 + 0.65 * xg), 0, 1);
  const seasonFreshness = (safe(home.seasonFreshness, 0) + safe(away.seasonFreshness, 0)) / 2;
  const weight = clamp(safe(seasonQualityWeight, 0), 0, 1);
  const score = clamp((1 - weight) * legacy + weight * seasonFreshness, 0, 1);
  return { score, seasonFreshness, label: score >= 0.78 ? "Alta" : score >= 0.58 ? "Media" : "Bassa" };
}

// Confidenza DICHIARATA: quanto di ciò che serve per questa previsione il modello ce l'ha
// davvero. È un canale di sola lettura — si calcola dopo i lambda, da quantità già calcolate,
// e non rientra in nessuna formula che produca una probabilità.
//
// Questa separazione è il punto della funzione, non un dettaglio. `quality.score` sembra il
// posto naturale dove metterla, ma alimenta applyCalibration() e quindi le previsioni: renderlo
// sensibile alla freschezza di stagione significa accendere `seasonQualityWeight`, cioè
// riaprire la famiglia «ridurre la fiducia nel passato» che ha peggiorato in cinque tentativi
// indipendenti su cinque. La decisione è di dichiarare l'incertezza, non di reagire a essa.
//
// `quality.score` non può nemmeno svolgere il ruolo, misurato: sui Big Five vale 1.000 in ogni
// fascia di stagione tranne la primissima (§15, saturo con p05 = 0.995). Alla prima giornata
// annuncia la stessa fiducia di aprile.
//
// Cosa la confidenza puo' dire e cosa no, misurato sul campione PIENO dal 2023-08-01
// (una prima misura su un campione da 75 gare dava un degrado a inizio stagione che il campione
// pieno non conferma: era rumore, ed e' registrato in docs/misure-riferimento.md §22):
//
//   campionati            n     log loss   err.std      coppe UEFA        n     log loss  err.std
//   giorni 0-9          233      0.9992    0.0274       giorni 0-9      288      1.0657   0.0216
//   giorni 10-24        174      1.0225    0.0276       giorni 10-24    505      1.0494   0.0151
//   giorni 50-99        828      0.9786    0.0146       giorni 50-99    380      1.0027   0.0199
//   giorni 100-199     1955      0.9926    0.0104       giorni 100-199  717      0.9736   0.0159
//
// Due letture, e cambiano cosa e' onesto dichiarare:
//
// 1. **Nei campionati la fase di stagione non produce un degrado misurabile.** Le fasce stanno
//    tutte entro un paio di errori standard l'una dall'altra. Cio' che e' grande a inizio
//    stagione e' il DIVARIO DAL MERCATO (+0.0579, 4.28 sigma, §3 del prompt sessione 3), non
//    l'errore assoluto del modello. Quindi il fattore di stagione qui NON dichiara "il modello
//    sbaglia di piu'": dichiara da cosa e' composta l'evidenza — alla prima giornata, per intero
//    dalla stagione precedente, su rose che si sono mosse. E' un'affermazione su cosa il modello
//    sa, verificabile, e non una previsione di accuratezza che la misura non sostiene.
//
// 2. **Nelle coppe il degrado c'e' ed e' netto**: 1.0657 contro 0.9736, oltre tre errori
//    standard, e l'xG manca sull'80-100% delle gare. E' il segnale piu' forte di tutti, e va
//    pesato — un'etichetta che dicesse "Alta" elencando "nessun dato di xG" si contraddirebbe.
//
// I fattori sotto seguono queste due letture. Non sono tarati su un esito: non esiste un
// osservabile "questa previsione era affidabile" contro cui tarare. Sono dichiarazioni di
// disponibilita' dei dati, e l'unica loro validazione possibile e' che ordinino davvero le gare
// per accuratezza — verificato in tests/confidence.test.js sui dati veri.
const CONFIDENCE_BANDS = [
  { minimum: 0.78, label: "Alta" },
  { minimum: 0.58, label: "Media" },
  { minimum: 0, label: "Bassa" },
];
const confidenceLabel = (value) => CONFIDENCE_BANDS.find((band) => value >= band.minimum).label;

function predictionConfidence(quality, home, away, xgCoverage, newcomerHome, newcomerAway) {
  const limits = [];
  const seasonEvidence = clamp(safe(quality.seasonFreshness, 0), 0, 1);

  // Il fattore di stagione non è "pochi dati": è "dati su una squadra che può essere cambiata".
  // Alla prima giornata il modello ha una stagione intera di storia — la sua risorsa migliore,
  // misurata — su una rosa che nel frattempo si è mossa. Va detto per quello che è.
  let seasonFactor = 1;
  if (seasonEvidence < 0.15) {
    seasonFactor = 0.45;
    limits.push({
      code: "stagione-non-iniziata",
      value: seasonEvidence,
      text: "Nessuna gara di questa stagione pesa nel campione: la previsione viene dalla stagione precedente, su rose che nel frattempo sono cambiate.",
    });
  } else if (seasonEvidence < 0.45) {
    seasonFactor = 0.72;
    limits.push({
      code: "stagione-iniziale",
      value: seasonEvidence,
      text: `Solo il ${Math.round(100 * seasonEvidence)}% dell'evidenza pesata viene da questa stagione.`,
    });
  }

  // L'xG e' la meta' del segnale del modello (esponenti 0.43/0.45 contro 0.22/0.27 dei gol).
  // Dove manca, il modello prevede peggio in modo misurabile, ed e' il caso della quasi totalita'
  // delle gare di coppa.
  let xgFactor = 1;
  if (xgCoverage < 0.5) {
    xgFactor = clamp(0.75 + 0.5 * xgCoverage, 0.75, 1);
    limits.push({
      code: "xg-assente",
      value: xgCoverage,
      text: xgCoverage <= 0
        ? "Nessun dato di xG per queste squadre: il modello usa solo gol e tiri, e misura peggio dove l'xG manca."
        : `Copertura xG al ${Math.round(100 * xgCoverage)}%.`,
    });
  }

  const newcomers = [newcomerHome, newcomerAway].filter((value) => value !== undefined && value !== null).length;
  const newcomerFactor = 1 - 0.10 * newcomers;
  if (newcomers) {
    limits.push({
      code: "neopromossa",
      value: newcomers,
      text: newcomers === 2
        ? "Entrambe le squadre sono senza storia recente in questa competizione."
        : "Una delle due squadre è senza storia recente in questa competizione.",
    });
  }

  const depth = (home.matches + away.matches);
  const depthFactor = depth >= 20 ? 1 : clamp(0.60 + 0.02 * depth, 0.60, 1);
  if (depth < 20) {
    limits.push({
      code: "poche-gare",
      value: depth,
      text: `Solo ${depth} gare recenti fra le due squadre nella finestra del modello.`,
    });
  }

  // La confidenza non è una probabilità stimata e non è tarata su nulla: non esiste un esito
  // osservabile "questa previsione era affidabile" contro cui tararla. È una dichiarazione di
  // disponibilità dei dati, e va letta così. Il minimo fra i due canali, non la media: un
  // limite che morde non si compensa con un'abbondanza altrove.
  // Il MINIMO dei fattori, non il prodotto e non la media: un limite che morde non si compensa
  // con un'abbondanza altrove, e comporre quattro fattori moltiplicandoli farebbe crollare
  // l'etichetta per accumulo di penalita' piccole invece che per un difetto reale.
  const binding = Math.min(seasonFactor, xgFactor, depthFactor, newcomerFactor);
  const score = clamp(quality.score * binding, 0, 1);
  return { score, label: confidenceLabel(score), seasonEvidence, limits };
}

function outcomeName(probabilities, homeTeam, awayTeam) {
  return [
    { key: "1", name: homeTeam, probability: probabilities.homeWin },
    { key: "X", name: "Pareggio", probability: probabilities.draw },
    { key: "2", name: awayTeam, probability: probabilities.awayWin },
  ].sort((left, right) => right.probability - left.probability)[0];
}

// --- Mercati sui singoli giocatori --------------------------------------------------------
//
// Densità binomiale negativa (miscela Gamma-Poisson) con media `lambda` e parametro di forma
// `dispersion`: stessa media di una Poisson, varianza λ + λ²/k, cioè più alta. Per
// dispersion → ∞ tende alla Poisson.
//
// Serve perché la Poisson pura assume che il tasso di un giocatore sia lo STESSO in ogni
// partita, e non lo è: cambia con la marcatura avversaria, il sistema di gioco, la condizione
// fisica. docs/player-probability-study.md misura il costo di quell'assunzione con una
// simulazione Monte Carlo (§4.3): con una sovradispersione realistica l'errore di calibrazione
// di `shotProbability` peggiora di 14 volte e quello di `multiShotProbability` di 22, e il
// modello risulta "sistematicamente troppo sicuro nella fascia alta". Lo studio identificava
// il problema ma il codice restava Poisson puro; qui la conclusione viene applicata.
export function negativeBinomialPmf(count, lambda, dispersion) {
  if (lambda <= 0) return count === 0 ? 1 : 0;
  if (!Number.isFinite(dispersion) || dispersion <= 0) return poissonPmf(count, lambda);
  const successProbability = dispersion / (dispersion + lambda);
  const failureProbability = lambda / (dispersion + lambda);
  let coefficient = 1;
  for (let index = 0; index < count; index += 1) coefficient *= (dispersion + index) / (index + 1);
  return coefficient * Math.pow(successProbability, dispersion) * Math.pow(failureProbability, count);
}

// Parametro di forma per mercato. Più basso = più sovradispersione. I tiri sono il mercato ad
// alto volume, dove la variabilità partita per partita pesa di più (5 è nell'ordine del k=4
// usato come scenario di sensitività nello studio); gol, assist e cartellini sono eventi rari,
// dove la sovradispersione conta molto meno e la Poisson resta una buona approssimazione,
// quindi hanno un k più alto (più vicino alla Poisson). Non sono valori stimati su esiti reali
// partita-per-partita — quel dato la pipeline non lo conserva ancora (vedi §6 dello studio) —
// ma la direzione della correzione è quella misurata, e un k finito è comunque più prudente
// del k infinito implicito nella Poisson.
export const PLAYER_MARKET_DISPERSION = Object.freeze({
  shots: 5,
  shotsOnTarget: 6,
  goals: 8,
  assists: 8,
  cards: 10,
});

// Un giocatore non "gioca metà partita": o parte titolare, o subentra, o resta in panchina.
// Usare i minuti ATTESI (media dei tre scenari) e poi una sola distribuzione è l'errore che
// faceva la versione precedente: un giocatore che parte titolare metà delle volte e resta
// fuori l'altra metà riceveva 45 minuti "certi", che non gli capitano mai. La probabilità
// corretta è la miscela dei tre scenari, ciascuno con la propria distribuzione. La differenza
// è grande proprio dove conta di più, sulle riserve e sui giocatori in rotazione.
function appearanceScenarios(player) {
  const squadAppearances = Math.max(safe(player.squad_appearances, 0), safe(player.appearances, 0));
  const appearances = Math.max(0, safe(player.appearances, 0));
  const starts = clamp(safe(player.starts, 0), 0, appearances);
  const minutes = Math.max(0, safe(player.minutes, 0));

  // Con i dati nuovi le due probabilità arrivano già corrette con la stima di Laplace dalla
  // pipeline; con un player_context di schema precedente si ricostruiscono qui, così una voce
  // vecchia continua a produrre numeri sensati invece di un errore.
  const sampleSize = Math.max(squadAppearances, appearances, 1);
  const startProbability = clamp(
    safe(player.start_probability, (starts + 0.5) / (sampleSize + 1.5)),
    0,
    1,
  );
  const playProbability = clamp(
    Math.max(startProbability, safe(player.play_probability, (appearances + 0.5) / (sampleSize + 1))),
    0,
    1,
  );

  const minutesPerStart = clamp(
    safe(player.minutes_per_start, 0) || (starts > 0 ? minutes / starts : 0) || 80,
    1,
    90,
  );
  const substituteAppearances = Math.max(0, appearances - starts);
  const substituteMinutes = substituteAppearances > 0
    ? clamp((minutes - starts * minutesPerStart) / substituteAppearances, 1, 90)
    : 20; // minutaggio mediano di un subentrato nei cinque campionati

  return [
    { probability: startProbability, minutes: minutesPerStart },
    { probability: Math.max(0, playProbability - startProbability), minutes: substituteMinutes },
  ].filter((scenario) => scenario.probability > 0 && scenario.minutes > 0);
}

// I tassi con shrinkage verso il prior di ruolo, quando la pipeline li ha prodotti (schema 2),
// altrimenti il tasso grezzo. Su tre-quattro partite campionate la differenza non è cosmetica:
// il tasso grezzo di un attaccante che ha segnato una volta in 200 minuti è 0.45 gol/90, cioè
// il ritmo del capocannoniere d'Europa, e quello di chi non ha ancora segnato è esattamente 0.
function playerRate(player, key) {
  const shrunk = safe(player[`${key}_shrunk`], NaN);
  return Math.max(0, Number.isFinite(shrunk) ? shrunk : safe(player[key], 0));
}

/**
 * Probabilità dei mercati sul singolo giocatore per UNA partita specifica, non medie storiche.
 *
 * L'ancoraggio al resto del modello è il punto: `teamLambda` è il numero di gol che
 * predictFromMatches si aspetta da QUESTA squadra in QUESTA partita, e ogni mercato del
 * giocatore vi si aggancia attraverso il rapporto con il rendimento storico della squadra. Un
 * avversario debole alza il lambda e con esso la probabilità di gol dei suoi attaccanti, in
 * coerenza con l'1X2 mostrato accanto — non una stima isolata che ignora il contesto.
 *
 * Tre scelte statistiche, tutte motivate:
 * 1. miscela sugli scenari di impiego (titolare / subentrato / in panchina) invece dei minuti
 *    attesi, vedi appearanceScenarios;
 * 2. binomiale negativa invece di Poisson, vedi negativeBinomialPmf;
 * 3. tassi con shrinkage bayesiano verso il prior di ruolo, vedi playerRate.
 *
 * Limiti dichiarati: assume che il tasso per-90 del giocatore resti stabile; non conosce la
 * formazione ufficiale (la probabilità di titolarità è storica, non una notizia di formazione);
 * non corregge per il rendimento difensivo dell'avversario contro quel ruolo specifico; per
 * "gol o assist" assume indipendenza condizionata allo scenario di impiego, il che sottostima
 * leggermente la probabilità congiunta perché nella stessa partita le due cose sono
 * correlate positivamente.
 */
export function estimatePlayerMarkets(player, teamLambda, teamRecentGoalsFor) {
  const scenarios = appearanceScenarios(player);
  const lambda = Math.max(0, safe(teamLambda, 0));
  const historicGoals = Math.max(0, safe(teamRecentGoalsFor, 0));

  // Quanto questa partita è più (o meno) offensiva della media storica della squadra.
  const teamScaling = historicGoals > 0 ? clamp(lambda / historicGoals, 0.4, 2.2) : 1;
  // I tiri rispondono al contesto di squadra meno che proporzionalmente: se il modello prevede
  // più gol perché l'avversario è debole, salgono sia il VOLUME dei tiri sia la loro QUALITÀ
  // media (λ ≈ tiri × conversione). Attribuire tutta la variazione al solo volume — come
  // faceva la versione precedente, che usava teamScaling pieno anche sui tiri — sovrastima la
  // reattività del numero di tiri. Ripartendo la variazione equamente tra i due fattori in
  // scala logaritmica si ottiene l'esponente 1/2. È un'assunzione strutturale dichiarata, non
  // un valore stimato: la pipeline non conserva ancora tiri-per-giocatore partita per partita.
  const shotScaling = Math.sqrt(teamScaling);

  const goalRate = playerRate(player, "goals_per90");
  const assistRate = playerRate(player, "assists_per90");
  const shotRate = playerRate(player, "shots_per90");
  const shotOnTargetRate = playerRate(player, "shots_on_target_per90");
  const cardRate = playerRate(player, "yellow_per90") + playerRate(player, "red_per90");

  const totals = {
    minutes: 0, goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, cards: 0,
    scores: 0, scoresTwice: 0, assistsOnce: 0, goalOrAssist: 0,
    shootsOnce: 0, shootsTwice: 0, shootsThrice: 0, onTarget: 0, booked: 0,
  };

  for (const scenario of scenarios) {
    const minutesFactor = scenario.minutes / 90;
    // Il gol resta ancorato al lambda di squadra: goalRate/historicGoals è la quota storica di
    // gol-squadra del giocatore, riportata sul lambda di oggi. Il tetto a 0.85·lambda impedisce
    // che un singolo giocatore assorba di fatto tutta la produzione offensiva della squadra
    // quando il campione è piccolo e il suo tasso storico è gonfiato.
    const expectedGoals = Math.min(0.85 * lambda, goalRate * minutesFactor * teamScaling);
    const expectedAssists = assistRate * minutesFactor * teamScaling;
    const expectedShots = shotRate * minutesFactor * shotScaling;
    // Un tiro in porta è un tiro: il vincolo va imposto, non sperato. Con tassi storici presi
    // da campioni diversi (o con un dato sporco) nulla garantisce di per sé che il tasso di
    // tiri in porta stia sotto quello dei tiri, e senza questo la UI potrebbe mostrare una
    // probabilità di "almeno un tiro in porta" più alta di quella di "almeno un tiro".
    const expectedShotsOnTarget = Math.min(expectedShots, shotOnTargetRate * minutesFactor * shotScaling);
    // I cartellini non dipendono dall'intensità offensiva: un'ammonizione non diventa più
    // probabile perché la squadra segna di più. Scalano solo con i minuti in campo.
    const expectedCards = cardRate * minutesFactor;

    const noGoal = negativeBinomialPmf(0, expectedGoals, PLAYER_MARKET_DISPERSION.goals);
    const oneGoal = negativeBinomialPmf(1, expectedGoals, PLAYER_MARKET_DISPERSION.goals);
    const noAssist = negativeBinomialPmf(0, expectedAssists, PLAYER_MARKET_DISPERSION.assists);
    const noShot = negativeBinomialPmf(0, expectedShots, PLAYER_MARKET_DISPERSION.shots);
    const oneShot = negativeBinomialPmf(1, expectedShots, PLAYER_MARKET_DISPERSION.shots);
    const twoShots = negativeBinomialPmf(2, expectedShots, PLAYER_MARKET_DISPERSION.shots);
    const noShotOnTarget = negativeBinomialPmf(0, expectedShotsOnTarget, PLAYER_MARKET_DISPERSION.shotsOnTarget);
    const noCard = negativeBinomialPmf(0, expectedCards, PLAYER_MARKET_DISPERSION.cards);

    const weight = scenario.probability;
    totals.minutes += weight * scenario.minutes;
    totals.goals += weight * expectedGoals;
    totals.assists += weight * expectedAssists;
    totals.shots += weight * expectedShots;
    totals.shotsOnTarget += weight * expectedShotsOnTarget;
    totals.cards += weight * expectedCards;
    totals.scores += weight * (1 - noGoal);
    totals.scoresTwice += weight * Math.max(0, 1 - noGoal - oneGoal);
    totals.assistsOnce += weight * (1 - noAssist);
    totals.goalOrAssist += weight * (1 - noGoal * noAssist);
    totals.shootsOnce += weight * (1 - noShot);
    totals.shootsTwice += weight * Math.max(0, 1 - noShot - oneShot);
    totals.shootsThrice += weight * Math.max(0, 1 - noShot - oneShot - twoShots);
    totals.onTarget += weight * (1 - noShotOnTarget);
    totals.booked += weight * (1 - noCard);
  }

  const round2 = (value) => Math.round(value * 100) / 100;
  // Il campione osservato determina quanta fiducia dare a queste stime. 450 minuti (cinque
  // partite intere) è la soglia oltre la quale i tassi individuali smettono di essere dominati
  // dal rumore: sotto, il valore resta utilizzabile grazie allo shrinkage verso il prior di
  // ruolo, ma va mostrato come stima debole e non come previsione a pari titolo.
  const observedMinutes = Math.max(0, safe(player.minutes, 0));
  const confidence = clamp(1 - Math.exp(-observedMinutes / 450), 0, 1);

  return {
    expectedMinutes: Math.round(totals.minutes),
    startProbability: round2(scenarios[0]?.probability ?? 0),
    playProbability: round2(scenarios.reduce((sum, scenario) => sum + scenario.probability, 0)),
    expectedGoals: Math.round(totals.goals * 1000) / 1000,
    expectedShots: round2(totals.shots),
    expectedShotsOnTarget: round2(totals.shotsOnTarget),
    // I clamp superiori restano quelli già in uso: nessun mercato mostra mai una quasi-certezza.
    anytimeScorerProbability: clamp(totals.scores, 0, 0.95),
    twoPlusGoalsProbability: clamp(totals.scoresTwice, 0, 0.6),
    assistProbability: clamp(totals.assistsOnce, 0, 0.9),
    goalOrAssistProbability: clamp(totals.goalOrAssist, 0, 0.95),
    cardProbability: clamp(totals.booked, 0, 0.85),
    // shotProbability: almeno 1 tiro; multiShot: almeno 2; threePlusShot: almeno 3.
    shotProbability: clamp(totals.shootsOnce, 0, 0.97),
    multiShotProbability: clamp(totals.shootsTwice, 0, 0.97),
    threePlusShotProbability: clamp(totals.shootsThrice, 0, 0.95),
    shotOnTargetProbability: clamp(totals.onTarget, 0, 0.95),
    confidence: round2(confidence),
  };
}

export function predictFromMatches(matches, rawOptions) {
  const options = { windowDays: 540, halfLifeDays: 120, competitionId: "", teamContext: null, hyperparameters: null, refereeHomeBias: 0, ...rawOptions };
  if (!SUPPORTED_COMPETITION_IDS.has(options.competitionId)) {
    throw new Error("Competizione non supportata: usa i Big Five o una delle tre coppe UEFA.");
  }
  const hyperparameters = mergeHyperparameters(options.hyperparameters);

  const europeanTarget = EUROPE_COMPETITION_IDS.has(options.competitionId);
  const predictionDate = dateAtNoon(options.date);
  const cutoffDate = dateAtNoon(options.cutoffDate || options.date);
  const windowStart = new Date(cutoffDate.getTime() - options.windowDays * DAY_MS);
  const warmupStart = new Date(windowStart.getTime() - 420 * DAY_MS);
  const chronological = matches.filter((match) => {
    const matchDate = dateAtNoon(match.date);
    const competitionAllowed = europeanTarget
      ? true
      : DOMESTIC_COMPETITION_IDS.has(String(match.competition_id));
    return competitionAllowed
      && matchDate < cutoffDate
      && matchDate >= warmupStart
      && match.home_goals !== null && match.home_goals !== undefined
      && match.away_goals !== null && match.away_goals !== undefined;
  }).sort((left, right) => left.date.localeCompare(right.date));
  const training = chronological.filter((match) => dateAtNoon(match.date) >= windowStart);
  if (training.length < 100) throw new Error("Dati recenti insufficienti per questa competizione e finestra temporale.");

  const baselineSelection = selectBaselineTraining(training, options.competitionId);
  const baselineTraining = baselineSelection.matches;
  const states = new Map();
  const newcomers = newcomerIndex(matches);
  chronological.forEach((match) => applyMatch(states, match, europeanTarget, hyperparameters, newcomers));
  // La stagione della gara arriva dalla gara stessa. È informazione di calendario, nota in
  // anticipo e priva di risultati — la stessa natura di competition_id e league_strength — ma
  // va PASSATA, non dedotta.
  //
  // Dedurla dall'array (`resolveCurrentSeason`) sembrava equivalente e non lo è, misurato il
  // 27/08/2026 con scripts/diag_leakage_truncation.mjs. Il commento che stava qui sosteneva
  // che leggere l'array non filtrato fosse sicuro «perché quell'array si ferma al cutoff e la
  // data della previsione cade sempre dopo l'ultima gara che contiene»: vero in backtest,
  // FALSO in produzione. `payload.matches` contiene solo gare concluse, quindi si ferma a
  // oggi. Alla prima giornata di una stagione nuova il backtest vede la stagione N (dalle sue
  // gare successive) e la produzione no — la stessa divergenza di Q1, in un altro punto.
  //
  // Oggi non cambia una previsione perché i tre consumatori di `currentSeason` sono tutti a
  // valore neutro per decisione misurata (seasonEloRegression 1, seasonQualityWeight 0,
  // cold-start neopromosse 0/1). Accendendone uno la divergenza diventa reale: misurata a
  // Δ 3.2e-2 su una probabilità 1X2 con seasonQualityWeight 0.5. Vedi
  // docs/misure-riferimento.md §19.
  //
  // Il ripiego su resolveCurrentSeason() resta per i chiamanti che non passano `season`
  // (fixture sintetiche dei test, diagnostici storici): non è la strada da usare in produzione.
  const currentSeason = options.season ? String(options.season) : resolveCurrentSeason(matches, predictionDate);
  // Media della lega di DESTINAZIONE: per una previsione domestica è la forza della
  // competizione richiesta (1570/1555/1550/1540/1520 secondo la lega), non 1500 e non la
  // lega di provenienza — è il caso della promossa, dove l'ancora giusta è quella nuova.
  // Per un obiettivo europeo la nozione di "lega di destinazione" non si applica e si usa
  // l'ultima lega domestica nota della squadra stessa.
  const targetLeagueStrength = europeanTarget
    ? null
    : safe(training.find((match) => String(match.competition_id) === options.competitionId)?.league_strength, 1500);
  const homeState = states.get(options.homeTeam) || emptyState();
  const awayState = states.get(options.awayTeam) || emptyState();
  const newcomerLookup = (team) => (europeanTarget ? undefined : newcomers.get(`${options.competitionId}|${currentSeason}|${team}`));
  // Il carico si legge dall'array NON filtrato, che contiene anche le coppe: è l'unica via
  // per vedere la gara di mercoledì quando l'obiettivo è di campionato.
  const homeLoad = recentLoad(matches, options.homeTeam, cutoffDate);
  const awayLoad = recentLoad(matches, options.awayTeam, cutoffDate);
  const home = stateMetrics(homeState, "home", predictionDate, {
    currentSeason,
    leagueMean: targetLeagueStrength ?? homeState.leagueStrength,
    seasonEloRegression: hyperparameters.seasonEloRegression,
    newcomerSeasonsAway: newcomerLookup(options.homeTeam),
    trueRestDays: homeLoad.lastMatchGapDays,
    competitionId: options.competitionId,
    hyperparameters,
  });
  const away = stateMetrics(awayState, "away", predictionDate, {
    currentSeason,
    leagueMean: targetLeagueStrength ?? awayState.leagueStrength,
    seasonEloRegression: hyperparameters.seasonEloRegression,
    newcomerSeasonsAway: newcomerLookup(options.awayTeam),
    trueRestDays: awayLoad.lastMatchGapDays,
    competitionId: options.competitionId,
    hyperparameters,
  });
  const league = weightedCompetitionAverages(baselineTraining, cutoffDate, options.halfLifeDays);
  const neutralGoals = mean(league.homeGoals, league.awayGoals);
  const neutralXg = mean(league.homeXg, league.awayXg);
  const neutralShots = mean(league.homeShots, league.awayShots);
  const neutralSot = mean(league.homeSot, league.awaySot);

  // General team form is venue-neutral. Only venue-specific splits are compared with
  // home/away league baselines; this avoids systematically suppressing home attack
  // and inflating away attack when general metrics are used.
  const ae = hyperparameters.attackExponents;
  const de = hyperparameters.defenseExponents;
  const homeAttack = Math.pow(clamp(blend(home.gf5, neutralGoals, home.sampleReliability) / neutralGoals, 0.5, 1.8), ae.goals)
    * Math.pow(clamp(blend(home.xgFor5, neutralXg, home.sampleReliability) / neutralXg, 0.5, 1.8), ae.xg)
    * Math.pow(clamp(blend(home.sot5, neutralSot, home.sampleReliability) / neutralSot, 0.6, 1.6), ae.sot)
    * Math.pow(clamp(blend(home.shots5, neutralShots, home.sampleReliability) / neutralShots, 0.65, 1.5), ae.shots)
    * Math.pow(clamp(blend(home.venueGf5, league.homeGoals, home.sampleReliability * 0.7) / league.homeGoals, 0.55, 1.65), ae.venue);
  const awayDefense = Math.pow(clamp(blend(away.ga5, neutralGoals, away.sampleReliability) / neutralGoals, 0.5, 1.9), de.goals)
    * Math.pow(clamp(blend(away.xgAgainst5, neutralXg, away.sampleReliability) / neutralXg, 0.5, 1.9), de.xg)
    * Math.pow(clamp(blend(away.sotAgainst5, neutralSot, away.sampleReliability) / neutralSot, 0.6, 1.7), de.sot)
    * Math.pow(clamp(blend(away.shotsAgainst5, neutralShots, away.sampleReliability) / neutralShots, 0.65, 1.6), de.shots)
    * Math.pow(clamp(blend(away.venueGa5, league.homeGoals, away.sampleReliability * 0.7) / league.homeGoals, 0.6, 1.7), de.venue);

  const awayAttack = Math.pow(clamp(blend(away.gf5, neutralGoals, away.sampleReliability) / neutralGoals, 0.5, 1.85), ae.goals)
    * Math.pow(clamp(blend(away.xgFor5, neutralXg, away.sampleReliability) / neutralXg, 0.5, 1.85), ae.xg)
    * Math.pow(clamp(blend(away.sot5, neutralSot, away.sampleReliability) / neutralSot, 0.6, 1.65), ae.sot)
    * Math.pow(clamp(blend(away.shots5, neutralShots, away.sampleReliability) / neutralShots, 0.65, 1.55), ae.shots)
    * Math.pow(clamp(blend(away.venueGf5, league.awayGoals, away.sampleReliability * 0.7) / league.awayGoals, 0.55, 1.7), ae.venue);
  const homeDefense = Math.pow(clamp(blend(home.ga5, neutralGoals, home.sampleReliability) / neutralGoals, 0.5, 1.9), de.goals)
    * Math.pow(clamp(blend(home.xgAgainst5, neutralXg, home.sampleReliability) / neutralXg, 0.5, 1.9), de.xg)
    * Math.pow(clamp(blend(home.sotAgainst5, neutralSot, home.sampleReliability) / neutralSot, 0.6, 1.7), de.sot)
    * Math.pow(clamp(blend(home.shotsAgainst5, neutralShots, home.sampleReliability) / neutralShots, 0.65, 1.6), de.shots)
    * Math.pow(clamp(blend(home.venueGa5, league.awayGoals, home.sampleReliability * 0.7) / league.awayGoals, 0.6, 1.7), de.venue);

  const eloDiff = home.elo - away.elo;
  // Scostamento storico (regolarizzato) del tasso di vittorie casalinghe sotto uno
  // specifico arbitro rispetto alla media di lega, calcolato da compute_referee_stats()
  // in update_europe_data.py (payload.referee_stats). Nessuna fonte usata da questa
  // pipeline (ESPN/UEFA/Football-Data) espone l'arbitro di una partita futura prima
  // dell'annuncio ufficiale: resta 0 (nessun effetto) finché non lo passi esplicitamente
  // per una partita specifica, es. quando lo apprendi a ridosso del match.
  const refereeBias = clamp(safe(options.refereeHomeBias, 0), -0.12, 0.12);
  const eloHome = Math.exp(clamp(eloDiff / hyperparameters.eloDivisor, -hyperparameters.eloClamp, hyperparameters.eloClamp) + refereeBias);
  const eloAway = Math.exp(clamp(-eloDiff / hyperparameters.eloDivisor, -hyperparameters.eloClamp, hyperparameters.eloClamp) - refereeBias);
  const shortWeight = hyperparameters.momentumShortWeight;
  const momentum = (shortWeight * home.ppg3 + (1 - shortWeight) * home.ppg10)
    - (shortWeight * away.ppg3 + (1 - shortWeight) * away.ppg10);
  const formHome = Math.exp(clamp(momentum * hyperparameters.momentumScale, -hyperparameters.momentumClamp, hyperparameters.momentumClamp));
  const formAway = Math.exp(clamp(-momentum * hyperparameters.momentumScale, -hyperparameters.momentumClamp, hyperparameters.momentumClamp));

  const homeContextAttack = attackContext(options.teamContext, options.homeTeam);
  const awayContextAttack = attackContext(options.teamContext, options.awayTeam);
  const homeContextDefense = defenseContext(options.teamContext, options.homeTeam);
  const awayContextDefense = defenseContext(options.teamContext, options.awayTeam);

  const rawLambdaHome = clamp(
    league.homeGoals * homeAttack * awayDefense * eloHome * formHome * restFactor(home.restDays, hyperparameters, homeLoad),
    ...LAMBDA_HOME_BOUNDS,
  );
  const rawLambdaAway = clamp(
    league.awayGoals * awayAttack * homeDefense * eloAway * formAway * restFactor(away.restDays, hyperparameters, awayLoad),
    ...LAMBDA_AWAY_BOUNDS,
  );

  // La qualità dei dati serve alla calibrazione (comprime di più l'asimmetria quando il
  // campione è sottile), quindi va calcolata prima dei lambda finali e non più dopo.
  const quality = dataQuality(home, away, training.length, baselineTraining.length, hyperparameters.seasonQualityWeight);
  const calibrated = applyCalibration(
    rawLambdaHome,
    rawLambdaAway,
    league.homeGoals,
    league.awayGoals,
    quality.score,
    hyperparameters.calibration,
  );

  // Dal 27/08/2026 nessun chiamante passa `teamContext`: la pagina lo passava e nessun backtest
  // lo vedeva, quindi il modello misurato non era il modello in produzione. Misurato appaiato
  // prima di spegnerlo, tocca fino al 94% delle gare francesi e nessuna gara inglese, e vale
  // +0.0002 ± 0.0010 (0.21σ): vedi prediction-inputs.js. Il codice qui sotto resta vivo e
  // testato — è la strada per l'opzione (b), un `player_context` versionato nel tempo.
  //
  // teamContext si applica DOPO la calibrazione, non prima, per due motivi che vanno insieme.
  // Primo: i parametri di calibrazione sono stimati sul modello senza teamContext (nel backtest
  // non è mai passato), quindi comprimono il segnale endogeno del modello — una notizia di
  // formazione fornita dall'esterno è informazione che il modello NON ha, e non c'è ragione di
  // scontarla del 58% come se fosse rumore prodotto dal modello stesso. Secondo: la
  // calibrazione è una trasformazione della COPPIA (λcasa, λtrasferta) — separa livello e
  // asimmetria, e ogni trasformazione in quella base accoppia i due valori. Applicandola prima,
  // indebolire la formazione di casa muoverebbe anche il lambda ospite; applicandola dopo, ogni
  // fattore di contesto tocca solo il lato a cui si riferisce, come è giusto che sia.
  const lambdaHome = clamp(calibrated.lambdaHome * homeContextAttack / awayContextDefense, ...LAMBDA_HOME_BOUNDS);
  const lambdaAway = clamp(calibrated.lambdaAway * awayContextAttack / homeContextDefense, ...LAMBDA_AWAY_BOUNDS);

  const probabilities = matrixProbabilities(scoreMatrix(lambdaHome, lambdaAway, 8, hyperparameters.rho, hyperparameters.sharedDispersion));
  return {
    lambdaHome,
    lambdaAway,
    // Lambda prima della calibrazione: li usa scripts/fit_calibration.mjs per ristimare i
    // parametri senza dover ricostruire l'Elo a ogni valutazione della ricerca.
    rawLambdaHome,
    rawLambdaAway,
    probabilities,
    home,
    away,
    league,
    quality,
    // Calcolata QUI, dopo `probabilities`, e da quantità già fissate: è la garanzia strutturale
    // che dichiarare l'incertezza non possa cambiare la previsione di cui si parla.
    confidence: predictionConfidence(
      quality,
      home,
      away,
      (home.xgCoverage + away.xgCoverage) / 2,
      newcomerLookup(options.homeTeam),
      newcomerLookup(options.awayTeam),
    ),
    mostLikelyOutcome: outcomeName(probabilities, options.homeTeam, options.awayTeam),
    trainingMatches: training.length,
    baselineMatches: baselineTraining.length,
    baselineSource: baselineSelection.source,
    firstTrainingDate: training[0].date,
    lastTrainingDate: training.at(-1).date,
    cutoffDate: String(options.cutoffDate || options.date).slice(0, 10),
    xgCoverage: (home.xgCoverage + away.xgCoverage) / 2,
    currentSeason,
    load: { home: homeLoad, away: awayLoad },
    competitionId: options.competitionId,
    context: {
      applied: Boolean(options.teamContext),
      homeAttack: homeContextAttack,
      awayAttack: awayContextAttack,
      homeDefense: homeContextDefense,
      awayDefense: awayContextDefense,
    },
    refereeBias,
    hyperparameters,
    calibration: {
      neutralGeneralBaseline: true,
      metricHalfLifeDays: 70,
      xgEloBlend: 0.45,
      lambdaCalibration: hyperparameters.calibration,
    },
    modelVersion: "6.0-shrunk-asymmetry",
  };
}

// Scostamento del tasso di vittorie casalinghe sotto uno specifico arbitro, letto da
// payload.referee_stats per la partita che si sta prevedendo.
//
// ATTENZIONE, misurato il 25/08/2026: `referee_stats` è calcolato IN-SAMPLE —
// compute_referee_stats() usa tutte le partite concluse che l'arbitro ha diretto, inclusa
// quella che si sta prevedendo. Usarlo in un backtest produce un guadagno apparente di
// +0.0050 ± 0.0012 (4.2 sigma) che è interamente leakage: ricalcolando il bias sulle sole
// partite PRECEDENTI, con la stessa formula, l'effetto scende a +0.0001 ± 0.0010, cioè zero.
//
// In produzione il leakage non c'è (una partita futura non è nel dataset da cui la tabella è
// calcolata), ma non c'è nemmeno il guadagno. Vedi docs/misure-riferimento.md §17.
//
// Prima di questa funzione `refereeHomeBias` era un parametro di predictFromMatches che
// nessun chiamante passava mai: il gancio esisteva, era testato, ed era inerte — lo stesso
// anti-pattern di newcomerEloDiscount. Il campo `referee` è presente sul 21.5% delle gare
// passate, quindi l'effetto era misurabile da subito senza bisogno di alcuna fonte nuova.
//
// Resta 0 quando l'arbitro è ignoto, che è il caso di TUTTE le partite future finché non
// esiste una fonte per le designazioni: nessun aggiustamento, comportamento identico a prima.
//
// Dal 27/08/2026 NESSUN chiamante passa `refereeStats`: app.js lo passava, nessuno script di
// misura lo passava, ed è la terza opzione che R13 vieta — usato in produzione e ignorato in
// misura. Il cablaggio resta qui, testato, ma spento: riaccenderlo richiede prima una tabella
// ricostruibile in avanti alla data della previsione, perché quella attuale non lo è. Vedi
// prediction-inputs.js e docs/misure-riferimento.md §17-18.
export function refereeBiasFor(fixture, refereeStats) {
  if (!refereeStats || !fixture) return 0;
  const name = String(fixture.referee || "").trim();
  if (!name) return 0;
  const entry = refereeStats[name];
  return entry ? safe(entry.home_bias, 0) : 0;
}

export function predictMatchdayFromMatches(matches, fixtures, options = {}) {
  if (!fixtures?.length) throw new Error("Il turno selezionato non contiene partite.");
  const ordered = fixtures.slice().sort((left, right) => left.date.localeCompare(right.date));
  const cutoffDate = ordered[0].date;
  const predictions = ordered.map((fixture) => ({
    fixture,
    result: predictFromMatches(matches, {
      ...options,
      // Per partita, non per turno: l'arbitro cambia da una gara all'altra. Un valore
      // esplicito in options ha comunque la precedenza, per il caso "lo so in anticipo e
      // lo passo a mano" che il README già documenta.
      refereeHomeBias: options.refereeHomeBias ?? refereeBiasFor(fixture, options.refereeStats),
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      date: fixture.date,
      cutoffDate,
      competitionId: fixture.competition_id || options.competitionId || "",
      // Dalla fixture, non dedotta: è l'unico valore che produzione e backtest possono
      // avere uguale alla prima giornata di una stagione nuova.
      season: fixture.season || options.season || "",
    }),
  }));
  return { cutoffDate, predictions, competitionId: ordered[0].competition_id || options.competitionId || "" };
}
