/**
 * Beta diversity: between-sample distances, ordination, and PERMANOVA.
 *
 * Distances are computed between COLUMNS of the feature table, since columns
 * are samples. All three metrics here are true dissimilarities in [0, 1] or
 * unbounded (Aitchison), and all are symmetric with a zero diagonal.
 */

import {
  clrTransformTable,
  defaultZeroReplacement,
  type ZeroReplacement,
} from './clr.js';

export const BETA_METRICS = ['braycurtis', 'jaccard', 'aitchison'] as const;
export type BetaMetric = (typeof BETA_METRICS)[number];

export interface DistanceMatrix {
  sampleIds: string[];
  /** Symmetric, zero diagonal. */
  values: number[][];
  metric: BetaMetric;
}

/** Bray-Curtis dissimilarity: sum|x-y| / sum(x+y). */
export function brayCurtis(a: number[], b: number[]): number {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < a.length; i++) {
    numerator += Math.abs(a[i] - b[i]);
    denominator += a[i] + b[i];
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Jaccard distance on presence/absence: 1 - |intersection| / |union|. */
export function jaccard(a: number[], b: number[]): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] > 0;
    const inB = b[i] > 0;
    if (inA && inB) intersection++;
    if (inA || inB) union++;
  }
  return union === 0 ? 0 : 1 - intersection / union;
}

export function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export interface BetaOptions {
  /**
   * Zero replacement used for the Aitchison metric only.
   *
   * This choice matters more than it looks. Aitchison distance is supposed to
   * be scale invariant — multiplying a sample by a constant should not change
   * its composition or its distance to anything else. That holds under
   * MULTIPLICATIVE replacement, which scales the substituted value along with
   * the data. It does NOT hold under the default additive pseudocount: adding
   * a fixed 0.5 to [10, 0, 5] and to [100, 0, 50] gives non-proportional
   * vectors, so sequencing depth leaks into the distances.
   *
   * Prefer `{ kind: 'multiplicative', fraction: 0.65 }` when comparing samples
   * whose depths differ substantially and rarefying is not on the table.
   */
  zeroReplacement?: ZeroReplacement;
}

/**
 * @param table features (rows) x samples (columns)
 */
export function betaDiversity(
  table: number[][],
  sampleIds: string[],
  metric: BetaMetric,
  options: BetaOptions = {},
): DistanceMatrix {
  const n = sampleIds.length;
  if (table.length > 0 && table[0].length !== n) {
    throw new Error(
      `Table has ${table[0].length} columns but ${n} sample IDs were given.`,
    );
  }

  // Aitchison distance is Euclidean distance in CLR space, so the transform
  // happens once up front rather than per pair.
  const source =
    metric === 'aitchison'
      ? clrTransformTable(
          table,
          options.zeroReplacement ?? defaultZeroReplacement(table),
        )
      : table;

  const samples: number[][] = Array.from({ length: n }, (_, j) =>
    source.map((row) => row[j]),
  );

  const fn =
    metric === 'braycurtis'
      ? brayCurtis
      : metric === 'jaccard'
        ? jaccard
        : euclidean;

  const values: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = fn(samples[i], samples[j]);
      values[i][j] = d;
      values[j][i] = d;
    }
  }

  return { sampleIds, values, metric };
}

// ---------------------------------------------------------------------------
// Eigendecomposition
// ---------------------------------------------------------------------------

/**
 * Jacobi eigenvalue algorithm for real symmetric matrices.
 *
 * Implemented rather than pulled from a dependency: it is short, numerically
 * well behaved on the symmetric matrices PCoA produces, and keeps this package
 * dependency-free. Returns eigenvalues sorted descending with matching
 * eigenvectors as columns.
 */
export function symmetricEigen(
  matrix: number[][],
  maxSweeps = 100,
): { values: number[]; vectors: number[][] } {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    }
    if (Math.sqrt(2 * off) < 1e-12) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const pairs = Array.from({ length: n }, (_, i) => ({
    value: a[i][i],
    vector: v.map((row) => row[i]),
  })).sort((x, y) => y.value - x.value);

  return {
    values: pairs.map((p) => p.value),
    vectors: pairs.map((p) => p.vector),
  };
}

// ---------------------------------------------------------------------------
// PCoA
// ---------------------------------------------------------------------------

export interface PcoaResult {
  sampleIds: string[];
  /** coordinates[axis][sample] */
  coordinates: number[][];
  eigenvalues: number[];
  /** Fraction of total variation on each axis, using positive eigenvalues. */
  varianceExplained: number[];
  warnings: string[];
}

/**
 * Principal coordinates analysis (classical multidimensional scaling).
 *
 * Double-centres -0.5 * D^2 and eigendecomposes the result. Negative
 * eigenvalues are expected for non-Euclidean metrics such as Bray-Curtis;
 * they are excluded from the variance denominator and reported, rather than
 * quietly ignored.
 */
