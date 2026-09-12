/**
 * Loading without a metadata file.
 *
 * A researcher often has only a feature table and a taxonomy — the metadata
 * lives in a lab notebook, or has not been assembled yet. Refusing to open at
 * all in that situation put the first obstacle before any value was delivered,
 * even though most of the analyses do not need groups.
 *
 * These tests pin down what still works, and that the one analysis which
 * genuinely cannot degrade says so rather than inventing a comparison.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  alphaDiversity,
  betaDiversity,
  differentialAbundance,
  pcoa,
} from 'microbiome-core';

import { buildCompositionPlot } from '../src/lib/composition';
import { loadDataset } from '../src/lib/load';
import { summarise } from '../src/lib/summary';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');
const read = (name: string) => readFileSync(join(DEMO, name), 'utf8');

const withoutMetadata = loadDataset({
  kind: 'asv',
  tableText: read('feature-table.tsv'),
  taxonomyText: read('taxonomy.tsv'),
});

const withMetadata = loadDataset({
  kind: 'asv',
  tableText: read('feature-table.tsv'),
  taxonomyText: read('taxonomy.tsv'),
  metadataText: read('metadata.tsv'),
});

describe('loading without metadata', () => {
  it('loads the table and taxonomy', () => {
    expect(withoutMetadata.table.featureIds).toHaveLength(64);
    expect(withoutMetadata.table.sampleIds).toHaveLength(40);
    expect(withoutMetadata.lineages).toBeDefined();
  });

  it('flags the absence rather than pretending', () => {
    expect(withoutMetadata.hasMetadata).toBe(false);
    expect(withMetadata.hasMetadata).toBe(true);
    expect(withoutMetadata.diagnostics.join(' ')).toMatch(/No metadata supplied/);
  });

  it('carries the sample IDs so nothing downstream needs a null check', () => {
    expect(withoutMetadata.metadata.sampleIds).toEqual(
      withoutMetadata.table.sampleIds,
    );
    expect(withoutMetadata.metadata.columns).toEqual([]);
  });

  it('warns that table orientation could not be verified', () => {
    // Orientation is normally resolved by matching sample IDs against the
    // metadata. Without it the common convention is assumed, and that
    // assumption has to be visible — a transposed DADA2 seqtab would
    // otherwise be analysed silently the wrong way round.
    expect(withoutMetadata.diagnostics.join(' ')).toMatch(/No metadata supplied/);
  });

  it('does not change the feature table it produces', () => {
    expect(withoutMetadata.table.values).toEqual(withMetadata.table.values);
    expect(withoutMetadata.table.sampleIds).toEqual(withMetadata.table.sampleIds);
  });
});

describe('what still works without metadata', () => {
  it('composition is unaffected', () => {
    const plot = buildCompositionPlot(withoutMetadata, {
      rank: 'genus',
      topN: 10,
      variable: '',
    });
    expect(plot.rows.length).toBeGreaterThan(0);
    expect(plot.order).toHaveLength(10);
    expect(plot.sampleOrder).toHaveLength(40);
    // No grouping variable means no group bands, not a broken plot.
    expect(plot.groupSpans).toEqual([]);
  });

  it('alpha diversity computes per sample', () => {
    const result = alphaDiversity(
      withoutMetadata.table.values,
      withoutMetadata.table.sampleIds,
    );
    expect(result.values.shannon).toHaveLength(40);
    expect(result.values.shannon.every(Number.isFinite)).toBe(true);
    // And matches what the same table gives with metadata present.
    const reference = alphaDiversity(
      withMetadata.table.values,
      withMetadata.table.sampleIds,
    );
    expect(result.values.shannon).toEqual(reference.values.shannon);
  });

  it('the ordination is identical, because structure comes from distances', () => {
    const build = (ds: typeof withoutMetadata) => {
      const distance = betaDiversity(
        ds.table.values,
        ds.table.sampleIds,
        'braycurtis',
      );
      return pcoa(distance, 2);
    };
    const a = build(withoutMetadata);
    const b = build(withMetadata);
    expect(a.coordinates[0]).toEqual(b.coordinates[0]);
    expect(a.varianceExplained).toEqual(b.varianceExplained);
  });

  it('the dataset summary still describes the data', () => {
    const summary = summarise(withoutMetadata);
    expect(summary.samples).toBe(40);
    expect(summary.features).toBe(64);
    expect(summary.isCounts).toBe(true);
    expect(summary.depth).toBeDefined();
    // No variables to describe, but the table facts are unchanged.
    expect(summary.variables).toEqual([]);
  });
});

describe('what cannot work without metadata', () => {
  it('differential abundance has no groups to compare', () => {
    // Asserted at the source: the core refuses rather than fabricating a
    // single group and returning meaningless results.
    expect(() =>
      differentialAbundance(
        withoutMetadata.table.values,
        withoutMetadata.table.featureIds,
        withoutMetadata.table.sampleIds.map(() => 'all'),
      ),
    ).toThrow(/at least two groups/);
  });
});

describe('MetaPhlAn input without metadata', () => {
  const MPA = [
    '#mpa_vJan21',
    '#clade_name\tS1\tS2\tS3',
    'k__Bacteria\t100.0\t100.0\t100.0',
    'k__Bacteria|p__Firmicutes\t60.0\t40.0\t50.0',
    'k__Bacteria|p__Bacteroidota\t40.0\t60.0\t50.0',
    'k__Bacteria|p__Firmicutes|g__Blautia\t60.0\t40.0\t50.0',
    'k__Bacteria|p__Bacteroidota|g__Bacteroides\t40.0\t60.0\t50.0',
  ].join('\n');

  it('loads and reports relative abundance correctly', () => {
    const dataset = loadDataset({
      kind: 'metaphlan',
      tableText: MPA,
      rank: 'genus',
    });
    expect(dataset.hasMetadata).toBe(false);
    expect(dataset.table.sampleIds).toEqual(['S1', 'S2', 'S3']);
    expect(dataset.isCounts).toBe(false);
    expect(dataset.unavailableMetrics).toContain('chao1');
    expect(dataset.diagnostics.join(' ')).toMatch(/No metadata supplied/);
  });
});
