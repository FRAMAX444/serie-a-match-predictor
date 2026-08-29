// Costruzione della schedina a partire da "quante partite" e "quanta sicurezza".
//
// Logica pura, senza rete e senza DOM: schedina.js la usa dopo aver scaricato le quote,
// schedina-page.js la usa per il percorso senza chiave API, tests/slip-builder.test.js la
// verifica in isolamento.
//
// --- Perché l'obiettivo è questo e non "massimizza la probabilità" ------------------------
//
// La versione precedente chiedeva una QUOTA target e cercava la combinazione più probabile
// dentro quella quota. È lo stesso problema visto dal lato sbagliato: chi gioca una schedina
// non sa quale quota vuole, sa quante partite vuole giocare e quanto vuole andare sul sicuro.
//
// Ribaltata la domanda, il problema è:
//
//     massimizza   Σ ln(quota)  +  w · Σ ln(affidabilità)
//     con vincolo  Σ ln(probabilità) ≥ ln(sicurezza richiesta)
//                  esattamente N selezioni, al più una per partita
//
// cioè "il massimo che si può vincere restando dentro la sicurezza chiesta". Il vincolo è
// ciò che rende viva la richiesta di sicurezza: chiedere sicurezza *massima* costringe verso
// selezioni quasi certe e quindi una quota bassa, chiedere sicurezza *bassa* lascia spazio a
// selezioni più remunerative. È il verso giusto in cui leggere il parametro — l'utente non
// chiede "la schedina più probabile possibile" (quella si costruisce da sola: tre Over 0.5 e
// buonanotte), chiede quanto è disposto a rischiare.
//
// L'obiettivo NON contiene ln(probabilità). Sembrerebbe naturale premiare le selezioni più
// probabili, ma con le quote eque del modello (quota = 1/probabilità) i due termini si
// annullano esattamente: ln(quota × probabilità) = 0 per ogni selezione, il punteggio diventa
// insensibile alla sicurezza richiesta e la funzione restituirebbe la stessa identica schedina
// per "sicurezza massima" e per "sicurezza bassa". La probabilità sta nel vincolo, il
// guadagno nell'obiettivo: ognuna al suo posto.
//
// Con quote di MERCATO invece di quote eque, lo stesso obiettivo diventa automaticamente una
// ricerca di valore: a parità di probabilità richiesta, la quota più alta è quella in cui il
// banco paga più di quanto il modello ritenga corretto.
//
// Il termine sull'affidabilità distingue selezioni altrimenti equivalenti: a parità di quota
// si preferisce la partita su cui il modello ha dati migliori, e si penalizzano i mercati sui
// giocatori con pochi minuti osservati. "Sicurezza della previsione" è anche questo — non solo
// quanto è probabile l'esito, ma quanto è solida la stima che lo dice.

const LOG_EPSILON = 1e-12;
const safeLog = (value) => Math.log(Math.max(LOG_EPSILON, value));

// Livelli di sicurezza. `minLeg` è la soglia sotto la quale una singola selezione non entra;
// `target` è la probabilità combinata che la schedina deve raggiungere. I due numeri non sono
// indipendenti: con 6 partite e target 0.50 servirebbero selezioni al 89% ciascuna, che
// tipicamente non esistono, quindi il target viene automaticamente rilassato (vedi
// resolveRequirements) e il rilassamento viene riportato invece di essere nascosto.
export const CONFIDENCE_LEVELS = Object.freeze({
  massima: { minLeg: 0.72, target: 0.50, label: "Massima" },
  alta: { minLeg: 0.62, target: 0.35, label: "Alta" },
  media: { minLeg: 0.50, target: 0.20, label: "Media" },
  bassa: { minLeg: 0.40, target: 0.10, label: "Bassa" },
});

export function resolveConfidence(confidence) {
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    const target = Math.min(0.95, Math.max(0.01, confidence));
    return { minLeg: 0, target, label: `${Math.round(target * 100)}%`, custom: true };
  }
  return CONFIDENCE_LEVELS[String(confidence || "").toLowerCase()] || CONFIDENCE_LEVELS.media;
}

