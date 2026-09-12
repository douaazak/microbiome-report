/**
 * Turns raw uploaded text into an analysis-ready dataset.
 *
 * Ordering matters here: metadata is parsed FIRST because its sample IDs are
 * what resolves the feature table's orientation. Without it, a DADA2 seqtab
 * (samples as rows) is indistinguishable from a normal table and would be
 * analysed transposed.
 */

import {
  detectCounts,
  joinTableAndMetadata,
  parseFeatureTable,
  parseLineages,
  parseMetaPhlAn,
  parseMetadata,
  parseTaxonomyFile,
  taxonomyCoverage,
  describeCoverage,
  describeLineageDiagnostics,
  type FeatureTable,
  type Metadata,
  type MetadataColumn,
  type ParsedLineage,
  type TaxonomyCoverage,
  type Rank,
} from 'microbiome-core';

export type InputKind = 'asv' | 'metaphlan';

/**
 * Shown when a dataset is loaded without metadata. Worth stating plainly
 * rather than leaving the user to discover which tabs went quiet.
 */
const NO_METADATA_NOTE =
  'No metadata supplied. Composition, alpha diversity and the ordination still work; grouping, statistical tests and differential abundance need a metadata file.';

export interface Dataset {
  kind: InputKind;
  table: FeatureTable;
  metadata: Metadata;
  /**
   * False when no metadata file was supplied. The `metadata` field is still
   * populated — with the sample IDs and no variables — so consumers do not
   * need null checks, but nothing can be grouped or compared.
   */
  hasMetadata: boolean;
  /** One per feature, when taxonomy was supplied. */
  lineages?: ParsedLineage[];
  /** How completely each rank is assigned; absent when no taxonomy was given. */
  coverage?: TaxonomyCoverage;
  isCounts: boolean;
  /** Alpha metrics that cannot be computed from this input. */
  unavailableMetrics: string[];
  /** Human-readable notes about what was parsed, fixed, or dropped. */
  diagnostics: string[];
}

export interface LoadAsvInput {
  kind: 'asv';
  tableText: string;
  /**
   * Optional. Without it the dataset still loads and every analysis that does
   * not need groups still runs — see `hasMetadata` on the result.
   */
  metadataText?: string;
  /** Optional QIIME2-style taxonomy.tsv (Feature ID / Taxon / Confidence). */
  taxonomyText?: string;
}

export interface LoadMetaPhlAnInput {
  kind: 'metaphlan';
  tableText: string;
  metadataText?: string;
  rank: Rank;
}

export type LoadInput = LoadAsvInput | LoadMetaPhlAnInput;

/**
 * A stand-in for metadata that was not supplied: the sample IDs from the
 * feature table, and no variables.
 *
 * Modelling absent metadata as an empty column list rather than as null means
 * every downstream consumer keeps working unchanged — a panel that asks for
 * categorical columns simply gets none, which it already has to handle for
 * datasets whose metadata is entirely numeric.
 */
function metadataFromTable(sampleIds: string[]): Metadata {
  return { sampleIds, columns: [] };
}

