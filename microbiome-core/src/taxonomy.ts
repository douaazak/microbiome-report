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

/**
 * Values that mean "nothing was assigned here", normalised to null.
 *
 * The `uncultured` family of tokens matters more than it looks. SILVA assigns
 * `g__uncultured` to a large share of ASVs, across families that are not
 * related to each other. Read as a name, they collapse into a single genus
 * called "uncultured" that then shows up as one of the largest bars in a
 * composition plot and as one feature in differential abundance. Read as
 * null, `labelAtRank` renders them as "Unclassified <family>", which keeps
 * genuinely different lineages apart and says plainly what is known.
 */
export const DEFAULT_NULL_TOKENS = [
  'na',
  'n/a',
  'unclassified',
  'unassigned',
  'unknown',
  'none',
  '',
  // SILVA / NCBI placeholders.
  'uncultured',
  'uncultured bacterium',
  'uncultured_bacterium',
  'uncultured archaeon',
  'uncultured_archaeon',
  'uncultured organism',
  'uncultured_organism',
  'uncultured soil bacterium',
  'uncultured_soil_bacterium',
  'unidentified',
  'ambiguous_taxa',
  'ambiguous taxa',
  'metagenome',
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
  /**
   * How many tokens in an otherwise-prefixed lineage had no prefix of their
   * own and were placed at the rank their neighbours bracket them into.
   * Always 0 for a fully prefixed or fully positional lineage.
   */
  inferredUnprefixed: number;
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
  /**
   * Rows where a token inside an otherwise-prefixed lineage had no prefix and
   * was placed from its position. Worth surfacing: the placement is inferred,
   * not stated by the file.
   */
  inferredUnprefixedRows: number;
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

/**
 * Strip an inline bootstrap confidence value, as mothur writes it:
 * `Firmicutes(100)`, `c__[Spartobacteria](99)`.
 *
 * Left in place, the confidence becomes part of the name, so the same phylum
 * at 100% and at 98% are two different taxa. One phylum then fragments into a
 * dozen composition bars and a dozen separately-tested features.
 */
function stripConfidence(value: string): string {
  return value.replace(/\(\s*\d+(?:\.\d+)?\s*\)\s*$/, '').trim();
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
  let inferredUnprefixed = 0;

  /*
   * Walk the tokens once, tracking the rank slot the next token would occupy.
   *
   * A prefixed token is placed at the rank its prefix names and sets the
   * cursor to the slot after it. An unprefixed token takes the cursor's slot.
   * That single rule covers both shapes: a lineage with no prefixes anywhere
   * is read positionally from domain downward (the cursor starts at 0 and
   * only ever advances by one), and a lineage where one token lost its prefix
   * — `d__Bacteria;p__Firmicutes;Clostridia;o__Clostridiales` — puts that
   * token in the slot its neighbours bracket it into.
   *
   * The previous version collected unprefixed tokens and then used them only
   * when the lineage had no prefixes at all, so in a mixed lineage they were
   * dropped: the class above went missing, and the row was then counted as a
   * legitimate gap, which hid the loss behind a diagnostic.
   *
   * An unprefixed token never overwrites a slot a prefix already claimed, so
   * this cannot shift a lower rank upward over an explicit assignment.
   */
  let cursor = 0;
  for (const token of tokens) {
    const trimmed = stripConfidence(token.trim());
    const match = /^([a-zA-Z])__(.*)$/.exec(trimmed);

    if (match) {
      const letter = match[1].toLowerCase();
      const value = stripConfidence(match[2].trim());

      const index = PREFIX_TO_INDEX[letter];
      // Unrecognised prefixes (notably MetaPhlAn's t__ strain level) have no
      // slot in a 7-rank model and are counted rather than forced somewhere.
      // They do not move the cursor either.
      if (index === undefined) continue;

      sawPrefix = true;
      ranks[index] = nullTokens.has(value.toLowerCase()) ? null : value;
      cursor = index + 1;
    } else {
      if (cursor >= RANKS.length) continue;
      if (ranks[cursor] === null) {
        ranks[cursor] = nullTokens.has(trimmed.toLowerCase()) ? null : trimmed;
        if (ranks[cursor] !== null) inferredUnprefixed++;
      }
      cursor++;
    }
  }

  if (!sawPrefix) {
    if (options.allowPositional === false) {
      return {
        ranks: new Array(RANKS.length).fill(null),
        raw,
        positional: true,
        inferredUnprefixed: 0,
      };
    }
    // No prefixes anywhere: the positional reading above is the only
    // interpretation available, so it is not an inference worth flagging.
    return { ranks, raw, positional: true, inferredUnprefixed: 0 };
  }

  return { ranks, raw, positional: false, inferredUnprefixed };
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
    inferredUnprefixedRows: 0,
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
    if (parsed.inferredUnprefixed > 0) diagnostics.inferredUnprefixedRows++;

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

  if (d.inferredUnprefixedRows > 0) {
    messages.push(
      `${d.inferredUnprefixedRows} lineage${d.inferredUnprefixedRows === 1 ? ' has a token' : 's have tokens'} with no rank prefix. ${d.inferredUnprefixedRows === 1 ? 'It was' : 'They were'} placed at the rank the surrounding prefixes imply.`,
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
