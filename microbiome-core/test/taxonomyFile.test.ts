import { describe, expect, it } from 'vitest';

import { parseTaxonomyFile, parseLineage } from '../src/index.js';

const QIIME2 = [
  'Feature ID\tTaxon\tConfidence',
  'ASV_1\td__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia\t0.99',
  'ASV_2\td__Bacteria;p__Bacteroidota;c__Bacteroidia\t0.97',
].join('\n');

/** The shape mothur, DADA2 and TaxAss produce: one column per rank. */
const RANKS = [
  'OTU,Kingdom,Phylum,Class,Order,Family,Genus,Species',
  'Otu0001,k__Bacteria(100),p__Verrucomicrobia(100),c__[Spartobacteria](99),o__[Chthoniobacterales](99),f__[Chthoniobacteraceae](99),g__CandidatusXiphinematobacter(94),unclassified',
  'Otu0002,k__Bacteria(100),p__Proteobacteria(100),c__Gammaproteobacteria(97),o__Methylococcales(96),f__Crenotrichaceae(75),g__Crenothrix(75),unclassified',
].join('\n');

/** Freshwater TaxAss names its lower three ranks differently. */
const TAXASS = [
  'OTU,Kingdom,Phylum,Class,Order,Lineage,Clade,Tribe',
  'Otu0001,k__Bacteria(100),p__Verrucomicrobia(100),c__Spartobacteria(99),o__Chthoniobacterales(99),f__Chthoniobacteraceae(99),g__CandXiphinematobacter(94),unclassified',
].join('\n');

describe('parseTaxonomyFile — lineage format', () => {
  it('reads a QIIME2 taxonomy export', () => {
    const result = parseTaxonomyFile(QIIME2);
    expect(result.format).toBe('lineage');
    expect(result.lineages.size).toBe(2);
    expect(result.lineages.get('ASV_1')).toBe(
      'd__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia',
    );
  });

  it('does not treat the header as a data row', () => {
    const result = parseTaxonomyFile(QIIME2);
    expect(result.lineages.has('Feature ID')).toBe(false);
  });

  it('accepts comma-separated files', () => {
    const csv = QIIME2.replace(/\t/g, ',');
    expect(parseTaxonomyFile(csv).lineages.size).toBe(2);
  });
});

describe('parseTaxonomyFile — rank-column format', () => {
  it('combines rank columns into a lineage', () => {
    const result = parseTaxonomyFile(RANKS);
    expect(result.format).toBe('ranks');
    expect(result.lineages.size).toBe(2);

    const parsed = parseLineage(result.lineages.get('Otu0001')!);
    expect(parsed.ranks[0]).toBe('Bacteria');
    expect(parsed.ranks[1]).toBe('Verrucomicrobia');
    expect(parsed.ranks[5]).toBe('CandidatusXiphinematobacter');
  });

  it('strips bootstrap confidence values', () => {
    const result = parseTaxonomyFile(RANKS);
    expect(result.lineages.get('Otu0002')).not.toMatch(/\(\d+\)/);
    expect(parseLineage(result.lineages.get('Otu0002')!).ranks[5]).toBe(
      'Crenothrix',
    );
  });

  it('strips brackets marking uncertain placement', () => {
    const parsed = parseLineage(
      parseTaxonomyFile(RANKS).lineages.get('Otu0001')!,
    );
    expect(parsed.ranks[2]).toBe('Spartobacteria');
  });

  it('normalises "unclassified" to unassigned rather than a taxon name', () => {
    const parsed = parseLineage(
      parseTaxonomyFile(RANKS).lineages.get('Otu0001')!,
    );
    // Species column reads "unclassified"; that is absence, not a name.
    expect(parsed.ranks[6]).toBeNull();
  });

  it('maps the freshwater Lineage/Clade/Tribe ranks onto family/genus/species', () => {
    const result = parseTaxonomyFile(TAXASS);
    expect(result.format).toBe('ranks');
    expect(result.rankColumns).toContain('Lineage');
    expect(result.rankColumns).toContain('Tribe');

    const parsed = parseLineage(result.lineages.get('Otu0001')!);
    expect(parsed.ranks[4]).toBe('Chthoniobacteraceae'); // Lineage -> family
    expect(parsed.ranks[5]).toBe('CandXiphinematobacter'); // Clade -> genus
  });

  it('reports which rank columns it used', () => {
    const result = parseTaxonomyFile(RANKS);
    expect(result.rankColumns).toEqual([
      'Kingdom',
      'Phylum',
      'Class',
      'Order',
      'Family',
      'Genus',
      'Species',
    ]);
  });
});

describe('parseTaxonomyFile — refusing what it cannot read', () => {
  it('rejects a rank-style file with unrecognised header names', () => {
    // This is the regression: before, a file like this was read as though
    // column 2 were a full lineage, producing wrong results with no error.
    const unknown = [
      'OTU,Level1,Level2,Level3',
      'Otu0001,Bacteria,Firmicutes,Clostridia',
    ].join('\n');

    expect(() => parseTaxonomyFile(unknown)).toThrow(
      /does not look like a taxonomic lineage/,
    );
  });

  it('names the columns it saw, so the user can fix the header', () => {
    const unknown = ['OTU,Level1,Level2', 'Otu0001,Bacteria,Firmicutes'].join(
      '\n',
    );
    expect(() => parseTaxonomyFile(unknown)).toThrow(/Level1, Level2/);
  });

  it('rejects a single-column file', () => {
    expect(() => parseTaxonomyFile('OTU\nOtu0001')).toThrow(/only one column/);
  });

  it('rejects a file with no data rows', () => {
    expect(() => parseTaxonomyFile('Feature ID\tTaxon')).toThrow(
      /no data rows/,
    );
  });

  it('warns rather than fails when the ID column has an unusual name', () => {
    const odd = [
      'sequence_hash\tTaxon',
      'abc123\td__Bacteria;p__Firmicutes',
    ].join('\n');
    const result = parseTaxonomyFile(odd);
    expect(result.lineages.get('abc123')).toBeDefined();
    expect(result.warnings.join(' ')).toMatch(/sequence_hash/);
  });
});