export function loadDataset(input: LoadInput): Dataset {
  const diagnostics: string[] = [];

  const metadata = input.metadataText
    ? parseMetadata(input.metadataText)
    : null;
  if (metadata) diagnostics.push(...metadata.warnings);

  if (input.kind === 'metaphlan') {
    const result = parseMetaPhlAn(input.tableText, { rank: input.rank });
    diagnostics.push(...result.warnings);

    if (!metadata) {
      diagnostics.push(NO_METADATA_NOTE);
      return {
        kind: 'metaphlan',
        table: result.table,
        metadata: metadataFromTable(result.table.sampleIds),
        hasMetadata: false,
        lineages: result.lineages,
        isCounts: !result.isRelativeAbundance,
        unavailableMetrics: result.unavailableMetrics,
        diagnostics,
      };
    }

    const joined = joinTableAndMetadata(result.table, metadata);
    diagnostics.push(...joined.warnings);

    return {
      kind: 'metaphlan',
      table: joined.table,
      metadata: joined.metadata,
      hasMetadata: true,
      lineages: result.lineages,
      isCounts: !result.isRelativeAbundance,
      unavailableMetrics: result.unavailableMetrics,
      diagnostics,
    };
  }

  const parsed = parseFeatureTable(input.tableText, {
    knownSampleIds: metadata?.sampleIds,
  });
  diagnostics.push(...parsed.warnings);

  const joined = metadata
    ? joinTableAndMetadata(parsed.table, metadata)
    : {
        table: parsed.table,
        metadata: metadataFromTable(parsed.table.sampleIds),
        warnings: [NO_METADATA_NOTE],
      };
  diagnostics.push(...joined.warnings);

  let lineages: ParsedLineage[] | undefined;
  let coverage: TaxonomyCoverage | undefined;

  /*
   * Some tables carry the full lineage in the feature ID itself, rather than
   * in a separate taxonomy file — GTDB-style
   * "d__Bacteria;p__Firmicutes;...;g__Blautia" as the column header. Without
   * recognising that, the composition plot labels every bar with a
   * hundred-character string and cannot collapse by rank at all.
   */
  if (!input.taxonomyText && looksLikeLineageIds(joined.table.featureIds)) {
    const result = parseLineages(joined.table.featureIds);
    lineages = result.lineages;
    diagnostics.push(
      'Feature names contain full taxonomic lineages, so ranks were read directly from them — no separate taxonomy file is needed.',
    );
    diagnostics.push(...describeLineageDiagnostics(result.diagnostics));

    coverage = taxonomyCoverage(lineages);
    diagnostics.push(...describeCoverage(coverage));
  }

  if (input.taxonomyText) {
    const parsed = parseTaxonomyFile(input.taxonomyText);
    diagnostics.push(...parsed.warnings);

    if (parsed.format === 'ranks') {
      diagnostics.push(
        `Taxonomy supplied as one column per rank (${parsed.rankColumns?.join(', ')}); combined into lineages.`,
      );
    }

    const missing = joined.table.featureIds.filter(
      (id) => !parsed.lineages.has(id),
    ).length;
    if (missing > 0) {
      diagnostics.push(
        `${missing} feature${missing === 1 ? '' : 's'} had no taxonomy assignment and will show as Unassigned.`,
      );
    }

    const raws = joined.table.featureIds.map(
      (id) => parsed.lineages.get(id) ?? '',
    );
    const result = parseLineages(raws);
    lineages = result.lineages;
    diagnostics.push(...describeLineageDiagnostics(result.diagnostics));

    coverage = taxonomyCoverage(lineages);
    diagnostics.push(...describeCoverage(coverage));
  }

  const isCounts = detectCounts(joined.table.values);
  if (!isCounts) {
    diagnostics.push(
      'Values are not whole numbers, so this table was treated as relative abundance. Richness metrics (observed features, Chao1) are unavailable.',
    );
  }

  return {
    kind: 'asv',
    table: joined.table,
    metadata: joined.metadata,
    hasMetadata: metadata !== null,
    coverage,
    lineages,
    isCounts,
    unavailableMetrics: isCounts ? [] : ['observed', 'chao1', 'rarefaction'],
    diagnostics,
  };
}

/**
 * Do these feature IDs look like taxonomic lineages rather than opaque IDs?
 *
 * Requires both a rank separator and rank prefixes on most entries, so an
 * ordinary ID that happens to contain a semicolon is not mistaken for one.
 */
export function looksLikeLineageIds(featureIds: string[]): boolean {
  if (featureIds.length === 0) return false;

  const sample = featureIds.slice(0, Math.min(featureIds.length, 50));
  const lineageLike = sample.filter(
    (id) => /[a-z]__/i.test(id) && (id.includes(';') || id.includes('|')),
  ).length;

  return lineageLike >= Math.ceil(sample.length * 0.8);
}

export interface GroupableColumns {
  /** Columns that can actually define groups. */
  usable: MetadataColumn[];
  /** Columns excluded, each with the reason, so nothing disappears silently. */
  excluded: { name: string; reason: string }[];
}

/**
 * Which metadata columns can serve as a grouping variable.
 *
 * Both extremes are useless and both occur in real files. A MIMARKS sheet
 * carries fields like `env_biome` and `seq_methods` that are identical for
 * every sample — the Linz et al. sheet has eight such columns out of
 * thirteen — and offering them produces a menu where most choices give the
 * same empty answer, which reads as the tool being broken. At the other end,
 * a column with a distinct value per sample defines no groups either.
 */
export function groupableColumns(
  metadata: Metadata,
  sampleCount: number,
): GroupableColumns {
  const usable: MetadataColumn[] = [];
  const excluded: { name: string; reason: string }[] = [];

  for (const column of metadata.columns) {
    if (column.type !== 'categorical') continue;

    const levels = column.levels?.length ?? 0;

    if (levels < 2) {
      excluded.push({
        name: column.name,
        reason:
          levels === 0
            ? 'no values'
            : `the same value for every sample (“${column.levels?.[0]}”)`,
      });
    } else if (levels >= sampleCount && sampleCount > 2) {
      excluded.push({
        name: column.name,
        reason: 'a different value for every sample',
      });
    } else {
      usable.push(column);
    }
  }

  return { usable, excluded };
}

/** Values of a metadata column as strings, for use as grouping labels. */
export function groupLabels(
  metadata: Metadata,
  columnName: string,
): (string | null)[] {
  const column = metadata.columns.find((c) => c.name === columnName);
  if (!column) throw new Error(`No metadata column named "${columnName}".`);
  return column.values.map((v) => (v === null ? null : String(v)));
}

/**
 * Indices of samples with a non-null value for the chosen column.
 * Samples missing the variable are excluded from that analysis rather than
 * grouped under a fabricated "unknown" level.
 */
export function completeCases(labels: (string | null)[]): number[] {
  return labels.flatMap((label, i) => (label === null ? [] : [i]));
}

export function subsetColumns(
  values: number[][],
  indices: number[],
): number[][] {
  return values.map((row) => indices.map((i) => row[i]));
}
