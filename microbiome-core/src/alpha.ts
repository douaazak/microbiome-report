/**
 * Alpha diversity — within-sample diversity.
 *
 * Metrics split into two kinds, and conflating them is a real source of wrong
 * results. Shannon, Simpson and Pielou depend only on proportions, so they
 * work on counts and relative abundances alike. Observed richness and Chao1
 * depend on COUNTS — Chao1 is built from the number of singletons and
 * doubletons, which relative abundance simply does not contain. Applied to
 * MetaPhlAn output they return a number that means nothing.
 *
 * Each metric therefore declares whether it needs counts, and the batch
 * function refuses those metrics on non-count input rather than obliging.
 */

export const ALPHA_METRICS = [
  'observed',
  'shannon',
  'simpson',
  'invsimpson',
  'pielou',
  'chao1',
] as const;

export type AlphaMetric = (typeof ALPHA_METRICS)[number];

/** Metrics that are only meaningful on integer counts. */
export const COUNT_ONLY_METRICS: readonly AlphaMetric[] = [
  'observed',
  'chao1',
];

function proportions(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  return counts.map((x) => x / total);
}

/** Number of features present. */
export function observed(counts: number[]): number {
  return counts.filter((x) => x > 0).length;
}

/**
 * True when a sample holds nothing at all — a blank, a negative control, or a
 * library emptied by upstream filtering.
 *
 * Diversity is undefined for such a sample, not zero and certainly not
 * maximal. Every metric here returns NaN for it so that it is excluded from
 * plots and tests rather than ranked against real samples.
 */
function isEmpty(counts: number[]): boolean {
  return counts.reduce((a, b) => a + b, 0) <= 0;
}

/** Shannon entropy, natural log — the convention vegan uses by default. */
export function shannon(counts: number[]): number {
  if (isEmpty(counts)) return NaN;
  const p = proportions(counts);
  let h = 0;
  for (const value of p) {
    if (value > 0) h -= value * Math.log(value);
  }
  return h;
}

/**
 * Gini-Simpson index: 1 - sum(p^2).
 *
 * The empty-sample guard is not cosmetic. `proportions` returns all zeros
 * when the total is zero, so the sum was 0 and this returned 1 — the maximum.
 * A blank well then plotted as the single most diverse sample in the study,
 * above every real one, while `inverseSimpson` and `pielou` returned NaN for
 * the same input.
 */
export function simpson(counts: number[]): number {
  if (isEmpty(counts)) return NaN;
  const p = proportions(counts);
  let sum = 0;
  for (const value of p) sum += value * value;
  return 1 - sum;
}

/** Inverse Simpson: 1 / sum(p^2). */
export function inverseSimpson(counts: number[]): number {
  const p = proportions(counts);
  let sum = 0;
  for (const value of p) sum += value * value;
  return sum > 0 ? 1 / sum : NaN;
}

/**
 * Pielou's evenness: Shannon divided by its maximum for the observed richness.
 * Undefined for a single observed feature, where log(1) = 0.
 */
export function pielou(counts: number[]): number {
  const richness = observed(counts);
  if (richness <= 1) return NaN;
  return shannon(counts) / Math.log(richness);
}

/**
 * Bias-corrected Chao1, matching the form vegan's `estimateR` uses:
 *
 *   S_obs + F1 * (F1 - 1) / (2 * (F2 + 1))
 *
 * The bias-corrected form is preferred because the classic F1^2 / (2*F2)
 * is undefined when no doubletons are observed, which happens often in
 * practice.
 */
export function chao1(counts: number[]): number {
  const sObs = observed(counts);
  let f1 = 0;
  let f2 = 0;
  for (const x of counts) {
    if (x === 1) f1++;
    else if (x === 2) f2++;
  }
  return sObs + (f1 * (f1 - 1)) / (2 * (f2 + 1));
}

const IMPLEMENTATIONS: Record<AlphaMetric, (counts: number[]) => number> = {
  observed,
  shannon,
  simpson,
  invsimpson: inverseSimpson,
  pielou,
  chao1,
};

export interface AlphaOptions {
  /**
   * Whether the table holds integer counts. When false, count-only metrics
   * are refused rather than computed.
   */
  isCounts?: boolean;
}

export interface AlphaResult {
  sampleIds: string[];
  /** Metric name to per-sample values, in sample order. */
  values: Record<string, number[]>;
  /** Metrics that were requested but not computed, with the reason. */
  refused: { metric: AlphaMetric; reason: string }[];
  warnings: string[];
}

/**
 * @param table  features (rows) x samples (columns)
 */
export function alphaDiversity(
  table: number[][],
  sampleIds: string[],
  metrics: readonly AlphaMetric[] = ALPHA_METRICS,
  options: AlphaOptions = {},
): AlphaResult {
  const isCounts = options.isCounts ?? detectCounts(table);
  const warnings: string[] = [];
  const refused: { metric: AlphaMetric; reason: string }[] = [];
  const values: Record<string, number[]> = {};

  const nSamples = sampleIds.length;
  if (table.length > 0 && table[0].length !== nSamples) {
    throw new Error(
      `Table has ${table[0].length} columns but ${nSamples} sample IDs were given.`,
    );
  }

  // Columns of the table are samples; each metric is computed down a column.
  const samples: number[][] = Array.from({ length: nSamples }, (_, j) =>
    table.map((row) => row[j]),
  );

  for (const metric of metrics) {
    if (!isCounts && COUNT_ONLY_METRICS.includes(metric)) {
      refused.push({
        metric,
        reason:
          metric === 'chao1'
            ? 'Chao1 is estimated from singleton and doubleton counts, which relative abundances do not contain.'
            : 'Observed richness counts features present, which is not meaningful once abundances have been normalised.',
      });
      continue;
    }
    values[metric] = samples.map((sample) => IMPLEMENTATIONS[metric](sample));
  }

  if (refused.length > 0) {
    warnings.push(
      `Skipped ${refused.map((r) => r.metric).join(', ')} because the table does not hold integer counts.`,
    );
  }

  const depths = samples.map((s) => s.reduce((a, b) => a + b, 0));
  if (isCounts && depths.length > 1) {
    /*
     * Empty samples are reported first and separately.
     *
     * The fold-change warning below is guarded on `min > 0` to avoid dividing
     * by zero — which meant that a table containing an empty sample, the case
     * most worth warning about, produced no warning at all, not even about
     * the other samples. Excluding empties from the ratio restores that.
     */
    const empty = depths.filter((d) => d <= 0).length;
    if (empty > 0) {
      warnings.push(
        `${empty} sample${empty === 1 ? ' has' : 's have'} no reads at all. Diversity is undefined for ${empty === 1 ? 'it' : 'them'}, so ${empty === 1 ? 'it is' : 'they are'} reported as blank rather than as zero diversity.`,
      );
    }

    const nonEmpty = depths.filter((d) => d > 0);
    if (nonEmpty.length > 1) {
      const min = Math.min(...nonEmpty);
      const max = Math.max(...nonEmpty);
      if (max / min > 10) {
        warnings.push(
          `Sequencing depth varies ${(max / min).toFixed(0)}-fold across samples (${min.toLocaleString()} to ${max.toLocaleString()}). Richness metrics are sensitive to depth; consider rarefying or using depth as a covariate.`,
        );
      }
    }
  }

  return { sampleIds, values, refused, warnings };
}

/** Heuristic: a table of whole numbers is treated as counts. */
export function detectCounts(table: number[][]): boolean {
  for (const row of table) {
    for (const value of row) {
      if (!Number.isInteger(value)) return false;
    }
  }
  return true;
}
