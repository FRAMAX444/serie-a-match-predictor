// Statistica del confronto appaiato, condivisa da diag_paired_ab.mjs (due configurazioni
// sullo stesso dataset) e diag_dataset_ab.mjs (stesse partite, due versioni dei dati).
//
// Il motivo per cui questo modulo esiste al posto di due copie: R3 del brief riposa
// interamente su queste tre funzioni, e due implementazioni della stessa formula divergono
// in silenzio alla prima modifica — lo stesso argomento per cui applyCalibration è esportata
// da model.js invece che riscritta dentro fit_calibration.mjs.

export const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export const sd = (values) => {
  if (values.length < 2) return NaN;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};

export const standardError = (values) => sd(values) / Math.sqrt(values.length);

// PRNG deterministico (mulberry32): il bootstrap deve dare lo stesso intervallo a ogni
// esecuzione, altrimenti due letture dello stesso esperimento non sono confrontabili e
// l'intervallo diventa una fonte di rumore invece di una misura del rumore.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bootstrap APPAIATO: si ricampionano le PARTITE (con reinserimento), non le due serie
// separatamente. Ricampionarle separatamente distruggerebbe l'appaiamento, cioè proprio ciò
// che rende la misura ~77 volte più precisa (errore std 0.0002 contro 0.0154 su 768 gare).
export function pairedBootstrap(differences, draws, rng) {
  if (!draws || differences.length < 2) return null;
  const count = differences.length;
  const means = new Float64Array(draws);
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    for (let index = 0; index < count; index += 1) sum += differences[(rng() * count) | 0];
    means[draw] = sum / count;
  }
  const sorted = Float64Array.from(means).sort();
  const quantile = (q) => sorted[Math.min(draws - 1, Math.max(0, Math.round(q * (draws - 1))))];
  return { lo: quantile(0.025), median: quantile(0.5), hi: quantile(0.975) };
}

export const BUCKETERS = {
  phase: {
    order: ["01-03", "04-06", "07-10", "11-19", "20+"],
    of: (row) => (row.phase <= 3 ? "01-03" : row.phase <= 6 ? "04-06" : row.phase <= 10 ? "07-10" : row.phase <= 19 ? "11-19" : "20+"),
  },
  league: { order: ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"], of: (row) => row.competition },
  season: { order: ["2324", "2425", "2526", "2627"], of: (row) => row.season },
  xgcoverage: {
    order: ["0-25%", "25-50%", "50-75%", "75-100%"],
    of: (row) => (row.xgCoverage < 0.25 ? "0-25%" : row.xgCoverage < 0.5 ? "25-50%" : row.xgCoverage < 0.75 ? "50-75%" : "75-100%"),
  },
};

// Stampa la differenza appaiata aggregata e per segmento. R5: un guadagno aggregato che
// nasconde un peggioramento su un segmento non è un guadagno, e l'aggregato non lo mostra.
// `onInert` viene chiamata quando il meccanismo sotto test non tocca NESSUNA gara. R11 del
// prompt di sessione 2: un risultato "nessun effetto" con zero gare toccate non è un
// risultato, è uno strumento rotto. Nella sessione 1 diag_paired_ab.mjs filtrava via le
// coppe e il fattore europeo di Task 6 risultava toccare 0/2779 gare — il difetto era nel
// sorgente inlinato nel brief v1, quindi invisibile a chi lo usava in buona fede.
export function reportDifference(label, differences, rows, bucketer, byName, boot, rng, onInert = null) {
  const count = differences.length;
  const touched = differences.filter((value) => Math.abs(value) > 1e-9);
  console.log(`=== ${label} ===`);
  console.log(`  GARE TOCCATE DAL MECCANISMO: ${touched.length}/${count} (${(100 * touched.length / count).toFixed(1)}%)`);
  if (touched.length === 0 && onInert) onInert(label);
  console.log(`  differenza appaiata  : ${mean(differences).toFixed(4)}  (positivo = la variante è migliore)`);
  console.log(`  errore std APPAIATO  : ${standardError(differences).toFixed(4)}`);
  const interval = pairedBootstrap(differences, boot, rng);
  if (interval) console.log(`  IC 95% bootstrap     : [${interval.lo.toFixed(4)}, ${interval.hi.toFixed(4)}]`);
  console.log(`  gare in cui la modifica cambia qualcosa: ${touched.length}/${count}`);
  if (touched.length > 1) {
    console.log(`    su quelle: diff media ${mean(touched).toFixed(4)}, errore std ${standardError(touched).toFixed(4)}`);
  }
  const segments = new Map();
  rows.forEach((row, index) => {
    const key = bucketer.of(row);
    segments.set(key, [...(segments.get(key) || []), differences[index]]);
  });
  const order = [
    ...bucketer.order.filter((key) => segments.has(key)),
    ...[...segments.keys()].filter((key) => !bucketer.order.includes(key)).sort(),
  ];
  console.log(`  per ${byName}:`);
  console.log("    segmento |    n | diff appaiata | err.std | tocc.");
  for (const key of order) {
    const bucket = segments.get(key);
    const error = bucket.length > 1 ? standardError(bucket).toFixed(4) : "  n/d ";
    const hit = bucket.filter((value) => Math.abs(value) > 1e-9).length;
    console.log(`    ${key.padEnd(8)} | ${String(bucket.length).padStart(4)} |     ${mean(bucket).toFixed(4).padStart(8)} |  ${error} | ${hit}`);
  }
  console.log("");
}
