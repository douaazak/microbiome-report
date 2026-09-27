/**
 * Regression tests for the bugs found in the September 2026 review.
 *
 * Each block names the failure it locks out, and states the wrong value the
 * old code produced, so that a future change that reintroduces it fails here
 * with an explanation rather than just a mismatched number.
 */

import { describe, expect, it } from 'vitest';

import { alphaDiversity, shannon, simpson } from '../src/alpha.js';
import { betaDiversity, permanova } from '../src/beta.js';
import { chiSquareUpperTail, normalUpperTail } from '../src/distributions.js';
import { parseTaxonomyFile } from '../src/taxonomyFile.js';
import { labelAtRank, parseLineage, parseLineages } from '../src/taxonomy.js';
import { wilcoxonRankSum } from '../src/tests.js';

describe('taxonomy files written by R', () => {
  /*
   * write.table(tax_table(ps), sep="\t") writes a header one field shorter
   * than the data rows. Read naively, every rank took the name of the rank
   * above it: genus showed the family name, species showed the genus.
   */
  const rWriteTable =
    'Kingdom\tPhylum\tClass\tOrder\tFamily\tGenus\tSpecies\n' +
    'ASV1\tBacteria\tFirmicutes\tClostridia\tLachnospirales\tLachnospiraceae\tBlautia\tBlautia_wexlerae\n' +
    'ASV2\tBacteria\tBacteroidota\tBacteroidia\tBacteroidales\tMuribaculaceae\tMuribaculum\tMuribaculum_intestinale\n';

  it('shifts the header to match the row-name column', () => {
    const result = parseTaxonomyFile(rWriteTable);
    expect(result.format).toBe('ranks');
    // Previously: d__;p__Bacteria;c__Firmicutes;...;g__Lachnospiraceae;s__Blautia
    expect(result.lineages.get('ASV1')).toBe(
      'd__Bacteria;p__Firmicutes;c__Clostridia;o__Lachnospirales;f__Lachnospiraceae;g__Blautia;s__Blautia_wexlerae',
    );
    expect(result.lineages.get('ASV2')).toBe(
      'd__Bacteria;p__Bacteroidota;c__Bacteroidia;o__Bacteroidales;f__Muribaculaceae;g__Muribaculum;s__Muribaculum_intestinale',
    );
  });

  it('says that it repaired the header rather than doing it silently', () => {
    const result = parseTaxonomyFile(rWriteTable);
    expect(result.warnings.join(' ')).toMatch(/one fewer column/i);
  });

  it('still reads a well-formed header with an ID column unchanged', () => {
    const normal =
      'Feature ID\tKingdom\tPhylum\tClass\n' + 'ASV1\tBacteria\tFirmicutes\tClostridia\n';
    const result = parseTaxonomyFile(normal);
    expect(result.lineages.get('ASV1')).toBe(
      'd__Bacteria;p__Firmicutes;c__Clostridia;o__;f__;g__;s__',
    );
    expect(result.warnings.join(' ')).not.toMatch(/one fewer column/i);
  });
});

describe('quoted taxonomy files', () => {
  /*
   * write.csv quotes everything. Splitting raw left the quotes on the IDs, so
   * "ASV_1" never matched ASV_1 from the feature table and every feature fell
   * through to Unassigned — with no error anywhere.
   */
  it('strips quotes from IDs so they match the feature table', () => {
    const csv =
      '"","Kingdom","Phylum","Class"\n' +
      '"ASV_1","Bacteria","Firmicutes","Bacilli"\n';
    const result = parseTaxonomyFile(csv);
    expect([...result.lineages.keys()]).toEqual(['ASV_1']);
    expect(result.lineages.get('ASV_1')).toContain('p__Firmicutes');
  });

  it('keeps a quoted lineage containing a comma intact', () => {
    const csv =
      'Feature ID,Taxon,Confidence\n' +
      'ASV_1,"d__Bacteria;p__Firmicutes, incertae sedis;c__Bacilli",0.99\n' +
      'ASV_2,"d__Bacteria;p__Bacteroidota;c__Bacteroidia",0.99\n';
    const result = parseTaxonomyFile(csv);
    expect(result.format).toBe('lineage');
    // Previously truncated at the comma to '"d__Bacteria;p__Firmicutes',
    // which also defeated the prefix test and lost the domain.
    expect(result.lineages.get('ASV_1')).toBe(
      'd__Bacteria;p__Firmicutes, incertae sedis;c__Bacilli',
    );
  });
});

