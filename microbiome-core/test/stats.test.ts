/**
 * Reference values in this file come from analytic results or from R.
 * Where a value came from R, the exact call is given in a comment so it can
 * be re-derived rather than taken on trust.
 */

import { describe, expect, it } from 'vitest';

import {
  benjaminiHochberg,
  chiSquareUpperTail,
  clrTransformSample,
  clrTransformTable,
  kruskalWallis,
  logGamma,
  normalCdf,
  rankWithTies,
  wilcoxonRankSum,
} from '../src/index.js';

describe('normalCdf', () => {
  // The A&S 7.1.26 approximation carries ~1.5e-7 absolute error, so these
  // tolerances reflect the documented accuracy rather than wishing for more.
  it('is 0.5 at zero', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
  });

  it('matches the standard 1.96 quantile', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 5);
  });

  it('is symmetric', () => {
    for (const z of [0.3, 1.0, 2.5, 3.7]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 7);
    }
  });
});

describe('logGamma', () => {
  it('matches known factorial values', () => {
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(2)).toBeCloseTo(0, 10);
    // gamma(5) = 4! = 24
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    // gamma(0.5) = sqrt(pi)
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });
});

describe('chiSquareUpperTail', () => {
  it('matches critical values at alpha = 0.05', () => {
    // R: qchisq(0.95, df = 1) -> 3.841459
    expect(chiSquareUpperTail(3.841459, 1)).toBeCloseTo(0.05, 6);
    // R: qchisq(0.95, df = 2) -> 5.991465
    expect(chiSquareUpperTail(5.991465, 2)).toBeCloseTo(0.05, 6);
    // R: qchisq(0.95, df = 5) -> 11.0705
    expect(chiSquareUpperTail(11.0705, 5)).toBeCloseTo(0.05, 5);
  });

  it('has an analytic closed form for df = 2', () => {
    // For df = 2 the upper tail is exp(-x/2).
    for (const x of [0.5, 2, 7.2]) {
      expect(chiSquareUpperTail(x, 2)).toBeCloseTo(Math.exp(-x / 2), 10);
    }
  });
});

describe('rankWithTies', () => {
  it('ranks distinct values in order', () => {
    const { ranks, tieGroupSizes } = rankWithTies([10, 20, 30]);
    expect(ranks).toEqual([1, 2, 3]);
    expect(tieGroupSizes).toEqual([]);
  });

  it('averages ranks across ties and reports group sizes', () => {
    const { ranks, tieGroupSizes } = rankWithTies([1, 1, 2]);
    expect(ranks).toEqual([1.5, 1.5, 3]);
    expect(tieGroupSizes).toEqual([2]);
  });

  it('preserves input order while ranking by value', () => {
    // sorted: 1, 3, 5, 5 -> ranks 1, 2, 3.5, 3.5
    const { ranks } = rankWithTies([5, 3, 5, 1]);
    expect(ranks).toEqual([3.5, 2, 3.5, 1]);
  });
});

