/**
 * Tests for the summary and findings layers.
 *
 * The findings module states conclusions in plain language, which makes it the
 * most dangerous code in the app: a wrong statement here is one a wet-lab
 * reader has no way to check. So the assertions below are mostly about
 * restraint — that nothing is claimed without passing its threshold, and that
 * a null result is reported as a null result rather than left silent.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildFindings } from '../src/lib/findings';
import { groupableColumns, loadDataset } from '../src/lib/load';
import { summarise } from '../src/lib/summary';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');
const read = (name: string) => readFileSync(join(DEMO, name), 'utf8');

const dataset = loadDataset({
  kind: 'asv',
  tableText: read('feature-table.tsv'),
  taxonomyText: read('taxonomy.tsv'),
  metadataText: read('metadata.tsv'),
});

describe('summarise', () => {
  const summary = summarise(dataset);

  it('counts samples and features', () => {
    expect(summary.samples).toBe(40);
    expect(summary.features).toBe(64);
    expect(summary.isCounts).toBe(true);
  });

  it('reports group sizes for each categorical variable', () => {
    const group = summary.variables.find((v) => v.name === 'group')!;
    expect(group.type).toBe('categorical');
    expect(group.counts).toEqual([
      { level: 'disease', n: 20 },
      { level: 'healthy', n: 20 },
    ]);
  });

  it('summarises continuous variables by range, not by level', () => {
    const age = summary.variables.find((v) => v.name === 'age')!;
    expect(age.type).toBe('continuous');
    expect(age.counts).toBeUndefined();
    expect(age.range!.min).toBeLessThanOrEqual(age.range!.median);
    expect(age.range!.median).toBeLessThanOrEqual(age.range!.max);
  });

  it('counts missing values rather than dropping them silently', () => {
    // The demo generator writes NA for exactly one age.
    const age = summary.variables.find((v) => v.name === 'age')!;
    expect(age.missing).toBe(1);
  });

  it('raises the uneven depth the demo was built with', () => {
    expect(summary.depth).toBeDefined();
    expect(summary.depth!.fold).toBeGreaterThan(1);
    expect(summary.cautions.join(' ')).toMatch(/depth varies/);
  });

  it('measures sparsity', () => {
    expect(summary.sparsity).toBeGreaterThan(0);
    expect(summary.sparsity).toBeLessThan(1);
  });
});

describe('groupableColumns', () => {
  /**
   * The bug this prevents: a MIMARKS metadata sheet carries fields that are
   * identical for every sample. Offering them in the "compare by" menu makes
   * most choices produce the same empty answer, which reads as the selector
   * being broken rather than as the columns being unusable.
   */
  it('excludes columns with the same value for every sample', () => {
    const metadata = {
      sampleIds: ['S1', 'S2', 'S3', 'S4'],
      columns: [
        {
          name: 'group',
          type: 'categorical' as const,
          values: ['a', 'a', 'b', 'b'],
          levels: ['a', 'b'],
        },
        {
          name: 'env_biome',
          type: 'categorical' as const,
          values: ['freshwater', 'freshwater', 'freshwater', 'freshwater'],
          levels: ['freshwater'],
        },
      ],
    };

    const { usable, excluded } = groupableColumns(metadata, 4);
    expect(usable.map((c) => c.name)).toEqual(['group']);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].name).toBe('env_biome');
    expect(excluded[0].reason).toMatch(/every sample/);
    // The excluded value is named, so the reason is checkable.
    expect(excluded[0].reason).toMatch(/freshwater/);
  });

  it('excludes columns with a different value for every sample', () => {
    const metadata = {
      sampleIds: ['S1', 'S2', 'S3', 'S4'],
      columns: [
        {
          name: 'barcode',
          type: 'categorical' as const,
          values: ['b1', 'b2', 'b3', 'b4'],
          levels: ['b1', 'b2', 'b3', 'b4'],
        },
      ],
    };
    const { usable, excluded } = groupableColumns(metadata, 4);
    expect(usable).toEqual([]);
    expect(excluded[0].reason).toMatch(/different value for every sample/);
  });

  it('keeps every usable column from the demo metadata', () => {
    const { usable, excluded } = groupableColumns(
      dataset.metadata,
      dataset.table.sampleIds.length,
    );
    expect(usable.map((c) => c.name).sort()).toEqual(['batch', 'group', 'sex']);
    expect(excluded).toEqual([]);
  });
});

