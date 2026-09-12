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

const UNASSIGNED = /^(unclassified|unassigned|unknown|none|na|n\/a)$/i;

function normaliseTaxon(raw: string): string {
  const value = stripConfidence(raw ?? '').trim();
  const withoutPrefix = value.replace(/^[a-z]__/i, '').trim();
  // Bracketed names such as [Spartobacteria] mark uncertain placement; the
  // brackets are noise for display and grouping.
  const cleaned = withoutPrefix.replace(/^\[(.*)\]$/, '$1').trim();
  return UNASSIGNED.test(cleaned) ? '' : cleaned;
}

function detectDelimiter(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return tabs >= commas ? '\t' : ',';
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
  const header = lines[0]
    .replace(/^#\s*/, '')
    .split(delimiter)
    .map((h) => h.trim());

  const warnings: string[] = [];

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
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(delimiter);
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
  const sample = lines
    .slice(1, Math.min(lines.length, 21))
    .map((line) => line.split(delimiter)[1] ?? '');
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
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter);
    const id = cells[0]?.trim();
    if (!id) continue;
    lineages.set(id, (cells[1] ?? '').trim());
  }

  return { lineages, format: 'lineage', warnings };
}
