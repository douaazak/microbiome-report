import { useMemo, useState } from 'react';
import { RANKS, type Rank } from 'microbiome-core';

import {
  buildCompositionPlot,
  type CompositionOrientation,
  MAX_DISTINCT_TAXA,
  MAX_VISIBLE_BARS,
  type CompositionMode,
} from '../lib/composition';
import { groupableColumns, type Dataset } from '../lib/load';
import { Explainer } from './Explainer';
import { PlotFigure } from './PlotFigure';
import { NumberField, Select } from './Select';

/**
 * Capped at the number of taxa that can still be given distinct colours once
 * "Other" has taken one slot. Above roughly a dozen stacked colours a
 * composition bar stops being readable anyway, so this is as much a design
 * choice as a palette limit.
 */
const MAX_TOP_N = MAX_DISTINCT_TAXA;

export function CompositionPanel({ dataset }: { dataset: Dataset }) {
  // Only columns that can actually define groups: constant columns and
  // columns unique per sample are excluded, with the reason reported.
  const { usable: categorical } = groupableColumns(
    dataset.metadata,
    dataset.table.sampleIds.length,
  );

  /*
   * Start at the deepest rank that is mostly assigned, not always at genus.
   *
   * Environmental datasets often assign genus for a small minority of features
   * — 14% in the freshwater dataset this was tested against — so defaulting to
   * genus produces a chart made almost entirely of "Unclassified …" bars. That
   * looks like a bug in the tool when it is a property of the data.
   */
  const [rank, setRank] = useState<Rank>(
    () => dataset.coverage?.bestRank ?? 'genus',
  );
  const [topN, setTopN] = useState(10);
  const [variable, setVariable] = useState(categorical[0]?.name ?? '');

  // Default to group means when there are more samples than can be drawn
  // individually, so the first view is one that can actually be read.
  const [orientation, setOrientation] = useState<'auto' | CompositionOrientation>('auto');
  const [mode, setMode] = useState<CompositionMode>(() =>
    dataset.table.sampleIds.length > MAX_VISIBLE_BARS && categorical.length > 0
      ? 'groupMeans'
      : 'samples',
  );

  const rankCoverage = dataset.coverage?.byRank.find((c) => c.rank === rank);

  const plot = useMemo(
    () =>
      buildCompositionPlot(dataset, {
        rank,
        topN: Math.min(Math.max(topN, 2), MAX_TOP_N),
        variable,
        mode: variable ? mode : 'samples',
        orientation: orientation === 'auto' ? undefined : orientation,
      }),
    [dataset, rank, topN, variable, mode, orientation],
  );

  return (
    <section>
      <Explainer question="What is each sample made of?">
        <p>
          Each bar is one sample, and each colour a taxon. Bar heights are
          normalised so every sample sums to 100%, which makes samples
          comparable even though they were sequenced to different depths.
        </p>
        <p>
          <strong>This tab is descriptive — there are no statistics here.</strong>{' '}
          Use it to see the broad picture and spot obvious outliers, then use
          the Differential tab to ask whether any specific taxon really differs.
        </p>
        <p className="watch-out">
          <strong>Watch out:</strong> because everything is a percentage, taxa
          are not independent. If one taxon genuinely increases, every other
          taxon's share must fall to keep the total at 100% — even when nothing
          happened to them biologically. Never read a drop in one bar as
          evidence that taxon declined.
        </p>
      </Explainer>

      <div className="controls">
        <Select
          label="Rank"
          value={rank}
          onChange={(v) => setRank(v as Rank)}
          // Coverage in the label, so a rank that will mostly say
          // "Unclassified" is visible before it is chosen.
          options={RANKS.map((r) => {
            const c = dataset.coverage?.byRank.find((x) => x.rank === r);
            return {
              value: r,
              label: c ? `${r} — ${(c.fraction * 100).toFixed(0)}% assigned` : r,
            };
          })}
        />
        <NumberField
          label="Show top"
          value={topN}
          onChange={setTopN}
          min={2}
          max={MAX_TOP_N}
          hint={`Up to ${MAX_TOP_N}; the rest are pooled as “Other”.`}
        />
        {categorical.length > 0 && (
          <Select
            label="Group by"
            value={variable}
            onChange={setVariable}
            options={[
              { value: '', label: 'None (sample ID order)' },
              ...categorical.map((c) => ({ value: c.name, label: c.name })),
            ]}
          />
        )}
        {variable && (
          <Select
            label="Show"
            value={mode}
            onChange={(v) => setMode(v as CompositionMode)}
            options={[
              { value: 'groupMeans', label: `Mean per ${variable}` },
              { value: 'samples', label: 'Each sample' },
            ]}
          />
        )}
        {plot.mode === 'samples' && (
          <Select
            label="Bars"
            value={orientation}
            onChange={(v) =>
              setOrientation(v as 'auto' | CompositionOrientation)
            }
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'horizontal', label: 'Horizontal (one row per sample)' },
              { value: 'vertical', label: 'Vertical (one column per sample)' },
            ]}
          />
        )}
      </div>

      {plot.tooManySamples && (
        <div className="notice warn">
          <strong>
            {plot.tooManySamples.total.toLocaleString()} samples is more than
            this chart can show individually.
          </strong>
          <p>
            Each bar would be under two pixels wide — the plot would draw, but
            nothing in it could be read or hovered. Roughly{' '}
            {plot.tooManySamples.limit} is the practical limit.
          </p>
          {categorical.length > 0 ? (
            <p>
              Switch “Show” to <em>Mean per {variable || 'group'}</em> for one
              bar per group, or filter to fewer samples upstream.
            </p>
          ) : (
            <p>
              With a metadata file you could average by group instead. Otherwise
              filter to fewer samples upstream.
            </p>
          )}
        </div>
      )}

      {rankCoverage && rankCoverage.fraction < 0.5 && (
        <div className="notice warn">
          <strong>
            Only {(rankCoverage.fraction * 100).toFixed(0)}% of features have a{' '}
            {rank} assignment.
          </strong>
          <p>
            The rest are grouped as “Unclassified …” by their nearest assigned
            ancestor, so most of this chart reflects what the reference database
            could not resolve rather than what is in the samples.
            {dataset.coverage &&
              dataset.coverage.bestRank !== rank &&
              ` ${dataset.coverage.bestRank} is the deepest rank that is mostly assigned.`}
          </p>
        </div>
      )}

      {!dataset.lineages && (
        <div className="notice">
          No taxonomy was supplied, so features are shown by their IDs. Add a
          taxonomy file to collapse them by rank.
        </div>
      )}

      <PlotFigure
        options={plot.options}
        exportName={`composition-${rank}-top${topN}`}
        exportRows={plot.rows}
        caption={plot.caption}
        scroll={plot.scrolls}
      />
    </section>
  );
}