describe('placeholder taxon names', () => {
  /*
   * SILVA assigns g__uncultured across many unrelated families. Read as a
   * name it becomes one enormous genus; read as null it becomes
   * "Unclassified <family>", which keeps the families apart.
   */
  it.each([
    'uncultured',
    'Uncultured',
    'uncultured_bacterium',
    'Ambiguous_taxa',
    'unidentified',
    'metagenome',
  ])('treats %s as unassigned rather than a genus', (token) => {
    const parsed = parseLineage(
      `d__Bacteria;p__Firmicutes;c__Clostridia;o__Clostridiales;f__Lachnospiraceae;g__${token}`,
    );
    expect(parsed.ranks[5]).toBeNull();
    expect(parsed.ranks[4]).toBe('Lachnospiraceae');
  });

  it('keeps two uncultured genera in different families distinct', () => {
    const a = parseLineage(
      'd__Bacteria;p__Firmicutes;c__Clostridia;o__Clostridiales;f__Lachnospiraceae;g__uncultured',
    );
    const b = parseLineage(
      'd__Bacteria;p__Firmicutes;c__Clostridia;o__Clostridiales;f__Ruminococcaceae;g__uncultured',
    );
    expect(labelAtRank(a, 'genus')).toBe('Unclassified Lachnospiraceae');
    expect(labelAtRank(b, 'genus')).toBe('Unclassified Ruminococcaceae');
    expect(labelAtRank(a, 'genus')).not.toBe(labelAtRank(b, 'genus'));
  });

  it('does not mistake a real name that merely starts with the token', () => {
    const parsed = parseLineage('d__Bacteria;p__Firmicutes;g__Uncultivatedbacillus');
    expect(parsed.ranks[5]).toBe('Uncultivatedbacillus');
  });
});

describe('mothur bootstrap confidence', () => {
  /*
   * Firmicutes(100) and Firmicutes(98) are the same phylum. Left in the name
   * they are two taxa, so one phylum fragments across a dozen bars and a
   * dozen separately-tested features.
   */
  it('strips confidence from an unprefixed lineage', () => {
    const parsed = parseLineage(
      'Bacteria(100);Firmicutes(100);Clostridia(99);Clostridiales(99);',
    );
    expect(parsed.ranks.slice(0, 4)).toEqual([
      'Bacteria',
      'Firmicutes',
      'Clostridia',
      'Clostridiales',
    ]);
  });

  it('collapses the same taxon assigned at different confidence', () => {
    const high = parseLineage('Bacteria(100);Firmicutes(100)');
    const low = parseLineage('Bacteria(100);Firmicutes(98)');
    expect(high.ranks[1]).toBe(low.ranks[1]);
  });

  it('strips confidence from a prefixed lineage too', () => {
    const parsed = parseLineage('k__Bacteria(100);p__Verrucomicrobia(100)');
    expect(parsed.ranks[1]).toBe('Verrucomicrobia');
  });

  it('leaves parentheses that are part of a name alone', () => {
    const parsed = parseLineage('d__Bacteria;p__Candidatus (Saccharibacteria)');
    expect(parsed.ranks[1]).toBe('Candidatus (Saccharibacteria)');
  });
});

describe('unprefixed tokens inside a prefixed lineage', () => {
  it('places the token at the rank its neighbours imply', () => {
    // Previously dropped, leaving class null and counting the row as a gap.
    const parsed = parseLineage('d__Bacteria;p__Firmicutes;Clostridia;o__Clostridiales');
    expect(parsed.ranks.slice(0, 4)).toEqual([
      'Bacteria',
      'Firmicutes',
      'Clostridia',
      'Clostridiales',
    ]);
    expect(parsed.inferredUnprefixed).toBe(1);
  });

  it('recovers a domain that lost its prefix', () => {
    const parsed = parseLineage('Bacteria;p__Firmicutes;c__Clostridia');
    expect(parsed.ranks.slice(0, 3)).toEqual(['Bacteria', 'Firmicutes', 'Clostridia']);
  });

  it('reports the inference rather than making it silently', () => {
    const { diagnostics } = parseLineages([
      'd__Bacteria;p__Firmicutes;Clostridia;o__Clostridiales',
    ]);
    expect(diagnostics.inferredUnprefixedRows).toBe(1);
  });

  it('never overwrites a rank a prefix already claimed', () => {
    const parsed = parseLineage('d__Bacteria;c__Clostridia;Firmicutes');
    expect(parsed.ranks[2]).toBe('Clostridia');
  });

  it('still pads a genuine gap rather than shifting a lower rank up', () => {
    const parsed = parseLineage('d__Bacteria;p__Firmicutes;g__Blautia');
    expect(parsed.ranks).toEqual([
      'Bacteria',
      'Firmicutes',
      null,
      null,
      null,
      'Blautia',
      null,
    ]);
  });
});

