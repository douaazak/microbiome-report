/**
 * Regressions from a robustness sweep against awkward but realistic inputs.
 *
 * Three of these previously loaded *successfully* and produced wrong results:
 * negative abundances, duplicated feature IDs and duplicated sample columns.
 * Silent wrongness is the failure mode this project exists to avoid, so each
 * now raises an error naming the offending value.
 *
 * The rest were files a user would reasonably supply that the parser could
 * not read — Excel's quoted CSV, European semicolon-separated exports, and
 * trailing delimiters.
 */

import { describe, expect, it } from 'vitest';

import { parseFeatureTable, splitDelimited, thinLabels } from '../src/index.js';

const TABLE = [
  '#OTU ID\tS1\tS2\tS3',
  'ASV_1\t10\t20\t30',
  'ASV_2\t5\t0\t15',
].join('\n');

const SAMPLES = ['S1', 'S2', 'S3'];

describe('integrity checks that previously passed silently', () => {
  it('rejects negative abundances', () => {
    // Left alone this flows through composition and diversity looking fine,
    // and only fails much later inside the CLR transform.
    expect(() =>
      parseFeatureTable(TABLE.replace('\t10\t', '\t-10\t'), {
        knownSampleIds: SAMPLES,
      }),
    ).toThrow(/negative value: "-10"/);
  });

  it('suggests the likely cause of a negative value', () => {
    expect(() =>
      parseFeatureTable(TABLE.replace('\t10\t', '\t-10\t'), {
        knownSampleIds: SAMPLES,
      }),
    ).toThrow(/log-transformed or already-normalised/);
  });

  it('rejects duplicate feature IDs', () => {
    // Two rows named the same double-count that taxon in every composition
    // plot and inflate observed richness.
    expect(() =>
      parseFeatureTable(`${TABLE}\nASV_1\t9\t9\t9`, {
        knownSampleIds: SAMPLES,
      }),
    ).toThrow(/duplicate feature IDs: ASV_1/);
  });

  it('rejects duplicate sample columns', () => {
    expect(() =>
      parseFeatureTable('#OTU ID\tS1\tS1\tS3\nASV_1\t1\t2\t3', {
        knownSampleIds: SAMPLES,
      }),
    ).toThrow(/duplicate column names: S1/);
  });

  it('lists only the first few duplicates, then elides', () => {
    const many = [
      '#OTU ID\tS1',
      ...Array.from({ length: 14 }, (_, i) => `ASV_${i % 7}\t1`),
    ].join('\n');
    expect(() => parseFeatureTable(many, { knownSampleIds: ['S1'] })).toThrow(
      /…/,
    );
  });
});

describe('formats a user would reasonably supply', () => {
  it('reads quoted CSV, as Excel writes it', () => {
    const csv = [
      '"#OTU ID","S1","S2"',
      '"ASV_1","10","20"',
      '"ASV_2","5","7"',
    ].join('\n');
    const { table } = parseFeatureTable(csv, { knownSampleIds: ['S1', 'S2'] });
    expect(table.featureIds).toEqual(['ASV_1', 'ASV_2']);
    expect(table.sampleIds).toEqual(['S1', 'S2']);
    expect(table.values).toEqual([
      [10, 20],
      [5, 7],
    ]);
  });

  it('keeps a delimiter that sits inside a quoted field', () => {
    const csv = ['"#OTU ID","S1","S2"', '"ASV,1","10","20"'].join('\n');
    const { table } = parseFeatureTable(csv, { knownSampleIds: ['S1', 'S2'] });
    expect(table.featureIds).toEqual(['ASV,1']);
  });

  it('reads semicolon-separated files, as Excel writes them in Europe', () => {
    const eu = TABLE.replace(/\t/g, ';');
    const { table } = parseFeatureTable(eu, { knownSampleIds: SAMPLES });
    expect(table.sampleIds).toEqual(SAMPLES);
    expect(table.values[0]).toEqual([10, 20, 30]);
  });

  it('ignores a trailing delimiter on every line', () => {
    const trailing = TABLE.split('\n')
      .map((line) => `${line}\t`)
      .join('\n');
    const { table, warnings } = parseFeatureTable(trailing, {
      knownSampleIds: SAMPLES,
    });
    // Without this the blank final column becomes a phantom sample named "".
    expect(table.sampleIds).toEqual(SAMPLES);
    expect(warnings.join(' ')).toMatch(/trailing empty column/);
  });

  it('does not mistake a genuinely empty last sample for a trailing delimiter', () => {
    // The column is named, so it is a real sample that happens to be all zero.
    const withEmptySample = [
      '#OTU ID\tS1\tS2\tS3',
      'ASV_1\t10\t20\t',
      'ASV_2\t5\t0\t',
    ].join('\n');
    const { table } = parseFeatureTable(withEmptySample, {
      knownSampleIds: SAMPLES,
    });
    expect(table.sampleIds).toEqual(SAMPLES);
    expect(table.values[0]).toEqual([10, 20, 0]);
  });
});

describe('splitDelimited', () => {
  it('splits plain lines unchanged', () => {
    expect(splitDelimited('a\tb\tc', '\t')).toEqual(['a', 'b', 'c']);
  });

  it('unwraps quoted fields', () => {
    expect(splitDelimited('"a","b"', ',')).toEqual(['a', 'b']);
  });

  it('keeps delimiters inside quotes', () => {
    expect(splitDelimited('"a,1","b"', ',')).toEqual(['a,1', 'b']);
  });

  it('collapses a doubled quote to a literal quote', () => {
    expect(splitDelimited('"a""b"', ',')).toEqual(['a"b']);
  });

  it('treats a mid-field quote as data, not as a delimiter', () => {
    // 5" is a measurement, not the start of a quoted field.
    expect(splitDelimited('5" pipe,10', ',')).toEqual(['5" pipe', '10']);
  });

  it('preserves empty fields', () => {
    expect(splitDelimited('a,,c', ',')).toEqual(['a', '', 'c']);
  });
});

describe('thinLabels', () => {
  const labels = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);

  it('keeps every label when they all fit', () => {
    expect(thinLabels(labels(10), 40)).toHaveLength(10);
    expect(thinLabels(labels(40), 40)).toHaveLength(40);
  });

  it('never returns more than asked for', () => {
    // The whole point: a band axis draws one tick per category, so 1,387
    // samples would otherwise render 1,387 overlapping labels.
    for (const n of [41, 100, 400, 1387, 5000]) {
      expect(thinLabels(labels(n), 40).length).toBeLessThanOrEqual(40);
    }
  });

  it('spaces the kept labels evenly', () => {
    const kept = thinLabels(labels(100), 10);
    const indices = kept.map((l) => Number(l.slice(1)));
    const gaps = indices.slice(1).map((v, i) => v - indices[i]);
    expect(new Set(gaps).size).toBe(1);
  });

  it('always keeps the first label, so the axis has an anchor', () => {
    expect(thinLabels(labels(1387), 40)[0]).toBe('S0');
  });

  it('returns labels that exist in the input', () => {
    const input = labels(500);
    for (const label of thinLabels(input, 40)) {
      expect(input).toContain(label);
    }
  });

  it('handles degenerate requests', () => {
    expect(thinLabels(labels(10), 0)).toEqual([]);
    expect(thinLabels([], 40)).toEqual([]);
  });
});
