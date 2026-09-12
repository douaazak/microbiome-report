import * as Plot from '@observablehq/plot';
import { useMemo, useState } from 'react';
import { differentialAbundance, labelAtRank } from 'microbiome-core';

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
import { NumberField, Select } from './Select';

export function DifferentialPanel({ dataset }: { dataset: Dataset }) {
  // Only columns that can actually define groups: constant columns and
  // columns unique per sample are excluded, with the reason reported.
  const { usable: categorical } = groupableColumns(
    dataset.metadata,
    dataset.table.sampleIds.length,
  );

  const [variable, setVariable] = useState(categorical[0]?.name ?? '');
  const [minPrevalence, setMinPrevalence] = useState(10);
  /*
   * Held as a PERCENT for the control and converted at the call site, because
   * "0.01%" is a quantity a microbiologist can reason about and "0.0001" is
   * one they have to stop and count zeros on.
   */
  const [minAbundance, setMinAbundance] = useState(0);
  const nameRank = dataset.coverage?.bestRank ?? 'genus';
  const [alpha, setAlpha] = useState(0.05);
  /*
   * Minimum |CLR difference| to call a hit. Significance and importance are
   * different questions: at n = 144 a shift of 0.3 in CLR units is reliably
   * detectable and biologically negligible, so with thousands of features the
   * q-value stops separating anything and this does the separating instead.
   * Zero by default, so nothing is hidden unless the reader asks.
   */
  const [minEffect, setMinEffect] = useState(0);

  /** Levels of the chosen variable, largest group first. */
  const levels = useMemo(() => {
    if (!variable) return [];
    const labels = groupLabels(dataset.metadata, variable);
    const counts = new Map<string, number>();
    for (const label of labels) {
      if (label === null) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([level, n]) => ({ level, n }));
  }, [dataset, variable]);

  /*
   * With more than two levels the default is a pairwise comparison rather than
   * an all-groups test.
   *
   * Kruskal-Wallis across eight lakes answers "does this taxon differ
   * somewhere among them" — which is true of almost everything and tells a
   * bench scientist nothing actionable. It also has no direction, so the
   * effect column and volcano plot become meaningless. Choosing two groups
   * gives a result that can be stated in a sentence.
   */
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [allGroups, setAllGroups] = useState(false);

  const activePair = useMemo<[string, string] | null>(() => {
    if (levels.length < 3) return null;
    if (allGroups) return null;
    if (pair && levels.some((l) => l.level === pair[0]) && levels.some((l) => l.level === pair[1])) {
      return pair;
    }
    // Default to the two largest groups, which have the most power.
    return [levels[0].level, levels[1].level];
  }, [levels, pair, allGroups]);

  const analysis = useMemo(() => {
    if (!variable) return null;

    const labels = groupLabels(dataset.metadata, variable);
    let keep = completeCases(labels);

    if (activePair) {
      keep = keep.filter(
        (i) => labels[i] === activePair[0] || labels[i] === activePair[1],
      );
    }
    if (keep.length < 6) return null;

    const values = subsetColumns(dataset.table.values, keep);
    const groups = keep.map((i) => labels[i] as string);

    /*
     * Name features at the deepest rank that is mostly assigned, not always at
     * genus. On a dataset where 14% of features have a genus, every row would
     * otherwise read "Unclassified <something>" and the table would be
     * unusable for deciding what to follow up.
     */
    const names = dataset.table.featureIds.map((id, i) =>
      dataset.lineages ? labelAtRank(dataset.lineages[i], nameRank) : id,
    );

    try {
      const result = differentialAbundance(
        values,
        dataset.table.featureIds,
        groups,
        {
          minPrevalence: minPrevalence / 100,
          minAbundance: minAbundance / 100,
        },
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
  }, [dataset, variable, minPrevalence, minAbundance, activePair, nameRank]);

  const passesQ = (analysis?.rows ?? []).filter((r) => (r.q ?? 1) < alpha);
  const effectOf = (r: { meanDifference: number }) => Math.abs(r.meanDifference);
  const significant = passesQ.filter(
    (r) => !Number.isFinite(r.meanDifference) || effectOf(r) >= minEffect,
  );

  const twoGroups = analysis?.result?.groups.length === 2;

  const options = useMemo<Plot.PlotOptions>(() => {
    const points = (analysis?.rows ?? []).map((r) => ({
      name: r.name,
      featureId: r.featureId,
      x: r.meanDifference,
      y: -Math.log10(Math.max(r.p ?? 1, 1e-10)),
      significant:
        (r.q ?? 1) < alpha &&
        (!Number.isFinite(r.meanDifference) ||
          Math.abs(r.meanDifference) >= minEffect)
          ? `q < ${alpha}`
          : 'ns',
    }));

    return {
      height: 460,
      marginLeft: 60,
      marginBottom: 55,
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
        // Show where the effect floor sits, so the reader can see what it cut.
        ...(minEffect > 0
          ? [
              Plot.ruleX([-minEffect, minEffect], {
                strokeOpacity: 0.45,
                strokeDasharray: '4,3',
              }),
            ]
          : []),
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
  }, [analysis, alpha, minEffect]);

  if (categorical.length === 0) {
    // The only tab that genuinely cannot degrade: without groups there is no
    // comparison to make, and inventing one would be worse than saying so.
    return (
      <section>
        <Explainer question="Which individual taxa differ between the groups?">
          <p>
            This tab tests each taxon separately to find the specific organisms
            that differ between two or more groups of samples.
          </p>
        </Explainer>
        <div className="notice warn">
          <strong>This analysis needs a grouping variable.</strong>
          <p>
            {dataset.hasMetadata
              ? 'The metadata you loaded has no categorical columns, so there are no groups to compare. A column such as treatment, site or timepoint is needed.'
              : 'No metadata was supplied, so there are no groups to compare. Add a metadata file with a column such as treatment, site or timepoint.'}
          </p>
          <p>
            Composition, alpha diversity and the ordination all work without
            metadata — this one cannot.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <Explainer question="Which individual taxa differ between the groups?">
        <p>
          The other tabs compare whole communities. This one tests{' '}
          <strong>each taxon separately</strong> to find the specific organisms
          that differ.
        </p>
        <p>
          <strong>Read the q column, not p.</strong> Testing hundreds of taxa
          means that by chance alone, roughly 5% will look significant at
          p &lt; 0.05 even when nothing is going on — with 400 taxa that is 20
          false leads. The q value corrects for this: q &lt; 0.05 means that
          among the taxa you call significant, about 5% are expected to be false
          positives. A taxon with a small p but a large q did not survive that
          correction and should not be reported as a finding.
        </p>
        <p>
          Values are CLR-transformed first. Raw percentages cannot be compared
          between samples, because they are forced to total 100% — CLR converts
          them into a form where a normal test is valid. The effect column shows
          direction and magnitude; the volcano plot puts effect on the x axis
          and evidence strength on the y, so the taxa worth attention sit at the
          top corners.
        </p>
        <p className="watch-out">
          <strong>Watch out:</strong> "higher" means a larger <em>share</em> of
          the community, not necessarily more cells — this data cannot
          distinguish those. The prevalence filter matters too: a taxon seen in
          three samples cannot yield a reliable result, so rare taxa are
          excluded before testing rather than adding noise to the correction.
          And finding nothing significant is common at typical sample sizes; it
          is not evidence that the groups are alike.
        </p>
      </Explainer>

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
          hint="Share of samples a taxon must be detected in to be tested."
        />
        <NumberField
          label="Min abundance (%)"
          value={minAbundance}
          onChange={setMinAbundance}
          min={0}
          max={100}
          step={0.01}
          hint="How much of a sample a taxon must make up to count as detected there. 0 counts any non-zero reading."
        />
        <NumberField
          label="FDR threshold"
          value={alpha}
          onChange={setAlpha}
          min={0.001}
          max={0.5}
          step={0.01}
        />
        <NumberField
          label="Min |CLR difference|"
          value={minEffect}
          onChange={setMinEffect}
          min={0}
          max={5}
          step={0.25}
          hint="Effect-size floor. 1 is roughly a e-fold shift in the ratio to the sample's geometric mean."
        />
      </div>

      {levels.length > 2 && (
        <div className="controls">
          <Select
            label="Comparison"
            value={allGroups ? 'all' : 'pair'}
            onChange={(v) => setAllGroups(v === 'all')}
            options={[
              { value: 'pair', label: 'Two groups' },
              {
                value: 'all',
                label: `All ${levels.length} groups at once`,
              },
            ]}
          />
          {activePair && (
            <>
              <Select
                label="Group A"
                value={activePair[0]}
                onChange={(v) => setPair([v, activePair[1]])}
                options={levels
                  .filter((l) => l.level !== activePair[1])
                  .map((l) => ({
                    value: l.level,
                    label: `${l.level} (n = ${l.n})`,
                  }))}
              />
              <Select
                label="Group B"
                value={activePair[1]}
                onChange={(v) => setPair([activePair[0], v])}
                options={levels
                  .filter((l) => l.level !== activePair[0])
                  .map((l) => ({
                    value: l.level,
                    label: `${l.level} (n = ${l.n})`,
                  }))}
              />
            </>
          )}
        </div>
      )}

      {levels.length > 2 && !allGroups && (
        <div className="notice">
          <strong>
            “{variable}” has {levels.length} groups; two are compared at a time.
          </strong>
          <p>
            A test across all groups at once can only say a taxon differs{' '}
            <em>somewhere</em> among them — it cannot say which is higher, so
            there is no direction to report and the volcano plot has no
            meaningful x axis. Comparing two groups gives a result you can state
            in a sentence.
          </p>
        </div>
      )}

      {levels.length > 2 && allGroups && (
        <div className="notice warn">
          <strong>Comparing all {levels.length} groups at once.</strong>
          <p>
            Kruskal-Wallis says only that a taxon differs somewhere among the
            groups. It does not say which group is higher, so the effect column
            and the volcano plot are not shown. With this many groups almost
            everything abundant will look significant, which is rarely a useful
            finding — prefer a two-group comparison unless you specifically want
            a screen.
          </p>
        </div>
      )}

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
            tested features significant at q &lt; {alpha}
            {minEffect > 0 && (
              <>
                {' '}
                with |CLR difference| ≥ {minEffect}{' '}
                <span className="muted">
                  ({passesQ.length} pass the q threshold alone)
                </span>
              </>
            )}
            .
          </p>

          {analysis.result &&
            analysis.result.testedCount > 0 &&
            significant.length / analysis.result.testedCount > 0.25 && (
              <div className="notice warn">
                <strong>
                  A large share of taxa —{' '}
                  {(
                    (100 * significant.length) /
                    analysis.result.testedCount
                  ).toFixed(0)}
                  % — came out significant.
                </strong>
                <p>
                  This is expected rather than a fault, and it has been checked
                  directly: shuffling the group labels on this method yields
                  zero significant features, and so does splitting one group in
                  half and comparing it with itself. The test is not simply
                  calling everything significant.
                </p>
                <p>
                  Three things drive the count up. A large sample size makes
                  small shifts detectable — power, not error. A large feature
                  table means many genuine small differences to find. And CLR
                  values are not independent: every taxon is expressed relative
                  to its sample's geometric mean, so a shift in the abundant
                  members moves everything else with it.
                </p>
                <p>
                  <strong>
                    So use the effect-size floor above, not the q-value.
                  </strong>{' '}
                  With this many hits q has stopped discriminating; |CLR
                  difference| is what separates a large change from a merely
                  detectable one. Raising the prevalence filter helps too, by
                  dropping rare taxa whose significance rests on a handful of
                  samples.
                </p>
              </div>
            )}

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
                  <th>Taxon ({nameRank})</th>
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
                    className={
                      (r.q ?? 1) < alpha &&
                      (!Number.isFinite(r.meanDifference) ||
                        Math.abs(r.meanDifference) >= minEffect)
                        ? 'hit'
                        : undefined
                    }
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