describe('samples with no reads', () => {
  const table = [
    [10, 0, 12],
    [20, 0, 25],
    [5, 0, 4],
  ];
  const ids = ['real1', 'blank', 'real2'];

  it('does not report an empty sample as the most diverse in the study', () => {
    // Previously 1 — the maximum of the Gini-Simpson index.
    expect(simpson([0, 0, 0])).toBeNaN();
    expect(shannon([0, 0, 0])).toBeNaN();
  });

  it('leaves every metric blank for the empty sample', () => {
    const result = alphaDiversity(table, ids, ['shannon', 'simpson', 'observed']);
    expect(result.values.simpson?.[1]).toBeNaN();
    expect(result.values.shannon?.[1]).toBeNaN();
    expect(result.values.simpson?.[0]).toBeGreaterThan(0);
    expect(result.values.simpson?.[0]).toBeLessThan(1);
  });

  it('warns about the empty sample', () => {
    const result = alphaDiversity(table, ids, ['shannon']);
    expect(result.warnings.join(' ')).toMatch(/no reads at all/i);
  });

  it('still warns about uneven depth when an empty sample is present', () => {
    // The fold-change guard used to be `min > 0`, so one empty sample
    // suppressed every depth warning, including about the other samples.
    const uneven = [
      [100, 0, 5000],
      [105, 0, 6000],
    ];
    const result = alphaDiversity(uneven, ['shallow', 'blank', 'deep'], ['shannon']);
    expect(result.warnings.join(' ')).toMatch(/depth varies/i);
  });
});

describe('PERMANOVA with no within-group variation', () => {
  it('refuses a design with one sample per group instead of reporting p = 0.001', () => {
    // Four features down the rows, six samples across the columns.
    const values = [
      [10, 1, 0, 5, 7, 2],
      [1, 12, 3, 0, 2, 8],
      [0, 3, 11, 2, 1, 4],
      [5, 0, 2, 9, 4, 1],
    ];
    const beta = betaDiversity(values, ['a', 'b', 'c', 'd', 'e', 'f'], 'braycurtis');
    // Previously returned { f: NaN, r2: 1, p: 0.001 }.
    expect(() => permanova(beta, ['a', 'b', 'c', 'd', 'e', 'f'], 99)).toThrow(
      /within-group variation/i,
    );
  });

  it('still runs normally when groups have several members', () => {
    const values = [
      [10, 9, 11, 1, 0, 2],
      [8, 9, 7, 2, 1, 0],
      [1, 0, 2, 11, 10, 9],
      [0, 2, 1, 9, 11, 10],
    ];
    const labels = ['ctrl', 'ctrl', 'case', 'case', 'case', 'ctrl'];
    const beta = betaDiversity(values, ['s1', 's2', 's3', 's4', 's5', 's6'], 'braycurtis');
    const result = permanova(beta, labels, 99);
    expect(Number.isFinite(result.f)).toBe(true);
    expect(result.p).toBeGreaterThan(0);
    expect(result.p).toBeLessThanOrEqual(1);
  });
});

describe('p-values in the far tail', () => {
  /*
   * These came back as exactly 0, which then became q = 0 and an infinite
   * -log10 on the volcano plot. A p-value can be tiny; it cannot be zero.
   */
  it('does not underflow the chi-square upper tail to zero', () => {
    expect(chiSquareUpperTail(80, 2)).toBeGreaterThan(0);
    expect(chiSquareUpperTail(100, 1)).toBeGreaterThan(0);
    // True values, from scipy: 4.25e-18 and 1.524e-23.
    expect(chiSquareUpperTail(80, 2)).toBeLessThan(1e-16);
    expect(chiSquareUpperTail(100, 1)).toBeLessThan(1e-20);
  });

  it('does not underflow the normal upper tail to zero', () => {
    expect(normalUpperTail(8.6138)).toBeGreaterThan(0);
    expect(normalUpperTail(20)).toBeGreaterThan(0);
  });

  it('returns a positive p for two perfectly separated groups of 50', () => {
    const a = Array.from({ length: 50 }, (_, i) => i + 1);
    const b = Array.from({ length: 50 }, (_, i) => i + 1001);
    const result = wilcoxonRankSum(a, b);
    // Previously exactly 0; scipy gives 7.066e-18.
    expect(result.p).toBeGreaterThan(0);
    expect(result.p).toBeLessThan(1e-12);
  });

  it('still agrees with the reference value for an ordinary comparison', () => {
    // scipy.stats.mannwhitneyu(..., method='asymptotic', use_continuity=True)
    const result = wilcoxonRankSum([1, 1, 1, 2, 2], [1, 1, 2, 2, 2]);
    expect(result.p).toBeCloseTo(0.63122739, 6);
  });

  it('agrees with the reference chi-square tail where no cancellation occurs', () => {
    expect(chiSquareUpperTail(3.841459, 1)).toBeCloseTo(0.05, 4);
    expect(chiSquareUpperTail(5.991465, 2)).toBeCloseTo(0.05, 4);
    expect(chiSquareUpperTail(9.0, 2)).toBeCloseTo(0.011109, 5);
  });
});
