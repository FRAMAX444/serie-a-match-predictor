#!/usr/bin/env node
// Esegue Python con qualunque nome abbia su questo sistema.
//
// `python3` esiste su Linux/WSL/macOS ma su Windows è solo un segnaposto del Microsoft Store
// che stampa un messaggio e non esegue nulla; `python` esiste su Windows ma non su Linux/WSL.
// Scrivere l'uno o l'altro dentro package.json rompe metà delle installazioni, e il modo in
// cui si rompe è particolarmente sgradevole: il comando esce subito, quindi sembra che il
// progetto non funzioni invece che il nome dell'eseguibile essere sbagliato.
//
// Uso: node scripts/python.mjs -m unittest discover -s tests -p "test_*.py"
import { spawnSync } from "node:child_process";

// L'ordine conta: `py` (il launcher ufficiale di Windows) prima di `python3`, perché su
// Windows `python3` risponde ma non esegue — e va quindi verificato, non solo trovato.
const CANDIDATES = process.platform === "win32"
  ? ["py", "python", "python3"]
  : ["python3", "python", "py"];

// Un candidato vale solo se stampa davvero una versione: il segnaposto dello Store esce con
// codice 9009 o stampa il messaggio di installazione, e non deve essere scambiato per Python.
function resolvePython() {
  for (const command of CANDIDATES) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8", shell: false });
    if (probe.error || probe.status !== 0) continue;
    if (/^Python \d+\.\d+/.test(`${probe.stdout}${probe.stderr}`.trim())) return command;
  }
  return null;
}

const python = resolvePython();
if (!python) {
  console.error(
    "Python non trovato. Provati: " + CANDIDATES.join(", ") + ".\n"
    + "Installa Python 3 da https://www.python.org/downloads/ (su Windows spunta "
    + '"Add python.exe to PATH" durante l\'installazione).',
  );
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
