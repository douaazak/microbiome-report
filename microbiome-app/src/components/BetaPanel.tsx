import * as Plot from '@observablehq/plot';
import { useMemo, useState } from 'react';
import {
  BETA_METRICS,
  betaDiversity,
  pcoa,
  permanova,
  type BetaMetric,
} from 'microbiome-core';

import {
  completeCases,
  groupLabels,
  subsetColumns,
  type Dataset,
} from '../lib/load';
import { formatP } from './AlphaPanel';
import { PlotFigure } from './PlotFigure';
import { Select } from './Select';

const METRIC_LABELS: Record<BetaMetric, string> = {
  braycurtis: 'Bray-Curtis',
  jaccard: 'Jaccard (presence/absence)',
  aitchison: 'Aitchison (CLR Euclidean)',
};

export function BetaPanel({ dataset }: { dataset: Dataset }) {
  const categorical = dataset.metadata.columns.filter(
    (c) => c.type === 'categorical',
  );

  const [metric, setMetric] = useState<BetaMetric>('braycurtis');
  const [variable, setVariable] = useState(categorical[0]?.name ?? '');

  const analysis = useMemo(() => {
    if (!variable) return null;

    const labels = groupLabels(dataset.metadata, variable);
    const keep = completeCases(labels);
    if (keep.length < 3) return null;

    const values = subsetColumns(dataset.table.values, keep);
    const sampleIds = keep.map((i) => dataset.table.sampleIds[i]);
    const groups = keep.map((i) => labels[i] as string);

    const distance = betaDiversity(values, sampleIds, metric);
    const ordination = pcoa(distance, 2);

    let test: ReturnType<typeof permanova> | null = null;
    let testError: string | null = null;
    try {
      test = permanova(distance, groups, 999);
    } catch (error) {
      testError = error instanceof Error ? error.message : String(error);
    }

    const points = sampleIds.map((sampleId, i) => ({
      sampleId,
      group: groups[i],
      pc1: ordination.coordinates[0]?.[i] ?? 0,
      pc2: ordination.coordinates[1]?.[i] ?? 0,
    }));

    const dropped = dataset.table.sampleIds.length - keep.length;

    return { ordination, test, testError, points, dropped };
  }, [dataset, metric, variable]);

  const options = useMemo<Plot.PlotOptions>(() => {
    const variance = analysis?.ordination.varianceExplained ?? [];
    return {
      height: 420,
      marginLeft: 60,
      marginBottom: 50,
      grid: true,
      x: { label: `PCo1 (${((variance[0] ?? 0) * 100).toFixed(1)}%)` },
      y: { label: `PCo2 (${((variance[1] ?? 0) * 100).toFixed(1)}%)` },
      color: { legend: true, label: variable },
      marks: [
        Plot.frame({ strokeOpacity: 0.2 }),
        Plot.dot(analysis?.points ?? [], {
          x: 'pc1',
          y: 'pc2',
          fill: 'group',
          r: 5,
          tip: true,
          channels: { sample: 'sampleId' },
        }),
      ],
    };
  }, [analysis, variable]);

  if (categorical.length === 0) {
    return <p className="empty">No categorical metadata columns to colour by.</p>;
  }

  return (
    <section>
      <div className="controls">
        <Select
          label="Distance"
          value={metric}
          onChange={(v) => setMetric(v as BetaMetric)}
          options={BETA_METRICS.map((m) => ({
            value: m,
            label: METRIC_LABELS[m],
          }))}
        />
        <Select
          label="Colour by"
          value={variable}
          onChange={setVariable}
          options={categorical.map((c) => ({ value: c.name, label: c.name }))}
        />
      </div>

      {metric === 'aitchison' && (
        <div className="notice">
          Aitchison distance uses an additive pseudocount by default, which
          makes it sensitive to sequencing depth. If depths vary a lot across
          your samples, treat the ordination with caution.
        </div>
      )}

      {analysis === null ? (
        <p className="empty">
          At least three samples with a value for this variable are needed.
        </p>
      ) : (
        <>
          {analysis.dropped > 0 && (
            <div className="notice warn">
              {analysis.dropped} sample{analysis.dropped === 1 ? '' : 's'} had no
              value for “{variable}” and {analysis.dropped === 1 ? 'was' : 'were'}{' '}
              excluded.
            </div>
          )}

          {analysis.ordination.warnings.map((warning) => (
            <div className="notice" key={warning}>
              {warning}
            </div>
          ))}

          {analysis.test?.warnings.map((warning) => (
            <div className="notice warn" key={warning}>
              {warning}
            </div>
          ))}

          <PlotFigure
            options={options}
            exportName={`pcoa-${metric}-by-${variable}`}
            exportRows={analysis.points}
            caption={
              analysis.test
                ? `PERMANOVA: pseudo-F = ${analysis.test.f.toFixed(2)}, R² = ${analysis.test.r2.toFixed(3)}, p = ${formatP(analysis.test.p)} (${analysis.test.permutations} permutations)`
                : (analysis.testError ?? undefined)
            }
          />
        </>
      )}
    </section>
  );
}
