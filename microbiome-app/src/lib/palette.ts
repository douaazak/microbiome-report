/**
 * Categorical palette generation.
 *
 * Observable Plot's built-in categorical schemes top out at 12 entries, which
 * capped the composition chart at 11 taxa plus "Other". Rather than accept
 * that limit, colours are constructed here for whatever number is asked for.
 *
 * They are built in OKLCH, not HSL. HSL's lightness is not perceptual: fully
 * saturated yellow and fully saturated blue are both "50% lightness" while one
 * of them nearly glows and the other is almost black, so a palette spaced
 * evenly in HSL has some pairs that are hard to tell apart and others that
 * differ wildly in weight. OKLCH is perceptually uniform, so an even spacing
 * in it really is an even visual spacing, and the distance between two colours
 * can be measured rather than hoped for — which the tests do.
 */

/** "Other" is always this: light, neutral, and never mistaken for a real taxon. */
export const OTHER_COLOR = '#d5dae1';

/** Chroma of the generated colours. High enough to be vivid, low enough to stay in sRGB. */
const CHROMA = 0.135;

/**
 * Lightness tiers, cycled across neighbouring hues.
 *
 * Hue alone is not enough at 25 colours: adjacent hues are then only ~14
 * degrees apart, which is a small perceptual step. Giving consecutive hues
 * different lightness adds a second axis of separation, so the two colours
 * most similar in hue are never also similar in lightness.
 */
const LIGHTNESS = [0.78, 0.64, 0.5];

/** Where the hue circle starts. Chosen so the first few colours are a pleasant set. */
const HUE_OFFSET = 25;

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/** Convert OKLCH to Oklab. Hue in degrees. */
export function oklchToOklab(L: number, C: number, h: number): Oklab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

/**
 * Oklab to linear sRGB. Coefficients from Björn Ottosson's definition of the
 * space; the result is NOT clamped, so out-of-gamut colours are detectable.
 */
function oklabToLinearRgb({ L, a, b }: Oklab): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear sRGB component to gamma-encoded sRGB. */
function encodeGamma(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  const ok = (x: number) => x >= -1e-6 && x <= 1 + 1e-6;
  return ok(r) && ok(g) && ok(b);
}

function toHex(rgb: [number, number, number]): string {
  const part = (x: number) => {
    const v = Math.round(Math.min(1, Math.max(0, encodeGamma(x))) * 255);
    return v.toString(16).padStart(2, '0');
  };
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/**
 * OKLCH to a hex string, reducing chroma until the colour fits in sRGB.
 *
 * Some hues — saturated blues especially — simply do not exist in sRGB at a
 * given lightness and chroma. Clamping the RGB channels instead would distort
 * the hue and quietly break the even spacing the palette depends on, so the
 * chroma is walked down until the colour is representable.
 */
export function oklchToHex(L: number, C: number, h: number): string {
  let chroma = C;
  for (let i = 0; i < 40; i++) {
    const rgb = oklabToLinearRgb(oklchToOklab(L, chroma, h));
    if (inGamut(rgb)) return toHex(rgb);
    chroma *= 0.92;
  }
  return toHex(oklabToLinearRgb(oklchToOklab(L, 0, h)));
}

/** Perceptual distance between two OKLCH colours, in Oklab units. */
export function oklabDistance(x: Oklab, y: Oklab): number {
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

/**
 * Largest integer below n that shares no factor with it.
 *
 * Used to step around a band's hues so that colours ADJACENT IN THE LEGEND are
 * far apart in hue. Stepping by 1 would put neighbouring hues next to each
 * other in the stack, which is exactly where confusion costs most. A step near
 * n/phi spreads them; being coprime with n guarantees every hue is visited
 * exactly once.
 */
function coprimeStep(n: number): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let step = Math.max(1, Math.round(n / 1.618));
  while (step > 1 && gcd(step, n) !== 1) step--;
  return step;
}

/**
 * `n` visually distinct colours, in the order they should be used.
 *
 * Deterministic: the same n always gives the same colours, so a figure
 * regenerated tomorrow matches the one saved today.
 *
 * The colours are split into LIGHTNESS BANDS, each spanning the hue circle
 * independently, rather than cycling lightness along one shared circle. That
 * earlier arrangement failed at the seam: with 25 colours and 3 lightness
 * tiers, the last hue and the first hue are neighbours on the circle but
 * 24 mod 3 = 0 mod 3, so they landed on the same tier and came out 0.03 apart
 * in Oklab — visually the same colour. Banding cannot produce that, because
 * hue neighbours within a band are a full band-spacing apart and colours in
 * different bands are separated by lightness no matter what their hues do.
 */
export function distinctColors(n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [oklchToHex(LIGHTNESS[1], CHROMA, HUE_OFFSET)];
  if (n === 2) {
    return [
      oklchToHex(LIGHTNESS[0], CHROMA, HUE_OFFSET),
      oklchToHex(LIGHTNESS[2], CHROMA, HUE_OFFSET + 180),
    ];
  }

  const bandCount = Math.min(LIGHTNESS.length, n);

  // Sizes as equal as possible; the remainder goes to the earliest bands.
  const sizes = Array.from({ length: bandCount }, (_, b) =>
    Math.floor(n / bandCount) + (b < n % bandCount ? 1 : 0),
  );

  const bands = sizes.map((size, b) => {
    const step = coprimeStep(size);
    // Bands are staggered against each other so that a colour in one band is
    // not sitting at the same hue as one in the next.
    const stagger = (b * 360) / (bandCount * size);
    return Array.from({ length: size }, (_, k) => {
      const j = (k * step) % size;
      return oklchToHex(LIGHTNESS[b], CHROMA, HUE_OFFSET + stagger + (360 * j) / size);
    });
  });

  // Round-robin the bands, so consecutive entries always differ in lightness.
  const out: string[] = [];
  const taken = new Array<number>(bandCount).fill(0);
  for (let k = 0; out.length < n; k++) {
    const b = k % bandCount;
    if (taken[b] < bands[b].length) out.push(bands[b][taken[b]++]);
  }
  return out;
}

/**
 * A full colour range for a stacked composition: one colour per named taxon,
 * with "Other" pinned to grey at the end.
 */
export function compositionColors(namedTaxa: number): string[] {
  return [...distinctColors(namedTaxa), OTHER_COLOR];
}
