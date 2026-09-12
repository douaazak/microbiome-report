/**
 * Composition plot construction, kept separate from the React component so it
 * can be rendered and measured in tests.
 *
 * This exists because a bug shipped that was invisible to every check in
 * place: the plot options were valid, the marks rendered, the colours resolved
 * — and the bars were still drawn a hundred times too tall and clipped out of
 * the frame. Counting elements does not catch that. Measuring them does.
 */

import * as Plot from '@observablehq/plot';
import { labelAtRank, type Rank } from 'microbiome-core';

import { axisLabelLayout } from './axis';
import { compositionColors, OTHER_COLOR } from './palette';

import { groupLabels, type Dataset } from './load';

export const OTHER = 'Other';

/*
 * Vertical positions of the group annotations, and the y domain that makes
 * room for them. Asymmetric on purpose, and verified by rendering.
 *
 * `percent: true` multiplies DATA VALUES by 100 but leaves the DOMAIN in the
 * transformed space. So anything positioned by a y CHANNEL must be given
 * pre-transform (1.04 -> 104) while the domain maximum is post-transform
 * (108). Setting the label to 104 places it at y = -32371 in screen
 * coordinates — far off canvas — which is exactly how the group labels went
 * missing after the domain was corrected from [0, 1.08] to [0, 108].
 */
const LABEL_Y = 1.045;
const BRACKET_Y = 1.012;
const SHADE_Y = 1.08;
const Y_MAX_WITH_LABELS = 108;

/** Background tint marking every other group's span. */
const SHADE_FILL = '#e8edf4';
/** Colour of the bracket under each group label. */
const BRACKET_STROKE = '#4a5568';

/**
 * Most named taxa the composition chart will show individually.
 *
 * This used to be 11, set by the size of Observable Plot's largest built-in
 * categorical scheme rather than by anything about the data. Colours are now
 * generated for whatever number is asked for (see lib/palette), so the limit
 * is a readability judgement instead: at 25 the least-similar pair of colours
 * is still 0.073 apart in Oklab, which is comfortably distinguishable, and
 * consecutive slices are further apart than that. Past roughly this many, a
 * stacked bar stops being a figure anyone can read whatever the palette does.
 */
export const MAX_DISTINCT_TAXA = 25;

/**
 * How many sample labels fit across the x axis before they collide.
 *
 * Rotated at -60° in the default plot width, roughly this many are legible.
 * Above it the labels are thinned rather than hidden entirely, so the axis
 * still says where you are in the ordering.
 */
export const MAX_AXIS_LABELS = 40;

/** Horizontal room one rotated label needs, in pixels. */
export const LABEL_PITCH = 13;

/**
 * Width each bar is given when every sample is to be labelled.
 *
 * Slightly more than LABEL_PITCH so vertical labels clear each other. Below
 * this the axis has to drop labels; at or above it, one tick per bar fits and
 * the plot is allowed to overflow its container and scroll instead.
 */
export const MIN_LABELLED_BAR_WIDTH = 15;

/** Left and right margins, fixed so bar width can be derived from the width. */
const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 24;

/** Height of one sample's row when the bars run horizontally. */
export const ROW_HEIGHT = 15;

/**
 * Assumed plot-area width when deciding tick rotation.
 *
 * The real width is measured at render time and passed to Plot, but the axis
 * layout has to be decided while building the options. This is a reasonable
 * estimate for the widened layout; being a little out only shifts the
 * rotation threshold, never breaks it, because the vertical fallback fits at
 * any width.
 */
export const PLOT_AREA_WIDTH = 1300;

/**
 * A type alias rather than an interface, so it satisfies the
 * `Record<string, unknown>` shape the TSV exporter expects. Interfaces do not
 * get an implicit index signature; type aliases do.
 */
export type CompositionRow = {
  sampleId: string;
  taxon: string;
  abundance: number;
  group: string;
};

export interface GroupSpan {
  group: string;
  /** Sample at the middle of this group's run, used to anchor its label. */
  middle: string;
  /** First and last sample of the run, used to draw the group's bracket. */
  first: string;
  last: string;
  n: number;
}

