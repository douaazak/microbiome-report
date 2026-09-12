/**
 * Tests for the .xlsx reader.
 *
 * Fixtures are built here rather than committed as binaries, so what is being
 * tested is visible in the source: a zip is assembled from stored (method 0)
 * entries, which exercises every parsing path except inflate itself. Inflate
 * is covered by the real-file test at the bottom, which runs only when the
 * validation dataset is present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isDateFormatCode, looksLikeXlsx, readXlsx, xlsxToTsv } from '../src/index.js';

// ---------------------------------------------------------------------------
// Build a minimal .xlsx in memory, using stored (uncompressed) zip entries.
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let table = (crc32 as unknown as { table?: Uint32Array }).table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    (crc32 as unknown as { table?: Uint32Array }).table = table;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, 0, true); // stored
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const total =
    locals.reduce((s, l) => s + l.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

interface SheetSpec {
  rows: string;
  styles?: string;
  shared?: string[];
  sheetName?: string;
}

function makeXlsx({ rows, styles, shared = [], sheetName = 'Sheet1' }: SheetSpec) {
  const sharedXml = `<?xml version="1.0"?><sst count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((s) => `<si><t>${s}</t></si>`)
    .join('')}</sst>`;

  return buildZip([
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0"?><workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    {
      name: 'xl/styles.xml',
      content:
        styles ??
        `<?xml version="1.0"?><styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`,
    },
  ]);
}

describe('looksLikeXlsx', () => {
  it('recognises a zip signature', () => {
    expect(looksLikeXlsx(makeXlsx({ rows: '<row r="1"></row>' }))).toBe(true);
  });

  it('rejects plain text', () => {
    expect(looksLikeXlsx(new TextEncoder().encode('SampleID\tgroup'))).toBe(
      false,
    );
  });
});

describe('readXlsx', () => {
  it('reads shared strings and inline values', async () => {
    const xlsx = makeXlsx({
      shared: ['SampleID', 'group', 'S1', 'control'],
      rows:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows).toEqual([
      ['SampleID', 'group'],
      ['S1', 'control'],
    ]);
  });

  it('uses the sheet name from the workbook', async () => {
    const xlsx = makeXlsx({ rows: '<row r="1"></row>', sheetName: 'Metadata' });
    expect((await readXlsx(xlsx)).sheets[0].name).toBe('Metadata');
  });

  it('places cells by their column reference, not their order', async () => {
    // A blank B leaves a gap that only the r="C1" reference reveals.
    const xlsx = makeXlsx({
      shared: ['left', 'right'],
      rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    expect(sheets[0].rows[0]).toEqual(['left', '', 'right']);
  });

  it('pads ragged rows to a common width', async () => {
    const xlsx = makeXlsx({
      shared: ['a', 'b', 'c'],
      rows:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>0</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    expect(sheets[0].rows[1]).toHaveLength(3);
  });

  it('decodes XML entities, ampersand last', async () => {
    const xlsx = makeXlsx({
      shared: ['A &amp; B', '&lt;tag&gt;', '&amp;lt;'],
      rows:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    // "&amp;lt;" must decode to the literal "&lt;", not to "<".
    expect(sheets[0].rows[0]).toEqual(['A & B', '<tag>', '&lt;']);
  });

  it('joins formatted text split across runs', async () => {
    const shared = `<?xml version="1.0"?><sst><si><t>Sample</t><t>ID</t></si></sst>`;
    const xlsx = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook><sheets><sheet name="S"/></sheets></workbook>',
      },
      { name: 'xl/sharedStrings.xml', content: shared },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      },
    ]);
    const { sheets } = await readXlsx(xlsx);
    expect(sheets[0].rows[0][0]).toBe('SampleID');
  });

  it('reads booleans and blanks formula errors', async () => {
    const xlsx = makeXlsx({
      rows:
        '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c>' +
        '<c r="C1" t="e"><v>#N/A</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    expect(sheets[0].rows[0]).toEqual(['TRUE', 'FALSE', '']);
  });
});

describe('date handling', () => {
  /** numFmtId 14 is the built-in short date; style index 1 uses it. */
  const DATE_STYLES = `<?xml version="1.0"?><styleSheet><cellXfs count="2">
      <xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

  it('converts a date-styled serial to ISO', async () => {
    // 38534 = 2005-07-01, the first collection date in the study sheet.
    const xlsx = makeXlsx({
      styles: DATE_STYLES,
      rows: '<row r="1"><c r="A1" s="1"><v>38534</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    expect(sheets[0].rows[0][0]).toBe('2005-07-01');
  });

  it('leaves an unstyled number of the same magnitude alone', async () => {
    // This is the regression the style table exists to prevent: a numeric
    // barcode or plate ID in the date range must not become a date.
    const xlsx = makeXlsx({
      styles: DATE_STYLES,
      rows: '<row r="1"><c r="A1"><v>38534</v></c></row>',
    });
    const { sheets } = await readXlsx(xlsx);
    expect(sheets[0].rows[0][0]).toBe('38534');
  });

  it('recognises a custom date format code', async () => {
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="180" formatCode="yyyy\\-mm\\-dd"/></numFmts>
      <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="180"/></cellXfs></styleSheet>`;
    const xlsx = makeXlsx({
      styles,
      rows: '<row r="1"><c r="A1" s="1"><v>38534</v></c></row>',
    });
    expect((await readXlsx(xlsx)).sheets[0].rows[0][0]).toBe('2005-07-01');
  });

  it('does not mistake a quoted literal for a date token', async () => {
    // formatCode '"Day "0' contains a "d" only inside quoted text.
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="181" formatCode="&quot;Day &quot;0"/></numFmts>
      <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="181"/></cellXfs></styleSheet>`;
    const xlsx = makeXlsx({
      styles,
      rows: '<row r="1"><c r="A1" s="1"><v>38534</v></c></row>',
    });
    expect((await readXlsx(xlsx)).sheets[0].rows[0][0]).toBe('38534');
  });

  it('does not mistake a colour or locale tag for a date token', async () => {
    // "Negatives in red" is the most common custom format Excel writes, and
    // the "d" in [Red] once turned a whole numeric column into dates.
    const styles = `<?xml version="1.0"?><styleSheet>
      <numFmts><numFmt numFmtId="182" formatCode="0.00;[Red]\\-0.00"/></numFmts>
      <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="182"/></cellXfs></styleSheet>`;
    const xlsx = makeXlsx({
      styles,
      rows: '<row r="1"><c r="A1" s="1"><v>38534</v></c></row>',
    });
    expect((await readXlsx(xlsx)).sheets[0].rows[0][0]).toBe('38534');
  });

  it('classifies format codes by their tokens outside literals', () => {
    expect(isDateFormatCode('yyyy-mm-dd')).toBe(true);
    expect(isDateFormatCode('[h]:mm:ss')).toBe(true);
    expect(isDateFormatCode('[$-409]d-mmm-yy')).toBe(true);
    expect(isDateFormatCode('0.00;[Red]-0.00')).toBe(false);
    expect(isDateFormatCode('[Blue]#,##0')).toBe(false);
    expect(isDateFormatCode('"Day "0')).toBe(false);
    expect(isDateFormatCode('0.00E+00')).toBe(false);
    expect(isDateFormatCode('#,##0\\d')).toBe(false);
  });
});

describe('sheet order', () => {
  it('follows the workbook relationships, not the file numbering', async () => {
    // The original Sheet1 was deleted and a new sheet added, so the files are
    // sheet2.xml and sheet3.xml — and the tabs were dragged so that sheet3
    // comes first in the workbook.
    const sheetXml = (cell: string) =>
      `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${cell}</t></is></c></row></sheetData></worksheet>`;
    const xlsx = buildZip([
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0"?><workbook><sheets>' +
          '<sheet name="Metadata" sheetId="3" r:id="rId9"/>' +
          '<sheet name="Notes" sheetId="2" r:id="rId4"/>' +
          '</sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<?xml version="1.0"?><Relationships>' +
          '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
          '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet3.xml"/>' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '</Relationships>',
      },
      { name: 'xl/worksheets/sheet2.xml', content: sheetXml('notes') },
      { name: 'xl/worksheets/sheet3.xml', content: sheetXml('metadata') },
    ]);

    const { sheets } = await readXlsx(xlsx);
    expect(sheets.map((s) => s.name)).toEqual(['Metadata', 'Notes']);
    expect(sheets[0].rows[0][0]).toBe('metadata');
    expect(sheets[1].rows[0][0]).toBe('notes');
    expect(await xlsxToTsv(xlsx, 'Metadata')).toBe('metadata\n');
  });

  it('pairs names by position when the relationships part is absent', async () => {
    const xlsx = makeXlsx({ rows: '<row r="1"></row>', sheetName: 'Only' });
    expect((await readXlsx(xlsx)).sheets.map((s) => s.name)).toEqual(['Only']);
  });
});

describe('xlsxToTsv', () => {
  it('produces tab-separated text the table parsers can read', async () => {
    const xlsx = makeXlsx({
      shared: ['SampleID', 'group', 'S1', 'control'],
      rows:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>',
    });
    expect(await xlsxToTsv(xlsx)).toBe('SampleID\tgroup\nS1\tcontrol\n');
  });

  it('replaces tabs and newlines inside cells rather than corrupting the file', async () => {
    const xlsx = makeXlsx({
      shared: ['a\tb', 'c\nd'],
      rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
    });
    expect(await xlsxToTsv(xlsx)).toBe('a b\tc d\n');
  });

  it('names the available sheets when asked for one that does not exist', async () => {
    const xlsx = makeXlsx({ rows: '<row r="1"></row>', sheetName: 'Only' });
    await expect(xlsxToTsv(xlsx, 'Missing')).rejects.toThrow(
      /Available sheets: Only/,
    );
  });
});

describe('rejecting what it cannot read', () => {
  it('explains itself when given something that is not a zip', async () => {
    const text = new TextEncoder().encode('SampleID,group\nS1,control\n');
    await expect(readXlsx(text)).rejects.toThrow(/does not look like an .xlsx/);
  });
});

// ---------------------------------------------------------------------------
// The real study spreadsheet — exercises deflate, which the fixtures do not.
// ---------------------------------------------------------------------------

const REAL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'validation',
  'linz2017',
  'NTL-MO_sample_metadata.xlsx',
);

describe.skipIf(!existsSync(REAL))('the Linz et al. 2017 metadata sheet', () => {
  it('reads all 1,387 samples and 13 columns', async () => {
    const { sheets } = await readXlsx(readFileSync(REAL));
    expect(sheets).toHaveLength(1);
    const { rows } = sheets[0];
    expect(rows).toHaveLength(1388); // header + samples
    expect(rows[0]).toHaveLength(13);
    expect(rows[0][0]).toBe('sample_name');
    expect(rows[0]).toContain('lake');
    expect(rows[0]).toContain('region_sampled');
  });

  it('converts the collection dates to ISO', async () => {
    const { sheets } = await readXlsx(readFileSync(REAL));
    const dateColumn = sheets[0].rows[0].indexOf('collection_date');
    expect(sheets[0].rows[1][dateColumn]).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('carries the same duplicated sample ID as the OTU table, and is refused', async () => {
    const tsv = await xlsxToTsv(readFileSync(REAL));
    const { parseMetadata } = await import('../src/index.js');

    /*
     * "TBE05NOV07 R1" appears twice in this sheet — the same duplication
     * already found in the study's OTU table header. Two files produced by
     * different steps of their pipeline carry it independently, so it is a
     * defect in the sample bookkeeping rather than an export accident.
     *
     * Refusing is correct: a repeated sample ID makes the join between table
     * and metadata ambiguous, and silently keeping one row would attach the
     * wrong metadata to a real sample. The message names the offending ID so
     * it can be fixed.
     */
    expect(() => parseMetadata(tsv)).toThrow(/TBE05NOV07 R1/);
  });

  it('parses once the duplicate row is removed', async () => {
    const tsv = await xlsxToTsv(readFileSync(REAL));
    const { parseMetadata } = await import('../src/index.js');

    const lines = tsv.split('\n').filter((l) => l.length > 0);
    const seen = new Set<string>();
    const deduplicated = lines.filter((line, index) => {
      if (index === 0) return true;
      const id = line.split('\t')[0];
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const metadata = parseMetadata(`${deduplicated.join('\n')}\n`);
    expect(metadata.sampleIds).toHaveLength(1386);

    const lake = metadata.columns.find((c) => c.name === 'lake')!;
    expect(lake.type).toBe('categorical');
    expect(lake.levels).toHaveLength(8);

    const region = metadata.columns.find((c) => c.name === 'region_sampled')!;
    expect(region.levels).toEqual([
      'epilimnion',
      'hypolimnion',
      'whole_water_column',
    ]);
  });
});
