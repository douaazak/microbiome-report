import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BETA_METRICS, type BetaMetric } from 'microbiome-core';

import { computeBeta } from '../lib/beta.compute';
import BetaWorker from '../lib/beta.worker?worker&inline';
import type { BetaProgress, BetaResult } from '../lib/beta.worker';
import { afterPaint, startWorker } from '../lib/offThread';
import {
  completeCases,
  groupableColumns,
  groupLabels,
  subsetColumns,
  type Dataset,
} from '../lib/load';
import { formatP } from './AlphaPanel';
import { Explainer } from './Explainer';
import { PlotFigure } from './PlotFigure';
import { Select } from './Select';

const METRIC_LABELS: Record<BetaMetric, string> = {
  braycurtis: 'Bray-Curtis',
  jaccard: 'Jaccard (presence/absence)',
  aitchison: 'Aitchison (CLR Euclidean)',
};

/**
 * Above this many samples the analysis is not started automatically.
 *
 * Measured cost is dominated by the eigendecomposition inside PCoA, which
 * grows roughly as n^4: 156 ms at 200 samples, 650 ms at 300, 1.6 s at 400.
 * Beyond a few hundred it becomes a wait worth consenting to rather than one
 * inflicted by clicking a tab.
 */
const AUTO_RUN_LIMIT = 250;

/** Rough seconds, from the measured n^4 growth. Deliberately pessimistic. */
function estimateSeconds(n: number): number {
  return (1.7 * (n / 400) ** 4) + n / 400;
}

