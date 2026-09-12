// @vitest-environment jsdom

/**
 * Rendering tests for the composition plot.
 *
 * These exist because of a bug that every other check passed: the options were
 * valid, the marks rendered, the colour scale resolved to ten distinct
 * colours — and the bars were drawn roughly a hundred times too tall and
 * clipped out of the frame, so the whole chart showed as one colour.
 *
 * `percent: true` multiplies values by 100, so a y domain written in
 * fractional units (0–1.08) against bars that reach 100 produces exactly that.
 * Counting elements cannot detect it. These tests MEASURE them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';

import {
  buildCompositionPlot,
  LABEL_PITCH,
  MAX_DISTINCT_TAXA,
  MIN_LABELLED_BAR_WIDTH,
  OTHER,
  ROW_HEIGHT,
} from '../src/lib/composition';
import { loadDataset } from '../src/lib/load';
import { OTHER_COLOR } from '../src/lib/palette';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');
const read = (name: string) => readFileSync(join(DEMO, name), 'utf8');

const dataset = loadDataset({
  kind: 'asv',
  tableText: read('feature-table.tsv'),
  taxonomyText: read('taxonomy.tsv'),
  metadataText: read('metadata.tsv'),
});

interface Bar {
  y: number;
  height: number;
  fill: string;
}

/**
 * Render and pull out the bar geometry.
 *
 * With `legend: true`, Plot returns a <figure> whose FIRST svg elements are
 * legend swatches — the plot itself is the last one. Selecting the first svg
 * silently inspects the legend, which is how the original bug survived a
 * first attempt at diagnosis.
 */
function render(options: Plot.PlotOptions): { height: number; bars: Bar[] } {
  const node = Plot.plot(options) as unknown as Element;
  const svgs = [...node.querySelectorAll('svg')];
  const plot = svgs.length > 0 ? svgs[svgs.length - 1] : (node as SVGElement);

  const height = Number(plot.getAttribute('height'));
  const bars = [...plot.querySelectorAll('rect')]
    .map((rect) => ({
      y: Number(rect.getAttribute('y')),
      height: Number(rect.getAttribute('height')),
      fill: rect.getAttribute('fill') ?? '',
    }))
    .filter((bar) => bar.fill !== '' && Number.isFinite(bar.height));

  return { height, bars };
}

describe('composition plot geometry', () => {
  const plot = buildCompositionPlot(dataset, {
    rank: 'genus',
    topN: 10,
    variable: 'group',
  });

  it('draws every bar inside the plot area', () => {
    const { height, bars } = render(plot.options);
    expect(bars.length).toBeGreaterThan(0);

    for (const bar of bars) {
      // The regression: bars were ~16,000px tall in a 470px plot.
      expect(bar.height).toBeLessThanOrEqual(height);
      expect(bar.y).toBeGreaterThanOrEqual(-1);
      expect(bar.y + bar.height).toBeLessThanOrEqual(height + 1);
    }
  });

  it('stacks each sample to fill the axis, not overflow it', () => {
    const { height, bars } = render(plot.options);
    const total = bars.reduce((sum, bar) => sum + bar.height, 0);
    const perSample = total / dataset.table.sampleIds.length;

    // Each sample's stack should span most of the plot height, since bars are
    // normalised to 100%. Allowing generous slack for margins and headroom.
    expect(perSample).toBeGreaterThan(height * 0.4);
    expect(perSample).toBeLessThan(height);
  });

  it('gives every taxon a distinct colour', () => {
    const { bars } = render(plot.options);
    const fills = new Set(bars.map((bar) => bar.fill));
    // 10 taxa plus "Other".
    expect(fills.size).toBe(plot.order.length + 1);
  });

  it('keeps every colour distinct at the maximum taxon count', () => {
    /*
     * Colours are generated rather than taken from a fixed scheme, so asking
     * for more taxa must never make two slices of the same bar share a
     * colour — which is what happened when the range recycled past 12.
     * The demo table has fewer genera than the cap, so the expectation is
     * "one distinct colour per taxon shown", not the cap itself.
     */
    const wide = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: MAX_DISTINCT_TAXA,
      variable: 'group',
    });
    const { bars } = render(wide.options);
    const fills = new Set(bars.map((bar) => bar.fill));
    expect(wide.order.length).toBeGreaterThan(10);
    expect(wide.order.length).toBeLessThanOrEqual(MAX_DISTINCT_TAXA);
    // Above the table's own genus count nothing is left over, so "Other" is
    // absent from the data even though it stays in the scale's domain.
    const pooled = wide.rows.some((r) => r.taxon === OTHER) ? 1 : 0;
    expect(fills.size).toBe(wide.order.length + pooled);
  });

  it('paints "Other" grey, whatever the taxon count', () => {
    for (const topN of [3, 10, MAX_DISTINCT_TAXA]) {
      const plot = buildCompositionPlot(dataset, {
        rank: 'genus',
        topN,
        variable: 'group',
      });
      const range = (plot.options.color as { range?: string[] }).range ?? [];
      const domain = (plot.options.color as { domain?: string[] }).domain ?? [];
      expect(domain[domain.length - 1]).toBe(OTHER);
      expect(range[range.length - 1]).toBe(OTHER_COLOR);
      expect(range).toHaveLength(domain.length);
      // Grey is reserved: no named taxon may be given it.
      expect(range.slice(0, -1)).not.toContain(OTHER_COLOR);
    }
  });

  it('renders without a grouping variable', () => {
    const ungrouped = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: '',
    });
    const { height, bars } = render(ungrouped.options);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.height).toBeLessThanOrEqual(height);
    }
  });
});

