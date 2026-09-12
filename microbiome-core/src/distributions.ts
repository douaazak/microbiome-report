/**
 * Minimal statistical distribution functions.
 *
 * Implemented here rather than pulled from a dependency because these are the
 * numerical foundation of every p-value the tool reports, and an unmaintained
 * stats package is a poor place to put that trust. Each function below is
 * tested against known analytic values.
 */

/**
 * Smallest p-value this module reports as a distinct number.
 *
 * The error function approximation used below has an absolute error around
 * 1.5e-7, so any p-value smaller than that is noise dressed as precision.
 * Callers should display anything at or below this as "< 1e-6" rather than
 * printing digits that mean nothing.
 */
export const P_VALUE_PRECISION_FLOOR = 1e-6;

/**
 * Standard normal cumulative distribution function.
 *
 * Uses an error function approximation with maximum absolute error ~1.5e-7
 * (Abramowitz & Stegun 7.1.26). That is ample for deciding significance at
 * conventional thresholds, but see P_VALUE_PRECISION_FLOOR: it is NOT enough
 * to distinguish p = 1e-9 from p = 1e-12, and neither should be reported as
 * though it were exact.
 */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;

  const t = 1 / (1 + p * ax);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);

  return sign * y;
}

/** Natural log of the gamma function (Lanczos approximation). */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  if (x < 0.5) {
    // Reflection formula, for numerical stability near zero.
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
    );
  }

  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) {
    a += c[i] / (z + i);
  }

  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularised lower incomplete gamma function P(a, x).
 *
 * Series expansion below the crossover point, continued fraction above it;
 * this is the standard split, since the series converges slowly for large x.
 */
export function lowerGamma(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;

  if (x < a + 1) {
    // Series representation.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }

  // Continued fraction representation (modified Lentz's method).
  const tiny = 1e-30;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;

  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }

  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return 1 - q;
}

/** Upper tail probability of the chi-square distribution. */
export function chiSquareUpperTail(x: number, df: number): number {
  if (x <= 0) return 1;
  if (df <= 0) return NaN;
  return 1 - lowerGamma(df / 2, x / 2);
}
