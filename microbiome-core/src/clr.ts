/**
 * Centred log-ratio transform.
 *
 * Microbiome counts are compositional: only the ratios carry information,
 * because total reads per sample is an artefact of sequencing depth rather
 * than biology. Testing raw or relative abundances treats samples as though
 * they were independent measurements, which they are not, and is the main
 * reason naive differential abundance analyses produce spurious hits.
 *
 * CLR maps a composition onto real coordinates by dividing each part by the
 * geometric mean of the sample, then taking the log. The catch is that the
 * geometric mean is undefined when any part is zero, and microbiome data is
 * mostly zeros — so zero replacement is not an implementation detail, it is a
 * modelling choice that changes results. It is therefore explicit here.
 */

export type ZeroReplacement =
  /** Add a fixed value to every entry. Simple, and the usual default. */
  | { kind: 'pseudocount'; value: number }
  /**
   * Replace zeros with a fraction of the detection limit, then rescale the
   * non-zeros so the composition still sums to its original total. Preserves
   * ratios among observed parts better than a flat pseudocount.
   *
   * `relativeDetectionLimit` is the smallest abundance the measurement could
   * report, expressed as a FRACTION OF THE SAMPLE TOTAL. Relative, not
   * absolute, so that the substituted value scales with the sample and the
   * transform stays scale invariant — a sample reported as counts and the
   * same sample reported as proportions must give the same answer, which is
   * the defining property of compositional data. Left undefined, each sample
   * falls back to its own smallest observed part.
   *
   * Deriving it per sample is nevertheless a trap for a different reason. The
   * imputed mass is delta x (number of zeros), and in a sparse table the zero
   * count is enormous: a species table with 55,882 features and 5,000
   * observed in a sample has 50,000 zeros, so a sample whose own minimum
   * happens to be large imputes more mass than it contains. Taking the limit
   * from the whole table keeps it small and consistent across samples;
   * `clrTransformTable` fills it in.
   */
  | {
      kind: 'multiplicative';
      fraction: number;
      relativeDetectionLimit?: number;
    };

export const DEFAULT_ZERO_REPLACEMENT: ZeroReplacement = {
  kind: 'pseudocount',
  value: 0.5,
};

/**
 * Most of a sample that may be imputed before the transform stops describing
 * the data. Past this, delta is scaled down and the transform reports how much
 * it had to invent rather than refusing to run.
 */
export const MAX_IMPUTED_FRACTION = 0.5;

export interface ClrOptions {
  /**
   * Row indices whose geometric mean forms the reference every feature is
   * divided by. Defaults to all rows.
   *
   * This is the CLR "denominator", and choosing it is a modelling decision.
   * On a sparse table the default — all rows — makes the reference mostly
   * zero replacement rather than measurement, so the transform describes the
   * imputation. Restricting it to features that were actually observed is
   * what ALDEx2 exposes as `denom` and what ANCOM-BC does implicitly.
   */
  denominator?: number[];
}

/**
 * Choose a zero replacement appropriate to the scale of the data.
 *
 * A fixed pseudocount of 0.5 is the convention for counts, where the smallest
 * real observation is 1. Applied to relative abundances it is a disaster: in a
 * shotgun table whose non-zero values sit around 1e-6, adding 0.5 to every
 * entry is a perturbation five hundred thousand times larger than the data,
 * and the CLR then describes the pseudocount rather than the community.
 *
 * Multiplicative replacement scales with the data by construction, so it is
 * the right default whenever the table is not counts.
 */
export function defaultZeroReplacement(table: number[][]): ZeroReplacement {
  let counts = true;
  outer: for (const row of table) {
    for (const value of row) {
      // Any fractional value means these are not counts.
      if (!Number.isInteger(value)) {
        counts = false;
        break outer;
      }
    }
  }

  if (counts) return DEFAULT_ZERO_REPLACEMENT;

  return {
    kind: 'multiplicative',
    fraction: 0.65,
    relativeDetectionLimit: relativeDetectionLimit(table),
  };
}

/**
 * The smallest positive value anywhere in the table, as a fraction of its own
 * sample's total — a proxy for the resolution of the measurement.
 *
 * @param table features (rows) x samples (columns)
 */
export function relativeDetectionLimit(table: number[][]): number | undefined {
  if (table.length === 0) return undefined;
  const nSamples = table[0].length;

  let smallest = Infinity;
  for (let j = 0; j < nSamples; j++) {
    let total = 0;
    let min = Infinity;
    for (const row of table) {
      const value = row[j];
      if (value > 0) {
        total += value;
        if (value < min) min = value;
      }
    }
    if (total > 0 && Number.isFinite(min)) {
      const relative = min / total;
      if (relative < smallest) smallest = relative;
    }
  }

  return Number.isFinite(smallest) ? smallest : undefined;
}

/**
 * Fraction of each sample's mass that zero replacement has to invent.
 *
 * Reported rather than merely guarded, because a CLR computed over a sample
 * that is mostly imputed describes the imputation and not the community — and
 * the only honest response to that is to say so.
 *
 * @param table features (rows) x samples (columns)
 * @returns one fraction per sample
 */
