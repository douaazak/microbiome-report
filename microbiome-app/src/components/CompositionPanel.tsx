import * as Plot from '@observablehq/plot';
import { useMemo, useState } from 'react';
import { labelAtRank, RANKS, type Rank } from 'microbiome-core';

import { groupLabels, type Dataset } from '../lib/load';
import { PlotFigure } from './PlotFigure';
import { NumberField, Select } from './Select';

const OTHER = 'Other';

export function CompositionPanel({ dataset }: { dataset: Dataset }) {
  const categorical = dataset.metadata.columns.filter(
    (c) => c.type === 'categorical',
  );

  const [rank, setRank] = useState<Rank>('genus');
  const [topN, setTopN] = useState(10);
  const [variable, setVariable] = useState(categorical[0]?.name ?? '');

  const rows = useMemo(() => {
    const { table, lineages } = dataset;

    // Collapse features to their label at the chosen rank. Without taxonomy
    // the feature IDs are used directly, so the panel still works.
    const labels = table.featureIds.map((id, i) =>
      lineages ? labelAtRank(lineages[i], rank) : id,
    );

    const perSample = table.sampleIds.map((_, j) => {
      const totals = new Map<string, number>();
      for (let i = 0; i < labels.length; i++) {
        totals.set(labels[i], (totals.get(labels[i]) ?? 0) + table.values[i][j]);
      }
      const sum = [...totals.values()].reduce((a, b) => a + b, 0);
      return { totals, sum };
    });

    // Rank taxa by their mean relative abundance across samples, so a taxon
    // that dominates one sample does not crowd out one that is consistently
    // present everywhere.
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

    const top = [...meanAbundance.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([label]) => label);
    const topSet = new Set(top);

    const groups = variable ? groupLabels(dataset.metadata, variable) : [];

    return table.sampleIds.flatMap((sampleId, j) => {
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
  }, [dataset, rank, topN, variable]);

  const options = useMemo<Plot.PlotOptions>(() => {
    // Keep "Other" last in the stack and in the legend, where it reads as a
    // remainder rather than as a taxon.
    const order = [
      ...new Set(rows.filter((r) => r.taxon !== OTHER).map((r) => r.taxon)),
    ].sort();

    return {
      height: 460,
      marginBottom: 90,
      marginLeft: 60,
      x: { label: 'Sample', tickRotate: -60 },
      y: { label: 'Relative abundance', percent: true, grid: true },
      color: { legend: true, domain: [...order, OTHER], label: rank },
      marks: [
        Plot.barY(rows, {
          x: 'sampleId',
          y: 'abundance',
          fill: 'taxon',
          order: [...order, OTHER],
          tip: true,
          fx: variable ? 'group' : undefined,
        }),
      ],
      fx: variable ? { label: variable } : undefined,
    };
  }, [rows, rank, variable]);

  return (
    <section>
      <div className="controls">
        <Select
          label="Rank"
          value={rank}
          onChange={(v) => setRank(v as Rank)}
          options={RANKS.map((r) => ({ value: r, label: r }))}
        />
        <NumberField
          label="Show top"
          value={topN}
          onChange={setTopN}
          min={2}
          max={30}
          hint="Remaining taxa are pooled as “Other”."
        />
        {categorical.length > 0 && (
          <Select
            label="Facet by"
            value={variable}
            onChange={setVariable}
            options={[
              { value: '', label: 'None' },
              ...categorical.map((c) => ({ value: c.name, label: c.name })),
            ]}
          />
        )}
      </div>

      {!dataset.lineages && (
        <div className="notice">
          No taxonomy was supplied, so features are shown by their IDs. Add a
          taxonomy file to collapse them by rank.
        </div>
      )}

      <PlotFigure
        options={options}
        exportName={`composition-${rank}-top${topN}`}
        exportRows={rows}
      />
    </section>
  );
}
