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

/**
 * Upper tail of the standard normal, P(Z > z).
 *
 * Exists so callers never write `1 - normalCdf(z)`. That subtraction is
 * catastrophic cancellation: `normalCdf(8.6)` is 1 to within double
 * precision, so the difference is exactly 0 and a real p-value of 7e-18 is
 * reported as p = 0 — which then becomes q = 0 and an infinite -log10 on the
 * volcano plot. `erfc` below computes the tail directly, without ever forming
 * the quantity close to 1.
 *
 * Accuracy is still bounded by the underlying approximation (see
 * P_VALUE_PRECISION_FLOOR): the value is positive and correct to a few
 * significant figures near the threshold, not exact out in the far tail.
 */
export function normalUpperTail(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

/*
 * Abramowitz & Stegun 7.1.26.
 *
 * The approximation is naturally expressed as erfc — a polynomial in t times
 * exp(-x^2) — and erf is then 1 minus that. Writing erfc directly, rather
 * than as `1 - erf(x)`, is what keeps the small tail values from being
 * rounded away.
 */
function erfcPositive(ax: number): number {
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;

  const t = 1 / (1 + p * ax);
  return ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
}

/** Complementary error function, erfc(x) = 1 - erf(x), computed without cancellation. */
export function erfc(x: number): number {
  return x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x);
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  return sign * (1 - erfcPositive(Math.abs(x)));
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

/**
 * Regularised UPPER incomplete gamma function Q(a, x) = 1 - P(a, x).
 *
 * Computed directly rather than as `1 - lowerGamma(a, x)`, for the same
 * reason as `normalUpperTail`: above the crossover the continued fraction
 * already produces Q, and the old code turned it into P only for the caller
 * to subtract it back, discarding every bit below 1e-16. That made
 * `chiSquareUpperTail(80, 2)` return exactly 0 where the true value is
 * 4.25e-18, and `chiSquareUpperTail(74, 2)` wrong by 30%.
 */
export function upperGamma(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;

  // Below the crossover the series for P converges quickly and Q is not
  // small, so 1 - P loses nothing here.
  if (x < a + 1) return 1 - lowerGamma(a, x);

  // Continued fraction (modified Lentz's method), which yields Q directly.
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

  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Upper tail probability of the chi-square distribution. */
export function chiSquareUpperTail(x: number, df: number): number {
  if (x <= 0) return 1;
  if (df <= 0) return NaN;
  return upperGamma(df / 2, x / 2);
}
