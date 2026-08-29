// Unica sorgente di verità per gli input che raggiungono predictFromMatches senza descrivere
// QUALE partita si sta prevedendo.
//
// R14 (prompt sessione 3 §2): produzione e misura devono ricevere gli stessi input. Fino al
// 27/08/2026 non era così — app.js passava `teamContext` e `refereeStats`, nessuno script di
// backtest li passava — quindi ogni log loss prodotto in due sessioni descriveva un modello
// diverso da quello che gira sul sito. Non era una configurazione: era un bug, e nessun test
// poteva accorgersene perché i due chiamanti si costruivano le opzioni a mano, ciascuno per
// conto proprio.
//
// Da qui in avanti ogni chiamante — la pagina, i backtest, i diagnostici — costruisce le sue
// opzioni come
//
//     { ...modelInputs(...), <sole chiavi di identità della partita> }
//
// così che un input nuovo si aggiunga QUI, e quindi a entrambi i lati, oppure a nessuno dei
// due. La terza opzione che R13 vieta — «usato in produzione e ignorato in misura» — smette
// di essere esprimibile: modelInputs() rifiuta ciò che non è dichiarato, e
// tests/prediction-input-parity.test.js fallisce se un chiamante torna a scriverselo a mano.

// Ciò che decide COME si prevede. I valori qui devono coincidere con i default interni di
// predictFromMatches: la parità è verificata bit per bit dal test, non solo per ispezione.
export const MODEL_INPUT_DEFAULTS = Object.freeze({
  windowDays: 540,
  halfLifeDays: 120,
});

// Ciò che decide QUALE partita si prevede. Cambia a ogni chiamata, quindi non può stare in un
// oggetto condiviso e resta legittimo scriverlo sul posto — è l'unica eccezione ammessa.
export const FIXTURE_IDENTITY_KEYS = Object.freeze([
  "homeTeam",
  "awayTeam",
  "date",
  "cutoffDate",
  "competitionId",
  // La stagione della gara, dal campo `season` della gara o della fixture. È identità e non
  // input del modello: nota in anticipo, priva di risultati, diversa a ogni chiamata. Va
  // passata e non dedotta dall'array — dedurla dava risposte diverse in produzione e in
  // backtest alle aperture di stagione (docs/misure-riferimento.md §19).
  "season",
]);

// Input deliberatamente ESCLUSI, con la misura che li esclude — non dimenticati:
//
// `teamContext` — spento in produzione il 27/08/2026. Misurato con
//   scripts/diag_prod_vs_measured.mjs, confronto appaiato sulle stesse partite dal 2024-08-01:
//   fra.1 +0.0002 ± 0.0010 su 585/621 gare toccate (0.21σ), esp.1 +0.0000 ± 0.0004 su 644/774,
//   ita.1 −0.0000 ± 0.0006 su 478/768, eng.1 0/769 gare toccate. Il fattore perturba fino al
//   94% delle gare francesi e nessuna gara inglese, e non sposta il log loss di una cifra
//   misurabile: è rumore con una struttura di bias per lega, e l'asimmetria non è calcistica —
//   dipende da quali squadre l'enrichment è riuscito a risolvere. Il codice resta in model.js
//   (attackContext/defenseContext) e resta testato: riaccenderlo richiede prima di rendere
//   `player_context` versionato nel tempo, perché lo snapshot attuale è `as_of` posteriore a
//   tutto il dataset e non è retro-applicabile senza leakage (R13).
//
// `refereeStats` — spento in produzione il 27/08/2026, per R13 più che per la misura. Il
//   guadagno apparente di +0.0050 ± 0.0012 (4.2σ) era interamente leakage: compute_referee_stats()
//   calcola il bias di ogni arbitro anche dalla partita da prevedere. Ricalcolato in avanti vale
//   +0.0001 ± 0.0010, cioè zero. In produzione era inerte comunque, perché nessuna fonte usata
//   qui pubblica le designazioni e `fixture.referee` è vuoto per ogni partita futura — ma
//   lasciarlo cablato significava tenere armato un effetto che nessun backtest può vedere.
//   refereeBiasFor() resta in model.js e resta testato.

export function modelInputs(overrides = {}) {
  const unknown = Object.keys(overrides).filter((key) => !(key in MODEL_INPUT_DEFAULTS));
  if (unknown.length) {
    throw new Error(
      `modelInputs: input non dichiarato (${unknown.join(", ")}). `
      + "Un input del modello va aggiunto a MODEL_INPUT_DEFAULTS, così arriva sia alla "
      + "produzione sia ai backtest, oppure a nessuno dei due (R13/R14).",
    );
  }
  const merged = { ...MODEL_INPUT_DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    const numeric = Number(value);
    // Un valore illeggibile ricade sul default invece di propagare NaN dentro il modello:
    // le preferenze arrivano da localStorage e da Firestore, entrambi fuori dal nostro
    // controllo. preferences.js valida già, questa è la seconda rete.
    if (Number.isFinite(numeric) && numeric > 0) merged[key] = numeric;
  }
  return merged;
}