export function pcoa(distance: DistanceMatrix, axes = 3): PcoaResult {
  const n = distance.sampleIds.length;
  const warnings: string[] = [];

  if (n < 3) {
    throw new Error('PCoA needs at least three samples.');
  }

  // A = -0.5 * D^2
  const a: number[][] = distance.values.map((row) =>
    row.map((d) => -0.5 * d * d),
  );

  const rowMeans = a.map((row) => row.reduce((x, y) => x + y, 0) / n);
  const grandMean = rowMeans.reduce((x, y) => x + y, 0) / n;

  // Gower double-centring.
  const b: number[][] = a.map((row, i) =>
    row.map((value, j) => value - rowMeans[i] - rowMeans[j] + grandMean),
  );

  const { values: eigenvalues, vectors } = symmetricEigen(b);

  const positiveSum = eigenvalues
    .filter((e) => e > 0)
    .reduce((x, y) => x + y, 0);

  const negatives = eigenvalues.filter((e) => e < -1e-9);
  if (negatives.length > 0) {
    const magnitude = Math.abs(Math.min(...negatives));
    warnings.push(
      `${negatives.length} negative eigenvalue${negatives.length === 1 ? '' : 's'} (largest magnitude ${magnitude.toFixed(4)}). This is normal for ${distance.metric}, which is not a Euclidean metric; variance explained uses positive eigenvalues only.`,
    );
  }

  const requested = Math.min(axes, n - 1);
  const coordinates: number[][] = [];
  const varianceExplained: number[] = [];

  for (let k = 0; k < requested; k++) {
    const lambda = eigenvalues[k];
    if (lambda <= 0) {
      warnings.push(
        `Only ${k} axis${k === 1 ? '' : 'es'} had positive eigenvalues; fewer than the ${requested} requested.`,
      );
      break;
    }
    const scale = Math.sqrt(lambda);
    coordinates.push(vectors[k].map((component) => component * scale));
    varianceExplained.push(positiveSum > 0 ? lambda / positiveSum : NaN);
  }

  return {
    sampleIds: distance.sampleIds,
    coordinates,
    eigenvalues,
    varianceExplained,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// PERMANOVA
// ---------------------------------------------------------------------------

/** Deterministic PRNG, so permutation results are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface PermanovaResult {
  /** Pseudo-F statistic. */
  f: number;
  /** Proportion of variation explained by the grouping. */
  r2: number;
  p: number;
  permutations: number;
  groups: string[];
  warnings: string[];
}

/**
 * PERMANOVA (Anderson 2001), one factor.
 *
 * Partitions the sum of squared distances into between- and within-group
 * components and tests the pseudo-F against a null built by permuting group
 * labels. The p-value uses the (count + 1) / (permutations + 1) convention,
 * which keeps it strictly positive — a permutation test can never establish
 * p = 0.
 */
export function permanova(
  distance: DistanceMatrix,
  groupLabels: string[],
  permutations = 999,
  seed = 12345,
): PermanovaResult {
  const n = distance.sampleIds.length;
  const warnings: string[] = [];

  if (groupLabels.length !== n) {
    throw new Error(
      `Expected ${n} group labels to match the distance matrix, got ${groupLabels.length}.`,
    );
  }

  const groups = [...new Set(groupLabels)].sort();
  if (groups.length < 2) {
    throw new Error('PERMANOVA needs at least two groups.');
  }

  const smallest = Math.min(
    ...groups.map((g) => groupLabels.filter((l) => l === g).length),
  );
  if (smallest < 3) {
    warnings.push(
      `The smallest group has ${smallest} sample${smallest === 1 ? '' : 's'}. PERMANOVA is unreliable at this size, and the permutation p-value is bounded below by 1/(permutations + 1) regardless.`,
    );
  }

  const squared: number[][] = distance.values.map((row) =>
    row.map((d) => d * d),
  );

  const observedF = pseudoF(squared, groupLabels, groups);

  const rng = makeRng(seed);
  const shuffled = [...groupLabels];
  let atLeastAsExtreme = 0;

  for (let iteration = 0; iteration < permutations; iteration++) {
    // Fisher-Yates.
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const permutedF = pseudoF(squared, shuffled, groups);
    if (permutedF >= observedF) atLeastAsExtreme++;
  }

  const { ssTotal, ssWithin } = sumsOfSquares(squared, groupLabels, groups);
  const r2 = ssTotal > 0 ? (ssTotal - ssWithin) / ssTotal : NaN;

  return {
    f: observedF,
    r2,
    p: (atLeastAsExtreme + 1) / (permutations + 1),
    permutations,
    groups,
    warnings,
  };
}

function sumsOfSquares(
  squared: number[][],
  labels: string[],
  groups: string[],
): { ssTotal: number; ssWithin: number } {
  const n = labels.length;

  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) total += squared[i][j];
  }
  const ssTotal = total / n;

  let ssWithin = 0;
  for (const group of groups) {
    const members: number[] = [];
    for (let i = 0; i < n; i++) if (labels[i] === group) members.push(i);
    if (members.length < 2) continue;

    let sum = 0;
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        sum += squared[members[x]][members[y]];
      }
    }
    ssWithin += sum / members.length;
  }

  return { ssTotal, ssWithin };
}

function pseudoF(
  squared: number[][],
  labels: string[],
  groups: string[],
): number {
  const n = labels.length;
  const a = groups.length;
  const { ssTotal, ssWithin } = sumsOfSquares(squared, labels, groups);
  const ssBetween = ssTotal - ssWithin;

  const denominator = ssWithin / (n - a);
  if (denominator <= 0) return Infinity;
  return ssBetween / (a - 1) / denominator;
}
