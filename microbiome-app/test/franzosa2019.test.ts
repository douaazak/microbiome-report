/**
 * Second validation dataset: Franzosa et al. 2019, human gut, IBD.
 *
 * Franzosa EA, Sirota-Madi A, Avila-Pacheco J, et al. "Gut microbiome
 * structure and metabolic activity in inflammatory bowel disease."
 * Nature Microbiology 2019;4(2):293-305.
 *
 * The bog-lake dataset checked the arithmetic against published numbers. This
 * one checks something different: that the tool recovers a well-established
 * clinical signal from real patient data, and that it handles the shape of a
 * clinical metadata sheet — constant columns, per-subject identifiers,
 * continuous covariates, medication flags — without being told anything.
 *
 * Data is not committed. Fetch into validation/franzosa2019/:
 *   metadata.tsv and genera.tsv
 * from borenstein-lab/microbiome-metabolome-curated-data. Skips when absent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  alphaDiversity,
  betaDiversity,
  differentialAbundance,
  permanova,
} from 'microbiome-core';

import {
  completeCases,
  groupableColumns,
  groupLabels,
  loadDataset,
  subsetColumns,
} from '../src/lib/load';

const DATA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'validation',
  'franzosa2019',
);

const present =
  existsSync(join(DATA, 'genera.tsv')) && existsSync(join(DATA, 'metadata.tsv'));

/*
 * `describe.skipIf` still EXECUTES the callback in order to collect the test
 * names — it only marks the results skipped. Anything read at the top of that
 * callback therefore runs even when the data is absent, which crashes the
 * suite on a fresh clone. Branching on the condition instead keeps the body
 * from running at all.
 */
if (!present) {
  describe.skip('Franzosa et al. 2019 (human gut, IBD)', () => {
    it('needs validation/franzosa2019/{genera,metadata}.tsv', () => {});
  });
} else {
  describe('Franzosa et al. 2019 (human gut, IBD)', () => {
  const read = (name: string) => readFileSync(join(DATA, name), 'utf8');

  const dataset = loadDataset({
    kind: 'asv',
    tableText: read('genera.tsv'),
    metadataText: read('metadata.tsv'),
    // No taxonomy file: the feature names are already genus names.
  });

  const labels = groupLabels(dataset.metadata, 'Study.Group');
  const keep = completeCases(labels);
  const groups = keep.map((i) => labels[i] as string);
  const values = subsetColumns(dataset.table.values, keep);
  const sampleIds = keep.map((i) => dataset.table.sampleIds[i]);

  const inGroup = (name: string) =>
    keep.filter((_, index) => groups[index] === name);

  describe('loading', () => {
    it('transposes a samples-as-rows table using the metadata', () => {
      // This collection stores samples as rows, the opposite of the QIIME2
      // convention. Getting it wrong would analyse genera as if they were
      // samples, and nothing downstream would look obviously wrong.
      expect(dataset.diagnostics.join(' ')).toMatch(
        /Samples were found in the row labels/,
      );
      // 220 samples x 11,720 features, the right way round. The earlier
      // assertion here compared the two counts, which is meaningless: a
      // feature table normally has far more features than samples whichever
      // orientation it started in.
      expect(dataset.table.sampleIds).toHaveLength(220);
      expect(dataset.table.featureIds.length).toBeGreaterThan(10000);
    });

    it('finds the three clinical groups', () => {
      expect([...new Set(groups)].sort()).toEqual(['CD', 'Control', 'UC']);
      // Roughly the published cohort composition.
      expect(inGroup('CD').length).toBeGreaterThan(50);
      expect(inGroup('Control').length).toBeGreaterThan(30);
      expect(inGroup('UC').length).toBeGreaterThan(50);
    });

    it('offers only columns that can define groups', () => {
      const { usable, excluded } = groupableColumns(
        dataset.metadata,
        dataset.table.sampleIds.length,
      );
      const names = usable.map((c) => c.name);
      expect(names).toContain('Study.Group');

      const excludedNames = excluded.map((c) => c.name);
      // Constant across every sample.
      expect(excludedNames).toContain('Dataset');
      expect(excludedNames).toContain('Publication.Name');
      // One value per sample, so it defines no groups.
      expect(excludedNames).toContain('Subject');

      // "Sample" is absent from BOTH lists because it was consumed as the
      // sample ID column rather than kept as a variable — the first column,
      // "Dataset", is a constant study label and cannot identify samples.
      expect(names).not.toContain('Sample');
      expect(excludedNames).not.toContain('Sample');
    });

    it('names genera recognisably, unlike the environmental dataset', () => {
      const names = dataset.table.featureIds.join(' ');
      // If these are missing, feature naming has regressed — this dataset has
      // near-complete genus assignment, so "Unclassified" should be rare.
      expect(names).toMatch(/Bacteroides/);
      expect(names).toMatch(/Faecalibacterium/);
    });
  });

  describe('the published biology', () => {
    it('shows lower diversity in Crohn’s disease than in controls', () => {
      // The most reproduced finding in the IBD microbiome literature.
      const shannon = alphaDiversity(values, sampleIds, ['shannon'], {
        isCounts: dataset.isCounts,
      }).values.shannon;

      const mean = (name: string) => {
        const v = shannon.filter((_, i) => groups[i] === name);
        return v.reduce((a, b) => a + b, 0) / v.length;
      };

      expect(mean('CD')).toBeLessThan(mean('Control'));
    });

    it('separates the groups by community structure', () => {
      const distance = betaDiversity(values, sampleIds, 'braycurtis');
      const result = permanova(distance, groups, 999);

      expect(result.p).toBeLessThan(0.05);
      // Microbiome studies typically report R² of 0.05-0.15 for a clinical
      // grouping; most variation is between individuals. A very high value
      // here would suggest something wrong rather than something remarkable.
      expect(result.r2).toBeGreaterThan(0.01);
      expect(result.r2).toBeLessThan(0.4);
    });

    it('recovers the canonical CD signature: Faecalibacterium down, Escherichia up', () => {
      // Compare CD against Control only — the pairwise default. An all-groups
      // test would say a taxon differs "somewhere" without direction.
      const pairIndices = keep.filter(
        (_, index) => groups[index] === 'CD' || groups[index] === 'Control',
      );
      const pairGroups = groups.filter((g) => g === 'CD' || g === 'Control');

      const result = differentialAbundance(
        subsetColumns(dataset.table.values, pairIndices),
        dataset.table.featureIds,
        pairGroups,
        { minPrevalence: 0.1 },
      );

      const find = (needle: string) =>
        result.results.find((r) =>
          r.featureId.toLowerCase().includes(needle.toLowerCase()),
        );

      const faecalibacterium = find('Faecalibacterium');
      expect(faecalibacterium).toBeDefined();
      // Depleted in CD: mean CLR abundance lower in CD than Control.
      expect(faecalibacterium!.groupMeans.CD).toBeLessThan(
        faecalibacterium!.groupMeans.Control,
      );

      const escherichia = find('Escherichia');
      if (escherichia) {
        expect(escherichia.groupMeans.CD).toBeGreaterThan(
          escherichia.groupMeans.Control,
        );
      }
    });
  });
});
}
