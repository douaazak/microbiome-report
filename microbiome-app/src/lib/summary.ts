/**
 * Descriptive summary of a loaded dataset.
 *
 * Deliberately separate from the analyses: these are facts about the data as
 * supplied, computed without transformation or testing, and they are what a
 * reader needs before any p-value means anything. Group sizes in particular
 * determine how much the rest of the report can be trusted.
 */

import type { Dataset } from './load';

export interface GroupCount {
  level: string;
  n: number;
}

export interface VariableSummary {
  name: string;
  type: 'categorical' | 'continuous';
  /** Populated for categorical variables. */
  counts?: GroupCount[];
  /** Populated for continuous variables. */
  range?: { min: number; median: number; max: number };
  missing: number;
}

export interface DatasetSummary {
  features: number;
  samples: number;
  isCounts: boolean;
  /** Total reads per sample; empty when the table is relative abundance. */
  depth?: { min: number; median: number; max: number; fold: number };
  /** Proportion of the table that is zero. */
  sparsity: number;
  /** Features observed per sample. */
  richness: { min: number; median: number; max: number };
  variables: VariableSummary[];
  /** Concerns worth raising before the reader looks at any result. */
  cautions: string[];
}

function quantiles(values: number[]): { min: number; median: number; max: number } {
  if (values.length === 0) return { min: NaN, median: NaN, max: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median:
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid],
  };
}

export function summarise(dataset: Dataset): DatasetSummary {
  const { table, metadata, isCounts } = dataset;
  const nSamples = table.sampleIds.length;
  const nFeatures = table.featureIds.length;

  const columnTotals: number[] = [];
  const observedPerSample: number[] = [];
  let zeros = 0;

  for (let j = 0; j < nSamples; j++) {
    let total = 0;
    let present = 0;
    for (let i = 0; i < nFeatures; i++) {
      const value = table.values[i][j];
      total += value;
      if (value > 0) present++;
      else zeros++;
    }
    columnTotals.push(total);
    observedPerSample.push(present);
  }

  const cautions: string[] = [];

  const depthStats = quantiles(columnTotals);
  const depth = isCounts
    ? {
        ...depthStats,
        fold: depthStats.min > 0 ? depthStats.max / depthStats.min : Infinity,
      }
    : undefined;

  if (depth && Number.isFinite(depth.fold) && depth.fold > 10) {
    cautions.push(
      `Sequencing depth varies ${depth.fold.toFixed(0)}-fold across samples (${depth.min.toLocaleString()} to ${depth.max.toLocaleString()} reads). Richness metrics and Aitchison distances are sensitive to this.`,
    );
  }

  if (depth && depth.min < 1000) {
    cautions.push(
      `The shallowest sample has only ${depth.min.toLocaleString()} reads. Samples below roughly 1,000 reads are usually excluded.`,
    );
  }

  const variables: VariableSummary[] = metadata.columns.map((column) => {
    const missing = column.values.filter((v) => v === null).length;

    if (column.type === 'categorical') {
      const counts = new Map<string, number>();
      for (const value of column.values) {
        if (value === null) continue;
        const key = String(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return {
        name: column.name,
        type: 'categorical',
        counts: [...counts.entries()]
          .map(([level, n]) => ({ level, n }))
          // Largest group first, ties broken alphabetically. Without the
          // second key, equally sized groups would fall back to the order
          // they happened to appear in the file, so the display would shift
          // for no visible reason between datasets.
          .sort((a, b) => b.n - a.n || a.level.localeCompare(b.level)),
        missing,
      };
    }

    const numeric = column.values.filter(
      (v): v is number => typeof v === 'number',
    );
    return {
      name: column.name,
      type: 'continuous',
      range: quantiles(numeric),
      missing,
    };
  });

  // Group sizes govern how much any test can show, so flag small ones here
  // rather than only at the point of testing.
  for (const variable of variables) {
    if (!variable.counts) continue;
    const smallest = variable.counts[variable.counts.length - 1];
    if (variable.counts.length >= 2 && smallest.n < 5) {
      cautions.push(
        `“${variable.name}” has only ${smallest.n} sample${smallest.n === 1 ? '' : 's'} in group “${smallest.level}”. Comparisons involving it have very little power, and a non-significant result would say more about sample size than about biology.`,
      );
    }
  }

  const sparsity = nFeatures * nSamples > 0 ? zeros / (nFeatures * nSamples) : 0;
  if (sparsity > 0.9) {
    cautions.push(
      `${(sparsity * 100).toFixed(0)}% of the table is zeros. Consider raising the prevalence filter before differential testing.`,
    );
  }

  return {
    features: nFeatures,
    samples: nSamples,
    isCounts,
    depth,
    sparsity,
    richness: quantiles(observedPerSample),
    variables,
    cautions,
  };
}
