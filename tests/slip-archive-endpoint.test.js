import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARCHIVE_FILE, ARCHIVE_ENDPOINT } from "../slip-history.js";

// Contratto fra il client e l'unico endpoint di scrittura del progetto.
//
// E' il confine su cui questo progetto ha gia' perso dati piu' volte: due lati che concordano
// "in teoria" sul nome di un campo o di un percorso. Qui il client scrive su ARCHIVE_ENDPOINT e
// rilegge ARCHIVE_FILE: se il server servisse un percorso diverso, o accettasse una forma
// diversa da { series, wins }, la schedina verrebbe salvata "con successo" e non si rileggerebbe
// mai piu' — cioe' esattamente il difetto che l'archivio su disco esiste per chiudere.
//
// Il test scrive davvero sul file dell'archivio, quindi ne salva e ne ripristina il contenuto.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(root, ARCHIVE_FILE);
const backup = fs.existsSync(archivePath) ? fs.readFileSync(archivePath) : null;

const port = 8300 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, ["scripts/serve.mjs", "--port", String(port)], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
});

function restore() {
  if (backup === null) fs.rmSync(archivePath, { force: true });
  else fs.writeFileSync(archivePath, backup);
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server non partito sulla porta ${port}`)), 8000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("in ascolto")) { clearTimeout(timer); resolve(); }
    });
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server uscito con codice ${code}`)); });
  });

  const base = `http://127.0.0.1:${port}`;
  const archive = {
    version: 1,
    series: [{ id: "test-1", generatedAt: "2026-08-29T12:00:00.000Z", competitionId: "ita.1", slips: [] }],
    wins: [{ id: "test-1#0", generatedAt: "2026-08-29T12:00:00.000Z", combinedOdds: 4.2, legs: [] }],
  };

  const written = await fetch(`${base}${ARCHIVE_ENDPOINT}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(archive),
  });
  assert.equal(written.status, 200, "PUT sull'endpoint deve scrivere l'archivio");
  assert.deepEqual(await written.json(), { ok: true, series: 1, wins: 1 });

  // La rilettura passa dal file statico, non dall'endpoint: e' la strada che funziona anche
  // quando il sito e' servito da GitHub Pages, dove nessuno puo' scrivere.
  const reread = await fetch(`${base}/${ARCHIVE_FILE}`, { cache: "no-store" });
  assert.equal(reread.status, 200);
  const body = await reread.json();
  assert.deepEqual(body.series, archive.series, "cio' che si rilegge deve essere cio' che si e' scritto");
  assert.deepEqual(body.wins, archive.wins);
  assert.ok(fs.existsSync(archivePath), `l'archivio deve esistere su disco in ${ARCHIVE_FILE}`);

  // Una forma sbagliata deve essere rifiutata, non scritta: sovrascrivere l'archivio con
  // qualcosa che il client rilegge come vuoto e' la perdita di dati che vogliamo evitare.
  const rifiutata = await fetch(`${base}${ARCHIVE_ENDPOINT}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ series: "no" }),
  });
  assert.equal(rifiutata.status, 422);
  const invalida = await fetch(`${base}${ARCHIVE_ENDPOINT}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: "{rotto",
  });
  assert.equal(invalida.status, 400);
  assert.deepEqual((await (await fetch(`${base}/${ARCHIVE_FILE}`)).json()).series, archive.series,
    "una richiesta rifiutata non deve aver toccato il file");

  assert.equal((await fetch(`${base}${ARCHIVE_ENDPOINT}`)).status, 405, "GET sull'endpoint non e' una lettura valida");

  // Il resto del server statico non deve essere cambiato da questa aggiunta.
  assert.equal((await fetch(`${base}/schedina.html`)).status, 200);
  assert.equal((await fetch(`${base}/non-esiste.html`)).status, 404);

  console.log("OK: archivio schedine su disco — PUT, rilettura statica, forme rifiutate");
} finally {
  server.kill();
  restore();
}