// Con una sicurezza numerica esplicita la soglia per singola selezione si deduce dal target:
// la media geometrica richiesta è target^(1/n), e si concede a ogni selezione di stare un po'
// sotto quella media (altre la compenseranno) senza però scendere in territorio da terno.
function resolveRequirements(confidence, legs) {
  const level = resolveConfidence(confidence);
  const geometricMean = Math.pow(level.target, 1 / Math.max(1, legs));
  const minLeg = level.custom
    ? Math.min(0.9, Math.max(0.35, geometricMean * 0.85))
    : level.minLeg;
  return { ...level, minLeg, geometricMean };
}

// Tra due selezioni sulla stessa partita ne sopravvive una sola se l'altra è peggiore sotto
// ogni aspetto (probabilità, quota e affidabilità): tenerla renderebbe la ricerca più lenta
// senza poter mai migliorare il risultato. È una potatura esatta, non un'euristica.
function paretoFront(candidates) {
  return candidates.filter((candidate, index) => !candidates.some((other, otherIndex) => (
    otherIndex !== index
    && other.probability >= candidate.probability
    && other.odds >= candidate.odds
    && other.reliability >= candidate.reliability
    && (
      other.probability > candidate.probability
      || other.odds > candidate.odds
      || other.reliability > candidate.reliability
    )
  )));
}

// Il numero di selezioni per partita va limitato perché la ricerca resti rapida quando sono
// attivi anche i mercati sui giocatori (decine di candidati per gara). Ma il criterio con cui
// si taglia decide il risultato: tenere le N più PROBABILI scarta proprio le selezioni che
// pagano di più, cioè quelle che l'obiettivo cerca, e la schedina esce molto più prudente di
// quanto richiesto (chiedendo sicurezza bassa si otteneva comunque il 29% invece del 10%).
// Si tiene quindi un campione DISTRIBUITO su tutto l'intervallo di probabilità ammissibile:
// estremi inclusi, il resto a passo costante.
function spreadSample(sorted, limit) {
  if (sorted.length <= limit) return sorted;
  if (limit <= 1) return [sorted[0]];
  const step = (sorted.length - 1) / (limit - 1);
  const picked = new Set();
  for (let index = 0; index < limit; index += 1) picked.add(Math.round(index * step));
  return [...picked].sort((left, right) => left - right).map((index) => sorted[index]);
}

// Quota minima per singola selezione. Senza questa soglia il vincolo di sicurezza spinge verso
// selezioni quasi certe — un 1X al 92% paga 1.08 — che gonfiano la probabilita' combinata e non
// pagano nulla: quattro gambe cosi' moltiplicano il margine del banco quattro volte per un
// ritorno che non copre nemmeno una gamba persa. L'obiettivo da solo non basta a escluderle,
// perche' e' il VINCOLO a metterle dentro.
export const DEFAULT_MIN_LEG_ODDS = 1.2;

function groupByFixture(candidates, minLegProbability, maxPerFixture, minLegOdds = 1) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!(candidate.probability >= minLegProbability)) continue;
    if (!(candidate.odds > 1)) continue;
    if (!(candidate.odds >= minLegOdds)) continue;
    if (!groups.has(candidate.fixtureIndex)) groups.set(candidate.fixtureIndex, []);
    groups.get(candidate.fixtureIndex).push(candidate);
  }
  return [...groups.values()]
    .map((group) => spreadSample(
      paretoFront(group).sort((left, right) => right.probability - left.probability),
      maxPerFixture,
    ))
    .filter((group) => group.length > 0);
}