describe('composition plot data', () => {
  it('normalises every sample to sum to 1', () => {
    const { rows } = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });

    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.sampleId, (totals.get(row.sampleId) ?? 0) + row.abundance);
    }
    expect(totals.size).toBe(dataset.table.sampleIds.length);
    for (const total of totals.values()) {
      expect(total).toBeCloseTo(1, 8);
    }
  });

  it('pools everything outside the top N into a single Other category', () => {
    const { rows, order } = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 5,
      variable: 'group',
    });
    expect(order).toHaveLength(5);
    expect(rows.some((r) => r.taxon === OTHER)).toBe(true);
  });

  it('orders samples by group, leaving no gaps in the axis', () => {
    const { sampleOrder, groupSpans } = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });

    // Every sample appears exactly once — faceting used to leave blank slots.
    expect(sampleOrder).toHaveLength(dataset.table.sampleIds.length);
    expect(new Set(sampleOrder).size).toBe(sampleOrder.length);

    // And samples of a group form one contiguous run.
    expect(groupSpans.map((s) => s.n).reduce((a, b) => a + b, 0)).toBe(
      sampleOrder.length,
    );
  });

  it('draws the group labels ON the canvas', () => {
    /*
     * Regression: the labels were positioned at y=104 while `percent: true`
     * multiplies data values by 100, putting them at y=-32371 in screen
     * coordinates. The mark existed, the plot rendered, and the labels were
     * simply nowhere visible — which counting elements cannot detect.
     */
    const plot = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });
    const node = Plot.plot(plot.options) as unknown as Element;
    const svgs = [...node.querySelectorAll('svg')];
    const svg = svgs.length > 0 ? svgs[svgs.length - 1] : (node as SVGElement);
    const height = Number(svg.getAttribute('height'));

    const positions = [...svg.querySelectorAll('text')]
      .filter((t) => /^(disease|healthy) \(n = \d+\)$/.test(t.textContent ?? ''))
      .map((t) => {
        const transform =
          t.getAttribute('transform') ??
          t.parentElement?.getAttribute('transform') ??
          '';
        const match = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(transform);
        return match ? Number(match[2]) : Number(t.getAttribute('y'));
      });

    expect(positions).toHaveLength(2);
    for (const y of positions) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });

  it('averages by group rather than pooling', () => {
    const plot = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
      mode: 'groupMeans',
    });

    expect(plot.mode).toBe('groupMeans');
    // One bar per group, not per sample.
    expect(plot.sampleOrder).toEqual(['disease', 'healthy']);

    // Each group's bar still sums to 1: means of proportions that each sum to
    // 1 must themselves sum to 1.
    const totals = new Map<string, number>();
    for (const row of plot.rows) {
      totals.set(row.group, (totals.get(row.group) ?? 0) + row.abundance);
    }
    for (const total of totals.values()) expect(total).toBeCloseTo(1, 8);

    // Group sizes are reported so the reader knows what was averaged.
    expect(plot.groupSpans.map((s) => s.n)).toEqual([20, 20]);
  });

  it('divides by group size, so absent taxa count as zero', () => {
    // Pooling only the samples that carry a taxon would overstate it. The
    // mean must be over every sample in the group.
    const plot = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
      mode: 'groupMeans',
    });
    const perSample = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });

    for (const group of ['disease', 'healthy']) {
      const members = new Set(
        perSample.rows.filter((r) => r.group === group).map((r) => r.sampleId),
      );
      for (const taxon of plot.order) {
        const manual =
          perSample.rows
            .filter((r) => r.group === group && r.taxon === taxon)
            .reduce((sum, r) => sum + r.abundance, 0) / members.size;
        const computed = plot.rows.find(
          (r) => r.group === group && r.taxon === taxon,
        )!.abundance;
        expect(computed).toBeCloseTo(manual, 10);
      }
    }
  });

  it('labels every sample, widening the figure when it has to', () => {
    /*
     * The complaint this fixes: 220 bars, ~100 labels. Thinning the axis made
     * most bars unidentifiable. The figure now takes the width it needs and
     * the panel scrolls it.
     */
    const many = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });
    const ticks = (many.options.x as { ticks?: string[] }).ticks ?? [];
    expect(ticks).toHaveLength(many.sampleOrder.length);

    // 40 samples still fit the default width, so no scrolling is needed.
    expect(many.scrolls).toBe(false);
    expect(many.options.width).toBeUndefined();
  });

  it('pins a wider figure once labels no longer fit the page', () => {
    // A Franzosa-sized cohort: 220 samples cannot be labelled in 1300px.
    const n = 220;
    const samples = Array.from({ length: n }, (_, i) => `PRISM.${7000 + i}`);
    const header = ['#OTU ID', ...samples].join('\t');
    const body = ['ASV_1', 'ASV_2', 'ASV_3']
      .map((id, f) =>
        [id, ...samples.map((_, i) => String(10 + ((i * (f + 3)) % 40)))].join('\t'),
      )
      .join('\n');
    const meta = [
      'sample-id\tarm',
      ...samples.map((id, i) => `${id}\t${i < 120 ? 'CD' : 'Control'}`),
    ].join('\n');

    const big = loadDataset({
      kind: 'asv',
      tableText: `${header}\n${body}\n`,
      metadataText: `${meta}\n`,
    });
    // Left to choose, 220 samples get one row each rather than a 3,384px
    // wide figure the reader has to drag through.
    const auto = buildCompositionPlot(big, {
      rank: 'genus',
      topN: 3,
      variable: 'arm',
    });
    expect(auto.horizontal).toBe(true);
    expect(auto.scrolls).toBe(false);
    expect(auto.options.height).toBeGreaterThanOrEqual(n * ROW_HEIGHT);

    // Forced back to columns, it takes the width instead and scrolls.
    const plot = buildCompositionPlot(big, {
      rank: 'genus',
      topN: 3,
      variable: 'arm',
      orientation: 'vertical',
    });

    expect(plot.scrolls).toBe(true);
    // Every sample labelled — that is the whole reason for the extra width.
    const ticks = (plot.options.x as { ticks?: string[] }).ticks ?? [];
    expect(ticks).toHaveLength(n);
    expect(plot.options.width).toBeGreaterThanOrEqual(n * MIN_LABELLED_BAR_WIDTH);

    // And each bar is wide enough for its label to clear its neighbour.
    const node = Plot.plot(plot.options) as unknown as Element;
    const svgs = [...node.querySelectorAll('svg')];
    const svg = svgs.length > 0 ? svgs[svgs.length - 1] : (node as SVGElement);
    const widths = [...svg.querySelectorAll('rect')]
      .map((r) => Number(r.getAttribute('width')))
      .filter((w) => Number.isFinite(w) && w > 0);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(LABEL_PITCH);
  });

  it('reports each group span so the caption can name the counts', () => {
    const plot = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });
    for (const span of plot.groupSpans) {
      const members = plot.sampleOrder.slice(
        plot.sampleOrder.indexOf(span.first),
        plot.sampleOrder.indexOf(span.last) + 1,
      );
      // first..last must be a contiguous run of exactly n samples.
      expect(members).toHaveLength(span.n);
      expect(plot.caption).toContain(`${span.group} n=${span.n}`);
    }
  });

  it('flags when there are more samples than bars can show', () => {
    const small = buildCompositionPlot(dataset, {
      rank: 'genus',
      topN: 10,
      variable: 'group',
    });
    // 40 samples is comfortably under the limit.
    expect(small.tooManySamples).toBeUndefined();
  });

  it('falls back to feature IDs when no taxonomy was supplied', () => {
    const noTaxonomy = loadDataset({
      kind: 'asv',
      tableText: read('feature-table.tsv'),
      metadataText: read('metadata.tsv'),
    });
    const { order } = buildCompositionPlot(noTaxonomy, {
      rank: 'genus',
      topN: 5,
      variable: 'group',
    });
    expect(order.every((label) => label.startsWith('ASV_'))).toBe(true);
  });
});