export function BetaPanel({ dataset }: { dataset: Dataset }) {
  // Only columns that can actually define groups: constant columns and
  // columns unique per sample are excluded, with the reason reported.
  const { usable: categorical } = groupableColumns(
    dataset.metadata,
    dataset.table.sampleIds.length,
  );
  const grouped = categorical.length > 0;

  const [metric, setMetric] = useState<BetaMetric>('braycurtis');
  const [variable, setVariable] = useState(categorical[0]?.name ?? '');

  const [result, setResult] = useState<BetaResult | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(0);
  /**
   * Set by the Cancel button, cleared by anything that changes what would be
   * computed.
   *
   * Cancel used to call `setRequested(0)`, which below the auto-run limit was
   * already 0 — so no dependency changed, the effect never re-ran, its
   * cleanup never fired, and the panel was left with no result, no stage and
   * no error: an empty tab with no way to restart it.
   */
  const [cancelledByUser, setCancelledByUser] = useState(false);
  /** True when this browser gave us no worker and the page is doing the work. */
  const [mainThread, setMainThread] = useState(false);

  const worker = useRef<Worker | null>(null);

  /** What to analyse, given the current grouping selection. */
  const inputs = useMemo(() => {
    if (!grouped) {
      return {
        values: dataset.table.values,
        sampleIds: dataset.table.sampleIds,
        groups: [] as string[],
        dropped: 0,
      };
    }
    if (!variable) return null;

    const labels = groupLabels(dataset.metadata, variable);
    const keep = completeCases(labels);
    if (keep.length < 3) return null;

    return {
      values: subsetColumns(dataset.table.values, keep),
      sampleIds: keep.map((i) => dataset.table.sampleIds[i]),
      groups: keep.map((i) => labels[i] as string),
      dropped: dataset.table.sampleIds.length - keep.length,
    };
  }, [dataset, variable, grouped]);

  const n = inputs?.sampleIds.length ?? 0;
  const needsConsent = n > AUTO_RUN_LIMIT;

  // Reset whenever the inputs change, so a stale ordination is never shown
  // next to newly chosen settings.
  useEffect(() => {
    setResult(null);
    setError(null);
    setStage(null);
    // Choosing a different distance or grouping is a new question, so an
    // earlier cancellation no longer applies.
    setCancelledByUser(false);
  }, [metric, variable, dataset]);

  useEffect(() => {
    if (!inputs) return;
    if (needsConsent && requested === 0) return;
    if (cancelledByUser) return;

    let cancelled = false;

    setStage('Starting…');
    setError(null);

    const request = {
      values: inputs.values,
      sampleIds: inputs.sampleIds,
      groups: inputs.groups,
      metric,
      // Fewer permutations on large datasets; the p-value floor rises from
      // 1/1000 to 1/200, which is ample when n is this large.
      permutations: n > 500 ? 199 : 999,
    };

    const instance = startWorker(() => new BetaWorker());

    if (!instance) {
      /*
       * No worker available. Without a fallback the entire Beta tab was
       * unreachable on such a browser — the ordination lives only in the
       * worker. Running it here blocks the tab, so say so first and let the
       * message paint before the thread stops responding.
       */
      worker.current = null;
      setMainThread(true);
      setStage('Computing on the page — the tab will not respond…');
      const cancelPaint = afterPaint(() => {
        if (cancelled) return;
        try {
          setResult(computeBeta(request));
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        setStage(null);
      });
      return () => {
        cancelled = true;
        cancelPaint();
      };
    }

    worker.current = instance;
    setMainThread(false);

    instance.onmessage = (event: MessageEvent<BetaProgress>) => {
      if (cancelled) return;
      const message = event.data;
      if (message.type === 'progress') setStage(message.stage);
      else if (message.type === 'done') {
        setResult(message.result);
        setStage(null);
      } else {
        setError(message.message);
        setStage(null);
      }
    };

    instance.onerror = (event) => {
      if (cancelled) return;
      setError(event.message || 'The analysis failed.');
      setStage(null);
    };
    // Without this, a result that cannot be structured-cloned back leaves the
    // progress message on screen for ever with no error anywhere.
    instance.onmessageerror = () => {
      if (cancelled) return;
      setError(
        'The ordination finished but its result could not be read back from the background thread.',
      );
      setStage(null);
    };

    instance.postMessage(request);

    return () => {
      cancelled = true;
      instance.terminate();
      worker.current = null;
    };
  }, [inputs, metric, n, needsConsent, requested, cancelledByUser]);

  const options = useMemo<Plot.PlotOptions>(() => {
    const variance = result?.ordination.varianceExplained ?? [];
    const points = result?.points ?? [];

    /*
     * An ordination is a MAP: the distance between two points is the whole
     * content of the figure, so a unit along PCo1 has to be the same length
     * on screen as a unit along PCo2. Letting the plot stretch to whatever
     * width the page happens to offer makes two samples look further apart
     * horizontally than the same separation vertically, which is a claim
     * about the data that the data does not make.
     *
     * So the figure is pinned to a fixed width and given a true aspect ratio
     * — except when the axes are so unequal that honouring it would produce a
     * letterbox a few dozen pixels tall. There the caption says the scales
     * differ rather than the figure quietly implying they do not.
     */
    const span = (get: (p: { pc1: number; pc2: number }) => number) => {
      if (points.length === 0) return 0;
      const values = points.map(get);
      return Math.max(...values) - Math.min(...values);
    };
    const spanX = span((p) => p.pc1);
    const spanY = span((p) => p.pc2);

    const width = 700;
    const trueHeight = spanX > 0 ? (width * spanY) / spanX : 0;
    const equalScale = trueHeight >= 280 && trueHeight <= 700;

    return {
      width,
      ...(equalScale ? { aspectRatio: 1 } : { height: 520 }),
      marginLeft: 60,
      marginBottom: 55,
      grid: true,
      x: { label: `PCo1 (${((variance[0] ?? 0) * 100).toFixed(1)}%)` },
      y: { label: `PCo2 (${((variance[1] ?? 0) * 100).toFixed(1)}%)` },
      color: grouped ? { legend: true, label: variable } : { legend: false },
      marks: [
        Plot.frame({ strokeOpacity: 0.2 }),
        Plot.dot(result?.points ?? [], {
          x: 'pc1',
          y: 'pc2',
          fill: grouped ? 'group' : 'currentColor',
          // Smaller points once there are enough to overlap heavily.
          r: (result?.points.length ?? 0) > 300 ? 2.5 : 5,
          fillOpacity: (result?.points.length ?? 0) > 300 ? 0.7 : 1,
          tip: true,
          channels: { sample: 'sampleId' },
        }),
      ],
    };
  }, [result, variable, grouped]);

  return (
    <section>
      <Explainer question="How different are the samples from each other?">
        <p>
          Where alpha diversity looks inside one sample, beta diversity compares
          samples <em>to each other</em>. Every pair gets a distance: 0 means
          identical communities, larger means more different.
        </p>
        <p>
          Those distances exist in far too many dimensions to draw, so the plot
          squashes them onto two axes (a PCoA) while preserving the distances as
          faithfully as it can. <strong>Each point is one entire sample.</strong>{' '}
          Points close together have similar communities. If the colours form
          separate clouds, the groups have different microbiomes.
        </p>
        <ul>
          <li>
            <strong>Bray-Curtis</strong> — the usual default. Accounts for how
            abundant each taxon is.
          </li>
          <li>
            <strong>Jaccard</strong> — presence/absence only; ignores abundance.
          </li>
          <li>
            <strong>Aitchison</strong> — designed for compositional data.
          </li>
        </ul>
        <p>
          <strong>PERMANOVA</strong>, under the plot, tests whether the
          separation is real. R² is the useful number: it says what share of the
          variation between samples the grouping explains. Microbiome studies
          often report R² of 0.05–0.15, meaning most variation is individual.
        </p>
        <p className="watch-out">
          <strong>Watch out:</strong> the axis percentages say how much of the
          total variation each axis shows. If they are low (say 10% and 8%),
          much of the structure is not on screen. PERMANOVA can also return a
          significant p-value when groups merely differ in <em>spread</em> — so
          check the clouds are genuinely offset, not just one being tighter.
        </p>
      </Explainer>

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
        {grouped && (
          <Select
            label="Colour by"
            value={variable}
            onChange={setVariable}
            options={categorical.map((c) => ({ value: c.name, label: c.name }))}
          />
        )}
      </div>

      {!grouped && (
        <div className="notice">
          {dataset.hasMetadata
            ? 'No categorical metadata columns, so points are uncoloured and PERMANOVA cannot run.'
            : 'No metadata supplied. The ordination is unaffected — clustering is a property of the distances, not the labels — but points cannot be coloured and PERMANOVA cannot run.'}
        </div>
      )}

      {metric === 'aitchison' && (
        <div className="notice">
          Aitchison distance uses an additive pseudocount by default, which
          makes it sensitive to sequencing depth. If depths vary a lot across
          your samples, treat the ordination with caution.
        </div>
      )}

      {inputs === null ? (
        <p className="empty">
          {grouped
            ? 'At least three samples with a value for this variable are needed.'
            : 'At least three samples are needed for an ordination.'}
        </p>
      ) : (
        <>
          {inputs.dropped > 0 && (
            <div className="notice warn">
              {inputs.dropped} sample{inputs.dropped === 1 ? '' : 's'} had no
              value for “{variable}” and{' '}
              {inputs.dropped === 1 ? 'was' : 'were'} excluded.
            </div>
          )}

          {needsConsent && requested === 0 && !result && (
            <div className="notice warn">
              <strong>
                {n.toLocaleString()} samples — this will take roughly{' '}
                {estimateSeconds(n) < 60
                  ? `${Math.ceil(estimateSeconds(n))} seconds`
                  : `${Math.ceil(estimateSeconds(n) / 60)} minutes`}
                .
              </strong>
              <p>
                The ordination's cost grows steeply with sample count. It runs
                in the background so the page stays usable, and you can leave
                this tab while it works.
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => setRequested((r) => r + 1)}
              >
                Run the analysis
              </button>
            </div>
          )}

          {stage && (
            <div className="notice" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" /> {stage}
              {mainThread && (
                <p>
                  This browser would not run the ordination in the background,
                  so it is running on the page itself. Nothing is lost, but the
                  tab will not respond until it finishes.
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  worker.current?.terminate();
                  worker.current = null;
                  setStage(null);
                  setCancelledByUser(true);
                }}
              >
                Cancel
              </button>
            </div>
          )}

          {cancelledByUser && !stage && !result && (
            <div className="notice">
              Cancelled.
              <button
                type="button"
                className="primary"
                onClick={() => setCancelledByUser(false)}
              >
                Run the analysis
              </button>
            </div>
          )}

          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}

          {result && (
            <>
              {result.ordination.warnings.map((warning) => (
                <div className="notice" key={warning}>
                  {warning}
                </div>
              ))}
              {result.test?.warnings.map((warning) => (
                <div className="notice warn" key={warning}>
                  {warning}
                </div>
              ))}

              <PlotFigure
                options={options}
                exportName={`pcoa-${metric}${grouped ? `-by-${variable}` : ''}`}
                exportRows={result.points}
                caption={
                  result.test
                    ? `PERMANOVA: pseudo-F = ${result.test.f.toFixed(2)}, R² = ${result.test.r2.toFixed(3)}, p = ${formatP(result.test.p)} (${result.test.permutations} permutations)`
                    : (result.testError ??
                      (grouped
                        ? undefined
                        : 'No grouping variable, so no test was run.'))
                }
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