// Peso del termine di affidabilità. Va scelto perché conti dove serve senza dominare: fra due
// partite di campionato l'affidabilità è quasi identica (≈0.95, ln ≈ −0.05) e il termine
// sparisce, mentre un mercato su un giocatore con pochi minuti campionati può scendere a 0.3
// (ln ≈ −1.2) e allora pesa quanto una differenza di quota da 1.1 a 1.5. È esattamente il
// caso in cui vogliamo che pesi.
const RELIABILITY_WEIGHT = 0.25;

function legScore(candidate) {
  return safeLog(candidate.odds) + RELIABILITY_WEIGHT * safeLog(candidate.reliability);
}

// Granularità della discretizzazione del vincolo di probabilità, in unità di logaritmo
// naturale. 0.002 significa che due schedine la cui probabilità combinata differisce di meno
// dello 0.2% sono trattate come equivalenti dal vincolo: sotto la soglia di significatività di
// una previsione calcistica, e sufficiente a tenere il numero di stati nell'ordine del migliaio.
const COST_UNIT = 0.002;

// Il "costo" di una selezione è quanta probabilità toglie alla schedina: −ln(p) ≥ 0. Una
// schedina rispetta la sicurezza richiesta se la somma dei costi non supera −ln(sicurezza).
// Arrotondato per ECCESSO, così l'approssimazione può solo rendere la schedina più sicura del
// richiesto, mai meno.
const costUnits = (probability) => Math.ceil(-safeLog(probability) / COST_UNIT);

/**
 * Programmazione dinamica su (partite esaminate, selezioni usate, costo accumulato).
 *
 * Sostituisce una ricerca in profondità con potatura che era esatta ma impraticabile: 91
 * secondi per una schedina da 8 partite con i mercati sui giocatori attivi. Il motivo di quel
 * collasso è strutturale, non un difetto dei limiti usati per potare: con le quote eque
 * ln(quota) = −ln(probabilità), quindi obiettivo e vincolo consumano la STESSA risorsa e
 * qualunque limite superiore calcolato separatamente sui due è inevitabilmente lasco.
 *
 * Trattando invece la probabilità come capacità di uno zaino il problema diventa
 * pseudo-polinomiale: O(partite × selezioni × unità di costo × candidati per partita), qualche
 * centinaio di migliaia di operazioni, millisecondi. Resta esatto a meno di COST_UNIT.
 */
