/**
 * Taxonomy lineage string normalisation.
 *
 * Every amplicon tool emits lineages in a slightly different shape: SILVA
 * carries trailing whitespace, QIIME2 and Greengenes disagree on `d__` vs
 * `k__`, MetaPhlAn uses `|` where most use `;`, and — the one that quietly
 * corrupts results — tools differ on what to do when a rank is unknown.
 *
 * The rule enforced here: a token is placed at the rank its prefix names, and
 * missing ranks are PADDED with null. A lower rank is never shifted upward to
 * fill a gap. Shifting is the bug behind reports of "Phylum jumps to Order",
 * and once it happens downstream analysis is wrong in a way nobody notices.
 */

export const RANKS = [
  'domain',
  'phylum',
  'class',
  'order',
  'family',
  'genus',
  'species',
] as const;

export type Rank = (typeof RANKS)[number];

/**
 * Prefix letter to rank index. Both `d__` and `k__` map to the first slot:
 * SILVA and GTDB say domain, Greengenes says kingdom, and they occupy the
 * same position.
 */
const PREFIX_TO_INDEX: Record<string, number> = {
  d: 0,
  k: 0,
  p: 1,
  c: 2,
  o: 3,
  f: 4,
  g: 5,
  s: 6,
};

/** Values that mean "nothing was assigned here", normalised to null. */
export const DEFAULT_NULL_TOKENS = [
  'na',
  'n/a',
  'unclassified',
  'unassigned',
  'unknown',
  'none',
  '',
];

export interface LineageOptions {
  /** Lowercased values treated as unassigned. */
  nullTokens?: string[];
  /**
   * When a lineage has no prefixes at all, tokens are assigned positionally
   * from domain downward. Set false to reject such rows instead.
   */
  allowPositional?: boolean;
}

export interface ParsedLineage {
  /** One entry per RANKS position; null where nothing was assigned. */
  ranks: (string | null)[];
  raw: string;
  /** True when the lineage carried no rank prefixes and was read positionally. */
  positional: boolean;
}

export interface LineageDiagnostics {
  total: number;
  /** How many rows used each domain-prefix convention. */
  prefixStyle: { d: number; k: number; none: number };
  delimiters: Record<string, number>;
  /** Rows where at least one token had surrounding whitespace. */
  whitespaceTrimmed: number;
  /**
   * Rows with a gap: a rank is empty while a LOWER rank is populated.
   * These are the rows other tools would silently collapse.
   */
  rowsWithGaps: number;
  /** Rows read positionally because they carried no prefixes. */
  positionalRows: number;
  /** MetaPhlAn `t__` strain tokens, which have no slot in the 7-rank model. */
  strainTokensDropped: number;
  /** Count of rows by how many ranks were populated. */
  depthCounts: Record<number, number>;
}

const DELIMITERS = [';', '|'] as const;

