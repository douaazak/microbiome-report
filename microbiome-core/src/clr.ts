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
   * Replace zeros with a fraction of the smallest observed non-zero value in
   * that sample, then rescale the non-zeros so the composition still sums to
   * its original total. Preserves ratios among observed parts better than a
   * flat pseudocount.
   */
  | { kind: 'multiplicative'; fraction: number };

export const DEFAULT_ZERO_REPLACEMENT: ZeroReplacement = {
  kind: 'pseudocount',
  value: 0.5,
};

/**
 * CLR-transform one sample (a vector of parts across features).
 * Returns a vector of the same length, centred on zero.
 */
export function clrTransformSample(
  parts: number[],
  replacement: ZeroReplacement = DEFAULT_ZERO_REPLACEMENT,
): number[] {
  if (parts.length === 0) return [];

  if (parts.some((x) => x < 0)) {
    throw new Error('CLR requires non-negative values; found a negative part.');
  }

  const replaced = replaceZeros(parts, replacement);

  // Geometric mean via logs, to avoid overflow on wide dynamic ranges.
  let logSum = 0;
  for (const x of replaced) logSum += Math.log(x);
  const meanLog = logSum / replaced.length;

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
): number[][] {
  const nFeatures = table.length;
  if (nFeatures === 0) return [];
  const nSamples = table[0].length;

  const result: number[][] = Array.from({ length: nFeatures }, () =>
    new Array<number>(nSamples).fill(0),
  );

  for (let j = 0; j < nSamples; j++) {
    const column = table.map((row) => row[j]);
    const transformed = clrTransformSample(column, replacement);
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
  const delta = Math.min(...nonZero) * replacement.fraction;

  if (delta <= 0) {
    throw new Error('Multiplicative replacement fraction must be positive.');
  }

  const zeroCount = parts.length - nonZero.length;
  if (zeroCount === 0) return [...parts];

  const removed = delta * zeroCount;
  if (removed >= total) {
    throw new Error(
      'Zero replacement would consume the entire composition; the sample is too sparse.',
    );
  }

  const scale = (total - removed) / total;
  return parts.map((x) => (x === 0 ? delta : x * scale));
}