// `constraints[i]` fissa o vieta la decisione sulla partita i:
//   { pin: n }        -> si DEVE prendere l'opzione n
//   { pin: "skip" }   -> la partita si DEVE saltare
//   { ban: n }        -> l'opzione n e' vietata (le altre, e il salto, restano)
//   { ban: "skip" }   -> saltare e' vietato (una selezione va presa, quale che sia)
// Serve alla procedura di Lawler per enumerare le K schedine migliori riusando questo stesso
// ottimizzatore invece di scriverne un secondo, che divergerebbe da questo alla prima modifica.
function optimiseSlip(fixtures, legs, capacityUnits, constraints = []) {
  const width = capacityUnits + 1;
  // score[k][u] = punteggio massimo con k selezioni e costo accumulato esattamente u.
  let score = Array.from({ length: legs + 1 }, () => new Float64Array(width).fill(-Infinity));
  score[0][0] = 0;
  // Per ricostruire la schedina serve sapere, per ogni stato raggiunto, da quale candidato ci
  // si è arrivati: -1 = partita saltata.
  const choices = [];

  for (let index = 0; index < fixtures.length; index += 1) {
    const constraint = constraints[index] || {};
    const skipAllowed = constraint.pin === undefined ? constraint.ban !== "skip" : constraint.pin === "skip";
    // Il salto e' la riga portata avanti invariata: se e' vietato, si riparte da "irraggiungibile"
    // e ogni stato dovra' essere raggiunto prendendo una selezione su questa partita.
    const next = skipAllowed
      ? score.map((row) => Float64Array.from(row))
      : Array.from({ length: legs + 1 }, () => new Float64Array(width).fill(-Infinity));
    const choice = Array.from({ length: legs + 1 }, () => new Int32Array(width).fill(-1));
    const allowed = (option) => {
      if (constraint.pin !== undefined) return constraint.pin === option;
      return constraint.ban !== option;
    };
    for (let used = 0; used < legs; used += 1) {
      const row = score[used];
      const target = next[used + 1];
      const targetChoice = choice[used + 1];
      for (let cost = 0; cost < width; cost += 1) {
        const current = row[cost];
        if (current === -Infinity) continue;
        for (let option = 0; option < fixtures[index].length; option += 1) {
          if (!allowed(option)) continue;
          const candidate = fixtures[index][option];
          const total = cost + candidate.costUnits;
          if (total >= width) continue;
          const value = current + candidate.score;
          if (value > target[total]) {
            target[total] = value;
            targetChoice[total] = option;
          }
        }
      }
    }
    choices.push(choice);
    score = next;
  }

  let bestCost = -1;
  let bestScore = -Infinity;
  for (let cost = 0; cost < width; cost += 1) {
    if (score[legs][cost] > bestScore) {
      bestScore = score[legs][cost];
      bestCost = cost;
    }
  }
  if (bestCost < 0 || bestScore === -Infinity) return null;

  // Ricostruzione a ritroso: da (legs, bestCost) si risale scegliendo, a ogni partita, il
  // candidato registrato oppure il salto.
  const legsChosen = [];
  // La decisione presa su OGNI partita, salto compreso (-1): e' cio' che permette di partizionare
  // lo spazio delle soluzioni per trovare la seconda schedina migliore, la terza, e cosi' via.
  const decisions = new Int32Array(fixtures.length).fill(-1);
  let used = legs;
  let cost = bestCost;
  for (let index = fixtures.length - 1; index >= 0; index -= 1) {
    if (used === 0) break;
    const option = choices[index][used][cost];
    if (option < 0) continue;
    const candidate = fixtures[index][option];
    decisions[index] = option;
    legsChosen.push(candidate);
    used -= 1;
    cost -= candidate.costUnits;
  }
  if (used !== 0) return null;
  return { legs: legsChosen.reverse(), decisions, score: bestScore };
}

// Massima probabilità combinata ottenibile con `legs` selezioni: la migliore di ogni partita,
// poi le `legs` partite migliori. Serve quando la sicurezza richiesta è irraggiungibile, per
// sapere di quanto va rilassata invece di rinunciare.
function maximumAchievableCost(fixtures, legs) {
  return fixtures
    .map((group) => Math.min(...group.map((candidate) => candidate.costUnits)))
    .sort((left, right) => left - right)
    .slice(0, legs)
    .reduce((total, units) => total + units, 0);
}

/**
 * Cerca la schedina migliore con ESATTAMENTE `legs` selezioni, al più una per partita.
 *
 * Ricerca esaustiva in profondità con potatura sui limiti superiori: con i numeri reali di un
 * turno (8-10 partite, poche selezioni Pareto-ottime ciascuna) esplora una frazione minima
 * dello spazio e restituisce comunque l'ottimo esatto, non un'approssimazione greedy.
 *
 * @returns null se non esistono abbastanza partite con almeno una selezione ammissibile.
 */