describe('wilcoxonRankSum', () => {
  it('matches R on completely separated groups', () => {
    // R: wilcox.test(1:5, 6:10, exact = FALSE, correct = TRUE)
    //    W = 0, p-value = 0.01216
    const { u, p, effectSize } = wilcoxonRankSum([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(u).toBe(0);
    expect(p).toBeCloseTo(0.01216, 4);
    // Complete separation is the extreme of the rank-biserial scale.
    expect(effectSize).toBe(-1);
  });

  it('reports no evidence when every value is tied', () => {
    const { p, effectSize } = wilcoxonRankSum([5, 5, 5], [5, 5, 5]);
    expect(p).toBe(1);
    expect(effectSize).toBe(0);
  });

  it('is symmetric in its arguments up to the sign of the effect', () => {
    const a = [3, 8, 1, 9, 4];
    const b = [7, 2, 10, 6, 5];
    const forward = wilcoxonRankSum(a, b);
    const reverse = wilcoxonRankSum(b, a);
    expect(forward.p).toBeCloseTo(reverse.p, 12);
    expect(forward.effectSize).toBeCloseTo(-reverse.effectSize, 12);
  });

  it('returns NaN rather than a misleading number for an empty group', () => {
    expect(wilcoxonRankSum([], [1, 2, 3]).p).toBeNaN();
  });
});

describe('kruskalWallis', () => {
  it('matches R on three separated groups', () => {
    // R: kruskal.test(list(1:3, 4:6, 7:9))
    //    Kruskal-Wallis chi-squared = 7.2, df = 2, p-value = 0.02732
    const { h, df, p } = kruskalWallis([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    expect(h).toBeCloseTo(7.2, 10);
    expect(df).toBe(2);
    expect(p).toBeCloseTo(0.02732, 5);
  });

  it('reports no evidence when every value is tied', () => {
    const { p } = kruskalWallis([
      [2, 2],
      [2, 2],
      [2, 2],
    ]);
    expect(p).toBe(1);
  });

  it('needs at least two groups', () => {
    expect(kruskalWallis([[1, 2, 3]]).p).toBeNaN();
  });
});

describe('benjaminiHochberg', () => {
  it('matches R p.adjust on a uniform ladder', () => {
    // R: p.adjust(c(0.01, 0.02, 0.03, 0.04, 0.05), method = "BH")
    //    -> all 0.05
    const q = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05]);
    for (const value of q) {
      expect(value).toBeCloseTo(0.05, 12);
    }
  });

  it('matches R p.adjust on an uneven set', () => {
    // R: p.adjust(c(0.001, 0.008, 0.039, 0.041, 0.042, 0.06), method = "BH")
    //    -> 0.00600 0.02400 0.05040 0.05040 0.05040 0.06000
    const q = benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.042, 0.06]);
    expect(q[0]).toBeCloseTo(0.006, 6);
    expect(q[1]).toBeCloseTo(0.024, 6);
    expect(q[2]).toBeCloseTo(0.0504, 6);
    expect(q[3]).toBeCloseTo(0.0504, 6);
    expect(q[4]).toBeCloseTo(0.0504, 6);
    expect(q[5]).toBeCloseTo(0.06, 6);
  });

  it('enforces monotonicity, which the naive formula does not', () => {
    const q = benjaminiHochberg([0.04, 0.01]);
    // Naive p * n / rank would give 0.04 for the larger and 0.02 for the
    // smaller; monotonicity pulls the smaller up to match.
    expect(q[1]).toBeLessThanOrEqual(q[0]);
  });

  it('never exceeds 1', () => {
    const q = benjaminiHochberg([0.9, 0.95, 0.99]);
    for (const value of q) expect(value).toBeLessThanOrEqual(1);
  });

  it('returns the input order', () => {
    const q = benjaminiHochberg([0.05, 0.01, 0.03]);
    expect(q.length).toBe(3);
    // Smallest raw p must have the smallest q.
    expect(q[1]).toBeLessThanOrEqual(q[2]);
    expect(q[2]).toBeLessThanOrEqual(q[0]);
  });

  it('handles an empty input', () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe('clrTransform', () => {
  it('centres on zero, which is the defining property', () => {
    const clr = clrTransformSample([5, 12, 3, 40, 1]);
    const sum = clr.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 10);
  });

  it('maps an even composition to all zeros', () => {
    const clr = clrTransformSample([1, 1, 1, 1]);
    for (const value of clr) expect(value).toBeCloseTo(0, 10);
  });

  it('computes log-ratios against the geometric mean', () => {
    // Geometric mean of 1, 10, 100 is 10.
    const clr = clrTransformSample([1, 10, 100], {
      kind: 'multiplicative',
      fraction: 0.65,
    });
    expect(clr[0]).toBeCloseTo(Math.log(0.1), 10);
    expect(clr[1]).toBeCloseTo(0, 10);
    expect(clr[2]).toBeCloseTo(Math.log(10), 10);
  });

  it('is scale invariant, because only ratios carry information', () => {
    const a = clrTransformSample([2, 4, 8], { kind: 'multiplicative', fraction: 0.65 });
    const b = clrTransformSample([200, 400, 800], { kind: 'multiplicative', fraction: 0.65 });
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBeCloseTo(b[i], 10);
    }
  });

  it('rejects negative input', () => {
    expect(() => clrTransformSample([1, -1, 2])).toThrow(/non-negative/);
  });

  it('transforms per sample, i.e. down columns', () => {
    // Two identical samples; each column must centre independently.
    const table = clrTransformTable([
      [1, 10],
      [1, 10],
      [1, 10],
    ]);
    for (let j = 0; j < 2; j++) {
      const column = table.map((row) => row[j]);
      expect(column.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
    }
  });
});
