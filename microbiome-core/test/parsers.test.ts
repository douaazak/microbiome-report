import { describe, expect, it } from 'vitest';

import {
  describeLineageDiagnostics,
  hasGap,
  joinTableAndMetadata,
  labelAtRank,
  looksLikeRelativeAbundance,
  parseFeatureTable,
  parseLineage,
  parseLineages,
  parseMetadata,
  parseMetaPhlAn,
} from '../src/index.js';

describe('parseLineage', () => {
  it('places each token at the rank its prefix names', () => {
    const { ranks } = parseLineage(
      'd__Bacteria;p__Firmicutes;c__Clostridia;o__Lachnospirales;f__Lachnospiraceae;g__Blautia;s__wexlerae',
    );
    expect(ranks).toEqual([
      'Bacteria',
      'Firmicutes',
      'Clostridia',
      'Lachnospirales',
      'Lachnospiraceae',
      'Blautia',
      'wexlerae',
    ]);
  });

  it('pads a skipped rank instead of shifting lower ranks upward', () => {
    // This is the phyloseq bug: Phylum present, Class absent, Order present.
    // Order must NOT slide into the Class slot.
    const { ranks } = parseLineage(
      'd__Bacteria;p__Cyanobacteria;o__Pleurocapsales;g__Stanieria',
    );
    expect(ranks[1]).toBe('Cyanobacteria'); // phylum
    expect(ranks[2]).toBeNull(); // class — the gap
    expect(ranks[3]).toBe('Pleurocapsales'); // order stays put
    expect(ranks[5]).toBe('Stanieria'); // genus
    expect(hasGap(ranks)).toBe(true);
  });

  it('treats k__ and d__ as the same rank', () => {
    const withK = parseLineage('k__Bacteria;p__Firmicutes');
    const withD = parseLineage('d__Bacteria;p__Firmicutes');
    expect(withK.ranks).toEqual(withD.ranks);
  });

  it('strips SILVA trailing whitespace', () => {
    const { ranks } = parseLineage('d__Bacteria ; p__Firmicutes ; c__Bacilli ');
    expect(ranks[0]).toBe('Bacteria');
    expect(ranks[1]).toBe('Firmicutes');
    expect(ranks[2]).toBe('Bacilli');
  });

  it('handles the pipe delimiter MetaPhlAn uses', () => {
    const { ranks } = parseLineage('k__Bacteria|p__Firmicutes|g__Blautia');
    expect(ranks[0]).toBe('Bacteria');
    expect(ranks[1]).toBe('Firmicutes');
    expect(ranks[5]).toBe('Blautia');
  });

  it('normalises empty and placeholder assignments to null', () => {
    const { ranks } = parseLineage(
      'd__Bacteria;p__Firmicutes;c__;o__unclassified;f__NA',
    );
    expect(ranks[2]).toBeNull();
    expect(ranks[3]).toBeNull();
    expect(ranks[4]).toBeNull();
  });

  it('falls back to positional reading when no prefixes are present', () => {
    const parsed = parseLineage('Bacteria;Firmicutes;Clostridia');
    expect(parsed.positional).toBe(true);
    expect(parsed.ranks[0]).toBe('Bacteria');
    expect(parsed.ranks[2]).toBe('Clostridia');
  });

  it('ignores MetaPhlAn strain tokens rather than misplacing them', () => {
    const { ranks } = parseLineage(
      'k__Bacteria|p__Firmicutes|s__Blautia_wexlerae|t__SGB4837',
    );
    expect(ranks[6]).toBe('Blautia_wexlerae');
    expect(ranks.length).toBe(7);
  });
});

describe('lineage diagnostics', () => {
  it('reports mixed prefix conventions, gaps and whitespace', () => {
    const { diagnostics } = parseLineages([
      'd__Bacteria;p__Firmicutes;c__Bacilli',
      'k__Bacteria;p__Firmicutes;c__Bacilli',
      'd__Bacteria;p__Cyanobacteria;o__Pleurocapsales',
      'd__Bacteria ; p__Firmicutes ',
    ]);

    expect(diagnostics.total).toBe(4);
    expect(diagnostics.prefixStyle.d).toBe(3);
    expect(diagnostics.prefixStyle.k).toBe(1);
    expect(diagnostics.rowsWithGaps).toBe(1);
    expect(diagnostics.whitespaceTrimmed).toBe(1);

    const messages = describeLineageDiagnostics(diagnostics);
    expect(messages.join(' ')).toMatch(/Mixed domain prefixes/);
    expect(messages.join(' ')).toMatch(/skip a rank/);
  });
});

describe('labelAtRank', () => {
  it('falls back to the nearest populated ancestor', () => {
    const lineage = parseLineage('d__Bacteria;p__Firmicutes');
    expect(labelAtRank(lineage, 'phylum')).toBe('Firmicutes');
    expect(labelAtRank(lineage, 'genus')).toBe('Unclassified Firmicutes');
  });

  it('uses the fallback label when nothing is assigned', () => {
    const lineage = parseLineage('');
    expect(labelAtRank(lineage, 'genus')).toBe('Unassigned');
  });
});

