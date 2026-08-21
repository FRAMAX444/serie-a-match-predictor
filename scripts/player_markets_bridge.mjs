#!/usr/bin/env node
// Bridge usato SOLO da scripts/validate_player_probabilities.py per validare lo studio
// statistico contro il VERO estimatePlayerMarkets di model.js — non una sua reimplementazione
// Python che potrebbe divergere silenziosamente dalla formula realmente in produzione.
//
// Legge da stdin un array JSON di richieste {player, teamLambda, teamRecentGoalsFor} e scrive
// su stdout l'array dei risultati di estimatePlayerMarkets, nello stesso ordine.
import { estimatePlayerMarkets } from "../model.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let requests;
  try {
    requests = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`JSON in input non valido: ${error.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(requests)) {
    process.stderr.write("Atteso un array JSON di richieste {player, teamLambda, teamRecentGoalsFor}\n");
    process.exit(1);
  }
  const results = requests.map((request) =>
    estimatePlayerMarkets(request.player, request.teamLambda, request.teamRecentGoalsFor)
  );
  process.stdout.write(JSON.stringify(results));
});
