/**
 * Minimal .xlsx reader.
 *
 * Wet-lab metadata lives in Excel far more often than in TSV, and the people
 * this tool is for are the least likely to convert it themselves. Refusing
 * .xlsx pushes the very first step back onto the user, which defeats the point.
 *
 * An .xlsx file is a zip of XML parts. Only three are needed — the worksheet,
 * the shared-string table, and the style table — so this reads them directly
 * rather than taking on a spreadsheet dependency, keeping the package free of
 * runtime dependencies.
 *
 * Decompression uses the platform's own `DecompressionStream('deflate-raw')`,
 * which exists in modern browsers and in Node 22+. There is no bundled inflate
 * implementation; if the runtime lacks it, this says so rather than failing
 * obscurely.
 */

export interface XlsxSheet {
  name: string;
  /** Rows of cells as strings; short rows are padded to the widest row. */
  rows: string[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  data: Uint8Array;
}

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits at the end, after a comment of
  // unknown length, so it has to be found by scanning backwards.
  let eocd = -1;
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === SIGNATURE_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error(
      'This does not look like an .xlsx file (no zip directory found). If it is an old .xls, re-save it as .xlsx or export it as CSV.',
    );
  }

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length) break;
    if (view.getUint32(offset, true) !== SIGNATURE_CENTRAL) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );

    // The local header repeats the name and extra fields with its own lengths,
    // which are not always the same as the central directory's.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      method,
      data: bytes.subarray(start, start + compressedSize),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflate(entry: ZipEntry): Promise<string> {
  if (entry.method === 0) return new TextDecoder().decode(entry.data);

  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser cannot decompress .xlsx files (DecompressionStream is unavailable). Please save the file as CSV or TSV instead.',
    );
  }

  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream('deflate-raw');
  } catch {
    throw new Error(
      'This browser does not support raw deflate decompression, which .xlsx requires. Please save the file as CSV or TSV instead.',
    );
  }

  // Copy: the entry is a view into a larger buffer, and Response wants its own.
  const response = new Response(
    new Blob([new Uint8Array(entry.data)]).stream().pipeThrough(stream),
  );
  return response.text();
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    // Ampersand last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/g, '&');
}

/** Excel stores repeated text once, in a shared-string table. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const si of xml.match(/<si[^>]*>[\s\S]*?<\/si>/g) ?? []) {
    // A single cell's text can be split across several <t> runs by inline
    // formatting; they concatenate.
    const runs = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
    strings.push(decodeEntities(runs.join('')));
  }
  return strings;
}

/**
 * Which cell styles represent dates.
 *
 * Excel stores dates as plain numbers, distinguished only by their number
 * format. Guessing from the value's magnitude — as a first version of this
 * did — turns any number in the right range into a date, so a plate barcode
 * or a numeric sample ID silently becomes "2038-04-17". The style table is
 * the only reliable signal.
 */
function parseDateStyles(stylesXml: string | undefined): Set<number> {
  const dateStyles = new Set<number>();
  if (!stylesXml) return dateStyles;

  // Built-in formats that are dates or times.
  const builtinDateFormats = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
  ]);

  // Custom formats: a format code containing date/time tokens outside of
  // quoted literal text.
  const customDateFormats = new Set<number>();
  for (const match of stylesXml.matchAll(
    /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g,
  )) {
    const id = Number(match[1]);
    if (isDateFormatCode(decodeEntities(match[2]))) customDateFormats.add(id);
  }

  // cellXfs maps a cell's style index to a number format.
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1];
  if (!cellXfs) return dateStyles;

  const xfs = cellXfs.match(/<xf[^>]*\/?>/g) ?? [];
  for (let i = 0; i < xfs.length; i++) {
    const id = Number(/numFmtId="(\d+)"/.exec(xfs[i])?.[1] ?? '0');
    if (builtinDateFormats.has(id) || customDateFormats.has(id)) {
      dateStyles.add(i);
    }
  }

  return dateStyles;
}

/**
 * Does a custom number format describe a date or time?
 *
 * Only letters OUTSIDE literal text count. Two kinds of literal have to be
 * removed first: quoted strings ("Day "0), and bracketed tokens. Brackets
 * carry colours and locales — `0.00;[Red]-0.00` is the standard "negatives in
 * red" format, and `[$-409]` a locale tag — and the "d" in Red once turned an
 * entire numeric column into dates. The bracketed forms that ARE time tokens,
 * `[h]`, `[mm]` and `[ss]` for elapsed time, are kept.
 */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!(?:h+|m+|s+)\])[^\]]*\]/gi, '');
  return /[ymdhs]/i.test(stripped);
}

/** "BC12" -> 54 (zero-based). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let index = 0;
  for (const character of letters) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Excel serial number to ISO date.
 *
 * Day 1 is 1900-01-01, but Excel wrongly treats 1900 as a leap year, so
 * serials at or above 60 are one day ahead of reality. Subtracting 25569 maps
 * onto the Unix epoch and absorbs that offset for every date after 1900-03-01,
 * which is every date that appears in practice.
 */
