/**
 * MetaPhlAn output parsing.
 *
 * Two properties of this format silently corrupt results if missed.
 *
 * 1. Every rank is stacked in one file. A MetaPhlAn table contains kingdom
 *    rows AND phylum rows AND species rows together, each summing to ~100%
 *    within its own rank. Summing without filtering double-counts everything.
 *    So a target rank is REQUIRED here, not optional.
 *
 * 2. Values are relative abundances, not counts. That makes richness-based
 *    metrics (observed features, Chao1, rarefaction) invalid — they need
 *    counts and singletons that relative abundance cannot provide. The parser
 *    reports this so the UI can disable those metrics with a reason attached
 *    rather than silently producing a number.
 */

import type { FeatureTable } from './table.js';
import { parseLineages, RANKS, type Rank, type ParsedLineage } from './taxonomy.js';

/** Prefix letter naming each rank, used to read a clade's depth. */
const RANK_PREFIX: Record<Rank, string> = {
  domain: 'k',
  phylum: 'p',
  class: 'c',
  order: 'o',
  family: 'f',
  genus: 'g',
  species: 's',
};

export interface MetaPhlAnParseOptions {
  /** Which rank to extract. Required, for the reason described above. */
  rank: Rank;
}

export interface MetaPhlAnParseResult {
  table: FeatureTable;
  lineages: ParsedLineage[];
  /** True when column sums are consistent with percentages rather than counts. */
  isRelativeAbundance: boolean;
  /** Alpha diversity metrics that cannot be computed from this input. */
  unavailableMetrics: string[];
  warnings: string[];
  /** MetaPhlAn version string from the header, when present. */
  version?: string;
}

export function parseMetaPhlAn(
  text: string,
  options: MetaPhlAnParseOptions,
): MetaPhlAnParseResult {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  let version: string | undefined;
  for (const line of lines) {
    const match = /^#(mpa_[^\s]+)/.exec(line);
    if (match) {
      version = match[1];
      break;
    }
  }

  // The header is the line naming clade_name; it may or may not be commented.
  const headerIndex = lines.findIndex((l) =>
    /clade_name/i.test(l.split('\t')[0].replace(/^#\s*/, '')),
  );

  if (headerIndex === -1) {
    throw new Error(
      'No "clade_name" header found. This does not look like MetaPhlAn output.',
    );
  }

  const header = lines[headerIndex]
    .replace(/^#\s*/, '')
    .split('\t')
    .map((h) => h.trim());

  // Single-sample MetaPhlAn output carries fixed metadata columns; merged
  // output carries one column per sample. Detect and drop the fixed ones.
  const metadataColumns = new Set([
    'ncbi_tax_id',
    'additional_species',
    'clade_taxid',
  ]);
  const sampleColumnIndices: number[] = [];
  for (let i = 1; i < header.length; i++) {
    if (!metadataColumns.has(header[i].toLowerCase())) {
      sampleColumnIndices.push(i);
    }
  }

  if (sampleColumnIndices.length === 0) {
    throw new Error('No sample columns found in the MetaPhlAn header.');
  }

  const sampleIds = sampleColumnIndices.map((i) => header[i]);

  const targetPrefix = RANK_PREFIX[options.rank];
  const featureIds: string[] = [];
  const rawLineages: string[] = [];
  const values: number[][] = [];

  let totalRows = 0;
  let keptRows = 0;

  for (const line of lines.slice(headerIndex + 1)) {
    if (line.startsWith('#')) continue;
    const cells = line.split('\t');
    const clade = cells[0].trim();
    if (clade === '') continue;
    totalRows++;

    // The row's rank is named by its LAST token's prefix. Using the count of
    // '|' separators instead would misread lineages that skip a rank.
    const tokens = clade.split('|');
    const last = tokens[tokens.length - 1];
    const prefixMatch = /^([a-zA-Z])__/.exec(last);
    if (!prefixMatch) continue;
    if (prefixMatch[1].toLowerCase() !== targetPrefix) continue;

    keptRows++;
    featureIds.push(last.replace(/^[a-zA-Z]__/, ''));
    rawLineages.push(clade);
    values.push(
      sampleColumnIndices.map((i) => {
        const cell = (cells[i] ?? '').trim();
        if (cell === '' || cell.toUpperCase() === 'NA') return 0;
        const value = Number(cell);
        if (!Number.isFinite(value)) {
          throw new Error(
            `Non-numeric abundance for clade "${clade}": "${cell}".`,
          );
        }
        return value;
      }),
    );
  }

  if (keptRows === 0) {
    const available = new Set<string>();
    for (const line of lines.slice(headerIndex + 1)) {
      if (line.startsWith('#')) continue;
      const clade = line.split('\t')[0]?.trim();
      if (!clade) continue;
      const tokens = clade.split('|');
      const match = /^([a-zA-Z])__/.exec(tokens[tokens.length - 1]);
      if (match) available.add(match[1].toLowerCase());
    }
    const names = RANKS.filter((r) => available.has(RANK_PREFIX[r]));
    throw new Error(
      `No rows at rank "${options.rank}". Ranks present in this file: ${names.join(', ') || 'none recognised'}.`,
    );
  }

  warnings.push(
    `Kept ${keptRows} of ${totalRows} rows at rank "${options.rank}". MetaPhlAn stacks every rank in one file; the rest were excluded to avoid double-counting.`,
  );

  const { lineages, diagnostics } = parseLineages(rawLineages);
  if (diagnostics.strainTokensDropped > 0) {
    warnings.push(
      `Ignored ${diagnostics.strainTokensDropped} strain-level (t__) token${diagnostics.strainTokensDropped === 1 ? '' : 's'}.`,
    );
  }

  const isRelativeAbundance = looksLikeRelativeAbundance(values);
  const unavailableMetrics: string[] = [];

  if (isRelativeAbundance) {
    unavailableMetrics.push('observed', 'chao1', 'rarefaction');
    warnings.push(
      'Values look like relative abundances rather than counts. Richness metrics (observed features, Chao1) and rarefaction need counts and are unavailable; Shannon, Simpson, Pielou and all beta-diversity metrics remain valid.',
    );
  }

  return {
    table: { featureIds, sampleIds, values },
    lineages,
    isRelativeAbundance,
    unavailableMetrics,
    warnings,
    version,
  };
}

/**
 * Relative abundance is identified by COLUMN SUMS near 100 (percentages) or
 * near 1 (proportions). Checked rather than assumed, because a user may hand
 * us a counts table carrying MetaPhlAn-shaped lineages.
 *
 * Deliberately NOT gated on the presence of non-integer values. Real MetaPhlAn
 * output frequently contains whole numbers ("35.0" parses to 35), so requiring
 * a fractional value somewhere misses obvious percentage tables.
 *
 * The remaining ambiguity is a counts table whose samples each happen to total
 * exactly 100 reads. That is rare, and the cost of getting it wrong is
 * asymmetric: a false positive disables Chao1 and observed richness, while a
 * false negative computes them from proportions and returns a number that
 * looks fine and means nothing. Erring toward "relative abundance" is the safe
 * direction.
 */
export function looksLikeRelativeAbundance(values: number[][]): boolean {
  if (values.length === 0) return false;
  const nSamples = values[0].length;
  if (nSamples === 0) return false;

  let consistent = 0;
  for (let j = 0; j < nSamples; j++) {
    let sum = 0;
    for (const row of values) sum += row[j];
    if (Math.abs(sum - 100) < 1 || Math.abs(sum - 1) < 0.01) consistent++;
  }

  return consistent >= Math.ceil(nSamples * 0.8);
}
