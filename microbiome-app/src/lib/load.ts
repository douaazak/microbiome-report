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
  describeLineageDiagnostics,
  type FeatureTable,
  type Metadata,
  type ParsedLineage,
  type Rank,
} from 'microbiome-core';

export type InputKind = 'asv' | 'metaphlan';

export interface Dataset {
  kind: InputKind;
  table: FeatureTable;
  metadata: Metadata;
  /** One per feature, when taxonomy was supplied. */
  lineages?: ParsedLineage[];
  isCounts: boolean;
  /** Alpha metrics that cannot be computed from this input. */
  unavailableMetrics: string[];
  /** Human-readable notes about what was parsed, fixed, or dropped. */
  diagnostics: string[];
}

export interface LoadAsvInput {
  kind: 'asv';
  tableText: string;
  metadataText: string;
  /** Optional QIIME2-style taxonomy.tsv (Feature ID / Taxon / Confidence). */
  taxonomyText?: string;
}

export interface LoadMetaPhlAnInput {
  kind: 'metaphlan';
  tableText: string;
  metadataText: string;
  rank: Rank;
}

export type LoadInput = LoadAsvInput | LoadMetaPhlAnInput;

export function loadDataset(input: LoadInput): Dataset {
  const diagnostics: string[] = [];

  const metadata = parseMetadata(input.metadataText);

  if (input.kind === 'metaphlan') {
    const result = parseMetaPhlAn(input.tableText, { rank: input.rank });
    diagnostics.push(...result.warnings);

    const joined = joinTableAndMetadata(result.table, metadata);
    diagnostics.push(...joined.warnings);

    return {
      kind: 'metaphlan',
      table: joined.table,
      metadata: joined.metadata,
      lineages: result.lineages,
      isCounts: !result.isRelativeAbundance,
      unavailableMetrics: result.unavailableMetrics,
      diagnostics,
    };
  }

  const parsed = parseFeatureTable(input.tableText, {
    knownSampleIds: metadata.sampleIds,
  });
  diagnostics.push(...parsed.warnings);

  const joined = joinTableAndMetadata(parsed.table, metadata);
  diagnostics.push(...joined.warnings);

  let lineages: ParsedLineage[] | undefined;
  if (input.taxonomyText) {
    const map = parseTaxonomyFile(input.taxonomyText);
    const missing = joined.table.featureIds.filter((id) => !map.has(id)).length;
    if (missing > 0) {
      diagnostics.push(
        `${missing} feature${missing === 1 ? '' : 's'} had no taxonomy assignment and will show as Unassigned.`,
      );
    }
    const raws = joined.table.featureIds.map((id) => map.get(id) ?? '');
    const result = parseLineages(raws);
    lineages = result.lineages;
    diagnostics.push(...describeLineageDiagnostics(result.diagnostics));
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
    lineages,
    isCounts,
    unavailableMetrics: isCounts ? [] : ['observed', 'chao1', 'rarefaction'],
    diagnostics,
  };
}

/**
 * QIIME2 taxonomy export: a header, then `Feature ID`, `Taxon`, `Confidence`.
 * Only the first two columns are used.
 */
export function parseTaxonomyFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const [index, line] of lines.entries()) {
    if (line.startsWith('#') && index === 0) continue;
    const delimiter = line.includes('\t') ? '\t' : ',';
    const cells = line.split(delimiter);
    if (cells.length < 2) continue;

    const id = cells[0].trim();
    // Skip the header row, whichever spelling it uses.
    if (index === 0 && /^(feature\s*id|otu\s*id|#otu id|id)$/i.test(id)) continue;

    map.set(id, cells[1].trim());
  }

  return map;
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
