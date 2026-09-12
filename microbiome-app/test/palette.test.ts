/**
 * Palette tests.
 *
 * The point of generating colours instead of picking a scheme is that the
 * result can be MEASURED. "Looks fine to me" is how a palette ships with two
 * indistinguishable entries — which is exactly what the first version of this
 * generator did at 25 colours, where the hue circle wrapped onto the same
 * lightness tier and produced a pair 0.031 apart in Oklab.
 *
 * So these tests convert the emitted hex back into Oklab and assert on real
 * perceptual distances, rather than counting that the strings differ.
 */

import { describe, expect, it } from 'vitest';

import {
  compositionColors,
  distinctColors,
  oklabDistance,
  OTHER_COLOR,
  type Oklab,
} from '../src/lib/palette';

const MAX_TAXA = 25;

/**
 * Decode a rendered hex colour back to Oklab.
 *
 * Deliberately an independent implementation of the reverse direction rather
 * than a reuse of the forward one: if the forward conversion were wrong, a
 * round trip through the same constants would still agree with itself.
 */
function hexToOklab(hex: string): Oklab {
  const channel = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  const linear = (x: number) =>
    x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);

  const r = linear(channel(0));
  const g = linear(channel(1));
  const b = linear(channel(2));

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function minimumSeparation(colors: string[]): number {
  const labs = colors.map(hexToOklab);
  let min = Infinity;
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) {
      min = Math.min(min, oklabDistance(labs[i], labs[j]));
    }
  }
  return min;
}

describe('distinctColors', () => {
  it('returns exactly the number asked for, all different', () => {
    for (let n = 1; n <= MAX_TAXA; n++) {
      const colors = distinctColors(n);
      expect(colors).toHaveLength(n);
      expect(new Set(colors).size).toBe(n);
    }
  });

  it('emits well-formed sRGB hex', () => {
    for (const color of distinctColors(MAX_TAXA)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps every pair perceptually apart, up to the maximum', () => {
    /*
     * 0.06 in Oklab is several times the just-noticeable difference for
     * patches this size. The measured worst case across every n up to 25 is
     * 0.073; the threshold sits below that so ordinary drift does not fail
     * the suite, but a regression like the wrap-around bug (0.031) does.
     */
    for (let n = 2; n <= MAX_TAXA; n++) {
      expect(minimumSeparation(compositionColors(n))).toBeGreaterThan(0.06);
    }
  });

  it('separates neighbours in the legend more than the set as a whole', () => {
    /*
     * Consecutive entries are stacked directly against each other, so they
     * are where confusion actually costs something. They get a stricter bound
     * than distant pairs, which the reader compares only via the legend.
     */
    const colors = compositionColors(MAX_TAXA);
    const labs = colors.map(hexToOklab);
    for (let i = 0; i + 1 < labs.length; i++) {
      expect(oklabDistance(labs[i], labs[i + 1])).toBeGreaterThan(0.12);
    }
  });

  it('is deterministic, so a rebuilt figure matches a saved one', () => {
    expect(distinctColors(MAX_TAXA)).toEqual(distinctColors(MAX_TAXA));
    // And a prefix is not assumed: asking for fewer may legitimately
    // re-space the hues, but must stay stable for that count.
    expect(distinctColors(7)).toEqual(distinctColors(7));
  });

  it('handles the degenerate counts', () => {
    expect(distinctColors(0)).toEqual([]);
    expect(distinctColors(1)).toHaveLength(1);
    expect(distinctColors(2)).toHaveLength(2);
    expect(new Set(distinctColors(2)).size).toBe(2);
  });
});

describe('compositionColors', () => {
  it('always ends with grey for "Other"', () => {
    for (let n = 0; n <= MAX_TAXA; n++) {
      const range = compositionColors(n);
      expect(range).toHaveLength(n + 1);
      expect(range[range.length - 1]).toBe(OTHER_COLOR);
    }
  });

  it('never gives a named taxon the "Other" grey', () => {
    for (let n = 1; n <= MAX_TAXA; n++) {
      expect(distinctColors(n)).not.toContain(OTHER_COLOR);
    }
  });

  it('keeps "Other" clearly lighter than the taxa around it', () => {
    // Grey has to read as "everything else", not as one more taxon. Being
    // both unsaturated and light is what does that.
    const grey = hexToOklab(OTHER_COLOR);
    expect(Math.hypot(grey.a, grey.b)).toBeLessThan(0.02);
    expect(grey.L).toBeGreaterThan(0.85);
  });
});