function excelSerialToIso(serial: number): string {
  const milliseconds = Math.round((serial - 25569) * 86400000);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return String(serial);

  const iso = date.toISOString();
  // Whole days carry no useful time component; keep those short.
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function parseSheet(
  xml: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
): string[][] {
  const rows: string[][] = [];

  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];

    // Cells may be self-closing (empty) or wrap a value.
    for (const cellXml of rowXml.match(/<c[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = /r="([A-Z]+\d+)"/.exec(cellXml)?.[1];
      const type = /t="([^"]+)"/.exec(cellXml)?.[1];
      const style = /s="(\d+)"/.exec(cellXml)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cellXml)?.[1];

      let text = '';
      if (type === 's' && value !== undefined) {
        text = sharedStrings[Number(value)] ?? '';
      } else if (type === 'inlineStr' && inline !== undefined) {
        text = decodeEntities(inline);
      } else if (type === 'e') {
        // Formula error such as #N/A — treat as blank rather than leaking it.
        text = '';
      } else if (type === 'b' && value !== undefined) {
        text = value === '1' ? 'TRUE' : 'FALSE';
      } else if (value !== undefined) {
        const numeric = Number(value);
        text =
          style !== undefined &&
          dateStyles.has(Number(style)) &&
          Number.isFinite(numeric)
            ? excelSerialToIso(numeric)
            : decodeEntities(value);
      }

      const index = ref ? columnIndex(ref) : cells.length;
      cells[index] = text;
    }

    rows.push(cells);
  }

  // Normalise ragged rows so every row has the same width.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) =>
    Array.from({ length: width }, (_, i) => row[i] ?? ''),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a workbook. Sheets are returned in workbook order. */
export async function readXlsx(
  data: ArrayBuffer | Uint8Array,
): Promise<XlsxWorkbook> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = readZipEntries(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  const sharedStringsEntry = byName.get('xl/sharedStrings.xml');
  const stylesEntry = byName.get('xl/styles.xml');
  const workbookEntry = byName.get('xl/workbook.xml');

  const sharedStrings = parseSharedStrings(
    sharedStringsEntry ? await inflate(sharedStringsEntry) : undefined,
  );
  const dateStyles = parseDateStyles(
    stylesEntry ? await inflate(stylesEntry) : undefined,
  );

  /*
   * Sheet display names live in workbook.xml, in workbook order, and each
   * points at its worksheet part through a relationship id. The id has to be
   * followed through xl/_rels/workbook.xml.rels: "sheet1.xml" is NOT
   * necessarily the first sheet. Delete the original first sheet and add a
   * new one and Excel writes sheet2.xml and sheet3.xml, in whatever order the
   * tabs were last dragged into — pairing names with files by number then
   * hands back the wrong sheet under the right name.
   */
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (relsEntry) {
    const relsXml = await inflate(relsEntry);
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]*)"/.exec(match[0])?.[1];
      const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1];
      if (id && target) targets.set(id, resolveWorkbookTarget(decodeEntities(target)));
    }
  }

  const numbered = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => {
      const n = (name: string) => Number(/sheet(\d+)\.xml$/.exec(name)?.[1] ?? 0);
      return n(a.name) - n(b.name);
    });

  const ordered: { name: string; entry: ZipEntry }[] = [];
  if (workbookEntry) {
    const workbookXml = await inflate(workbookEntry);
    const declared = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
      name: /\bname="([^"]*)"/.exec(m[0])?.[1],
      rid: /\br:id="([^"]*)"/.exec(m[0])?.[1],
    }));

    for (const [index, sheet] of declared.entries()) {
      if (sheet.name === undefined) continue;
      const target = sheet.rid ? targets.get(sheet.rid) : undefined;
      // Without a usable relationship (a workbook written by a tool that
      // omits the part), fall back to pairing by position — the only
      // interpretation left, and right whenever sheets were never reordered.
      const entry = (target ? byName.get(target) : undefined) ?? numbered[index];
      if (entry) ordered.push({ name: decodeEntities(sheet.name), entry });
    }
  }

  if (ordered.length === 0) {
    for (const [index, entry] of numbered.entries()) {
      ordered.push({ name: `Sheet${index + 1}`, entry });
    }
  }

  if (ordered.length === 0) {
    throw new Error('The workbook contains no worksheets.');
  }

  const sheets: XlsxSheet[] = [];
  for (const { name, entry } of ordered) {
    sheets.push({
      name,
      rows: parseSheet(await inflate(entry), sharedStrings, dateStyles),
    });
  }

  return { sheets };
}

/**
 * Relationship targets are written relative to xl/ ("worksheets/sheet1.xml")
 * or, less often, absolute from the package root ("/xl/worksheets/sheet1.xml").
 * Both are mapped onto the zip entry name.
 */
function resolveWorkbookTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  if (target.startsWith('xl/')) return target;
  return `xl/${target}`;
}

/**
 * Read a workbook and return one sheet as tab-separated text, so it can be
 * handed to the existing table and metadata parsers unchanged.
 *
 * @param sheetName which sheet to take; the first by default.
 */
export async function xlsxToTsv(
  data: ArrayBuffer | Uint8Array,
  sheetName?: string,
): Promise<string> {
  const { sheets } = await readXlsx(data);

  const sheet = sheetName
    ? sheets.find((s) => s.name === sheetName)
    : sheets[0];

  if (!sheet) {
    throw new Error(
      `No sheet named "${sheetName}". Available sheets: ${sheets.map((s) => s.name).join(', ')}.`,
    );
  }

  if (sheet.rows.length === 0) {
    throw new Error(`Sheet "${sheet.name}" is empty.`);
  }

  return `${sheet.rows
    .map((row) =>
      // Tabs and newlines inside a cell would corrupt the output.
      row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ')).join('\t'),
    )
    .join('\n')}\n`;
}

/** True when the bytes begin with a zip signature, as every .xlsx does. */
export function looksLikeXlsx(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}
