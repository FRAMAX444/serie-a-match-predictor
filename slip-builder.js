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

function groupByFixture(candidates, minLegProbability, maxPerFixture) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!(candidate.probability >= minLegProbability)) continue;
    if (!(candidate.odds > 1)) continue;
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
function optimiseSlip(fixtures, legs, capacityUnits) {
  const width = capacityUnits + 1;
  // score[k][u] = punteggio massimo con k selezioni e costo accumulato esattamente u.
  let score = Array.from({ length: legs + 1 }, () => new Float64Array(width).fill(-Infinity));
  score[0][0] = 0;
  // Per ricostruire la schedina serve sapere, per ogni stato raggiunto, da quale candidato ci
  // si è arrivati: -1 = partita saltata.
  const choices = [];

  for (let index = 0; index < fixtures.length; index += 1) {
    const next = score.map((row) => Float64Array.from(row));
    const choice = Array.from({ length: legs + 1 }, () => new Int32Array(width).fill(-1));
    for (let used = 0; used < legs; used += 1) {
      const row = score[used];
      const target = next[used + 1];
      const targetChoice = choice[used + 1];
      for (let cost = 0; cost < width; cost += 1) {
        const current = row[cost];
        if (current === -Infinity) continue;
        for (let option = 0; option < fixtures[index].length; option += 1) {
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
  let used = legs;
  let cost = bestCost;
  for (let index = fixtures.length - 1; index >= 0; index -= 1) {
    if (used === 0) break;
    const option = choices[index][used][cost];
    if (option < 0) continue;
    const candidate = fixtures[index][option];
    legsChosen.push(candidate);
    used -= 1;
    cost -= candidate.costUnits;
  }
  return used === 0 ? legsChosen.reverse() : null;
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
export function buildSlip(candidates, options = {}) {
  const {
    legs = 3,
    confidence = "media",
    maxCandidatesPerFixture = 40,
    minLegProbability = null,
  } = options;
  const requested = Math.max(1, Math.round(legs));
  const requirements = resolveRequirements(confidence, requested);
  const floor = minLegProbability === null ? requirements.minLeg : minLegProbability;

  // Rilassamenti in ordine: prima si abbassa la soglia per singola selezione, poi il target
  // combinato. Ogni passo viene registrato e riportato all'utente: una schedina che non
  // rispetta la sicurezza richiesta va detta, non consegnata come se la rispettasse.
  const relaxations = [];
  let fixtures = groupByFixture(candidates, floor, maxCandidatesPerFixture);
  let appliedFloor = floor;
  while (fixtures.length < requested && appliedFloor > 0.2) {
    appliedFloor = Math.max(0.2, appliedFloor - 0.05);
    fixtures = groupByFixture(candidates, appliedFloor, maxCandidatesPerFixture);
  }
  if (appliedFloor < floor) {
    relaxations.push(`soglia per selezione abbassata da ${Math.round(floor * 100)}% a ${Math.round(appliedFloor * 100)}%`);
  }
  if (fixtures.length < requested) return null;

  // Costo e punteggio si calcolano una volta sola per candidato: la programmazione dinamica li
  // rilegge migliaia di volte.
  const prepared = fixtures.map((group) => group.map((candidate) => ({
    ...candidate,
    costUnits: costUnits(candidate.probability),
    score: legScore(candidate),
  })));

  let capacity = Math.floor(-safeLog(requirements.target) / COST_UNIT);
  const bestPossibleCost = maximumAchievableCost(prepared, requested);
  if (bestPossibleCost > capacity) {
    relaxations.push(
      `probabilità combinata richiesta (${Math.round(requirements.target * 100)}%) non raggiungibile `
      + `con ${requested} selezioni: il massimo possibile in questo turno è `
      + `${Math.round(Math.exp(-bestPossibleCost * COST_UNIT) * 100)}%`,
    );
    capacity = bestPossibleCost;
  }

  const chosenLegs = optimiseSlip(prepared, requested, capacity);
  if (!chosenLegs) return null;

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
    confidence: { ...requirements, appliedMinLeg: appliedFloor },
    targetProbability: requirements.target,
    targetMet: combinedProbability >= requirements.target - 1e-9,
    relaxations,
    usesMarketOdds: chosenLegs.some((leg) => leg.source === "market"),
  };
}
