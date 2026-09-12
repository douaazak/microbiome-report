import { describe, expect, it } from 'vitest';

import {
  alphaDiversity,
  betaDiversity,
  brayCurtis,
  chao1,
  euclidean,
  inverseSimpson,
  jaccard,
  observed,
  pcoa,
  permanova,
  pielou,
  shannon,
  simpson,
  symmetricEigen,
} from '../src/index.js';

describe('alpha diversity metrics', () => {
  const EVEN = [1, 1, 1, 1];

  it('matches analytic values on an even community', () => {
    // Four equally abundant taxa: p = 0.25 each.
    expect(shannon(EVEN)).toBeCloseTo(Math.log(4), 10);
    expect(simpson(EVEN)).toBeCloseTo(0.75, 10);
    expect(inverseSimpson(EVEN)).toBeCloseTo(4, 10);
    // Evenness is maximal, by construction.
    expect(pielou(EVEN)).toBeCloseTo(1, 10);
  });

  it('is scale invariant, since it depends only on proportions', () => {
    expect(shannon([1, 1, 1, 1])).toBeCloseTo(shannon([100, 100, 100, 100]), 10);
  });

  it('gives zero Shannon for a single-taxon community', () => {
    expect(shannon([10, 0, 0])).toBeCloseTo(0, 10);
    expect(simpson([10, 0, 0])).toBeCloseTo(0, 10);
  });

  it('counts only present features for richness', () => {
    expect(observed([1, 0, 3, 0, 7])).toBe(3);
  });

  it('computes bias-corrected Chao1', () => {
    // S_obs = 4, F1 (singletons) = 2, F2 (doubletons) = 1
    // 4 + 2*(2-1) / (2*(1+1)) = 4 + 2/4 = 4.5
    expect(chao1([1, 1, 2, 5])).toBeCloseTo(4.5, 10);
  });

  it('returns observed richness when there are no singletons', () => {
    expect(chao1([5, 6, 7])).toBeCloseTo(3, 10);
  });

  it('leaves Pielou undefined for a single observed feature', () => {
    expect(pielou([10, 0, 0])).toBeNaN();
  });
});

describe('alphaDiversity', () => {
  const COUNTS = [
    [10, 0, 5],
    [10, 20, 5],
    [10, 0, 5],
    [10, 20, 5],
  ];
  const SAMPLES = ['S1', 'S2', 'S3'];

  it('computes every metric on a counts table', () => {
    const result = alphaDiversity(COUNTS, SAMPLES);
    expect(result.refused).toEqual([]);
    expect(result.values.shannon).toHaveLength(3);
    // S1 has four equally abundant features.
    expect(result.values.shannon[0]).toBeCloseTo(Math.log(4), 10);
    // S2 has two.
    expect(result.values.observed[1]).toBe(2);
  });

  it('refuses count-only metrics on relative abundances, with a reason', () => {
    const relative = [
      [0.25, 0.5],
      [0.25, 0.5],
      [0.5, 0.0],
    ];
    const result = alphaDiversity(relative, ['A', 'B'], undefined, {
      isCounts: false,
    });

    expect(result.values.shannon).toBeDefined();
    expect(result.values.chao1).toBeUndefined();
    expect(result.values.observed).toBeUndefined();

    const chaoRefusal = result.refused.find((r) => r.metric === 'chao1')!;
    expect(chaoRefusal.reason).toMatch(/singleton and doubleton/);
    expect(result.warnings.join(' ')).toMatch(/does not hold integer counts/);
  });

  it('warns when sequencing depth is badly uneven', () => {
    const uneven = [
      [1, 1000],
      [1, 1000],
    ];
    const result = alphaDiversity(uneven, ['shallow', 'deep']);
    expect(result.warnings.join(' ')).toMatch(/depth varies/);
  });

  it('rejects a sample-count mismatch rather than silently truncating', () => {
    expect(() => alphaDiversity(COUNTS, ['S1', 'S2'])).toThrow(
      /columns but 2 sample IDs/,
    );
  });
});

