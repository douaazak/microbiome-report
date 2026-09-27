/**
 * Non-parametric hypothesis tests, and Benjamini-Hochberg FDR control.
 *
 * Both tests use the normal / chi-square approximation with tie correction,
 * which is what R's `wilcox.test(exact = FALSE)` and `kruskal.test` do. The
 * approximation degrades at very small n, so `minGroupSize` below is enforced
 * by the caller rather than silently returning a p-value nobody should trust.
 */

import { chiSquareUpperTail, normalUpperTail } from './distributions.js';
import { rankWithTies, tieCorrectionSum } from './ranks.js';

export interface WilcoxonResult {
  /** Mann-Whitney U for the first group. */
  u: number;
  /** Normal-approximation z statistic, with continuity correction. */
  z: number;
  /** Two-sided p-value. */
  p: number;
  /**
   * Rank-biserial correlation: a bounded effect size in [-1, 1].
   * Reported because a p-value alone tells the user nothing about magnitude.
   */
  effectSize: number;
}

/**
 * Wilcoxon rank-sum test (equivalently Mann-Whitney U), two-sided,
 * normal approximation with tie and continuity correction.
 */
export function wilcoxonRankSum(a: number[], b: number[]): WilcoxonResult {
  const n1 = a.length;
  const n2 = b.length;

  if (n1 === 0 || n2 === 0) {
    return { u: NaN, z: NaN, p: NaN, effectSize: NaN };
  }

  const combined = [...a, ...b];
  const { ranks, tieGroupSizes } = rankWithTies(combined);

  let rankSumA = 0;
  for (let i = 0; i < n1; i++) rankSumA += ranks[i];

  const u = rankSumA - (n1 * (n1 + 1)) / 2;

  const n = n1 + n2;
  const meanU = (n1 * n2) / 2;

  // Variance, corrected for ties. Reduces to n1*n2*(n+1)/12 when there are none.
  const tieSum = tieCorrectionSum(tieGroupSizes);
  const varU =
    ((n1 * n2) / 12) * (n + 1 - tieSum / (n * (n - 1)));

  if (varU <= 0) {
    // Every value tied: no information, so no evidence of a difference.
    return { u, z: 0, p: 1, effectSize: 0 };
  }

  // Continuity correction pulls the statistic 0.5 toward the mean.
  const diff = u - meanU;
  const corrected = Math.sign(diff) * Math.max(0, Math.abs(diff) - 0.5);
  const z = corrected / Math.sqrt(varU);

  // Two-sided, via the upper tail directly. `2 * (1 - normalCdf(|z|))`
  // cancels to exactly 0 once |z| passes about 8.3 — reachable with two
  // well-separated groups of 50 — and a p of 0 becomes a q of 0 and an
  // infinite -log10 on the volcano plot.
  const p = 2 * normalUpperTail(Math.abs(z));

  // Rank-biserial correlation.
  const effectSize = (2 * u) / (n1 * n2) - 1;

  return { u, z, p: Math.min(1, Math.max(0, p)), effectSize };
}

export interface KruskalResult {
  /** H statistic, corrected for ties. */
  h: number;
  df: number;
  p: number;
  /** Epsilon-squared effect size in [0, 1]. */
  effectSize: number;
}

/**
 * Kruskal-Wallis test for three or more groups (works for two, where it is
 * equivalent to the squared Wilcoxon z), with tie correction.
 */
export function kruskalWallis(groups: number[][]): KruskalResult {
  const nonEmpty = groups.filter((g) => g.length > 0);
  const k = nonEmpty.length;

  if (k < 2) {
    return { h: NaN, df: NaN, p: NaN, effectSize: NaN };
  }

  const combined = nonEmpty.flat();
  const n = combined.length;
  const { ranks, tieGroupSizes } = rankWithTies(combined);

  let offset = 0;
  let sumTerm = 0;
  for (const group of nonEmpty) {
    let rankSum = 0;
    for (let i = 0; i < group.length; i++) {
      rankSum += ranks[offset + i];
    }
    sumTerm += (rankSum * rankSum) / group.length;
    offset += group.length;
  }

  let h = (12 / (n * (n + 1))) * sumTerm - 3 * (n + 1);

  // Tie correction.
  const tieSum = tieCorrectionSum(tieGroupSizes);
  const denominator = 1 - tieSum / (n * n * n - n);

  if (denominator <= 0) {
    return { h: 0, df: k - 1, p: 1, effectSize: 0 };
  }
  h = h / denominator;

  const df = k - 1;
  const p = chiSquareUpperTail(h, df);

  // Epsilon-squared: H normalised by its maximum given n.
  const effectSize = n > 1 ? h / ((n * n - 1) / (n + 1)) : NaN;

  return { h, df, p: Math.min(1, Math.max(0, p)), effectSize };
}

/**
 * Benjamini-Hochberg adjusted p-values (q-values).
 *
 * Returned in the input order. Monotonicity is enforced from the largest
 * p-value downward, which is what makes this match R's `p.adjust(method="BH")`
 * rather than the naive p * n / rank that people often write instead.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];

  const indexed = pValues
    .map((p, i) => ({ p, i }))
    .filter((x) => Number.isFinite(x.p));

  if (indexed.length === 0) return pValues.map(() => NaN);

  indexed.sort((a, b) => a.p - b.p);

  const m = indexed.length;
  const adjusted = new Array<number>(n).fill(NaN);

  let previous = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1];
    const q = Math.min(previous, (p * m) / rank);
    adjusted[i] = Math.min(1, q);
    previous = adjusted[i];
  }

  return adjusted;
}
