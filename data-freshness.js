// Quanto e' vecchio il dataset che la pagina sta usando.
//
// Dal 01/11/2026 al 09/11/2026 il workflow di aggiornamento e' fallito a ogni esecuzione
// (Understat irraggiungibile, contratto xG rosso) e il sito ha continuato a mostrare previsioni
// calcolate su un dataset di otto giorni prima senza dirlo: nessuna pagina leggeva
// `generated_at`. Un dataset vecchio non solleva niente — produce previsioni plausibili con
// risultati mancanti — quindi va dichiarato (MISTAKES.md, «Il sito e' rimasto fermo»).
//
// Il workflow gira quattro volte al giorno: oltre 36 ore significa almeno sei esecuzioni
// consecutive senza pubblicazione, cioe' un guasto e non un ritardo.
export const STALE_AFTER_HOURS = 36;

export function datasetFreshness(payload, now = new Date()) {
  const generated = new Date(String(payload?.generated_at || ""));
  if (Number.isNaN(generated.getTime())) return { stale: true, ageHours: null, generatedAt: null };
  const ageHours = (now.getTime() - generated.getTime()) / 3_600_000;
  return { stale: ageHours > STALE_AFTER_HOURS, ageHours, generatedAt: generated };
}

export function freshnessMessage(freshness) {
  if (!freshness.stale) return "";
  if (!freshness.generatedAt) return "Data di aggiornamento dei dati sconosciuta: le previsioni potrebbero non includere gli ultimi risultati.";
  const days = Math.floor(freshness.ageHours / 24);
  const date = freshness.generatedAt.toISOString().slice(0, 10);
  return `Dati fermi al ${date} (${days} ${days === 1 ? "giorno" : "giorni"} fa): le previsioni non tengono conto dei risultati successivi.`;
}
