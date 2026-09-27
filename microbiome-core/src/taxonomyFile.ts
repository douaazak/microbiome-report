/**
 * Taxonomy file parsing.
 *
 * Two shapes are common in the wild and this must handle both, because a user
 * has no way to know which one their upstream tool produced:
 *
 *   LINEAGE — QIIME2's taxonomy.tsv. One column holds the whole assignment.
 *     Feature ID   Taxon                              Confidence
 *     ASV_1        d__Bacteria;p__Firmicutes;...      0.99
 *
 *   RANKS — mothur, DADA2's assignTaxonomy matrix, phyloseq exports, TaxAss.
 *     One column per rank, sometimes with bootstrap confidence inline.
 *     OTU     Kingdom          Phylum                    Class
 *     Otu0001 k__Bacteria(100) p__Verrucomicrobia(100)   c__[Spartobacteria](99)
 *
 * An earlier version assumed LINEAGE and, given a RANKS file, silently
 * returned the Phylum column as if it were a full lineage — no error, just
 * wrong results all the way through. Detecting the shape and refusing what it
 * cannot read is the point of this module.
 */

import { splitDelimited } from './table.js';
import { DEFAULT_NULL_TOKENS } from './taxonomy.js';

/** Header names that identify a rank column, mapped to their rank index. */
const RANK_HEADERS: Record<string, number> = {
  // Standard.
  domain: 0,
  kingdom: 0,
  phylum: 1,
  class: 2,
  order: 3,
  family: 4,
  genus: 5,
  species: 6,
  // Freshwater TaxAss uses finer-grained names for the lower three ranks.
  lineage: 4,
  clade: 5,
  tribe: 6,
};

const ID_HEADERS = new Set([
  'feature id',
  'featureid',
  '#otu id',
  'otu id',
  'otuid',
  'otu',
  'id',
  '',
]);

export type TaxonomyFileFormat = 'lineage' | 'ranks';

export interface TaxonomyFileResult {
  /** Feature ID to a semicolon-separated, prefixed lineage string. */
  lineages: Map<string, string>;
  format: TaxonomyFileFormat;
  /** Rank column names used, in order, when the format is 'ranks'. */
  rankColumns?: string[];
  warnings: string[];
}

const RANK_PREFIX = ['d', 'p', 'c', 'o', 'f', 'g', 's'];

/** Strip bootstrap confidence such as "p__Verrucomicrobia(100)". */
function stripConfidence(value: string): string {
  return value.replace(/\(\s*\d+(?:\.\d+)?\s*\)\s*$/, '').trim();
}

/**
 * Placeholders that mean "nothing was assigned here".
 *
 * Shared with the lineage parser so the two file shapes agree about what
 * counts as a name. Read as names, SILVA's `uncultured` and `Ambiguous_taxa`
 * merge unrelated lineages into one taxon in every downstream plot and test.
 */
const UNASSIGNED = new Set(DEFAULT_NULL_TOKENS.map((t) => t.toLowerCase()));

function normaliseTaxon(raw: string): string {
  const value = stripConfidence(raw ?? '').trim();
  const withoutPrefix = value.replace(/^[a-z]__/i, '').trim();
  // Bracketed names such as [Spartobacteria] mark uncertain placement; the
  // brackets are noise for display and grouping.
  const cleaned = withoutPrefix.replace(/^\[(.*)\]$/, '$1').trim();
  return UNASSIGNED.has(cleaned.toLowerCase()) ? '' : cleaned;
}

function detectDelimiter(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return tabs >= commas ? '\t' : ',';
}

