import * as Plot from '@observablehq/plot';
import { useMemo, useState } from 'react';
import {
  ALPHA_METRICS,
  alphaDiversity,
  kruskalWallis,
  wilcoxonRankSum,
  type AlphaMetric,
} from 'microbiome-core';

import { groupLabels, type Dataset } from '../lib/load';
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
  const categorical = dataset.metadata.columns.filter(
    (c) => c.type === 'categorical',
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

  const options = useMemo<Plot.PlotOptions>(
    () => ({
      marginLeft: 70,
      marginBottom: 50,
      height: 380,
      y: { grid: true, label: activeMetric ? METRIC_LABELS[activeMetric] : '' },
      x: { label: variable },
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
    }),
    [rows, activeMetric, variable],
  );

  if (categorical.length === 0) {
    return <p className="empty">No categorical metadata columns to group by.</p>;
  }

  return (
    <section>
      <div className="controls">
        <Select
          label="Metric"
          value={activeMetric ?? ''}
          onChange={(v) => setMetric(v as AlphaMetric)}
          options={available.map((m) => ({ value: m, label: METRIC_LABELS[m] }))}
        />
        <Select
          label="Group by"
          value={variable}
          onChange={setVariable}
          options={categorical.map((c) => ({ value: c.name, label: c.name }))}
        />
      </div>

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
        exportName={`alpha-${activeMetric}-by-${variable}`}
        exportRows={rows}
        caption={
          test
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
