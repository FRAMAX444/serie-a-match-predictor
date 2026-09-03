// Scrittore .xlsx minimo, senza dipendenze.
//
// Perche' non una libreria: questo repo non ha `node_modules` e la pipeline Python non ha
// openpyxl ne' pandas. Un .xlsx e' uno zip di XML, e servono qui cinque cose — piu' fogli,
// intestazioni leggibili, numeri veri (non stringhe), riga di intestazione bloccata e filtro
// automatico. Sono ~150 righe, contro l'aggiungere un gestore di pacchetti al progetto.
//
// Limiti dichiarati: nessuna formula, nessun grafico, nessuna formattazione condizionale, e le
// stringhe sono inline (niente sharedStrings) — su decine di migliaia di righe sarebbe uno
// spreco, su qualche centinaio non si nota.
import fs from "node:fs";
import zlib from "node:zlib";

const escape = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
  // I caratteri di controllo non sono ammessi in XML e farebbero rifiutare il file da Excel
  // senza dire quale cella: meglio perderli qui.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

// Stili disponibili nelle celle. L'indice e' la posizione in cellXfs, sotto.
const STYLES = { normale: 0, intestazione: 1, decimale: 2, intero: 3, percento: 4, grassetto: 5, nota: 6, titolo: 7 };

const columnName = (index) => {
  let name = "";
  let value = index;
  while (value >= 0) {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  }
  return name;
};

function cellXml(cell, reference) {
  if (cell === null || cell === undefined || cell === "") return "";
  const { v, style } = typeof cell === "object" && !(cell instanceof Date) ? cell : { v: cell, style: null };
  if (v === null || v === undefined || v === "") return "";
  const s = style ? ` s="${STYLES[style] ?? 0}"` : "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return `<c r="${reference}"${s}><v>${v}</v></c>`;
  }
  return `<c r="${reference}"${s} t="inlineStr"><is><t xml:space="preserve">${escape(v)}</t></is></c>`;
}

function sheetXml(sheet) {
  const rows = sheet.rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${rowIndex + 1}`)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const columns = (sheet.widths || []).length
    ? `<cols>${sheet.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  // L'ordine degli elementi non e' negoziabile: fuori sequenza Excel dichiara il file corrotto
  // e non dice quale elemento. sheetViews prima di cols, cols prima di sheetData, autoFilter dopo.
  const freeze = sheet.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  const filter = sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${columns}<sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

// --- ZIP ------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(raw);
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); // data e ora: irrilevanti, e fissarle rende il file riproducibile
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);   // versione con cui e' stato scritto
    entry.writeUInt16LE(20, 6);   // versione minima per leggerlo
    entry.writeUInt16LE(0, 8);    // flag
    // Il metodo di compressione sta all'offset 10, non 8. Scriverlo all'8 mette 8 nei FLAG
    // (bit 3 = "dimensioni in un data descriptor") e lascia il metodo a 0 = "non compresso":
    // il lettore prende allora i byte deflate come se fossero i dati veri e fallisce sul CRC.
    // Diagnosi identica a mezzo repo: nessuna eccezione dove sta l'errore, un file che sembra
    // scritto bene e si rompe da un'altra parte.
    entry.writeUInt16LE(8, 10);   // deflate
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);

    offset += 30 + nameBuffer.length + deflated.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * Scrive un .xlsx. `sheets`: [{ name, rows, widths?, freezeRow?, autoFilter? }].
 * Una cella e' un numero, una stringa, o { v, style } con style fra:
 * normale, intestazione, decimale, intero, percento, grassetto, nota, titolo.
 */
