#!/usr/bin/env node
// Server statico per lo sviluppo locale: `npm start`.
//
// Esiste per togliere di mezzo un problema che non c'entra nulla con l'app. Il comando
// suggerito finora era `python -m http.server`, ma il nome dell'eseguibile Python cambia da
// sistema a sistema: su Windows con l'installer ufficiale è `python` (e `python3` esiste solo
// come segnaposto del Microsoft Store, che stampa un messaggio e non avvia niente), su
// Linux/WSL e macOS moderni è `python3` (e `python` non esiste affatto). Qualunque dei due si
// scriva nel README, metà degli utenti riceve "comando non trovato" e una pagina che non si
// apre — senza che ci sia alcun problema nel codice.
//
// Node è già richiesto dal progetto (test, backtest, tuning) e qui basta la sua libreria
// standard: nessuna dipendenza da installare, nessun `npx` che scarica pacchetti, stesso
// comando su ogni sistema.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Il tipo MIME non è un dettaglio estetico: un browser rifiuta di eseguire un modulo ES
// servito con un content-type diverso da JavaScript, e la pagina resta bianca senza errori di
// rete. È il modo più comune in cui un server statico improvvisato "sembra funzionare" mentre
// l'app non parte.
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function parsePort(argv) {
  const flagIndex = argv.indexOf("--port");
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : argv.find((value) => /^\d+$/.test(value));
  const port = Number(raw ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Porta non valida: ${raw}`);
  }
  return port;
}

// Risolve l'URL in un percorso dentro ROOT, o null se ne esce. Senza questo controllo una
// richiesta come /../../qualcosa servirebbe file fuori dal progetto: è un server di sviluppo,
// ma resta raggiungibile da tutta la rete locale.
function resolveRequestPath(requestUrl) {
  const { pathname } = new URL(requestUrl, "http://localhost");
  const decoded = decodeURIComponent(pathname);
  const candidate = path.resolve(ROOT, `.${path.posix.normalize(decoded)}`);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) return path.join(candidate, "index.html");
  } catch {
    return candidate;
  }
  return candidate;
}

const server = http.createServer((request, response) => {
  const filePath = resolveRequestPath(request.url || "/");
  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("403 percorso fuori dal progetto");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`404 ${path.relative(ROOT, filePath)} non trovato`);
      console.error(`404 ${request.method} ${request.url}`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      // Il dataset viene rigenerato spesso: una cache locale nasconderebbe le modifiche e
      // farebbe sembrare che la pipeline non abbia funzionato.
      "Cache-Control": "no-store",
    });
    response.end(content);
    console.log(`200 ${request.method} ${request.url}`);
  });
});

try {
  const port = parsePort(process.argv.slice(2));
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Porta ${port} già occupata. Prova: npm start -- --port ${port + 1}`);
    } else {
      console.error(`Server non avviato: ${error.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(port, () => {
    console.log(`Match Predictor in ascolto su http://localhost:${port}`);
    console.log(`Cartella servita: ${ROOT}`);
    if (!fs.existsSync(path.join(ROOT, "data", "matches.json"))) {
      console.warn("Attenzione: data/matches.json non esiste, l'app mostrerà un errore di caricamento.");
    }
    console.log("Ctrl+C per fermare.");
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