function prepareSearch(candidates, options) {
  const {
    legs = 3,
    confidence = "media",
    maxCandidatesPerFixture = 40,
    minLegProbability = null,
    minLegOdds = DEFAULT_MIN_LEG_ODDS,
  } = options;
  const requested = Math.max(1, Math.round(legs));
  const requirements = resolveRequirements(confidence, requested);
  const floor = minLegProbability === null ? requirements.minLeg : minLegProbability;
  const requestedOdds = Math.max(1, minLegOdds);

  // Rilassamenti in ordine, ognuno registrato e riportato: una schedina che non rispetta cio'
  // che le e' stato chiesto va detta, non consegnata come se lo rispettasse.
  //
  // L'ordine non e' arbitrario, e la gerarchia nemmeno: la SICUREZZA e' cio' che l'utente
  // chiede, la quota minima e' una preferenza su come ottenerla. Le due possono essere
  // incompatibili — "sicurezza massima" vuole selezioni al 72%, che pagano 1.39 al massimo —
  // e in quel caso cede la quota minima, dicendolo.
  const relaxations = [];
  let appliedFloor = floor;
  let appliedOdds = requestedOdds;
  const regroup = () => groupByFixture(candidates, appliedFloor, maxCandidatesPerFixture, appliedOdds);
  const prepare = (groups) => groups.map((group) => group.map((candidate) => ({
    // Costo e punteggio si calcolano una volta sola per candidato: la programmazione dinamica
    // li rilegge migliaia di volte.
    ...candidate,
    costUnits: costUnits(candidate.probability),
    score: legScore(candidate),
  })));

  let fixtures = regroup();
  while (fixtures.length < requested && appliedFloor > 0.2) {
    appliedFloor = Math.max(0.2, appliedFloor - 0.05);
    fixtures = regroup();
  }
  while (fixtures.length < requested && appliedOdds > 1.01) {
    appliedOdds = Math.max(1.01, appliedOdds - 0.05);
    fixtures = regroup();
  }
  if (appliedFloor < floor) {
    relaxations.push(`soglia per selezione abbassata da ${Math.round(floor * 100)}% a ${Math.round(appliedFloor * 100)}%`);
  }
  if (fixtures.length < requested) return null;

  let capacity = Math.floor(-safeLog(requirements.target) / COST_UNIT);
  let prepared = prepare(fixtures);
  // La quota minima puo' rendere irraggiungibile la sicurezza richiesta, perche' toglie proprio
  // le selezioni quasi certe. Cede lei, un passo alla volta, finche' il target torna possibile.
  while (maximumAchievableCost(prepared, requested) > capacity && appliedOdds > 1.01) {
    appliedOdds = Math.max(1.01, appliedOdds - 0.05);
    fixtures = regroup();
    if (fixtures.length < requested) break;
    prepared = prepare(fixtures);
  }
  if (fixtures.length < requested) return null;
  if (appliedOdds < requestedOdds) {
    relaxations.push(
      `quota minima per selezione abbassata da ${requestedOdds.toFixed(2)} a ${appliedOdds.toFixed(2)}: `
      + "la sicurezza richiesta non era raggiungibile con selezioni pagate almeno quanto chiesto",
    );
  }

  const bestPossibleCost = maximumAchievableCost(prepared, requested);
  if (bestPossibleCost > capacity) {
    relaxations.push(
      `probabilità combinata richiesta (${Math.round(requirements.target * 100)}%) non raggiungibile `
      + `con ${requested} selezioni: il massimo possibile in questo turno è `
      + `${Math.round(Math.exp(-bestPossibleCost * COST_UNIT) * 100)}%`,
    );
    capacity = bestPossibleCost;
  }
  return { prepared, requested, requirements, capacity, relaxations, appliedFloor, appliedOdds };
}

function assembleSlip(chosenLegs, context) {
  const { requested, requirements, relaxations, appliedFloor, appliedOdds } = context;
  const combinedProbability = chosenLegs.reduce((total, leg) => total * leg.probability, 1);
  const combinedOdds = chosenLegs.reduce((total, leg) => total * leg.odds, 1);
  return {
    legs: chosenLegs.map(({ costUnits: _costUnits, score: _score, ...leg }) => leg),
    combinedOdds,
    combinedProbability,
    // Valore atteso di 1 unità giocata: > 1 solo se le quote reali sono più generose di quanto
    // il modello ritenga corretto. Con le sole quote eque vale esattamente 1 per costruzione,
    // e va letto come "nessun vantaggio dimostrabile", non come "scommessa equa vantaggiosa".
    expectedReturn: combinedOdds * combinedProbability,
    requestedLegs: requested,
    confidence: { ...requirements, appliedMinLeg: appliedFloor, appliedMinOdds: appliedOdds },
    targetProbability: requirements.target,
    targetMet: combinedProbability >= requirements.target - 1e-9,
    relaxations,
    usesMarketOdds: chosenLegs.some((leg) => leg.source === "market"),
  };
}