export function writeWorkbook(filePath, sheets) {
  // Il nome di un foglio ha vincoli veri (31 caratteri, niente []:*?/\) e Excel rifiuta il file
  // senza spiegare quale foglio: si troncano e ripuliscono qui invece di scoprirlo aprendolo.
  const names = sheets.map((sheet) => sheet.name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31));
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((name, index) => `<sheet name="${escape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ["xl/styles.xml", STYLES_XML],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)]),
  ];
  fs.writeFileSync(filePath, zip(files));
  return filePath;
}

// --- Lettura ----------------------------------------------------------------------------------
//
// Serve a leggere l'export "Statistiche Fantacalcio" di Fantagazzetta senza chiedere all'utente
// di convertirlo in CSV: un passaggio manuale in piu' e' un passaggio in cui si sbaglia foglio,
// separatore o codifica.

function unzip(buffer) {
  const parti = new Map();
  let posizione = 0;
  while (posizione + 30 <= buffer.length && buffer.readUInt32LE(posizione) === 0x04034b50) {
    const metodo = buffer.readUInt16LE(posizione + 8);
    const flag = buffer.readUInt16LE(posizione + 6);
    const compressa = buffer.readUInt32LE(posizione + 18);
    const lunghezzaNome = buffer.readUInt16LE(posizione + 26);
    const extra = buffer.readUInt16LE(posizione + 28);
    const nome = buffer.subarray(posizione + 30, posizione + 30 + lunghezzaNome).toString("utf8");
    const inizio = posizione + 30 + lunghezzaNome + extra;
    // Bit 3 = dimensioni scritte DOPO i dati, in un data descriptor: la lunghezza compressa qui
    // vale 0 e i byte non si possono delimitare senza cercare la firma successiva. Nessun
    // produttore di .xlsx lo usa, ma se capita e' meglio dirlo che leggere byte a caso.
    if (flag & 0x08) throw new Error(`${nome}: zip con data descriptor, non supportato`);
    const dati = buffer.subarray(inizio, inizio + compressa);
    parti.set(nome, metodo === 0 ? dati : zlib.inflateRawSync(dati));
    posizione = inizio + compressa;
  }
  if (!parti.size) throw new Error("Non e' un file .xlsx: manca la firma zip iniziale.");
  return parti;
}

const decodifica = (testo) => testo
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, codice) => String.fromCharCode(Number(codice)))
  .replace(/&amp;/g, "&");

const testoDi = (xml) => decodifica([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

const indiceColonna = (riferimento) => {
  const lettere = /^([A-Z]+)/.exec(riferimento || "");
  if (!lettere) return 0;
  return [...lettere[1]].reduce((somma, lettera) => somma * 26 + (lettera.charCodeAt(0) - 64), 0) - 1;
};

/**
 * Legge un foglio di un .xlsx come matrice di stringhe. `foglio` e' l'indice (0 = il primo).
 *
 * Le celle vuote diventano stringa vuota e le righe sono allineate per RIFERIMENTO di colonna,
 * non per ordine di apparizione: Excel omette del tutto le celle vuote, e leggerle in sequenza
 * farebbe scivolare tutte le colonne successive di una posizione — un file che si legge senza
 * errori e con i valori sotto l'intestazione sbagliata.
 */
export function readSheet(filePath, foglio = 0) {
  const parti = unzip(fs.readFileSync(filePath));
  const condivise = parti.has("xl/sharedStrings.xml")
    ? [...parti.get("xl/sharedStrings.xml").toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => testoDi(m[1]))
    : [];
  const nome = `xl/worksheets/sheet${foglio + 1}.xml`;
  if (!parti.has(nome)) throw new Error(`Il file non contiene il foglio numero ${foglio + 1}.`);
  const xml = parti.get(nome).toString("utf8");
  const righe = [];
  for (const [, contenuto] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const riga = [];
    for (const cella of contenuto.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributi = cella[1] || "";
      const corpo = cella[2] || "";
      const colonna = indiceColonna(/r="([A-Z]+\d+)"/.exec(attributi)?.[1]);
      const tipo = /t="([^"]+)"/.exec(attributi)?.[1];
      const valore = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
      let contenutoCella = "";
      if (tipo === "s") contenutoCella = condivise[Number(valore)] ?? "";
      else if (tipo === "inlineStr") contenutoCella = testoDi(corpo);
      else if (valore !== undefined) contenutoCella = decodifica(valore);
      while (riga.length < colonna) riga.push("");
      riga[colonna] = contenutoCella;
    }
    righe.push(riga);
  }
  return righe;
}