/** The width shared by most data rows, which is what the header should match. */
function modalWidth(rows: string[][]): number {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [width, count] of counts) {
    if (count > bestCount) {
      best = width;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse a taxonomy file in either supported shape.
 * Throws with an explanation rather than guessing when the shape is unclear.
 */
export function parseTaxonomyFile(text: string): TaxonomyFileResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('The taxonomy file has no data rows.');
  }

  const delimiter = detectDelimiter(lines[0]);
  const warnings: string[] = [];

  /*
   * Quote-aware splitting, matching parseFeatureTable.
   *
   * These two files are read by the same user in the same session and must
   * agree about the same bytes. Splitting raw here meant `write.csv` output
   * kept its quotes, so the IDs were `"ASV_1"` in the taxonomy and `ASV_1` in
   * the feature table and nothing joined — every feature showed as Unassigned
   * with no error. A quoted lineage containing a comma was also truncated at
   * the comma, which then defeated the `p__` prefix test as well.
   */
  const header = splitDelimited(lines[0].replace(/^#\s*/, ''), delimiter).map(
    (h) => h.trim(),
  );

  const rows = lines
    .slice(1)
    .map((line) => splitDelimited(line, delimiter).map((c) => c.trim()));

  /*
   * Repair R's `write.table` header.
   *
   * `write.table(tax_table(ps), sep="\t")` — the way phyloseq and DADA2 users
   * export a taxonomy — writes a header with one fewer field than the data
   * rows, because the row-name column gets no name. Rank columns were located
   * by header index while values were read from the data row at that index,
   * so every rank landed one column to the left: the genus column showed the
   * family name and the species column showed the genus. The feature IDs
   * still parsed, so the join succeeded and nothing downstream looked wrong.
   *
   * The repair is unambiguous — the header describes columns 1..n and column
   * 0 holds the row names — so it is done here rather than refused, but it is
   * always reported.
   */
  const dataWidth = modalWidth(rows);
  if (rows.length > 0 && dataWidth === header.length + 1) {
    header.unshift('');
    warnings.push(
      `The header has one fewer column than the data rows, which is how R's write.table writes row names. The first column was read as the feature ID and every named column shifted one to the right to line up with it. Without this, each rank would have taken the name of the rank above it.`,
    );
  } else if (rows.length > 0 && dataWidth !== header.length) {
    warnings.push(
      `Most data rows have ${dataWidth} fields but the header has ${header.length}. Columns may not line up with their names.`,
    );
  }

  // Which header cells name a taxonomic rank?
  const rankColumns: { index: number; rank: number; name: string }[] = [];
  for (let i = 1; i < header.length; i++) {
    const rank = RANK_HEADERS[header[i].toLowerCase()];
    if (rank !== undefined) {
      rankColumns.push({ index: i, rank, name: header[i] });
    }
  }

  const firstColumnIsId = ID_HEADERS.has(header[0].toLowerCase());

  if (rankColumns.length >= 2) {
    // ---- RANKS ----------------------------------------------------------
    if (!firstColumnIsId) {
      warnings.push(
        `Treating the first column ("${header[0]}") as the feature ID.`,
      );
    }

    const seen = new Set<number>();
    for (const column of rankColumns) {
      if (seen.has(column.rank)) {
        warnings.push(
          `More than one column maps to the same rank; "${column.name}" may overwrite an earlier one.`,
        );
      }
      seen.add(column.rank);
    }

    const lineages = new Map<string, string>();
    for (const cells of rows) {
      const id = cells[0]?.trim();
      if (!id) continue;

      const ranks = new Array<string>(7).fill('');
      for (const column of rankColumns) {
        ranks[column.rank] = normaliseTaxon(cells[column.index] ?? '');
      }
      lineages.set(
        id,
        ranks.map((value, index) => `${RANK_PREFIX[index]}__${value}`).join(';'),
      );
    }

    return {
      lineages,
      format: 'ranks',
      rankColumns: rankColumns.map((c) => c.name),
      warnings,
    };
  }

  // ---- LINEAGE ----------------------------------------------------------
  if (header.length < 2) {
    throw new Error(
      'The taxonomy file has only one column. Expected a feature ID plus either a lineage string or one column per rank.',
    );
  }

  // Confirm the second column actually looks like a lineage before trusting
  // it. Sampling a few rows is what stops a rank-style file with unfamiliar
  // header names being read as lineages.
  const sample = rows.slice(0, 20).map((cells) => cells[1] ?? '');
  const looksLikeLineage = sample.filter(
    (value) => value.includes(';') || value.includes('|') || /[a-z]__/i.test(value),
  ).length;

  if (looksLikeLineage < Math.ceil(sample.length * 0.5)) {
    throw new Error(
      `Column "${header[1]}" does not look like a taxonomic lineage — no rank separators (";" or "|") or rank prefixes ("p__") were found. ` +
        `If this file has one column per rank, name those columns Domain/Kingdom, Phylum, Class, Order, Family, Genus, Species ` +
        `(or Lineage/Clade/Tribe) so they can be recognised. Header seen: ${header.slice(0, 8).join(', ')}`,
    );
  }

  if (!firstColumnIsId) {
    warnings.push(
      `Treating the first column ("${header[0]}") as the feature ID.`,
    );
  }

  const lineages = new Map<string, string>();
  for (const cells of rows) {
    const id = cells[0]?.trim();
    if (!id) continue;
    lineages.set(id, (cells[1] ?? '').trim());
  }

  return { lineages, format: 'lineage', warnings };
}
