// @vitest-environment jsdom

/**
 * Which SVG gets exported.
 *
 * "Download SVG" once saved a 15×15 colour swatch on every plot that had a
 * legend, because Plot puts the legend before the chart inside its <figure>
 * and each swatch is itself an <svg>. The chart is the figure's direct child.
 */

import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';

import { plotSvg } from '../src/lib/download';

const rows = [
  { x: 'a', y: 1, kind: 'p' },
  { x: 'b', y: 2, kind: 'q' },
];

describe('plotSvg', () => {
  it('returns the plot itself when there is no legend', () => {
    const node = Plot.plot({
      marks: [Plot.barY(rows, { x: 'x', y: 'y' })],
    }) as unknown as Element;
    expect(node instanceof SVGSVGElement).toBe(true);
    expect(plotSvg(node)).toBe(node);
  });

  it('skips the legend swatches and returns the chart', () => {
    const node = Plot.plot({
      width: 400,
      color: { legend: true },
      marks: [Plot.barY(rows, { x: 'x', y: 'y', fill: 'kind' })],
    }) as unknown as Element;

    // The precondition for the bug: a figure with several svgs, the first of
    // which is a swatch, not the chart.
    expect(node.tagName.toLowerCase()).toBe('figure');
    const all = [...node.querySelectorAll('svg')];
    expect(all.length).toBeGreaterThan(1);
    expect(Number(all[0].getAttribute('width'))).toBeLessThan(50);

    const chart = plotSvg(node);
    expect(chart).not.toBeNull();
    expect(chart!.parentElement).toBe(node);
    expect(Number(chart!.getAttribute('width'))).toBe(400);
    // The chart is the one carrying the marks.
    expect(chart!.querySelectorAll('rect').length).toBeGreaterThanOrEqual(2);
  });
});