describe('buildFindings', () => {
  it('produces different results for different variables', () => {
    // Guards the reported symptom "changing the variable does nothing", which
    // turned out to be constant columns rather than a stale computation.
    const byGroup = buildFindings(dataset, 'group');
    const bySex = buildFindings(dataset, 'sex');

    expect(byGroup.groups).toEqual(['disease', 'healthy']);
    expect(bySex.groups).toEqual(['F', 'M']);
    expect(byGroup.findings.length).not.toBe(bySex.findings.length);
  });

  const report = buildFindings(dataset, 'group');

  it('reports the groups it compared and their sizes', () => {
    expect(report.groups).toEqual(['disease', 'healthy']);
    expect(report.groupSizes).toEqual([
      { level: 'disease', n: 20 },
      { level: 'healthy', n: 20 },
    ]);
  });

  it('finds the community-level difference the demo contains', () => {
    const structure = report.findings.find(
      (f) => f.area === 'Community structure',
    );
    expect(structure).toBeDefined();
    expect(structure!.evidence).toMatch(/PERMANOVA/);
    expect(structure!.evidence).toMatch(/R²/);
  });

  it('finds differential taxa and names the strongest', () => {
    const taxa = report.findings.find((f) => f.area === 'Individual taxa');
    expect(taxa).toBeDefined();
    expect(taxa!.statement).toMatch(/differ in abundance/);
    expect(taxa!.evidence).toMatch(/Benjamini-Hochberg/);
  });

  it('never states a finding without numbers behind it', () => {
    for (const finding of report.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.interpretation.length).toBeGreaterThan(0);
      // Every evidence string must cite an actual statistic.
      expect(finding.evidence).toMatch(/p = |q = |R² = /);
    }
  });

  it('accounts for every analysis: found, null, or not run', () => {
    const accounted =
      report.findings.length + report.nullResults.length + report.notRun.length;
    // Community structure, diversity, individual taxa — all three must be
    // reported one way or another. Silence is not an option.
    expect(accounted).toBeGreaterThanOrEqual(3);
  });

  it('states nothing at all when the threshold is impossibly strict', () => {
    const strict = buildFindings(dataset, 'group', { alpha: 1e-12 });
    expect(strict.findings).toHaveLength(0);
    // And says so, rather than going quiet.
    expect(strict.nullResults.length).toBeGreaterThan(0);
  });

  it('reports a null result for a variable with no real signal', () => {
    // Sex is assigned at random by the generator, so nothing should be found.
    const bySex = buildFindings(dataset, 'sex');
    const taxa = bySex.findings.find((f) => f.area === 'Individual taxa');
    expect(taxa).toBeUndefined();
    expect(bySex.nullResults.join(' ')).toMatch(/No individual taxon/);
  });

  it('refuses to test rather than reporting an underpowered comparison', () => {
    const tiny = loadDataset({
      kind: 'asv',
      tableText: read('feature-table.tsv'),
      taxonomyText: read('taxonomy.tsv'),
      // Two samples in one group, one in the other.
      metadataText: ['SampleID\tarm', 'H01\ta', 'H02\ta', 'D01\tb'].join('\n'),
    });
    const report = buildFindings(tiny, 'arm');
    expect(report.findings).toHaveLength(0);
    expect(report.notRun.length).toBeGreaterThan(0);
    expect(report.notRun.join(' ')).toMatch(/fewer than three|smallest group/);
  });
});
