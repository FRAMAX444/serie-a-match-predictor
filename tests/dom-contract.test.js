import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Contratto fra le pagine HTML e il JavaScript che le pilota.
//
// Difetto del 28/08/2026: schedina.html aveva DUE elementi con id="schedina-legs" — l'<input>
// "Numero di partite" del form e il <div> dei risultati. getElementById restituisce il primo in
// ordine di documento, quindi renderSlip() scriveva le selezioni dentro un <input>, che non
// renderizza figli. La schedina spariva: nessuna eccezione, stato "Fatto.", sezione visibile e
// vuota. Il caso peggiore per chi debugga, perché tutto sembra funzionare.
//
// Due regole, entrambe verificabili staticamente:
//   1. nessun id duplicato in una pagina;
//   2. ogni id che il JS cerca con $("...") deve esistere nella pagina che carica quel modulo.
// La seconda intercetta anche il refuso opposto: rinominare l'elemento e non il chiamante.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const PAGES = fs.readdirSync(root).filter((file) => file.endsWith(".html"));
assert.ok(PAGES.length >= 4, `attese piu' pagine HTML, trovate ${PAGES.length}`);

// --- 1) Nessun id duplicato -----------------------------------------------------------------
for (const page of PAGES) {
  const ids = [...read(page).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(
    [...new Set(duplicates)], [],
    `${page}: id duplicati ${[...new Set(duplicates)].join(", ")}. `
    + "getElementById restituisce il primo in ordine di documento, quindi uno dei due elementi "
    + "diventa irraggiungibile e il codice che lo scrive fallisce in silenzio.",
  );
}

// --- 2) Ogni id cercato dal JS esiste nella pagina che lo carica -----------------------------
// L'associazione pagina -> moduli si legge dai <script type="module"> della pagina stessa,
// seguendo gli import locali di primo livello: un id puo' essere letto da un modulo importato,
// non solo dall'entry point.
function modulesFor(page) {
  const entries = [...read(page).matchAll(/<script[^>]*\ssrc="\.?\/?([^"]+\.js)"/g)].map((match) => match[1]);
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !fs.existsSync(path.join(root, file))) continue;
    seen.add(file);
    for (const match of read(file).matchAll(/from\s+"\.\/([^"]+\.js)"/g)) queue.push(match[1]);
  }
  return [...seen];
}

for (const page of PAGES) {
  const modules = modulesFor(page);
  if (!modules.length) continue;
  const ids = new Set([...read(page).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const missing = new Set();
  for (const file of modules) {
    const source = read(file);
    // Solo la forma `$("id")`, che in questo progetto è sempre getElementById. Gli id costruiti
    // dinamicamente non sono verificabili staticamente e restano fuori dal contratto.
    for (const match of source.matchAll(/\$\("([^"]+)"\)/g)) {
      if (!ids.has(match[1])) missing.add(`${match[1]} (cercato in ${file})`);
    }
  }
  assert.deepEqual(
    [...missing].sort(), [],
    `${page}: il JS cerca id che la pagina non contiene: ${[...missing].join(", ")}`,
  );
}

// --- 3) Nessun risultato dentro un blocco che il CSS nasconde --------------------------------
// Difetto del 28/08/2026: la quota totale della schedina veniva calcolata, scritta in
// #schedina-summary e mai vista da nessuno, perche' ui-cleanup.css nasconde con
// `display: none !important` i <p> dentro `.settings-card__heading` — sono copia esplicativa, e
// quella regola e' giusta. Il difetto e' che un RISULTATO stava in un contenitore riservato alla
// copia. Nessuna eccezione solleva niente: l'elemento esiste, il testo c'e', il pixel no.
//
// La regola: un id in cui il JS scrive non puo' stare dentro un blocco nascosto dal CSS.
// La regola del CSS e' precisa — nasconde i <p> FIGLI DIRETTI dell'intestazione, con le
// eccezioni dichiarate in :not(#...) — e il contratto deve esserlo altrettanto: un <div> dentro
// la stessa intestazione resta visibile ed e' legittimo (settings.html lo fa).
const HIDDEN_RULES = [...read("ui-cleanup.css").matchAll(/^\.([\w-]+__heading) > p((?::not\(#[\w-]+\))*)/gm)]
  .map((match) => ({
    className: match[1],
    exceptions: [...match[2].matchAll(/#([\w-]+)/g)].map((exception) => exception[1]),
  }));
assert.ok(HIDDEN_RULES.length, "ui-cleanup.css non nasconde piu' i <p> delle intestazioni: aggiornare il contratto");

// Estensione di un blocco: dal tag di apertura al </div> che lo chiude, contando l'annidamento.
function blockRanges(html, className) {
  const ranges = [];
  const opener = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "g");
  for (const match of html.matchAll(opener)) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (depth > 0) {
      const next = /<div\b|<\/div>/g;
      next.lastIndex = cursor;
      const tag = next.exec(html);
      if (!tag) break;
      depth += tag[0] === "</div>" ? -1 : 1;
      cursor = tag.index + tag[0].length;
    }
    ranges.push([match.index, cursor]);
  }
  return ranges;
}

for (const page of PAGES) {
  const html = read(page);
  const written = new Set();
  for (const file of modulesFor(page)) {
    const source = read(file);
    for (const match of source.matchAll(/\$\("([^"]+)"\)\.(?:innerHTML|textContent)\s*=/g)) {
      written.add(match[1]);
    }
  }
  for (const { className, exceptions } of HIDDEN_RULES) {
    for (const [from, to] of blockRanges(html, className)) {
      const block = html.slice(from, to);
      for (const paragraph of block.matchAll(/<p[^>]*\sid="([^"]+)"/g)) {
        const id = paragraph[1];
        if (exceptions.includes(id) || !written.has(id)) continue;
        assert.fail(
          `${page}: #${id} riceve un risultato dal JS ma e' un <p> dentro .${className}, che `
          + "ui-cleanup.css nasconde con display:none. Verrebbe scritto e mai mostrato.",
        );
      }
    }
  }
}

// --- 4) Il caso specifico, fissato ----------------------------------------------------------
// Se qualcuno riportasse il contenitore dei risultati sull'id dell'input, la regola 1 lo
// prenderebbe comunque; questo lo dice esplicitamente, così il messaggio spiega il difetto.
const schedina = read("schedina.html");
assert.match(
  schedina, /<input id="schedina-legs"/,
  "schedina-legs deve restare l'input del form: runGeneration ne legge .value",
);
assert.match(
  schedina, /<div id="schedina-selections"/,
  "il contenitore delle selezioni deve avere un id proprio, distinto dall'input",
);

console.log(`OK: contratto DOM — ${PAGES.length} pagine senza id duplicati, ogni id cercato dal JS esiste, nessun risultato in un blocco nascosto dal CSS`);