function detectDelimiter(raw: string): string {
  let best = ';';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = raw.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Parse one lineage string into a fixed-length rank array. */
export function parseLineage(
  raw: string,
  options: LineageOptions = {},
): ParsedLineage {
  const nullTokens = new Set(
    (options.nullTokens ?? DEFAULT_NULL_TOKENS).map((t) => t.toLowerCase()),
  );

  const delimiter = detectDelimiter(raw);
  const tokens = raw.split(delimiter);

  const ranks: (string | null)[] = new Array(RANKS.length).fill(null);
  let sawPrefix = false;
  const unprefixed: string[] = [];

  for (const token of tokens) {
    const trimmed = token.trim();
    const match = /^([a-zA-Z])__(.*)$/.exec(trimmed);

    if (match) {
      sawPrefix = true;
      const letter = match[1].toLowerCase();
      const value = match[2].trim();

      const index = PREFIX_TO_INDEX[letter];
      // Unrecognised prefixes (notably MetaPhlAn's t__ strain level) have no
      // slot in a 7-rank model and are counted rather than forced somewhere.
      if (index === undefined) continue;

      ranks[index] = nullTokens.has(value.toLowerCase()) ? null : value;
    } else {
      unprefixed.push(trimmed);
    }
  }

  if (!sawPrefix) {
    if (options.allowPositional === false) {
      return { ranks, raw, positional: true };
    }
    // No prefixes anywhere: fall back to positional assignment, which is the
    // only interpretation available.
    for (let i = 0; i < Math.min(unprefixed.length, RANKS.length); i++) {
      const value = unprefixed[i];
      ranks[i] = nullTokens.has(value.toLowerCase()) ? null : value;
    }
    return { ranks, raw, positional: true };
  }

  return { ranks, raw, positional: false };
}

export interface LineageParseResult {
  lineages: ParsedLineage[];
  diagnostics: LineageDiagnostics;
}

export function parseLineages(
  raws: string[],
  options: LineageOptions = {},
): LineageParseResult {
  const diagnostics: LineageDiagnostics = {
    total: raws.length,
    prefixStyle: { d: 0, k: 0, none: 0 },
    delimiters: {},
    whitespaceTrimmed: 0,
    rowsWithGaps: 0,
    positionalRows: 0,
    strainTokensDropped: 0,
    depthCounts: {},
  };

  const lineages = raws.map((raw) => {
    const delimiter = detectDelimiter(raw);
    diagnostics.delimiters[delimiter] =
      (diagnostics.delimiters[delimiter] ?? 0) + 1;

    const tokens = raw.split(delimiter);
    if (tokens.some((t) => t !== t.trim())) {
      diagnostics.whitespaceTrimmed++;
    }
    for (const token of tokens) {
      if (/^t__/i.test(token.trim())) diagnostics.strainTokensDropped++;
    }

    if (/(^|[;|])\s*d__/i.test(raw)) diagnostics.prefixStyle.d++;
    else if (/(^|[;|])\s*k__/i.test(raw)) diagnostics.prefixStyle.k++;
    else diagnostics.prefixStyle.none++;

    const parsed = parseLineage(raw, options);
    if (parsed.positional) diagnostics.positionalRows++;

    const depth = parsed.ranks.filter((r) => r !== null).length;
    diagnostics.depthCounts[depth] = (diagnostics.depthCounts[depth] ?? 0) + 1;

    if (hasGap(parsed.ranks)) diagnostics.rowsWithGaps++;

    return parsed;
  });

  return { lineages, diagnostics };
}

/** True when a null rank sits above a populated one. */
export function hasGap(ranks: (string | null)[]): boolean {
  let seenPopulated = false;
  for (let i = ranks.length - 1; i >= 0; i--) {
    if (ranks[i] !== null) seenPopulated = true;
    else if (seenPopulated) return true;
  }
  return false;
}

/**
 * Label for a lineage at a given rank, falling back to the nearest populated
 * ancestor so plots never show a bare "unclassified".
 */
export function labelAtRank(
  lineage: ParsedLineage,
  rank: Rank,
  unassignedLabel = 'Unassigned',
): string {
  const index = RANKS.indexOf(rank);
  if (lineage.ranks[index] !== null) return lineage.ranks[index] as string;

  for (let i = index - 1; i >= 0; i--) {
    const value = lineage.ranks[i];
    if (value !== null) return `Unclassified ${value}`;
  }
  return unassignedLabel;
}

/** Human-readable diagnostic messages, ready to render in a UI panel. */
export function describeLineageDiagnostics(d: LineageDiagnostics): string[] {
  const messages: string[] = [];

  const { d: dCount, k: kCount } = d.prefixStyle;
  if (dCount > 0 && kCount > 0) {
    const total = dCount + kCount;
    messages.push(
      `Mixed domain prefixes: ${((dCount / total) * 100).toFixed(0)}% d__, ${((kCount / total) * 100).toFixed(0)}% k__. Both were treated as the same rank.`,
    );
  }

  if (d.whitespaceTrimmed > 0) {
    messages.push(
      `Stripped surrounding whitespace from ${d.whitespaceTrimmed} lineage${d.whitespaceTrimmed === 1 ? '' : 's'} (common in SILVA exports).`,
    );
  }

  if (d.rowsWithGaps > 0) {
    messages.push(
      `${d.rowsWithGaps} lineage${d.rowsWithGaps === 1 ? '' : 's'} skip a rank. Missing ranks were padded, not filled by shifting lower ranks upward.`,
    );
  }

  if (d.positionalRows > 0 && d.positionalRows < d.total) {
    messages.push(
      `${d.positionalRows} of ${d.total} lineages carried no rank prefixes and were read positionally. Verify these are correct.`,
    );
  }

  if (d.strainTokensDropped > 0) {
    messages.push(
      `Dropped ${d.strainTokensDropped} strain-level (t__) token${d.strainTokensDropped === 1 ? '' : 's'}; this model resolves to species.`,
    );
  }

  const depths = Object.keys(d.depthCounts).map(Number).sort((a, b) => a - b);
  if (depths.length > 1) {
    messages.push(
      `Assigned depth varies from ${depths[0]} to ${depths[depths.length - 1]} ranks across lineages.`,
    );
  }

  return messages;
}