describe('beta diversity metrics', () => {
  it('gives zero distance between identical samples', () => {
    expect(brayCurtis([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(jaccard([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('gives maximal Bray-Curtis for non-overlapping communities', () => {
    expect(brayCurtis([1, 0], [0, 1])).toBeCloseTo(1, 10);
  });

  it('matches the analytic Bray-Curtis value', () => {
    // sum|x-y| = 2 + 2 = 4; sum(x+y) = 4 + 4 = 8
    expect(brayCurtis([1, 1], [3, 3])).toBeCloseTo(0.5, 10);
  });

  it('computes Jaccard on presence/absence, ignoring magnitude', () => {
    // Shared: 1 feature. Union: 2. Distance = 1 - 1/2.
    expect(jaccard([1, 1, 0], [999, 0, 0])).toBeCloseTo(0.5, 10);
  });

  it('computes Euclidean distance', () => {
    expect(euclidean([0, 0], [3, 4])).toBeCloseTo(5, 10);
  });
});

describe('betaDiversity matrix', () => {
  const TABLE = [
    [10, 0, 8],
    [0, 10, 2],
    [5, 5, 5],
  ];
  const SAMPLES = ['A', 'B', 'C'];

  it('produces a symmetric matrix with a zero diagonal', () => {
    for (const metric of ['braycurtis', 'jaccard', 'aitchison'] as const) {
      const { values } = betaDiversity(TABLE, SAMPLES, metric);
      for (let i = 0; i < 3; i++) {
        expect(values[i][i]).toBe(0);
        for (let j = 0; j < 3; j++) {
          expect(values[i][j]).toBeCloseTo(values[j][i], 12);
        }
      }
    }
  });

  it('keeps Bray-Curtis and Jaccard within [0, 1]', () => {
    for (const metric of ['braycurtis', 'jaccard'] as const) {
      const { values } = betaDiversity(TABLE, SAMPLES, metric);
      for (const row of values) {
        for (const d of row) {
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('makes Aitchison distance scale invariant under multiplicative replacement', () => {
    const scaled = TABLE.map((row) => row.map((x, j) => (j === 0 ? x * 10 : x)));
    const replacement = { kind: 'multiplicative', fraction: 0.65 } as const;

    const a = betaDiversity(TABLE, SAMPLES, 'aitchison', {
      zeroReplacement: replacement,
    });
    const b = betaDiversity(scaled, SAMPLES, 'aitchison', {
      zeroReplacement: replacement,
    });

    // Multiplying a sample by a constant does not change its composition, and
    // multiplicative replacement scales the substituted value along with it.
    expect(b.values[0][1]).toBeCloseTo(a.values[0][1], 8);
  });

  it('is NOT scale invariant under the default additive pseudocount', () => {
    const scaled = TABLE.map((row) => row.map((x, j) => (j === 0 ? x * 10 : x)));
    const a = betaDiversity(TABLE, SAMPLES, 'aitchison');
    const b = betaDiversity(scaled, SAMPLES, 'aitchison');

    // Adding a fixed 0.5 to [10, 0, 5] and to [100, 0, 50] does not produce
    // proportional vectors, so the CLR coordinates differ. This is a genuine
    // property of additive pseudocounts, not a defect here, and it means
    // sequencing depth leaks into Aitchison distances. Asserted so the
    // behaviour cannot change without someone noticing.
    expect(b.values[0][1]).not.toBeCloseTo(a.values[0][1], 3);
  });
});

describe('symmetricEigen', () => {
  it('recovers eigenvalues of a diagonal matrix, sorted descending', () => {
    const { values } = symmetricEigen([
      [2, 0],
      [0, 3],
    ]);
    expect(values[0]).toBeCloseTo(3, 10);
    expect(values[1]).toBeCloseTo(2, 10);
  });

  it('recovers eigenvalues of a known symmetric matrix', () => {
    // [[2,1],[1,2]] has eigenvalues 3 and 1.
    const { values } = symmetricEigen([
      [2, 1],
      [1, 2],
    ]);
    expect(values[0]).toBeCloseTo(3, 10);
    expect(values[1]).toBeCloseTo(1, 10);
  });

  it('produces orthonormal eigenvectors', () => {
    const { vectors } = symmetricEigen([
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ]);
    for (const v of vectors) {
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      expect(norm).toBeCloseTo(1, 8);
    }
    const dot = vectors[0].reduce((a, x, i) => a + x * vectors[1][i], 0);
    expect(dot).toBeCloseTo(0, 8);
  });
});

describe('pcoa', () => {
  /** Four points on a 2D grid, so the true structure is known. */
  const POINTS = [
    [0, 0],
    [0, 3],
    [4, 0],
    [4, 3],
  ];

  function euclideanMatrix(points: number[][]) {
    const n = points.length;
    const values = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = euclidean(points[i], points[j]);
        values[i][j] = d;
        values[j][i] = d;
      }
    }
    return {
      sampleIds: points.map((_, i) => `P${i}`),
      values,
      metric: 'braycurtis' as const,
    };
  }

  it('reconstructs the original distances from a Euclidean configuration', () => {
    const distance = euclideanMatrix(POINTS);
    const result = pcoa(distance, 2);

    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const reconstructed = Math.sqrt(
          result.coordinates.reduce((acc, axis) => {
            const d = axis[i] - axis[j];
            return acc + d * d;
          }, 0),
        );
        expect(reconstructed).toBeCloseTo(distance.values[i][j], 6);
      }
    }
  });

  it('centres each axis on zero', () => {
    const result = pcoa(euclideanMatrix(POINTS), 2);
    for (const axis of result.coordinates) {
      expect(axis.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 8);
    }
  });

  it('reports variance explained in descending order, summing to at most one', () => {
    const result = pcoa(euclideanMatrix(POINTS), 2);
    expect(result.varianceExplained[0]).toBeGreaterThanOrEqual(
      result.varianceExplained[1],
    );
    const total = result.varianceExplained.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('warns about negative eigenvalues from non-Euclidean metrics', () => {
    const table = [
      [10, 0, 8, 1],
      [0, 10, 2, 9],
      [5, 5, 5, 3],
      [1, 7, 0, 6],
    ];
    const distance = betaDiversity(
      table,
      ['A', 'B', 'C', 'D'],
      'braycurtis',
    );
    const result = pcoa(distance, 2);
    // Bray-Curtis is not Euclidean, so some negative eigenvalues are expected.
    // The assertion is that if they occur, they are reported rather than hidden.
    const negatives = result.eigenvalues.filter((e) => e < -1e-9);
    if (negatives.length > 0) {
      expect(result.warnings.join(' ')).toMatch(/negative eigenvalue/);
    }
  });

  it('needs at least three samples', () => {
    expect(() =>
      pcoa({ sampleIds: ['A', 'B'], values: [[0, 1], [1, 0]], metric: 'jaccard' }),
    ).toThrow(/at least three samples/);
  });
});

describe('permanova', () => {
  /** Two tight, well-separated clusters. */
  const SEPARATED = [
    [100, 98, 102, 99, 1, 2, 0, 3],
    [1, 2, 0, 3, 100, 98, 102, 99],
    [50, 51, 49, 50, 50, 49, 51, 50],
  ];
  const LABELS = ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b'];
  const IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

  it('detects clear group separation', () => {
    const distance = betaDiversity(SEPARATED, IDS, 'braycurtis');
    const result = permanova(distance, LABELS, 999);

    expect(result.f).toBeGreaterThan(1);
    expect(result.r2).toBeGreaterThan(0.5);
    expect(result.p).toBeLessThan(0.05);
  });

  it('finds nothing when labels are unrelated to the data', () => {
    const noise = [
      [10, 11, 9, 10, 11, 9, 10, 11],
      [20, 19, 21, 20, 19, 21, 20, 19],
      [5, 5, 6, 5, 6, 5, 5, 6],
    ];
    const distance = betaDiversity(noise, IDS, 'braycurtis');
    const result = permanova(distance, LABELS, 999);
    expect(result.p).toBeGreaterThan(0.05);
  });

  it('never reports p = 0, because a permutation test cannot', () => {
    const distance = betaDiversity(SEPARATED, IDS, 'braycurtis');
    const result = permanova(distance, LABELS, 99);
    expect(result.p).toBeGreaterThanOrEqual(1 / 100);
  });

  it('is deterministic for a given seed', () => {
    const distance = betaDiversity(SEPARATED, IDS, 'braycurtis');
    const a = permanova(distance, LABELS, 199, 7);
    const b = permanova(distance, LABELS, 199, 7);
    expect(a.p).toBe(b.p);
  });

  it('warns about groups too small to test reliably', () => {
    const distance = betaDiversity(SEPARATED, IDS, 'braycurtis');
    const result = permanova(
      distance,
      ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b'],
      99,
    );
    expect(result.warnings.join(' ')).toMatch(/smallest group has 1 sample/);
  });

  it('rejects a label-count mismatch', () => {
    const distance = betaDiversity(SEPARATED, IDS, 'braycurtis');
    expect(() => permanova(distance, ['a', 'b'], 99)).toThrow(
      /Expected 8 group labels/,
    );
  });
});
