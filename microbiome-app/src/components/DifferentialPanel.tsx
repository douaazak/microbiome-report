import * as Plot from '@observablehq/plot';
import { useMemo, useState } from 'react';
import { differentialAbundance, labelAtRank } from 'microbiome-core';

import {
  completeCases,
  groupLabels,
  subsetColumns,
  type Dataset,
} from '../lib/load';
import { formatP } from './AlphaPanel';
import { PlotFigure } from './PlotFigure';
import { NumberField, Select } from './Select';

export function DifferentialPanel({ dataset }: { dataset: Dataset }) {
  const categorical = dataset.metadata.columns.filter(
    (c) => c.type === 'categorical',
  );

  const [variable, setVariable] = useState(categorical[0]?.name ?? '');
  const [minPrevalence, setMinPrevalence] = useState(10);
  const [alpha, setAlpha] = useState(0.05);

  const analysis = useMemo(() => {
    if (!variable) return null;

    const labels = groupLabels(dataset.metadata, variable);
    const keep = completeCases(labels);
    if (keep.length < 6) return null;

    const values = subsetColumns(dataset.table.values, keep);
    const groups = keep.map((i) => labels[i] as string);

    const names = dataset.table.featureIds.map((id, i) =>
      dataset.lineages ? labelAtRank(dataset.lineages[i], 'genus') : id,
    );

    try {
      const result = differentialAbundance(
        values,
        dataset.table.featureIds,
        groups,
        { minPrevalence: minPrevalence / 100 },
      );

      const rows = result.results
        .map((r, i) => ({
          ...r,
          name: names[i],
          meanDifference:
            result.groups.length === 2
              ? r.groupMeans[result.groups[1]] - r.groupMeans[result.groups[0]]
              : NaN,
        }))
        .filter((r) => r.p !== null)
        .sort((a, b) => (a.q ?? 1) - (b.q ?? 1));

      return { result, rows, error: null as string | null };
    } catch (error) {
      return {
        result: null,
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [dataset, variable, minPrevalence]);

  const significant = (analysis?.rows ?? []).filter(
    (r) => (r.q ?? 1) < alpha,
  );

  const twoGroups = analysis?.result?.groups.length === 2;

  const options = useMemo<Plot.PlotOptions>(() => {
    const points = (analysis?.rows ?? []).map((r) => ({
      name: r.name,
      featureId: r.featureId,
      x: r.meanDifference,
      y: -Math.log10(Math.max(r.p ?? 1, 1e-10)),
      significant: (r.q ?? 1) < alpha ? `q < ${alpha}` : 'ns',
    }));

    return {
      height: 400,
      marginLeft: 60,
      marginBottom: 50,
      grid: true,
      x: { label: 'Difference in mean CLR abundance' },
      y: { label: '−log₁₀(p)' },
      color: {
        legend: true,
        domain: [`q < ${alpha}`, 'ns'],
        range: ['#c2410c', '#94a3b8'],
      },
      marks: [
        Plot.ruleX([0], { strokeOpacity: 0.3 }),
        Plot.dot(points, {
          x: 'x',
          y: 'y',
          fill: 'significant',
          r: 4,
          tip: true,
          channels: { taxon: 'name' },
        }),
      ],
    };
  }, [analysis, alpha]);

  if (categorical.length === 0) {
    return <p className="empty">No categorical metadata columns to compare.</p>;
  }

  return (
    <section>
      <div className="controls">
        <Select
          label="Compare by"
          value={variable}
          onChange={setVariable}
          options={categorical.map((c) => ({ value: c.name, label: c.name }))}
        />
        <NumberField
          label="Min prevalence (%)"
          value={minPrevalence}
          onChange={setMinPrevalence}
          min={0}
          max={100}
          step={5}
          hint="Features below this are excluded before testing."
        />
        <NumberField
          label="FDR threshold"
          value={alpha}
          onChange={setAlpha}
          min={0.001}
          max={0.5}
          step={0.01}
        />
      </div>

      <div className="notice">
        CLR transform, then {twoGroups ? 'Wilcoxon rank-sum' : 'Kruskal-Wallis'}{' '}
        per feature, then Benjamini-Hochberg across features. This method does
        not support covariates or repeated measures — for those, MaAsLin 3 is
        the right tool.
      </div>

      {analysis === null ? (
        <p className="empty">
          At least six samples with a value for this variable are needed.
        </p>
      ) : analysis.error ? (
        <div className="notice warn">{analysis.error}</div>
      ) : (
        <>
          {analysis.result?.warnings.map((warning) => (
            <div className="notice warn" key={warning}>
              {warning}
            </div>
          ))}

          <p className="summary">
            <strong>{significant.length}</strong> of {analysis.result?.testedCount}{' '}
            tested features significant at q &lt; {alpha}.
          </p>

          {twoGroups && (
            <PlotFigure
              options={options}
              exportName={`differential-${variable}`}
              exportRows={analysis.rows.map((r) => ({
                feature: r.featureId,
                taxon: r.name,
                p: r.p,
                q: r.q,
                effectSize: r.effectSize,
                meanDifference: r.meanDifference,
              }))}
            />
          )}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Taxon</th>
                  <th>p</th>
                  <th>q (BH)</th>
                  <th>Effect</th>
                  {analysis.result?.groups.map((g) => (
                    <th key={g}>mean CLR ({g})</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analysis.rows.slice(0, 100).map((r) => (
                  <tr
                    key={r.featureId}
                    className={(r.q ?? 1) < alpha ? 'hit' : undefined}
                  >
                    <td title={r.featureId}>{r.name}</td>
                    <td>{formatP(r.p as number)}</td>
                    <td>{formatP(r.q as number)}</td>
                    <td>{r.effectSize?.toFixed(2)}</td>
                    {analysis.result?.groups.map((g) => (
                      <td key={g}>{r.groupMeans[g]?.toFixed(2)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis.rows.length > 100 && (
            <p className="summary">
              Showing the first 100 of {analysis.rows.length} tested features.
              Download the data for the full list.
            </p>
          )}
        </>
      )}
    </section>
  );
}
