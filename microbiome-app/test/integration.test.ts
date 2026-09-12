/**
 * End-to-end check against the demo dataset.
 *
 * A green `vite build` proves the code compiles, not that the analysis works.
 * This runs the same path the UI runs — parse, join, then every analysis —
 * and asserts on the biology the demo data was generated to contain.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  alphaDiversity,
  betaDiversity,
  differentialAbundance,
  labelAtRank,
  pcoa,
  permanova,
} from 'microbiome-core';

import {
  completeCases,
  groupLabels,
  loadDataset,
  subsetColumns,
} from '../src/lib/load';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');
const read = (name: string) => readFileSync(join(DEMO, name), 'utf8');

const dataset = loadDataset({
  kind: 'asv',
  tableText: read('feature-table.tsv'),
  taxonomyText: read('taxonomy.tsv'),
  metadataText: read('metadata.tsv'),
});

describe('loading the demo dataset', () => {
  it('parses the QIIME2-style table and joins it to metadata', () => {
    expect(dataset.table.featureIds).toHaveLength(64);
    expect(dataset.table.sampleIds).toHaveLength(40);
    expect(dataset.isCounts).toBe(true);
    expect(dataset.lineages).toBeDefined();
  });

  it('reports the messy lineages the demo deliberately contains', () => {
    const notes = dataset.diagnostics.join(' ');
    expect(notes).toMatch(/Mixed domain prefixes/);
    expect(notes).toMatch(/whitespace/);
    expect(notes).toMatch(/skip a rank/);
  });

  it('pads the skipped Class rank instead of shifting Order up', () => {
    // The generator drops c__ on every 7th feature (index 3, 10, 17, ...).
    const gapped = dataset.lineages![3];
    expect(gapped.ranks[1]).not.toBeNull(); // phylum present
    expect(gapped.ranks[2]).toBeNull(); // class is the gap
    expect(gapped.ranks[3]).not.toBeNull(); // order stayed at order
    // Order must not have slid into the class slot.
    expect(gapped.ranks[2]).not.toBe(gapped.ranks[3]);
  });

  it('infers metadata column types', () => {
    const types = Object.fromEntries(
      dataset.metadata.columns.map((c) => [c.name, c.type]),
    );
    expect(types.group).toBe('categorical');
    expect(types.age).toBe('continuous');
    expect(types.sex).toBe('categorical');
    // batch is numeric but two-level, so it is a label, not a measurement.
    expect(types.batch).toBe('categorical');
  });
});

describe('analyses on the demo dataset', () => {
  const labels = groupLabels(dataset.metadata, 'group');
  const keep = completeCases(labels);
  const values = subsetColumns(dataset.table.values, keep);
  const sampleIds = keep.map((i) => dataset.table.sampleIds[i]);
  const groups = keep.map((i) => labels[i] as string);

  it('computes every alpha metric on counts', () => {
    const result = alphaDiversity(dataset.table.values, dataset.table.sampleIds);
    expect(result.refused).toEqual([]);
    for (const metric of ['shannon', 'simpson', 'chao1', 'observed']) {
      expect(result.values[metric]).toHaveLength(40);
      expect(result.values[metric].every(Number.isFinite)).toBe(true);
    }
  });

  it('warns about the uneven sequencing depth the demo was built with', () => {
    const result = alphaDiversity(dataset.table.values, dataset.table.sampleIds);
    expect(result.warnings.join(' ')).toMatch(/depth varies/);
  });

  it('separates the two groups by PERMANOVA', () => {
    const distance = betaDiversity(values, sampleIds, 'braycurtis');
    const result = permanova(distance, groups, 999);
    expect(result.p).toBeLessThan(0.05);
    expect(result.r2).toBeGreaterThan(0.05);
  });

  it('produces a usable ordination', () => {
    const distance = betaDiversity(values, sampleIds, 'braycurtis');
    const ordination = pcoa(distance, 2);
    expect(ordination.coordinates).toHaveLength(2);
    expect(ordination.coordinates[0]).toHaveLength(keep.length);
    expect(ordination.varianceExplained[0]).toBeGreaterThan(0);
    expect(ordination.coordinates[0].every(Number.isFinite)).toBe(true);
  });

  /** Genera the demo generator shifts between groups. */
  const PLANTED = new Set([
    'Escherichia-Shigella',
    'Streptococcus',
    'Eggerthella',
    'Faecalibacterium',
    'Roseburia',
    'Akkermansia',
  ]);

  it('ranks the planted taxa above the background', () => {
    const result = differentialAbundance(
      values,
      dataset.table.featureIds,
      groups,
      { minPrevalence: 0.1 },
    );

    const genusOf = new Map(
      dataset.table.featureIds.map((id, i) => [
        id,
        labelAtRank(dataset.lineages![i], 'genus'),
      ]),
    );

    // Ranking is asserted rather than a significance threshold, because
    // whether a given feature clears FDR depends on sample size and noise,
    // while correct ORDERING is the property the method must always have.
    const ranked = result.results
      .filter((r) => r.p !== null)
      .sort((a, b) => (a.p as number) - (b.p as number));

    const topQuarter = ranked
      .slice(0, Math.ceil(ranked.length / 4))
      .map((r) => genusOf.get(r.featureId));

    const plantedInTop = topQuarter.filter((g) => PLANTED.has(g!)).length;
    // The top quarter should be dominated by planted taxa, not background.
    expect(plantedInTop / topQuarter.length).toBeGreaterThan(0.7);
  });

  it('flags planted taxa and not the background at q < 0.05', () => {
    const result = differentialAbundance(
      values,
      dataset.table.featureIds,
      groups,
      { minPrevalence: 0.1 },
    );

    const genusOf = new Map(
      dataset.table.featureIds.map((id, i) => [
        id,
        labelAtRank(dataset.lineages![i], 'genus'),
      ]),
    );

    const hits = result.results.filter((r) => r.q !== null && r.q < 0.05);
    const hitGenera = new Set(hits.map((r) => genusOf.get(r.featureId)));

    expect(hits.length).toBeGreaterThan(0);

    // Every genus that clears FDR should be one that was actually planted.
    // A false positive here would mean the method is not controlling error.
    for (const genus of hitGenera) {
      expect(PLANTED.has(genus!)).toBe(true);
    }

    // And it must discriminate rather than flagging everything.
    expect(hits.length).toBeLessThan(result.testedCount * 0.75);
  });

  it('orders q values consistently with p values', () => {
    const result = differentialAbundance(
      values,
      dataset.table.featureIds,
      groups,
    );
    const tested = result.results.filter((r) => r.p !== null);
    for (const r of tested) {
      expect(r.q).toBeGreaterThanOrEqual((r.p as number) - 1e-12);
    }
  });
});