/** Cerca la schedina migliore con ESATTAMENTE `legs` selezioni, al più una per partita. */
export function buildSlip(candidates, options = {}) {
  const context = prepareSearch(candidates, options);
  if (!context) return null;
  const solution = optimiseSlip(context.prepared, context.requested, context.capacity);
  return solution ? assembleSlip(solution.legs, context) : null;
}

/**
 * Le `count` schedine MIGLIORI e tutte diverse fra loro, in ordine di punteggio.
 *
 * Non sono dieci schedine a caso ne' dieci varianti della prima: e' l'enumerazione esatta delle
 * prime `count` soluzioni, ottenuta con la procedura di Lawler. Trovata la migliore, lo spazio
 * delle soluzioni rimanenti si partiziona in blocchi disgiunti — per ogni partita: "decisa come
 * nella migliore fino a qui, e diversa QUI" — e ognuno si risolve con lo stesso ottimizzatore
 * gia' usato per la prima. Ogni schedina esce una volta sola, e la k-esima e' davvero la
 * k-esima migliore.
 *
 * Costa `count × partite` esecuzioni della programmazione dinamica, cioe' millisecondi.
 *
 * ATTENZIONE, e l'interfaccia lo dice: dieci schedine dello stesso turno condividono le
 * partite, quindi condividono anche gli esiti. Giocarle tutte non e' diversificare — e' la
 * stessa scommessa moltiplicata, con la stessa correlazione dentro.
 */