/**
 * How many bars remain individually visible.
 *
 * A composition plot is about 700px wide, so beyond a few hundred samples each
 * bar is under two pixels — the chart still "renders", but nothing in it can
 * be read or clicked, which is worse than saying so. Past this the group-mean
 * view answers the question the per-sample view no longer can.
 */
export const MAX_VISIBLE_BARS = 300;

export type CompositionMode = 'samples' | 'groupMeans';

/**
 * 'vertical' puts samples on the x axis, 'horizontal' gives each sample a row.
 * Undefined picks horizontal once there are more samples than fit across the
 * page, which is the point at which vertical labels start being dropped.
 */
export type CompositionOrientation = 'vertical' | 'horizontal';

/**
 * Shared colour scale. Identical in both orientations, and defined once so
 * they cannot drift apart.
 */
function colorScale(stackOrder: string[], rank: string): Plot.ScaleOptions {
  /*
   * An explicit range, not a named scheme. Plot's schemes cap at 12 entries
   * and silently recycle colours beyond that, so two slices of the same bar
   * would come out identical. `compositionColors` builds as many as are
   * needed and always ends with grey for "Other", which is the last entry of
   * stackOrder by construction.
   */
  return {
    legend: true,
    domain: stackOrder,
    range: compositionColors(Math.max(0, stackOrder.length - 1)),
    unknown: OTHER_COLOR,
    label: rank,
  };
}

export interface CompositionSettings {
  rank: Rank;
  topN: number;
  /** Metadata column to order or aggregate by; empty string for neither. */
  variable: string;
  /**
   * 'samples' draws one bar per sample; 'groupMeans' draws one bar per level
   * of `variable`, averaging the samples in it.
   */
  mode?: CompositionMode;
  /** Bar direction; undefined chooses by sample count. */
  orientation?: CompositionOrientation;
}

export interface CompositionPlot {
  rows: CompositionRow[];
  /** Taxa in stack order, excluding "Other" which always sits last. */
  order: string[];
  sampleOrder: string[];
  groupSpans: GroupSpan[];
  options: Plot.PlotOptions;
  caption: string;
  mode: CompositionMode;
  /** Set when there are more samples than can be drawn individually. */
  tooManySamples?: { total: number; limit: number };
  /**
   * True when the figure is drawn wider than the page so every bar can carry
   * its own label. The panel scrolls it horizontally.
   */
  scrolls: boolean;
  /** True when each sample got its own row rather than its own column. */
  horizontal: boolean;
}

