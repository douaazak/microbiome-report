/**
 * Axis label layout.
 *
 * The reported symptom was overlapping labels on the alpha-diversity x axis.
 * The cause was a fixed -60° rotation: it fits short labels and fails long
 * ones, because the space a rotated label needs depends on its length and on
 * how many neighbours share the axis. Rotation is now derived from both.
 */

import { describe, expect, it } from 'vitest';

import { axisLabelLayout } from '../src/lib/axis';

const labels = (n: number, length = 6) =>
  Array.from({ length: n }, (_, i) => `S${String(i).padStart(length - 1, '0')}`);

describe('axisLabelLayout', () => {
  it('leaves a handful of short labels horizontal', () => {
    const { tickRotate, ticks } = axisLabelLayout(['a', 'b', 'c'], 1000);
    expect(tickRotate).toBe(0);
    expect(ticks).toEqual(['a', 'b', 'c']);
  });

  it('tilts when labels start to crowd', () => {
    const { tickRotate } = axisLabelLayout(labels(30), 1000);
    expect(tickRotate).toBeLessThan(0);
  });

  it('goes vertical rather than let long labels overlap', () => {
    // Long IDs at many ticks cannot fit at any partial angle.
    const { tickRotate } = axisLabelLayout(
      Array.from({ length: 40 }, (_, i) => `SampleIdentifier_${i}_replicate2`),
      1000,
    );
    expect(tickRotate).toBe(-90);
  });

  it('never returns more ticks than the cap', () => {
    for (const n of [50, 400, 1387]) {
      expect(axisLabelLayout(labels(n), 1000, 40).ticks.length).toBeLessThanOrEqual(40);
    }
  });

  it('reserves more bottom margin as rotation steepens', () => {
    const flat = axisLabelLayout(['a', 'b'], 1000);
    const steep = axisLabelLayout(
      Array.from({ length: 40 }, (_, i) => `SampleIdentifier_${i}_replicate2`),
      1000,
    );
    expect(steep.marginBottom).toBeGreaterThan(flat.marginBottom);
  });

  it('caps the margin so one long label cannot swallow the figure', () => {
    const { marginBottom } = axisLabelLayout(
      [`${'x'.repeat(300)}`, `${'y'.repeat(300)}`, 'z'],
      1000,
    );
    expect(marginBottom).toBeLessThanOrEqual(200);
  });

  it('always leaves room for the axis title', () => {
    expect(axisLabelLayout([], 1000).marginBottom).toBeGreaterThan(0);
    expect(axisLabelLayout(['a'], 1000).marginBottom).toBeGreaterThan(20);
  });

  it('tilts sooner in a narrow plot than a wide one', () => {
    const wide = axisLabelLayout(labels(20, 10), 1400);
    const narrow = axisLabelLayout(labels(20, 10), 400);
    expect(Math.abs(narrow.tickRotate)).toBeGreaterThanOrEqual(
      Math.abs(wide.tickRotate),
    );
  });

  it('handles an empty axis', () => {
    const { ticks, tickRotate } = axisLabelLayout([], 1000);
    expect(ticks).toEqual([]);
    expect(tickRotate).toBe(0);
  });
});