export function buildSlipSeries(candidates, options = {}) {
  const { count = 10, maxExtractions = 600 } = options;
  const wanted = Math.max(1, Math.round(count));
  const context = prepareSearch(candidates, options);
  if (!context) return [];
  const { prepared, requested, capacity, relaxations } = context;

  const first = optimiseSlip(prepared, requested, capacity);
  if (!first) return [];

  // DIVERSITA': ogni schedina deve avere almeno META' delle partite diverse da ciascuna delle
  // altre gia' scelte. Il vincolo e' sulle PARTITE e non sulle selezioni, perche' due schedine
  // sulle stesse quattro gare con mercati diversi non sono due alternative: se quel turno va
  // male vanno male entrambe, che e' esattamente cio' da cui la diversita' dovrebbe proteggere.
  const minDifferentFixtures = Math.max(1, Math.ceil(requested / 2));
  const fixturesOf = (solution) => new Set(solution.legs.map((leg) => leg.fixtureIndex));
  const differentEnough = (fixtures, other) => {
    let shared = 0;
    for (const fixture of fixtures) if (other.has(fixture)) shared += 1;
    return fixtures.size - shared >= minDifferentFixtures;
  };

  // Enumerazione di Lawler: trovata la migliore, lo spazio si partiziona in blocchi disgiunti
  // ("come questa fino a qui, diversa qui") e ognuno si risolve con lo stesso ottimizzatore.
  // L'estrazione e' pigra e si ferma appena si hanno abbastanza schedine diverse: enumerarne un
  // bacino fisso costerebbe centinaia di esecuzioni della programmazione dinamica anche quando
  // ne bastano dieci.
  const queue = [{ solution: first, constraints: [] }];
  const seen = new Set();
  const signature = (decisions) => decisions.join(",");
  const chosen = [];
  const chosenFixtures = [];
  let extractions = 0;

  while (chosen.length < wanted && queue.length && extractions < maxExtractions) {
    let bestIndex = 0;
    for (let index = 1; index < queue.length; index += 1) {
      if (queue[index].solution.score > queue[bestIndex].solution.score) bestIndex = index;
    }
    const [current] = queue.splice(bestIndex, 1);
    const key = signature(current.solution.decisions);
    if (seen.has(key)) continue;
    seen.add(key);
    extractions += 1;

    const fixtures = fixturesOf(current.solution);
    if (chosenFixtures.every((other) => differentEnough(fixtures, other))) {
      chosen.push(current.solution);
      chosenFixtures.push(fixtures);
    }

    const decisions = current.solution.decisions;
    for (let fixture = 0; fixture < prepared.length; fixture += 1) {
      const inherited = current.constraints[fixture];
      if (inherited && inherited.pin !== undefined) continue; // qui la decisione era gia' fissata
      const constraints = current.constraints.slice();
      let conflict = false;
      for (let earlier = 0; earlier < fixture; earlier += 1) {
        const pin = decisions[earlier] < 0 ? "skip" : decisions[earlier];
        const existing = constraints[earlier];
        // Un vincolo ereditato che vieta proprio cio' che qui andrebbe fissato rende il blocco
        // vuoto: si salta invece di risolvere un problema senza soluzioni.
        if (existing && existing.ban !== undefined && existing.ban === pin) { conflict = true; break; }
        constraints[earlier] = { pin };
      }
      if (conflict) continue;
      constraints[fixture] = { ban: decisions[fixture] < 0 ? "skip" : decisions[fixture] };
      const solution = optimiseSlip(prepared, requested, capacity, constraints);
      if (solution && !seen.has(signature(solution.decisions))) queue.push({ solution, constraints });
    }
  }

  // SECONDA FASE. L'enumerazione per punteggio decrescente si intasa: le prime soluzioni usano
  // tutte le partite migliori, e dopo poche schedine nessuna delle successive ha abbastanza gare
  // diverse. Su otto partite di Bundesliga si fermava a tre. Qui si forza la ricerca altrove,
  // vietando (saltando) le partite piu' usate finora e riottimizzando: ogni risultato passa
  // comunque il controllo di diversita' prima di essere accettato, quindi la promessa resta
  // esatta — cambia solo dove si cerca.
  let ban = minDifferentFixtures;
  let attempts = 0;
  while (chosen.length < wanted && attempts < wanted * 8 && ban < prepared.length) {
    attempts += 1;
    const usage = new Map();
    for (const fixtures of chosenFixtures) {
      for (const fixture of fixtures) usage.set(fixture, (usage.get(fixture) || 0) + 1);
    }
    const mostUsed = [...usage.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, ban)
      .map(([fixture]) => fixture);
    if (mostUsed.length < ban) break;
    if (prepared.length - mostUsed.length < requested) break; // non resterebbero partite a sufficienza

    const constraints = [];
    for (const fixture of mostUsed) constraints[fixture] = { pin: "skip" };
    const solution = optimiseSlip(prepared, requested, capacity, constraints);
    const key = solution ? signature(solution.decisions) : null;
    if (!solution || seen.has(key)) { ban += 1; continue; }
    seen.add(key);
    const fixtures = fixturesOf(solution);
    if (chosenFixtures.every((other) => differentEnough(fixtures, other))) {
      chosen.push(solution);
      chosenFixtures.push(fixtures);
    } else {
      ban += 1;
    }
  }

  // Quante ne escono dipende da quante partite ha il turno: con sei gare giocabili e schedine da
  // quattro non esistono dieci combinazioni che condividano al piu' due partite l'una con
  // l'altra. Si consegnano quelle che ci sono — una schedina che VIOLA il vincolo non e' una
  // schedina in piu', e' una copia mascherata — e il numero mancante viene dichiarato.
  if (chosen.length < wanted) {
    relaxations.push(
      `richieste ${wanted} schedine, generate ${chosen.length}: ognuna deve avere almeno `
      + `${minDifferentFixtures} partite diverse da ogni altra, e questo turno ha `
      + `${prepared.length} partite giocabili con selezioni ammissibili. Con meno partite, o con `
      + "una quota minima più bassa, se ne compongono di più.",
    );
  }

  return chosen.map((solution) => assembleSlip(solution.legs, context));
}