export function buildCompositionPlot(
  dataset: Dataset,
  settings: CompositionSettings,
): CompositionPlot {
  const { rank, topN, variable } = settings;
  const { table, lineages } = dataset;

  // Collapse features to their label at the chosen rank. Without taxonomy the
  // feature IDs are used directly, so the panel still works.
  const labels = table.featureIds.map((id, i) =>
    lineages ? labelAtRank(lineages[i], rank) : id,
  );

  const perSample = table.sampleIds.map((_, j) => {
    const totals = new Map<string, number>();
    for (let i = 0; i < labels.length; i++) {
      totals.set(labels[i], (totals.get(labels[i]) ?? 0) + table.values[i][j]);
    }
    return {
      totals,
      sum: [...totals.values()].reduce((a, b) => a + b, 0),
    };
  });

  // Rank taxa by mean relative abundance across samples, so a taxon that
  // dominates one sample does not crowd out one present everywhere.
  const meanAbundance = new Map<string, number>();
  for (const { totals, sum } of perSample) {
    for (const [label, value] of totals) {
      const relative = sum > 0 ? value / sum : 0;
      meanAbundance.set(
        label,
        (meanAbundance.get(label) ?? 0) + relative / perSample.length,
      );
    }
  }

  const topSet = new Set(
    [...meanAbundance.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([label]) => label),
  );

  const groups = variable ? groupLabels(dataset.metadata, variable) : [];

  const rows: CompositionRow[] = table.sampleIds.flatMap((sampleId, j) => {
    const { totals, sum } = perSample[j];
    const collapsed = new Map<string, number>();

    for (const [label, value] of totals) {
      const key = topSet.has(label) ? label : OTHER;
      collapsed.set(key, (collapsed.get(key) ?? 0) + value);
    }

    return [...collapsed.entries()].map(([taxon, value]) => ({
      sampleId,
      taxon,
      abundance: sum > 0 ? value / sum : 0,
      group: variable ? (groups[j] ?? 'n/a') : '',
    }));
  });

  /*
   * Samples are SORTED by group rather than faceted. Observable Plot shares a
   * band scale across facets, so faceting by group renders every sample slot
   * in every panel and leaves the ones belonging to other groups blank, which
   * reads as missing data. Sorting gives one continuous axis with no gaps.
   */
  let sampleOrder = table.sampleIds;
  const groupSpans: GroupSpan[] = [];

  if (variable) {
    const annotated = table.sampleIds
      .map((id, i) => ({ id, group: groups[i] ?? 'n/a' }))
      .sort(
        (a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id),
      );

    sampleOrder = annotated.map((s) => s.id);

    for (const group of [...new Set(annotated.map((s) => s.group))]) {
      const members = annotated.filter((s) => s.group === group);
      groupSpans.push({
        group,
        middle: members[Math.floor(members.length / 2)].id,
        first: members[0].id,
        last: members[members.length - 1].id,
        n: members.length,
      });
    }
  }

  const order = [
    ...new Set(rows.filter((r) => r.taxon !== OTHER).map((r) => r.taxon)),
  ].sort();

  const stackOrder = [...order, OTHER];

  // ---- Group means -------------------------------------------------------
  if (settings.mode === 'groupMeans' && variable) {
    /*
     * One bar per group, each the MEAN of its samples' relative abundances —
     * not the pooled total. Pooling would let a deeply sequenced sample
     * dominate its group, which is the opposite of what "the composition of
     * this lake" should mean.
     */
    const byGroup = new Map<string, Map<string, number[]>>();
    for (const row of rows) {
      let taxa = byGroup.get(row.group);
      if (!taxa) {
        taxa = new Map();
        byGroup.set(row.group, taxa);
      }
      const values = taxa.get(row.taxon) ?? [];
      values.push(row.abundance);
      taxa.set(row.taxon, values);
    }

    const groupNames = [...byGroup.keys()].sort();
    const groupRows: CompositionRow[] = [];
    const counts = new Map<string, number>();

    for (const group of groupNames) {
      const taxa = byGroup.get(group)!;
      const n = Math.max(...[...taxa.values()].map((v) => v.length));
      counts.set(group, n);
      for (const taxon of stackOrder) {
        const values = taxa.get(taxon) ?? [];
        groupRows.push({
          sampleId: group,
          taxon,
          // Absent taxa contribute zero to the mean, so divide by the group
          // size rather than by however many samples happened to carry it.
          abundance: values.reduce((a, b) => a + b, 0) / n,
          group,
        });
      }
    }

    const groupAxis = axisLabelLayout(groupNames, PLOT_AREA_WIDTH);

    return {
      rows: groupRows,
      order,
      sampleOrder: groupNames,
      groupSpans: groupNames.map((group) => ({
        group,
        middle: group,
        first: group,
        last: group,
        n: counts.get(group) ?? 0,
      })),
      mode: 'groupMeans',
      scrolls: false,
      horizontal: false,
      options: {
        height: 500,
        marginBottom: groupAxis.marginBottom,
        marginLeft: 60,
        x: {
          label: variable,
          domain: groupNames,
          ticks: groupAxis.ticks,
          tickRotate: groupAxis.tickRotate,
        },
        y: {
          label: 'Mean relative abundance',
          percent: true,
          grid: true,
          domain: [0, 100],
        },
        color: colorScale(stackOrder, rank),
        marks: [
          Plot.barY(groupRows, {
            x: 'sampleId',
            y: 'abundance',
            fill: 'taxon',
            order: stackOrder,
            tip: true,
          }),
        ],
      },
      caption: `Mean relative abundance per ${variable}, averaged across the samples in each group (${groupNames
        .map((g) => `${g} n=${counts.get(g)}`)
        .join(', ')}). Top ${topN} taxa shown; the rest pooled as “Other”.`,
    };
  }

  /*
   * Width is chosen so that EVERY bar can carry its own label. Thinning the
   * axis was the wrong trade: a bar with no label is a bar you cannot
   * identify, and the page can scroll but the figure cannot invent space.
   * When the samples need more room than the page has, the plot is drawn at
   * its natural width and the panel scrolls it.
   */
  /*
   * ORIENTATION.
   *
   * Vertical bars put sample names on the x axis, where they have to be
   * rotated and still collide, and the figure has to grow sideways past the
   * page. Horizontal bars put each sample on its own row: names read
   * left-to-right at full size, and the figure grows downwards, which is the
   * direction a page scrolls anyway. Beyond a few dozen samples that is
   * simply the better layout, so it is the default there.
   */
  const horizontal =
    settings.orientation === 'horizontal' ||
    (settings.orientation === undefined &&
      sampleOrder.length * MIN_LABELLED_BAR_WIDTH >
        PLOT_AREA_WIDTH - MARGIN_LEFT - MARGIN_RIGHT);

  const shadedGroups = new Set(
    groupSpans.filter((_, i) => i % 2 === 1).map((s) => s.group),
  );

  /*
   * Group spans are shown three ways, because the label alone was ambiguous:
   * a background tint on every other group makes the extent visible at a
   * glance, a bracket ties the label to the run it describes, and the label
   * itself carries the count. The tint is drawn first so the bars sit on top.
   */
  const tint =
    groupSpans.length > 0
      ? sampleOrder
          .map((id) => rows.find((r) => r.sampleId === id))
          .filter((row): row is CompositionRow => row !== undefined)
          .filter((row) => shadedGroups.has(row.group))
      : [];

  // Two points per group: the bracket runs from the first bar to the last.
  const bracket = groupSpans.flatMap((span) => [
    { group: span.group, at: span.first },
    { group: span.group, at: span.last },
  ]);

  const groupText = (d: GroupSpan) => `${d.group} (n = ${d.n})`;
  const abundanceLabel = 'Relative abundance';
  const sampleLabel = variable
    ? `Sample (${sampleOrder.length}, ordered by ${variable})`
    : `Sample (${sampleOrder.length})`;
  const abundanceMax = groupSpans.length > 0 ? Y_MAX_WITH_LABELS : 100;

  let options: Plot.PlotOptions;
  let scrolls = false;
  let shownLabels = sampleOrder.length;

  if (horizontal) {
    const marks: Plot.Markish[] = [];

    if (tint.length > 0) {
      marks.push(
        Plot.barX(tint, { y: 'sampleId', x: SHADE_Y, fill: SHADE_FILL, inset: 0 }),
      );
    }

    marks.push(
      Plot.barX(rows, {
        y: 'sampleId',
        x: 'abundance',
        fill: 'taxon',
        order: stackOrder,
        tip: true,
      }),
    );

    if (groupSpans.length > 0) {
      marks.push(
        Plot.line(bracket, {
          y: 'at',
          x: BRACKET_Y,
          z: 'group',
          stroke: BRACKET_STROKE,
          strokeWidth: 1.5,
        }),
        Plot.text(groupSpans, {
          y: 'middle',
          x: LABEL_Y,
          text: groupText,
          textAnchor: 'start',
          dx: 6,
          fontWeight: 600,
          fontSize: 12,
          fill: BRACKET_STROKE,
        }),
      );
    }

    // Room for the sample names, which are not rotated in this orientation.
    const longest = sampleOrder.reduce((max, id) => Math.max(max, id.length), 0);
    const nameWidth = Math.min(Math.ceil(longest * 6.5) + 16, 260);
    // Room for the group labels, which sit to the right of the bars.
    const groupWidth =
      groupSpans.length > 0
        ? Math.min(
            Math.ceil(
              groupSpans.reduce((m, s) => Math.max(m, groupText(s).length), 0) * 6.5,
            ) + 24,
            220,
          )
        : MARGIN_RIGHT;

    options = {
      // One row per sample. The page scrolls down; the figure does not have
      // to scroll sideways, which is the whole point of this orientation.
      height: sampleOrder.length * ROW_HEIGHT + 70,
      marginLeft: nameWidth,
      marginRight: groupWidth,
      marginTop: 20,
      marginBottom: 40,
      y: { label: sampleLabel, domain: sampleOrder, ticks: sampleOrder },
      x: {
        label: abundanceLabel,
        percent: true,
        grid: true,
        domain: [0, abundanceMax],
      },
      color: colorScale(stackOrder, rank),
      marks,
    };
  } else {
    const naturalArea = sampleOrder.length * MIN_LABELLED_BAR_WIDTH;
    const defaultArea = PLOT_AREA_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
    scrolls = naturalArea > defaultArea;
    const plotArea = Math.max(defaultArea, naturalArea);

    const marks: Plot.Markish[] = [];

    if (tint.length > 0) {
      marks.push(
        Plot.barY(tint, { x: 'sampleId', y: SHADE_Y, fill: SHADE_FILL, inset: 0 }),
      );
    }

    marks.push(
      Plot.barY(rows, {
        x: 'sampleId',
        y: 'abundance',
        fill: 'taxon',
        order: stackOrder,
        tip: true,
      }),
    );

    if (groupSpans.length > 0) {
      marks.push(
        Plot.line(bracket, {
          x: 'at',
          y: BRACKET_Y,
          z: 'group',
          stroke: BRACKET_STROKE,
          strokeWidth: 1.5,
        }),
        Plot.text(groupSpans, {
          x: 'middle',
          y: LABEL_Y,
          text: groupText,
          fontWeight: 600,
          fontSize: 12,
          fill: BRACKET_STROKE,
        }),
      );
    }

    /*
     * The label budget follows the width, and the width was chosen above to
     * fit one label per bar — so this normally returns every sample. It still
     * thins if a caller forces a narrower layout.
     */
    const axis = axisLabelLayout(sampleOrder, plotArea);
    shownLabels = axis.ticks.length;

    options = {
      height: 520,
      // Only pinned when the figure must exceed the page; otherwise the
      // measured container width wins and the plot fills the room it is given.
      ...(scrolls ? { width: plotArea + MARGIN_LEFT + MARGIN_RIGHT } : {}),
      marginBottom: axis.marginBottom,
      marginLeft: MARGIN_LEFT,
      marginRight: MARGIN_RIGHT,
      marginTop: 30,
      x: {
        label: sampleLabel,
        domain: sampleOrder,
        ticks: axis.ticks,
        tickRotate: axis.tickRotate,
      },
      y: {
        label: abundanceLabel,
        percent: true,
        grid: true,
        // Percent units — see LABEL_Y above.
        domain: [0, abundanceMax],
      },
      color: colorScale(stackOrder, rank),
      marks,
    };
  }

  /*
   * The caption says explicitly when axis labels are thinned. Seeing fewer
   * labels than bars otherwise reads as missing data — one bar per sample is
   * always drawn, but only a legible subset is labelled.
   */
  const labelNote = horizontal
    ? ` One row per sample, all ${sampleOrder.length} labelled.`
    : shownLabels < sampleOrder.length
      ? ` Every sample has a bar, but only ${shownLabels} of ${sampleOrder.length} labels are shown to keep the axis readable — hover any bar for its sample.`
      : scrolls
        ? ` All ${sampleOrder.length} samples are labelled, so the figure is wider than the page — scroll it sideways.`
        : '';

  const groupNote =
    groupSpans.length > 0
      ? ` Samples are ordered by ${variable} and each group's span is bracketed ${horizontal ? 'beside' : 'above'} the bars, with alternating groups tinted: ${groupSpans
          .map((s) => `${s.group} n=${s.n}`)
          .join(', ')}.`
      : '';

  const caption =
    (groupSpans.length > 0
      ? `The top ${topN} taxa by mean abundance are shown individually and the rest pooled as “Other”.`
      : `The top ${topN} taxa by mean abundance are shown individually; the rest are pooled as “Other”.`) +
    groupNote +
    labelNote;

  return {
    rows,
    order,
    sampleOrder,
    groupSpans,
    options,
    caption,
    mode: 'samples',
    scrolls,
    horizontal,
    tooManySamples:
      sampleOrder.length > MAX_VISIBLE_BARS
        ? { total: sampleOrder.length, limit: MAX_VISIBLE_BARS }
        : undefined,
  };
}