export function imputedFractions(
  table: number[][],
  replacement: ZeroReplacement,
): number[] {
  if (table.length === 0) return [];
  const nSamples = table[0].length;
  const out = new Array<number>(nSamples).fill(0);
  if (replacement.kind !== 'multiplicative') return out;

  const limit =
    replacement.relativeDetectionLimit ?? relativeDetectionLimit(table);
  if (limit === undefined) return out;

  for (let j = 0; j < nSamples; j++) {
    let zeros = 0;
    let positives = 0;
    for (const row of table) {
      if (row[j] > 0) positives++;
      else zeros++;
    }
    out[j] =
      positives > 0
        ? Math.min(MAX_IMPUTED_FRACTION, limit * replacement.fraction * zeros)
        : 1;
  }
  return out;
}

/**
 * CLR-transform one sample (a vector of parts across features).
 * Returns a vector of the same length, centred on the reference.
 */
export function clrTransformSample(
  parts: number[],
  replacement: ZeroReplacement = DEFAULT_ZERO_REPLACEMENT,
  options: ClrOptions = {},
): number[] {
  if (parts.length === 0) return [];

  if (parts.some((x) => x < 0)) {
    throw new Error('CLR requires non-negative values; found a negative part.');
  }

  const replaced = replaceZeros(parts, replacement);

  const reference = options.denominator ?? replaced.map((_, i) => i);
  if (reference.length === 0) {
    throw new Error('CLR needs at least one feature in the denominator.');
  }

  // Geometric mean via logs, to avoid overflow on wide dynamic ranges.
  let logSum = 0;
  for (const i of reference) logSum += Math.log(replaced[i]);
  const meanLog = logSum / reference.length;

  return replaced.map((x) => Math.log(x) - meanLog);
}

/**
 * CLR-transform a whole table.
 *
 * @param table  features (rows) x samples (columns)
 * @returns      a new table of the same shape
 *
 * The transform is applied per *sample*, i.e. down each column, because the
 * compositional constraint applies within a sample and not across features.
 */
export function clrTransformTable(
  table: number[][],
  replacement: ZeroReplacement = DEFAULT_ZERO_REPLACEMENT,
  options: ClrOptions = {},
): number[][] {
  const nFeatures = table.length;
  if (nFeatures === 0) return [];
  const nSamples = table[0].length;

  const result: number[][] = Array.from({ length: nFeatures }, () =>
    new Array<number>(nSamples).fill(0),
  );

  /*
   * Resolve the detection limit ONCE, across the whole table, so every sample
   * substitutes the same relative value. Letting each sample use its own
   * minimum makes the imputed value vary by orders of magnitude between
   * samples, and the transform then reports that variation as biology.
   */
  const resolved: ZeroReplacement =
    replacement.kind === 'multiplicative' &&
    replacement.relativeDetectionLimit === undefined
      ? { ...replacement, relativeDetectionLimit: relativeDetectionLimit(table) }
      : replacement;

  for (let j = 0; j < nSamples; j++) {
    const column = table.map((row) => row[j]);
    const transformed = clrTransformSample(column, resolved, options);
    for (let i = 0; i < nFeatures; i++) {
      result[i][j] = transformed[i];
    }
  }

  return result;
}

function replaceZeros(parts: number[], replacement: ZeroReplacement): number[] {
  if (replacement.kind === 'pseudocount') {
    if (replacement.value <= 0) {
      throw new Error('Pseudocount must be positive.');
    }
    return parts.map((x) => x + replacement.value);
  }

  // Multiplicative replacement.
  const nonZero = parts.filter((x) => x > 0);
  if (nonZero.length === 0) {
    throw new Error('Cannot CLR-transform a sample with no non-zero parts.');
  }

  const total = nonZero.reduce((a, b) => a + b, 0);
  const zeroCount = parts.length - nonZero.length;
  if (zeroCount === 0) return [...parts];

  if (!(replacement.fraction > 0)) {
    throw new Error('Multiplicative replacement fraction must be positive.');
  }

  /*
   * A relative limit, times this sample's total, is an absolute value in this
   * sample's units — so scaling a sample scales delta with it and the
   * transform is unchanged. Falling back to the sample's own minimum gives
   * the same thing expressed the long way round.
   */
  const relative = replacement.relativeDetectionLimit ?? Math.min(...nonZero) / total;
  if (!(relative > 0)) {
    throw new Error('Detection limit must be positive.');
  }

  /*
   * Cap the imputed mass instead of refusing to transform.
   *
   * A sparse sample used to throw here, which killed the whole analysis and
   * showed the user nothing at all. Sparsity is a property of the data, not
   * an error in it — the honest response is to bound the imputation, carry
   * on, and report how much was invented (see imputedFractions).
   */
  const ceiling = (total * MAX_IMPUTED_FRACTION) / zeroCount;
  const delta = Math.min(replacement.fraction * relative * total, ceiling);

  const scale = (total - delta * zeroCount) / total;
  return parts.map((x) => (x === 0 ? delta : x * scale));
}
