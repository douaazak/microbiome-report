import { describe, expect, it } from 'vitest';

import { differentialAbundance } from '../src/index.js';

/** Six samples: three "control", three "treated". */
const GROUPS = ['ctrl', 'ctrl', 'ctrl', 'trt', 'trt', 'trt'];

/**
 * Deterministic LCG, so "noisy" fixtures are reproducible across runs.
 * A flaky statistical test is worse than no test.
 */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Background features spanning a wide range within each group.
 *
 * The spread matters: CLR references every value to its sample's geometric
 * mean, so one feature changing sharply shifts every other feature's CLR
 * value in the opposite direction. If background features are near-constant,
 * that induced shift separates them perfectly and they look differential.
 * Real data is noisier than the induced shift; these fixtures must be too.
 */
function backgroundFeatures(count: number, nSamples: number, seed = 42): number[][] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, () =>
    Array.from({ length: nSamples }, () => 200 + Math.floor(rng() * 800)),
  );
}

describe('differentialAbundance', () => {
  it('finds a feature that separates the groups', () => {
    // Twelve samples, six per group, so the normal approximation can reach
    // p values well below 0.05 rather than flooring out at small n.
    const groups = [
      'ctrl', 'ctrl', 'ctrl', 'ctrl', 'ctrl', 'ctrl',
      'trt', 'trt', 'trt', 'trt', 'trt', 'trt',
    ];
    const enriched = [10, 12, 11, 9, 13, 10, 900, 880, 920, 910, 890, 905];
    const table = [enriched, ...backgroundFeatures(15, 12)];
    const ids = ['enriched', ...Array.from({ length: 15 }, (_, i) => `bg${i}`)];

    const { results, testedCount, groups: seen } = differentialAbundance(
      table,
      ids,
      groups,
    );

    expect(seen).toEqual(['ctrl', 'trt']);
    expect(testedCount).toBe(16);

    const hit = results.find((r) => r.featureId === 'enriched')!;
    expect(hit.test).toBe('wilcoxon');
    expect(hit.q).toBeLessThan(0.05);
    expect(hit.groupMeans.trt).toBeGreaterThan(hit.groupMeans.ctrl);
    expect(Math.abs(hit.effectSize!)).toBe(1);

    // The planted feature must be the most significant of the set.
    const smallest = Math.min(
      ...results.filter((r) => r.p !== null).map((r) => r.p as number),
    );
    expect(hit.p).toBe(smallest);

    // And the background must not be wholly swept up with it.
    const backgroundHits = results.filter(
      (r) => r.featureId !== 'enriched' && (r.q ?? 1) < 0.05,
    );
    expect(backgroundHits.length).toBeLessThan(8);
  });

  it('uses Kruskal-Wallis for three or more groups', () => {
    const groups = [
      'a', 'a', 'a', 'a',
      'b', 'b', 'b', 'b',
      'c', 'c', 'c', 'c',
    ];
    const graded = [10, 12, 11, 9, 200, 210, 190, 205, 3000, 3100, 2900, 3050];
    const table = [graded, ...backgroundFeatures(15, 12, 7)];
    const ids = ['graded', ...Array.from({ length: 15 }, (_, i) => `bg${i}`)];

    const { results } = differentialAbundance(table, ids, groups);
    const hit = results.find((r) => r.featureId === 'graded')!;

    expect(hit.test).toBe('kruskal-wallis');
    expect(hit.p).toBeLessThan(0.05);
  });

  it('warns that CLR is degenerate on a single feature', () => {
    const { warnings, results } = differentialAbundance(
      [[1, 2, 3, 40, 50, 60]],
      ['only'],
      GROUPS,
    );
    // Every CLR value is log(x) - log(x) = 0, so nothing can differ.
    expect(warnings.join(' ')).toMatch(/degenerate/);
    expect(results[0].p).toBe(1);
  });

  it('warns when the table is too small for CLR to behave', () => {
    const { warnings } = differentialAbundance(
      [
        [10, 12, 11, 900, 880, 920],
        [500, 490, 510, 495, 505, 500],
        [300, 310, 290, 300, 295, 305],
      ],
      ['a', 'b', 'c'],
      GROUPS,
    );
    expect(warnings.join(' ')).toMatch(/Only 3 features/);
  });

  it('excludes low-prevalence features and keeps them out of the FDR denominator', () => {
    const table = [
      [10, 12, 11, 900, 880, 920],
      // Present in one sample only.
      [0, 0, 0, 0, 0, 7],
    ];
    const { results, testedCount } = differentialAbundance(
      table,
      ['common', 'rare'],
      GROUPS,
      { minPrevalence: 0.5 },
    );

    const rare = results.find((r) => r.featureId === 'rare')!;
    expect(rare.p).toBeNull();
    expect(rare.q).toBeNull();
    expect(rare.excludedReason).toMatch(/below the/);

    // Only the surviving feature counts toward multiple testing.
    expect(testedCount).toBe(1);
    expect(results.find((r) => r.featureId === 'common')!.q).not.toBeNull();
  });

  it('refuses to test undersized groups and says so', () => {
    const table = [[1, 2, 3, 4, 5, 6]];
    const { results, warnings, testedCount } = differentialAbundance(
      table,
      ['f1'],
      ['a', 'a', 'a', 'a', 'a', 'b'], // group b has n = 1
      { minGroupSize: 3 },
    );

    expect(testedCount).toBe(0);
    expect(results[0].p).toBeNull();
    expect(warnings.join(' ')).toMatch(/below the minimum size/);
  });

  it('still reports group means for excluded features', () => {
    const table = [[0, 0, 0, 0, 0, 7]];
    const { results } = differentialAbundance(table, ['rare'], GROUPS, {
      minPrevalence: 0.5,
    });
    expect(Number.isFinite(results[0].groupMeans.ctrl)).toBe(true);
    expect(Number.isFinite(results[0].groupMeans.trt)).toBe(true);
  });

  it('rejects mismatched inputs rather than guessing', () => {
    expect(() =>
      differentialAbundance([[1, 2, 3]], ['a', 'b'], ['x', 'y', 'z']),
    ).toThrow(/does not match featureIds/);

    expect(() =>
      differentialAbundance([[1, 2, 3]], ['a'], ['x', 'y']),
    ).toThrow(/does not match groupLabels/);
  });

  it('requires at least two groups', () => {
    expect(() =>
      differentialAbundance([[1, 2, 3]], ['a'], ['x', 'x', 'x']),
    ).toThrow(/at least two groups/);
  });

  it('produces q values that are never below their raw p', () => {
    const table = Array.from({ length: 20 }, (_, i) => [
      10 + i, 12 + i, 11 + i, 30 + i, 28 + i, 32 + i,
    ]);
    const ids = table.map((_, i) => `f${i}`);
    const { results } = differentialAbundance(table, ids, GROUPS);

    for (const r of results) {
      if (r.p !== null && r.q !== null) {
        expect(r.q).toBeGreaterThanOrEqual(r.p - 1e-12);
      }
    }
  });
});
