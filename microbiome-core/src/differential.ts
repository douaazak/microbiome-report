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

import {
  clrTransformTable,
  defaultZeroReplacement,
  imputedFractions,
  type ZeroReplacement,
} from './clr.js';
import { benjaminiHochberg, kruskalWallis, wilcoxonRankSum } from './tests.js';

export interface DifferentialOptions {
  zeroReplacement?: ZeroReplacement;
  /**
   * Minimum samples per group. Below this the normal / chi-square
   * approximation is unreliable, so the feature is reported as untested
   * rather than given a p-value that looks meaningful and is not.
   */
  minGroupSize?: number;
  /**
   * Drop features detected in fewer than this fraction of samples.
   *
   * "Detected" means reaching `minAbundance`, so the two filters are one
   * criterion rather than two independent ones — the same coupling MaAsLin 2
   * uses, where min_prevalence is the share of samples in which a feature is
   * seen AT min_abundance.
   */
  minPrevalence?: number;
  /**
   * Minimum RELATIVE abundance for a feature to count as detected in a
   * sample, as a fraction of that sample's total.
   *
   * Relative rather than raw, because raw values mean different things in a
   * count table and a proportion table, and because a deeply sequenced sample
   * would otherwise clear any raw threshold that a shallow one could not.
   *
   * Zero by default: every non-zero observation counts, which is right when
   * the table has already been quality controlled. Raising it to 1e-4 or so
   * excludes taxa that are only ever present at trace level, where the
   * distinction between a real organism and index hopping is thin.
   */
  minAbundance?: number;
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
    // Scale-aware by default: a fixed pseudocount is right for counts and
    // ruinous for relative abundances. See defaultZeroReplacement.
    zeroReplacement = defaultZeroReplacement(table),
    minGroupSize = 3,
    minPrevalence = 0,
    minAbundance = 0,
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

  /*
   * Prevalence is measured on the raw table, before transformation, because
   * after zero replacement nothing is zero any more.
   *
   * A feature counts as detected in a sample when it is present at all AND
   * reaches minAbundance as a share of that sample's total.
   */
  const sampleTotals = new Array<number>(nSamples).fill(0);
  for (const row of table) {
    for (let j = 0; j < nSamples; j++) {
      if (row[j] > 0) sampleTotals[j] += row[j];
    }
  }

  const detected = (value: number, j: number): boolean => {
    if (!(value > 0)) return false;
    if (minAbundance <= 0) return true;
    // A sample with nothing in it cannot detect anything.
    return sampleTotals[j] > 0 && value / sampleTotals[j] >= minAbundance;
  };

  const prevalence = table.map(
    (row) => row.filter((x, j) => detected(x, j)).length / nSamples,
  );

  /*
   * The prevalence filter chooses the CLR DENOMINATOR, not which features get
   * transformed.
   *
   * CLR divides each part by the geometric mean of its sample, so every
   * feature included in that mean shapes the reference all the others are
   * measured against. On a sparse table the default reference — every row —
   * is mostly imputed values: a species table with 55,882 features and 10% of
   * them observed in a given sample puts 90% of the geometric mean's weight
   * on the zero replacement, and the transform then describes the imputation
   * rather than the community.
   *
   * So the reference is built from the features that survive the filter,
   * which is what ALDEx2 exposes as `denom`. Every feature is still
   * transformed against it, so a rare feature keeps interpretable group means
   * even though it is not tested. This does change results relative to using
   * every row as the reference — that is the point.
   */
  const keptRows: number[] = [];
  for (let i = 0; i < table.length; i++) {
    if (prevalence[i] >= minPrevalence) keptRows.push(i);
  }

  if (keptRows.length === 0 && table.length > 0) {
    warnings.push(
      `No feature meets the filter — ${describeFilter(minPrevalence, minAbundance)} — so nothing could be tested. Lower the thresholds.`,
    );
  }

  /*
   * With nothing left to form a reference, fall back to every row. Nothing is
   * tested either way, but the group means stay interpretable rather than
   * coming back NaN, and the warning above says why the table is empty.
   */
  const denominator =
    keptRows.length > 0 ? keptRows : table.map((_, i) => i);

  const clr =
    table.length > 0
      ? clrTransformTable(table, zeroReplacement, { denominator })
      : [];

  const tested = new Set(keptRows);

  /*
   * How much of each sample the zero replacement had to invent. Reported
   * because a heavily imputed sample is a real limitation of the data that
   * the reader has to weigh — and because this used to be the difference
   * between a result and an exception that showed the user nothing.
   */
  if (keptRows.length > 0) {
    const imputed = imputedFractions(table, zeroReplacement);
    const heavy = imputed.filter((f) => f > 0.2).length;
    if (heavy > 0) {
      const worst = Math.max(...imputed);
      warnings.push(
        `Zero replacement accounts for more than 20% of the composition in ${heavy} of ${nSamples} samples (worst: ${(worst * 100).toFixed(0)}%). ` +
          `CLR values for those samples reflect the replacement as much as the measurement. ` +
          `This is a property of how sparse the table is — the prevalence filter chooses the CLR reference but does not change it; ` +
          `collapsing to a higher rank or removing rarely seen features before loading does.`,
      );
    }
  }

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
      const values = groupIndices[gi].map((j) => clr[i]?.[j] ?? NaN);
      groupMeans[groups[gi]] =
        values.length > 0
          ? values.reduce((a, b) => a + b, 0) / values.length
          : NaN;
    }

    if (!tested.has(i)) {
      results.push({
        featureId: featureIds[i],
        p: null,
        q: null,
        effectSize: null,
        groupMeans,
        test: null,
        excludedReason:
          minAbundance > 0
            ? `Reaches ${formatAbundance(minAbundance)} in ${(prevalence[i] * 100).toFixed(1)}% of samples, below the ${(minPrevalence * 100).toFixed(1)}% threshold.`
            : `Present in ${(prevalence[i] * 100).toFixed(1)}% of samples, below the ${(minPrevalence * 100).toFixed(1)}% threshold.`,
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

/** Render a relative abundance as a readable percentage. */
function formatAbundance(fraction: number): string {
  const percent = fraction * 100;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  if (percent >= 0.01) return `${percent.toFixed(2)}%`;
  return `${percent.toExponential(1)}%`;
}

/** One phrase describing both filters, since they act as a single criterion. */
function describeFilter(minPrevalence: number, minAbundance: number): string {
  const share = `${(minPrevalence * 100).toFixed(1)}% of samples`;
  return minAbundance > 0
    ? `at least ${formatAbundance(minAbundance)} abundance in ${share}`
    : `present in ${share}`;
}
