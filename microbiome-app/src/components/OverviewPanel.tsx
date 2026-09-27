import { useEffect, useMemo, useState } from 'react';

import { buildFindings, type FindingsReport } from '../lib/findings';
import FindingsWorker from '../lib/findings.worker?worker&inline';
import type { FindingsProgress } from '../lib/findings.worker';
import { afterPaint, startWorker } from '../lib/offThread';
import { summarise } from '../lib/summary';
import { groupableColumns, type Dataset } from '../lib/load';
import { Explainer } from './Explainer';
import { Select } from './Select';

export function OverviewPanel({ dataset }: { dataset: Dataset }) {
  // Only columns that can actually define groups: constant columns and
  // columns unique per sample are excluded, with the reason reported.
  const { usable: categorical, excluded: excludedColumns } = groupableColumns(
    dataset.metadata,
    dataset.table.sampleIds.length,
  );
  const [variable, setVariable] = useState(categorical[0]?.name ?? '');

  const summary = useMemo(() => summarise(dataset), [dataset]);

  /*
   * The findings need a distance matrix, a PERMANOVA and a differential
   * abundance pass — the same work the beta and differential tabs do, and far
   * too much for the main thread on a large table. It runs in a worker so the
   * page stays responsive, and is discarded if the inputs change underneath
   * it or the tab is left.
   */
  const [report, setReport] = useState<FindingsReport | null>(null);
  const [computing, setComputing] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  /** True when this browser gave us no worker and the page is doing the work. */
  const [mainThread, setMainThread] = useState(false);

  useEffect(() => {
    setReport(null);
    setReportError(null);
    if (!variable) {
      setComputing(false);
      return;
    }

    let cancelled = false;
    setComputing(true);

    const n = dataset.table.sampleIds.length;
    // Fewer permutations on large datasets, as the beta tab does; the
    // p-value floor rises from 1/1000 to 1/200, ample at that n.
    const options = { permutations: n > 500 ? 199 : 999 };

    const worker = startWorker(() => new FindingsWorker());

    if (!worker) {
      /*
       * No worker available. Compute here instead — this blocks the tab
       * while it runs, which is exactly what the worker exists to avoid, but
       * it is the difference between slow results and no results at all.
       * The wait is announced first, and `afterPaint` makes sure that
       * message is on screen before the thread stops responding.
       */
      setMainThread(true);
      const cancelPaint = afterPaint(() => {
        if (cancelled) return;
        try {
          setReport(buildFindings(dataset, variable, options));
        } catch (error) {
          setReportError(
            error instanceof Error ? error.message : String(error),
          );
        }
        setComputing(false);
      });
      return () => {
        cancelled = true;
        cancelPaint();
      };
    }

    setMainThread(false);

    worker.onmessage = (event: MessageEvent<FindingsProgress>) => {
      if (cancelled) return;
      if (event.data.type === 'done') setReport(event.data.report);
      else setReportError(event.data.message);
      setComputing(false);
    };
    worker.onerror = (event) => {
      if (cancelled) return;
      setReportError(event.message || 'The analysis failed.');
      setComputing(false);
    };
    // Without this, a result that cannot be structured-cloned back leaves the
    // spinner turning for ever with no error anywhere.
    worker.onmessageerror = () => {
      if (cancelled) return;
      setReportError(
        'The analysis finished but its result could not be read back from the background thread.',
      );
      setComputing(false);
    };

    worker.postMessage({ dataset, variable, options });

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [dataset, variable]);

  return (
    <section>
      <Explainer question="What is in this dataset, and what did the analyses find?">
        <p>
          This page describes the data you loaded and summarises only those
          results that reached statistical significance. Everything here is
          computed from your file; nothing is uploaded anywhere.
        </p>
      </Explainer>

      <h3>The dataset</h3>
      <div className="stat-grid">
        <Stat label="Samples" value={summary.samples.toLocaleString()} />
        <Stat label="Features" value={summary.features.toLocaleString()} />
        <Stat
          label="Values"
          value={summary.isCounts ? 'Counts' : 'Relative abundance'}
        />
        <Stat
          label="Zeros"
          value={`${(summary.sparsity * 100).toFixed(0)}%`}
          hint="Proportion of the table that is zero — normal for microbiome data."
        />
        {summary.depth && (
          <Stat
            label="Median depth"
            value={summary.depth.median.toLocaleString()}
            hint={`Range ${summary.depth.min.toLocaleString()}–${summary.depth.max.toLocaleString()} reads.`}
          />
        )}
        <Stat
          label="Features per sample"
          value={`${summary.richness.median}`}
          hint={`Range ${summary.richness.min}–${summary.richness.max}.`}
        />
      </div>

      <h3>Sample groups</h3>
      {!dataset.hasMetadata && (
        <div className="notice">
          <strong>No metadata supplied.</strong>
          <p>
            Composition, alpha diversity and the ordination all work without it.
            Grouping, statistical tests and differential abundance do not — add
            a file whose first column matches these sample IDs and whose other
            columns describe them.
          </p>
        </div>
      )}
      <div className="variable-grid">
        {summary.variables.map((v) => (
          <div className="variable-card" key={v.name}>
            <h4>
              {v.name} <span className="muted">{v.type}</span>
            </h4>
            {v.counts ? (
              <ul className="counts">
                {v.counts.map((c) => (
                  <li key={c.level}>
                    <span className="level">{c.level}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{
                          width: `${(c.n / summary.samples) * 100}%`,
                        }}
                      />
                    </span>
                    <strong>{c.n}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              v.range && (
                <p className="muted">
                  median {formatNumber(v.range.median)} (range{' '}
                  {formatNumber(v.range.min)}–{formatNumber(v.range.max)})
                </p>
              )
            )}
            {v.missing > 0 && (
              <p className="muted small">
                {v.missing} sample{v.missing === 1 ? '' : 's'} missing this value
              </p>
            )}
          </div>
        ))}
      </div>

      {summary.cautions.length > 0 && (
        <div className="notice warn">
          <strong>Before reading the results</strong>
          <ul>
            {summary.cautions.map((caution) => (
              <li key={caution}>{caution}</li>
            ))}
          </ul>
        </div>
      )}

      <h3>Main findings</h3>

      {excludedColumns.length > 0 && (
        <div className="notice">
          <strong>
            {excludedColumns.length} column
            {excludedColumns.length === 1 ? '' : 's'} cannot define groups and{' '}
            {excludedColumns.length === 1 ? 'is' : 'are'} not offered below.
          </strong>
          <ul>
            {excludedColumns.map((c) => (
              <li key={c.name}>
                <em>{c.name}</em> — {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {categorical.length === 0 ? (
        <p className="empty">
          {dataset.hasMetadata
            ? 'No categorical metadata columns, so there are no groups to compare.'
            : 'Findings compare groups of samples, which needs a metadata file.'}
        </p>
      ) : (
        <>
          <div className="controls">
            <Select
              label="Compare by"
              value={variable}
              onChange={setVariable}
              options={categorical.map((c) => ({
                value: c.name,
                label: c.name,
              }))}
            />
          </div>

          {computing && (
            <div className="notice" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" /> Testing community
              structure, diversity and individual taxa by “{variable}”…
              {mainThread && (
                <p>
                  This browser would not run the analysis in the background, so
                  it is running on the page itself. Nothing is lost, but the
                  tab will not respond until it finishes.
                </p>
              )}
            </div>
          )}

          {reportError && (
            <div className="notice error" role="alert">
              {reportError}
            </div>
          )}

          {report && (
            <>
              <p className="summary">
                Comparing{' '}
                {report.groupSizes
                  .map((g) => `${g.level} (n = ${g.n})`)
                  .join(' vs ')}
                . Only results reaching <strong>p or q &lt; {report.alpha}</strong>{' '}
                are stated as findings.
              </p>

              {report.findings.length === 0 ? (
                <div className="notice">
                  <strong>No statistically significant differences were found.</strong>
                  <p>
                    That is a result, but it is not the same as showing the
                    groups are alike. With these sample sizes a real difference
                    could easily go undetected.
                  </p>
                </div>
              ) : (
                <ol className="findings">
                  {report.findings.map((finding) => (
                    <li key={finding.statement}>
                      <span className="area">{finding.area}</span>
                      <p className="statement">{finding.statement}</p>
                      <p className="evidence">{finding.evidence}</p>
                      <p className="interpretation">{finding.interpretation}</p>
                    </li>
                  ))}
                </ol>
              )}

              {report.nullResults.length > 0 && (
                <div className="null-results">
                  <h4>Tested, nothing significant</h4>
                  <ul>
                    {report.nullResults.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {report.notRun.length > 0 && (
                <div className="null-results">
                  <h4>Not tested</h4>
                  <ul>
                    {report.notRun.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="notice caveat">
                <strong>How to read these findings</strong>
                <ul>
                  <li>
                    These are <em>associations</em>. Nothing here shows that one
                    thing caused another — a difference between groups can come
                    from diet, medication, age, batch, or anything else that
                    differs alongside “{report.variable}”.
                  </li>
                  <li>
                    Absence of a finding means the test did not reach the
                    threshold <em>in this dataset</em>. It is not evidence that
                    no difference exists.
                  </li>
                  <li>
                    Individual-taxon results use q values, which already account
                    for the number of taxa tested. Community and diversity
                    results use a single test each and are not corrected across
                    the three analyses.
                  </li>
                </ul>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="stat" title={hint}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