describe('parseFeatureTable', () => {
  const QIIME2 = [
    '# Constructed from biom file',
    '#OTU ID\tS1\tS2\tS3',
    'ASV_1\t10\t20\t30',
    'ASV_2\t5\t0\t15',
  ].join('\n');

  it('reads a QIIME2 export, using the commented header rather than skipping it', () => {
    const { table, warnings } = parseFeatureTable(QIIME2, {
      knownSampleIds: ['S1', 'S2', 'S3'],
    });
    expect(table.featureIds).toEqual(['ASV_1', 'ASV_2']);
    expect(table.sampleIds).toEqual(['S1', 'S2', 'S3']);
    expect(table.values).toEqual([
      [10, 20, 30],
      [5, 0, 15],
    ]);
    expect(warnings.join(' ')).toMatch(/Skipped 1 comment line/);
  });

  it('transposes a DADA2 seqtab, where samples are rows', () => {
    const seqtab = ['\tASV_1\tASV_2', 'S1\t10\t5', 'S2\t20\t0', 'S3\t30\t15'].join(
      '\n',
    );
    const { table, transposed } = parseFeatureTable(seqtab, {
      knownSampleIds: ['S1', 'S2', 'S3'],
    });
    expect(transposed).toBe(true);
    expect(table.sampleIds).toEqual(['S1', 'S2', 'S3']);
    expect(table.featureIds).toEqual(['ASV_1', 'ASV_2']);
    expect(table.values).toEqual([
      [10, 20, 30],
      [5, 0, 15],
    ]);
  });

  it('refuses to guess when neither axis matches the metadata', () => {
    expect(() =>
      parseFeatureTable(QIIME2, { knownSampleIds: ['X1', 'X2'] }),
    ).toThrow(/Neither the row labels nor the column labels match/);
  });

  it('warns when no metadata is available to resolve orientation', () => {
    const { warnings, transposed } = parseFeatureTable(QIIME2);
    expect(transposed).toBe(false);
    expect(warnings.join(' ')).toMatch(/No metadata supplied/);
  });

  it('rejects non-numeric values rather than coercing them', () => {
    const bad = ['#OTU ID\tS1', 'ASV_1\tabc'].join('\n');
    expect(() => parseFeatureTable(bad, { knownSampleIds: ['S1'] })).toThrow(
      /non-numeric value/,
    );
  });

  it('rejects ragged rows', () => {
    const ragged = ['#OTU ID\tS1\tS2', 'ASV_1\t1'].join('\n');
    expect(() => parseFeatureTable(ragged)).toThrow(/fields but the header/);
  });

  it('reads comma-separated files too', () => {
    const csv = ['FeatureID,S1,S2', 'ASV_1,1,2'].join('\n');
    const { table } = parseFeatureTable(csv, { knownSampleIds: ['S1', 'S2'] });
    expect(table.values).toEqual([[1, 2]]);
  });
});

describe('parseMetadata', () => {
  const METADATA = [
    'SampleID\tgroup\tage\tbatch',
    'S1\tcontrol\t34\t1',
    'S2\ttreated\t51\t1',
    'S3\ttreated\t28\t2',
  ].join('\n');

  it('infers categorical and continuous columns', () => {
    const metadata = parseMetadata(METADATA);
    expect(metadata.sampleIds).toEqual(['S1', 'S2', 'S3']);

    const group = metadata.columns.find((c) => c.name === 'group')!;
    expect(group.type).toBe('categorical');
    expect(group.levels).toEqual(['control', 'treated']);

    const age = metadata.columns.find((c) => c.name === 'age')!;
    expect(age.type).toBe('continuous');
    expect(age.values).toEqual([34, 51, 28]);
  });

  it('treats a two-level numeric column as categorical, not a measurement', () => {
    const batch = parseMetadata(METADATA).columns.find(
      (c) => c.name === 'batch',
    )!;
    expect(batch.type).toBe('categorical');
  });

  it('rejects duplicate sample IDs', () => {
    const duplicated = ['SampleID\tgroup', 'S1\ta', 'S1\tb'].join('\n');
    expect(() => parseMetadata(duplicated)).toThrow(/duplicate sample IDs/);
  });
});

