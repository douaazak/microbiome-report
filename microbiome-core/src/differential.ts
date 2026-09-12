/**
 * Differential abundance: CLR transform, then a non-parametric test per
 * feature, then Benjamini-Hochberg FDR across features.
 *
 * This is deliberately a simple, well-understood method rather than a
 * reimplementation of MaAsLin. It handles two groups (Wilcoxon rank-sum) and
 * three or more (Kruskal-Wallis). It does NOT support covariates, random
 * effects, or repeated measures — running MaAsLin 3 under WebR is the planned
 * route for those, and this module should never grow into a half-correct
 * imitation of it.
 */

import { clrTransformTable, DEFAULT_ZERO_REPLACEMENT, type ZeroReplacement } from './clr.js';
import { benjaminiHochberg, kruskalWallis, wilcoxonRankSum } from './tests.js';

export interface DifferentialOptions {
  zeroReplacement?: ZeroReplacement;
  /**
   * Minimum samples per group. Below this the normal / chi-square
   * approximation is unreliable, so the feature is reported as untested
   * rather than given a p-value that looks meaningful and is not.
   */
  minGroupSize?: number;
  /** Drop features present in fewer than this fraction of samples. */
  minPrevalence?: number;
}

export interface FeatureResult {
  featureId: string;
  /** null when the feature was filtered or could not be tested. */
  p: number | null;
  /** Benjamini-Hochberg adjusted p-value across all tested features. */
  q: number | null;
  effectSize: number | null;
  /** Mean CLR value within each group, keyed by group label. */
  groupMeans: Record<string, number>;
  test: 'wilcoxon' | 'kruskal-wallis' | null;
  /** Populated when the feature was not tested, explaining why. */
  excludedReason?: string;
}

export interface DifferentialResult {
  results: FeatureResult[];
  /** Group labels in the order used internally. */
  groups: string[];
  /** Number of features that were actually tested (the FDR denominator). */
  testedCount: number;
  warnings: string[];
}

/**
 * @param table       features (rows) x samples (columns)
 * @param featureIds  one id per row
 * @param groupLabels one group label per column
 */
export function differentialAbundance(
  table: number[][],
  featureIds: string[],
  groupLabels: string[],
  options: DifferentialOptions = {},
): DifferentialResult {
  const {
    zeroReplacement = DEFAULT_ZERO_REPLACEMENT,
    minGroupSize = 3,
    minPrevalence = 0,
  } = options;

  const warnings: string[] = [];

  if (table.length !== featureIds.length) {
    throw new Error(
      `Row count (${table.length}) does not match featureIds length (${featureIds.length}).`,
    );
  }
  if (table.length > 0 && table[0].length !== groupLabels.length) {
    throw new Error(
      `Column count (${table[0].length}) does not match groupLabels length (${groupLabels.length}).`,
    );
  }

  const groups = [...new Set(groupLabels)].sort();
  if (groups.length < 2) {
    throw new Error('Differential abundance requires at least two groups.');
  }

  // CLR divides each part by the geometric mean of its own sample, so with a
  // single feature every value becomes log(x) - log(x) = 0 and all signal is
  // destroyed. With a handful of features the constraint is still severe: one
  // feature rising forces the others down in CLR space, which shows up as
  // spurious "depletion". This is a property of compositional data, not a bug,
  // but it surprises people, so it is surfaced rather than left implicit.
  if (table.length < 2) {
    warnings.push(
      'CLR is degenerate with fewer than two features: every transformed value is zero and no difference can be detected.',
    );
  } else if (table.length < 10) {
    warnings.push(
      `Only ${table.length} features supplied. Under CLR, a large change in one feature forces apparent changes in the others, so results from very small tables should be read with care.`,
    );
  }

  // Column indices belonging to each group.
  const groupIndices = groups.map((g) =>
    groupLabels.flatMap((label, i) => (label === g ? [i] : [])),
  );

  const undersized = groups.filter((_, gi) => groupIndices[gi].length < minGroupSize);
  if (undersized.length > 0) {
    warnings.push(
      `Groups below the minimum size of ${minGroupSize} were not tested: ${undersized.join(', ')}. ` +
        `The normal approximation used by these tests is unreliable at small n.`,
    );
  }

  const nSamples = groupLabels.length;

  // Prevalence filter runs on the raw table, before transformation, because
  // after zero replacement nothing is zero any more.
  const prevalence = table.map(
    (row) => row.filter((x) => x > 0).length / nSamples,
  );

  const clr = clrTransformTable(table, zeroReplacement);

  const usableGroupIndices = groupIndices.filter(
    (idx) => idx.length >= minGroupSize,
  );
  const usableGroups = groups.filter(
    (_, gi) => groupIndices[gi].length >= minGroupSize,
  );

  const canTest = usableGroups.length >= 2;
  if (!canTest) {
    warnings.push(
      'Fewer than two groups met the minimum size; no features could be tested.',
    );
  }

  const results: FeatureResult[] = [];
  const rawP: number[] = [];
  const testedRowIndices: number[] = [];

  for (let i = 0; i < table.length; i++) {
    const groupMeans: Record<string, number> = {};
    for (let gi = 0; gi < groups.length; gi++) {
      const values = groupIndices[gi].map((j) => clr[i][j]);
      groupMeans[groups[gi]] =
        values.length > 0
          ? values.reduce((a, b) => a + b, 0) / values.length
          : NaN;
    }

    if (prevalence[i] < minPrevalence) {
      results.push({
        featureId: featureIds[i],
        p: null,
        q: null,
        effectSize: null,
        groupMeans,
        test: null,
        excludedReason: `Present in ${(prevalence[i] * 100).toFixed(1)}% of samples, below the ${(minPrevalence * 100).toFixed(1)}% threshold.`,
      });
      continue;
    }

    if (!canTest) {
      results.push({
        featureId: featureIds[i],
        p: null,
        q: null,
        effectSize: null,
        groupMeans,
        test: null,
        excludedReason: 'Fewer than two groups met the minimum group size.',
      });
      continue;
    }

    const groupValues = usableGroupIndices.map((idx) =>
      idx.map((j) => clr[i][j]),
    );

    if (usableGroups.length === 2) {
      const { p, effectSize } = wilcoxonRankSum(groupValues[0], groupValues[1]);
      results.push({
        featureId: featureIds[i],
        p,
        q: null,
        effectSize,
        groupMeans,
        test: 'wilcoxon',
      });
    } else {
      const { p, effectSize } = kruskalWallis(groupValues);
      results.push({
        featureId: featureIds[i],
        p,
        q: null,
        effectSize,
        groupMeans,
        test: 'kruskal-wallis',
      });
    }

    rawP.push(results[results.length - 1].p as number);
    testedRowIndices.push(results.length - 1);
  }

  // FDR is computed only across features that were actually tested. Including
  // filtered features in the denominator would deflate every q-value.
  const adjusted = benjaminiHochberg(rawP);
  for (let k = 0; k < testedRowIndices.length; k++) {
    results[testedRowIndices[k]].q = adjusted[k];
  }

  return {
    results,
    groups,
    testedCount: testedRowIndices.length,
    warnings,
  };
}
