import assert from "node:assert/strict";
import fs from "node:fs";
import { estimatePlayerMarkets } from "../model.js";

// Verifica il CONTRATTO tra la pipeline Python e il codice JavaScript che legge i suoi dati,
// sul dataset vero e non su una fixture inventata.
//
// È il test che sarebbe servito prima: il bug che ha azzerato ogni probabilità di ogni
// giocatore (ESPN non espone i minuti giocati, la pipeline li leggeva come 0) non ha rotto
// nessun test, perché tutti i test esistenti giravano su fixture scritte a mano in cui il
// campo "minutes" c'era sempre. Un dato mancante in produzione non produce un'eccezione:
// produce silenziosamente 0% per tutti, e nell'interfaccia sembra una previsione.
//
// Salta senza fallire se data/matches.json non c'è (ambienti di solo codice, CI a monte della
// generazione del dataset): un test di contratto sui dati non deve bloccare chi non ha i dati.

if (!fs.existsSync("data/matches.json")) {
  console.log("SALTATO: data/matches.json non presente, contratto player_context non verificabile");
  process.exit(0);
}

const payload = JSON.parse(fs.readFileSync("data/matches.json", "utf8"));
const playerContext = payload.player_context || {};
const teams = Object.keys(playerContext);
assert.ok(teams.length > 0, "il dataset non contiene alcun player_context");

const NUMERIC_PLAYER_FIELDS = [
  "minutes", "appearances", "starts", "squad_appearances",
  "goals", "assists", "shots", "shots_on_target", "yellow_cards", "red_cards",
  "goals_per90_shrunk", "assists_per90_shrunk", "shots_per90_shrunk",
  "shots_on_target_per90_shrunk", "yellow_per90_shrunk", "red_per90_shrunk",
  "start_probability", "play_probability",
];

let players = 0;
let withMinutes = 0;
let withCards = 0;
let nonZeroScorer = 0;
const formations = new Set();

for (const team of teams) {
  const context = playerContext[team];
  assert.ok(Array.isArray(context.players), `${team}: players non è un array`);
  assert.ok(Array.isArray(context.probable_lineup), `${team}: probable_lineup non è un array`);
  assert.ok(context.formation, `${team}: formation mancante`);
  formations.add(context.formation);

  // La formazione probabile deve essere un undici vero: 11 giocatori, uno solo portiere.
  // Prima della correzione sui ruoli qui finivano moduli come 2-7-1 perché i difensori
  // centrali (CD, CD-L, CD-R) non venivano riconosciuti e confluivano nel centrocampo.
  assert.equal(context.probable_lineup.length, 11, `${team}: formazione con ${context.probable_lineup.length} giocatori`);
  const goalkeepers = context.probable_lineup.filter((player) => player.position === "GK").length;
  assert.ok(goalkeepers <= 1, `${team}: ${goalkeepers} portieri nella formazione probabile`);

  for (const player of context.players) {
    players += 1;
    assert.ok(player.name, `${team}: giocatore senza nome`);
    for (const field of NUMERIC_PLAYER_FIELDS) {
      assert.ok(
        Number.isFinite(Number(player[field])),
        `${team}/${player.name}: campo ${field} assente o non numerico (${player[field]})`,
      );
    }
    assert.ok(player.starts <= player.appearances, `${team}/${player.name}: più partite da titolare che presenze`);
    assert.ok(
      player.appearances <= player.squad_appearances,
      `${team}/${player.name}: più presenze che convocazioni`,
    );
    if (player.minutes > 0) withMinutes += 1;
    if (player.yellow_cards > 0 || player.red_cards > 0) withCards += 1;

    // E soprattutto: il modello deve produrre numeri utilizzabili su OGNI giocatore reale,
    // non solo sulle fixture di test.
    const markets = estimatePlayerMarkets(player, 1.5, 1.4);
    for (const [key, value] of Object.entries(markets)) {
      assert.ok(Number.isFinite(value), `${team}/${player.name}: ${key} non finito (${value})`);
      if (key.endsWith("Probability")) {
        assert.ok(value >= 0 && value <= 1, `${team}/${player.name}: ${key} fuori da [0,1] (${value})`);
      }
    }
    assert.ok(
      markets.multiShotProbability <= markets.shotProbability + 1e-12,
      `${team}/${player.name}: P(2+ tiri) supera P(1+ tiro)`,
    );
    assert.ok(
      markets.shotOnTargetProbability <= markets.shotProbability + 1e-12,
      `${team}/${player.name}: P(tiro in porta) supera P(tiro)`,
    );
    if (markets.anytimeScorerProbability > 0.01) nonZeroScorer += 1;
  }
}

// Le tre soglie che il bug precedente avrebbe violato, tutte e tre in silenzio.
assert.ok(
  withMinutes / players > 0.5,
  `solo ${withMinutes}/${players} giocatori hanno minuti registrati: i minuti non stanno arrivando dalla pipeline`,
);
assert.ok(withCards > 0, "nessun giocatore ha cartellini: la lettura dei cartellini è rotta");
assert.ok(
  nonZeroScorer / players > 0.4,
  `solo ${nonZeroScorer}/${players} giocatori hanno una probabilità di segnare non nulla`,
);
// Un modulo plausibile ha 3, 4 o 5 difensori. La comparsa di 1 o 2 difensori significa che il
// riconoscimento dei ruoli è tornato a rompersi.
for (const formation of formations) {
  const defenders = Number(String(formation).split("-")[0]);
  if (!Number.isFinite(defenders)) continue;
  assert.ok(defenders >= 3 && defenders <= 5, `modulo implausibile nel dataset: ${formation}`);
}

console.log(
  `OK: contratto player_context — ${teams.length} squadre, ${players} giocatori, `
  + `${withMinutes} con minuti, ${withCards} con cartellini, ${formations.size} moduli distinti tutti plausibili`,
);