describe('joinTableAndMetadata', () => {
  it('intersects samples and reports both kinds of mismatch', () => {
    const { table } = parseFeatureTable(
      ['#OTU ID\tS1\tS2\tS9', 'ASV_1\t1\t2\t3'].join('\n'),
      { knownSampleIds: ['S1', 'S2'] },
    );
    const metadata = parseMetadata(
      ['SampleID\tgroup', 'S1\ta', 'S2\tb', 'S7\ta'].join('\n'),
    );

    const joined = joinTableAndMetadata(table, metadata);
    expect(joined.table.sampleIds).toEqual(['S1', 'S2']);
    expect(joined.table.values).toEqual([[1, 2]]);
    expect(joined.metadata.columns[0].values).toEqual(['a', 'b']);
    expect(joined.warnings.join(' ')).toMatch(/S9/);
    expect(joined.warnings.join(' ')).toMatch(/S7/);
  });

  it('throws when nothing overlaps', () => {
    const { table } = parseFeatureTable(['#OTU ID\tS1', 'ASV_1\t1'].join('\n'));
    const metadata = parseMetadata(['SampleID\tgroup', 'X1\ta'].join('\n'));
    expect(() => joinTableAndMetadata(table, metadata)).toThrow(
      /No sample IDs are shared/,
    );
  });
});

describe('parseMetaPhlAn', () => {
  // Every rank stacked in one file, as MetaPhlAn actually emits.
  const MPA = [
    '#mpa_vJan21_CHOCOPhlAnSGB_202103',
    '#clade_name\tSampleA\tSampleB',
    'k__Bacteria\t100.0\t100.0',
    'k__Bacteria|p__Firmicutes\t60.0\t40.0',
    'k__Bacteria|p__Bacteroidota\t40.0\t60.0',
    'k__Bacteria|p__Firmicutes|g__Blautia\t35.0\t20.0',
    'k__Bacteria|p__Firmicutes|g__Faecalibacterium\t25.0\t20.0',
    'k__Bacteria|p__Bacteroidota|g__Bacteroides\t40.0\t60.0',
  ].join('\n');

  it('extracts a single rank rather than double-counting', () => {
    const { table, warnings, version } = parseMetaPhlAn(MPA, { rank: 'genus' });
    expect(table.featureIds).toEqual([
      'Blautia',
      'Faecalibacterium',
      'Bacteroides',
    ]);
    expect(table.sampleIds).toEqual(['SampleA', 'SampleB']);
    expect(version).toBe('mpa_vJan21_CHOCOPhlAnSGB_202103');
    expect(warnings.join(' ')).toMatch(/Kept 3 of 6 rows/);
  });

  it('picks the phylum rank independently', () => {
    const { table } = parseMetaPhlAn(MPA, { rank: 'phylum' });
    expect(table.featureIds).toEqual(['Firmicutes', 'Bacteroidota']);
    expect(table.values).toEqual([
      [60, 40],
      [40, 60],
    ]);
  });

  it('detects relative abundance and disables richness metrics', () => {
    const { isRelativeAbundance, unavailableMetrics, warnings } =
      parseMetaPhlAn(MPA, { rank: 'genus' });
    expect(isRelativeAbundance).toBe(true);
    expect(unavailableMetrics).toContain('chao1');
    expect(unavailableMetrics).toContain('observed');
    expect(warnings.join(' ')).toMatch(/Shannon, Simpson, Pielou/);
  });

  it('names the ranks available when the requested one is absent', () => {
    expect(() => parseMetaPhlAn(MPA, { rank: 'species' })).toThrow(
      /Ranks present in this file/,
    );
  });

  it('rejects files that are not MetaPhlAn output', () => {
    expect(() =>
      parseMetaPhlAn('featureid\tS1\nASV_1\t10', { rank: 'genus' }),
    ).toThrow(/does not look like MetaPhlAn/);
  });
});

describe('looksLikeRelativeAbundance', () => {
  it('recognises percentages', () => {
    expect(
      looksLikeRelativeAbundance([
        [60.5, 40.5],
        [39.5, 59.5],
      ]),
    ).toBe(true);
  });

  it('recognises percentages that happen to be whole numbers', () => {
    // MetaPhlAn writes "35.0", which parses to an integer. Detection must not
    // depend on finding a fractional value somewhere in the table.
    expect(
      looksLikeRelativeAbundance([
        [60, 40],
        [40, 60],
      ]),
    ).toBe(true);
  });

  it('recognises proportions summing to one', () => {
    expect(
      looksLikeRelativeAbundance([
        [0.6, 0.4],
        [0.4, 0.6],
      ]),
    ).toBe(true);
  });

  it('treats a counts table as counts', () => {
    expect(
      looksLikeRelativeAbundance([
        [1204, 980],
        [3310, 4021],
      ]),
    ).toBe(false);
  });

  it('errs toward relative abundance on the ambiguous case, by design', () => {
    // A counts table whose samples each total exactly 100 is indistinguishable
    // from percentages. Calling it relative abundance disables Chao1; calling
    // it counts would compute Chao1 from proportions and return a meaningless
    // number. The conservative error is the one taken.
    expect(
      looksLikeRelativeAbundance([
        [50, 50],
        [50, 50],
      ]),
    ).toBe(true);
  });
});
