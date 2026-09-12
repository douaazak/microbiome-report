/**
 * Convert an .xlsx metadata sheet to the TSV the tool reads.
 *
 * This exists because microbiome-report cannot open Excel files, which is a
 * real gap rather than an inconvenience: wet-lab metadata is kept in Excel far
 * more often than in TSV, and the audience this tool targets is exactly the
 * one least likely to convert it themselves. Until the app reads .xlsx
 * directly, this bridges it.
 *
 * Usage: node xlsx-to-tsv.mjs <input.xlsx> <output.tsv> [--sheet NAME]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node xlsx-to-tsv.mjs <input.xlsx> <output.tsv>');
  process.exit(1);
}

/**
 * Minimal zip reader. An .xlsx is a zip of XML parts; pulling out two of them
 * is far less machinery than a spreadsheet dependency, and keeps this script
 * runnable with nothing installed.
 */
function readZip(buffer) {
  const files = new Map();

  // Locate the end-of-central-directory record, scanning back from the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a zip file (no end-of-central-directory record).');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra fields, with its own lengths.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');

/** Excel stores repeated text once, in a shared-strings table. */
function readSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    // A cell's text can be split across several <t> runs by formatting.
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
    strings.push(decodeEntities(parts.join('')));
  }
  return strings;
}

const columnIndex = (ref) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Excel serial date -> ISO. Day 1 is 1900-01-01, with the 1900 leap bug. */
function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

const zip = readZip(readFileSync(input));
const sharedStrings = readSharedStrings(
  zip.get('xl/sharedStrings.xml')?.toString('utf8'),
);

const sheetName = [...zip.keys()].find((k) => /^xl\/worksheets\/sheet1\.xml$/.test(k));
if (!sheetName) throw new Error('No worksheet found in the workbook.');
const sheet = zip.get(sheetName).toString('utf8');

const rows = [];
for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
  const cells = [];
  for (const cellXml of rowXml.match(/<c[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
    const ref = /r="([A-Z]+\d+)"/.exec(cellXml)?.[1] ?? 'A1';
    const type = /t="([^"]+)"/.exec(cellXml)?.[1];
    const style = /s="(\d+)"/.exec(cellXml)?.[1];
    const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
    const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cellXml)?.[1];

    let value = '';
    if (type === 's' && raw !== undefined) value = sharedStrings[Number(raw)] ?? '';
    else if (type === 'inlineStr' && inline !== undefined) value = decodeEntities(inline);
    else if (raw !== undefined) {
      const n = Number(raw);
      // Excel keeps dates as serial numbers; a styled numeric in a plausible
      // range is almost always a date in a metadata sheet.
      value = style && Number.isFinite(n) && n > 20000 && n < 60000
        ? excelDate(n)
        : raw;
    }

    cells[columnIndex(ref)] = value;
  }
  rows.push(cells);
}

if (rows.length < 2) throw new Error('The sheet has no data rows.');

const width = Math.max(...rows.map((r) => r.length));
const lines = rows.map((row) =>
  Array.from({ length: width }, (_, i) => (row[i] ?? '').replace(/[\t\r\n]/g, ' ')).join('\t'),
);

writeFileSync(output, `${lines.join('\n')}\n`);
console.log(`${rows.length - 1} rows x ${width} columns -> ${output}`);
console.log(`columns: ${rows[0].slice(0, width).join(', ')}`);
