import * as Plot from '@observablehq/plot';
import { useMemo, useState } from 'react';
import {
  ALPHA_METRICS,
  alphaDiversity,
  kruskalWallis,
  wilcoxonRankSum,
  type AlphaMetric,
} from 'microbiome-core';

import { axisLabelLayout } from '../lib/axis';
import { MAX_AXIS_LABELS, PLOT_AREA_WIDTH } from '../lib/composition';
import { groupableColumns, groupLabels, type Dataset } from '../lib/load';
import { Explainer } from './Explainer';
import { PlotFigure } from './PlotFigure';
import { Select } from './Select';

const METRIC_LABELS: Record<AlphaMetric, string> = {
  observed: 'Observed features',
  shannon: 'Shannon',
  simpson: 'Simpson',
  invsimpson: 'Inverse Simpson',
  pielou: "Pielou's evenness",
  chao1: 'Chao1',
};

export function AlphaPanel({ dataset }: { dataset: Dataset }) {
  // Only columns that can actually define groups: constant columns and
  // columns unique per sample are excluded, with the reason reported.
  const { usable: categorical } = groupableColumns(
    dataset.metadata,
    dataset.table.sampleIds.length,
  );

  const [metric, setMetric] = useState<AlphaMetric>('shannon');
  const [variable, setVariable] = useState(categorical[0]?.name ?? '');

  const result = useMemo(
    () =>
      alphaDiversity(dataset.table.values, dataset.table.sampleIds, ALPHA_METRICS, {
        isCounts: dataset.isCounts,
      }),
    [dataset],
  );

  const available = ALPHA_METRICS.filter((m) => result.values[m] !== undefined);

  // If the current selection was refused for this input, fall back to one that
  // is actually computable rather than rendering an empty chart.
  const activeMetric = available.includes(metric) ? metric : available[0];

  const rows = useMemo(() => {
    if (!activeMetric || !variable) return [];
    const labels = groupLabels(dataset.metadata, variable);
    const values = result.values[activeMetric];
    return dataset.table.sampleIds.flatMap((sampleId, i) =>
      labels[i] === null
        ? []
        : [{ sampleId, group: labels[i] as string, value: values[i] }],
    );
  }, [dataset, result, activeMetric, variable]);

  const test = useMemo(() => {
    if (rows.length === 0) return null;
    const groups = [...new Set(rows.map((r) => r.group))].sort();
    if (groups.length < 2) return null;

    const grouped = groups.map((g) =>
      rows.filter((r) => r.group === g).map((r) => r.value),
    );
    if (grouped.some((g) => g.length < 3)) return null;

    if (groups.length === 2) {
      const { p, effectSize } = wilcoxonRankSum(grouped[0], grouped[1]);
      return { name: 'Wilcoxon rank-sum', p, effect: effectSize, groups };
    }
    const { p, effectSize } = kruskalWallis(grouped);
    return { name: 'Kruskal-Wallis', p, effect: effectSize, groups };
  }, [rows]);

  /**
   * Without a grouping variable there is still something worth showing: the
   * per-sample values themselves, sorted. That reveals the spread and any
   * outliers, which is most of what this tab is for — only the comparison
   * between groups is lost.
   */
  const ungrouped = useMemo(() => {
    if (!activeMetric) return [];
    const values = result.values[activeMetric];
    return dataset.table.sampleIds
      .map((sampleId, i) => ({ sampleId, value: values[i] }))
      .sort((a, b) => a.value - b.value);
  }, [dataset, result, activeMetric]);

  const grouped = categorical.length > 0;

  const options = useMemo<Plot.PlotOptions>(() => {
    const label = activeMetric ? METRIC_LABELS[activeMetric] : '';

    if (!grouped) {
      // Rotation and bottom margin are chosen together from how much room
      // each label actually gets, so long sample IDs tip to vertical rather
      // than overlapping, and short ones stay horizontal.
      const axis = axisLabelLayout(
        ungrouped.map((d) => d.sampleId),
        PLOT_AREA_WIDTH,
        MAX_AXIS_LABELS,
      );

      return {
        marginLeft: 70,
        marginBottom: axis.marginBottom,
        height: 420,
        y: { grid: true, label },
        x: {
          label: `Sample (${ungrouped.length}, sorted by ${label.toLowerCase()})`,
          domain: ungrouped.map((d) => d.sampleId),
          ticks: axis.ticks,
          tickRotate: axis.tickRotate,
        },
        marks: [
          Plot.ruleY([0]),
          Plot.dot(ungrouped, {
            x: 'sampleId',
            y: 'value',
            r: ungrouped.length > 200 ? 2 : 3,
            fill: 'currentColor',
            tip: true,
          }),
        ],
      };
    }

    return {
      marginLeft: 70,
      marginBottom: 60,
      height: 420,
      y: { grid: true, label },
      x: { label: variable, tickRotate: rows.length > 0 ? -20 : 0 },
      color: { legend: false },
      marks: [
        Plot.boxY(rows, {
          x: 'group',
          y: 'value',
          fill: 'group',
          fillOpacity: 0.25,
          stroke: 'group',
        }),
        // Individual samples over the box: with typical microbiome n, the
        // points carry more information than the summary does.
        Plot.dot(rows, {
          x: 'group',
          y: 'value',
          fill: 'group',
          r: 3,
          tip: true,
          channels: { sample: 'sampleId' },
        }),
      ],
    };
  }, [rows, ungrouped, grouped, activeMetric, variable]);

  return (
    <section>
      <Explainer question="How varied is the community inside each sample?">
        <p>
          Alpha diversity reduces each sample's whole community to a single
          number, so groups can be compared. Two things go into it: how{' '}
          <strong>many</strong> different taxa are present (richness), and how{' '}
          <strong>evenly</strong> they are spread (evenness).
        </p>
        <ul>
          <li>
            <strong>Observed features</strong> — simply how many taxa were seen.
            Richness only.
          </li>
          <li>
            <strong>Shannon</strong> — the usual default. Combines richness and
            evenness; higher means more diverse.
          </li>
          <li>
            <strong>Simpson</strong> — weighted toward the common taxa, so less
            affected by rare ones.
          </li>
          <li>
            <strong>Pielou's evenness</strong> — evenness alone, on a 0–1 scale.
          </li>
          <li>
            <strong>Chao1</strong> — estimates how many taxa you would have
            found with unlimited sequencing, including ones you missed.
          </li>
        </ul>
        <p>
          Each dot is one sample; the box shows the median and quartiles. The
          test under the plot asks whether the groups differ more than you would
          expect by chance.
        </p>
        <p className="watch-out">
          <strong>Watch out:</strong> richness metrics rise with sequencing
          depth, so if one group was sequenced more deeply it can look more
          diverse for purely technical reasons. Check the depth figures on the
          Overview tab before believing a richness difference. Alpha diversity
          also cannot tell you <em>which</em> taxa differ — two samples with
          completely different organisms can have identical Shannon values.
        </p>
      </Explainer>

      <div className="controls">
        <Select
          label="Metric"
          value={activeMetric ?? ''}
          onChange={(v) => setMetric(v as AlphaMetric)}
          options={available.map((m) => ({ value: m, label: METRIC_LABELS[m] }))}
        />
        {grouped && (
          <Select
            label="Group by"
            value={variable}
            onChange={setVariable}
            options={categorical.map((c) => ({ value: c.name, label: c.name }))}
          />
        )}
      </div>

      {!grouped && (
        <div className="notice">
          {dataset.hasMetadata
            ? 'No categorical metadata columns, so there is nothing to group by. Per-sample values are shown instead.'
            : 'No metadata supplied, so there is nothing to group by. Per-sample values are shown instead — add a metadata file to compare groups and run a test.'}
        </div>
      )}

      {result.refused.length > 0 && (
        <div className="notice">
          <strong>Some metrics are unavailable for this dataset.</strong>
          <ul>
            {result.refused.map((r) => (
              <li key={r.metric}>
                <em>{METRIC_LABELS[r.metric]}</em> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.warnings
        .filter((w) => !w.startsWith('Skipped'))
        .map((warning) => (
          <div className="notice warn" key={warning}>
            {warning}
          </div>
        ))}

      <PlotFigure
        options={options}
        exportName={
          grouped
            ? `alpha-${activeMetric}-by-${variable}`
            : `alpha-${activeMetric}-per-sample`
        }
        exportRows={grouped ? rows : ungrouped}
        caption={
          !grouped
            ? `${ungrouped.length} samples, sorted. No statistical test without groups.`
            : test
              ? `${test.name}: p = ${formatP(test.p)}${
                  test.groups.length === 2
                    ? `, rank-biserial r = ${test.effect.toFixed(2)}`
                    : ''
                }`
              : 'Not enough samples per group for a test (minimum 3).'
        }
      />
    </section>
  );
}

export function formatP(p: number): string {
  if (!Number.isFinite(p)) return 'n/a';
  // Below this the normal approximation's own error dominates, so printing
  // more digits would be inventing precision.
  if (p < 1e-6) return '< 1e-6';
  if (p < 0.001) return p.toExponential(1);
  return p.toFixed(4);
}
