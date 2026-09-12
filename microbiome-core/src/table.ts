/**
 * Feature table and metadata parsing.
 *
 * The subtle problem here is orientation. DADA2's seqtab has samples as ROWS;
 * QIIME2 exports and most other tools have features as rows. Guessing from
 * "features usually outnumber samples" fails on small studies and fails
 * silently, producing a transposed analysis that still runs. So orientation is
 * resolved by matching against the metadata's sample IDs, and when neither
 * axis matches we stop and say so rather than picking one.
 */

export interface FeatureTable {
  featureIds: string[];
  sampleIds: string[];
  /** features (rows) x samples (columns) */
  values: number[][];
}

export interface TableParseOptions {
  /** Sample IDs from the metadata, used to resolve orientation. */
  knownSampleIds?: string[];
  delimiter?: string;
}

export interface TableParseResult {
  table: FeatureTable;
  warnings: string[];
  /** Whether the input had samples as rows and was transposed. */
  transposed: boolean;
}

/**
 * Pick the delimiter by counting candidates in the header.
 *
 * Semicolon is included because Excel writes it instead of comma in locales
 * where the comma is the decimal separator — most of continental Europe. A
 * file exported there and opened here would otherwise appear to have a single
 * column, and the resulting error would point nowhere near the real cause.
 */
function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'))
    .slice(0, 12);

  if (lines.length === 0) return '\t';

  // Tab first, then comma, then semicolon: the order to prefer on a tie.
  const candidates = ['\t', ',', ';'];
  let best = '\t';
  let bestScore = -1;

  for (const delimiter of candidates) {
    const headerFields = splitDelimited(lines[0], delimiter).length;
    if (headerFields < 2) continue;

    /*
     * Score by CONSISTENCY, not by how often the character occurs.
     *
     * Counting occurrences picks whichever character is most common, which
     * fails badly when a delimiter also appears inside field values: a table
     * whose column names are taxonomic lineages
     * ("d__Bacteria;p__Firmicutes;…") contains several semicolons per column
     * and would be split on ";" instead of on tab, shattering the header into
     * thousands of fragments. A real delimiter instead yields the same field
     * count on every line; one appearing inside values does not.
     */
    const consistent = lines.filter(
      (line) => splitDelimited(line, delimiter).length === headerFields,
    ).length;

    const score = consistent / lines.length;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/**
 * Split one delimited line, honouring quoted fields.
 *
 * Excel's "Save as CSV" quotes any value containing the delimiter, a quote or
 * a newline, and doubles embedded quotes. A naive split turns `"ASV,1",10`
 * into three fields and leaves stray quote characters in the data, which then
 * surfaces as a baffling "non-numeric value" error several steps later.
 */
export function splitDelimited(line: string, delimiter: string): string[] {
  // Fast path: nothing quoted.
  if (!line.includes('"')) return line.split(delimiter);

  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"' && current.trim() === '') {
      // A quote only opens a field at its start; mid-field quotes are data.
      inQuotes = true;
      current = '';
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Split raw text into a header row and data rows, handling the comment lines
 * that QIIME2 exports carry.
 *
 * A QIIME2 BIOM export looks like:
 *   # Constructed from biom file
 *   #OTU ID<TAB>sample1<TAB>sample2
 *   ASV_1<TAB>10<TAB>20
 *
 * The header is itself commented, so "skip all # lines" would discard it.
 * The rule used: among leading comment lines, the last one that contains the
 * delimiter is the header.
 */
function splitHeaderAndRows(
  text: string,
  delimiter: string,
): { header: string[]; rows: string[][]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error('The file is empty.');
  }

  let headerIndex = 0;
  const leadingComments: number[] = [];
  while (headerIndex < lines.length && lines[headerIndex].startsWith('#')) {
    leadingComments.push(headerIndex);
    headerIndex++;
  }

  let headerLine: string;
  if (leadingComments.length > 0) {
    // Prefer the last comment line that looks tabular.
    const candidates = leadingComments.filter((i) =>
      lines[i].includes(delimiter),
    );
    if (candidates.length > 0) {
      const chosen = candidates[candidates.length - 1];
      headerLine = lines[chosen].replace(/^#\s*/, '');
      if (chosen > 0) {
        warnings.push(
          `Skipped ${chosen} comment line${chosen === 1 ? '' : 's'} before the header.`,
        );
      }
    } else {
      // All comments were prose; the first uncommented line is the header.
      headerLine = lines[headerIndex];
      headerIndex++;
      warnings.push(
        `Skipped ${leadingComments.length} comment line${leadingComments.length === 1 ? '' : 's'}.`,
      );
    }
  } else {
    headerLine = lines[0];
    headerIndex = 1;
  }

  let header = splitDelimited(headerLine, delimiter).map((h) => h.trim());
  let rows = lines
    .slice(headerIndex)
    .filter((line) => !line.startsWith('#'))
    .map((line) => splitDelimited(line, delimiter).map((c) => c.trim()));

  /*
   * Drop a trailing empty column.
   *
   * Files written with a delimiter at the end of every line — several
   * pipelines and most hand-edited exports do this — otherwise produce a final
   * column with a blank name and no values, which becomes a phantom sample
   * named "" and is then reported as not matching the metadata.
   */
  const last = header.length - 1;
  if (
    header.length > 1 &&
    header[last] === '' &&
    rows.every((row) => row.length <= last || row[last] === '')
  ) {
    header = header.slice(0, last);
    rows = rows.map((row) => row.slice(0, last));
    warnings.push(
      'Ignored a trailing empty column caused by a delimiter at the end of each line.',
    );
  }

  return { header, rows, warnings };
}

/**
 * Distinct values that occur more than once, in first-occurrence order.
 *
 * Linear, on purpose. The obvious `filter((id, i) => ids.indexOf(id) !== i)`
 * is quadratic, and on a species table with tens of thousands of features
 * that is over a billion string comparisons before anything is shown.
 */
function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    else seen.add(id);
  }
  return [...repeated];
}

/** Parse a feature table from delimited text. */
export function parseFeatureTable(
  text: string,
  options: TableParseOptions = {},
): TableParseResult {
  const delimiter = options.delimiter ?? detectDelimiter(text);

  const { header, rows, warnings } = splitHeaderAndRows(text, delimiter);

  if (header.length < 2) {
    throw new Error(
      'The header has fewer than two columns; the file may use a different delimiter.',
    );
  }

  const columnIds = header.slice(1);

  // Duplicated column labels make every join ambiguous, and silently keeping
  // both attaches one sample's metadata to another's counts.
  const duplicateColumns = duplicates(columnIds);
  if (duplicateColumns.length > 0) {
    throw new Error(
      `The table has duplicate column names: ${duplicateColumns.join(', ')}. Each sample must appear once.`,
    );
  }

  const rowIds: string[] = [];
  const values: number[][] = [];

  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new Error(
        `Row ${index + 1} has ${row.length} fields but the header has ${header.length}.`,
      );
    }
    rowIds.push(row[0]);

    const numbers = row.slice(1).map((cell) => {
      if (cell === '' || cell.toUpperCase() === 'NA') return 0;
      const value = Number(cell);
      if (!Number.isFinite(value)) {
        throw new Error(
          `Row "${row[0]}" contains a non-numeric value: "${cell}".`,
        );
      }
      // Abundances cannot be negative. Left alone, a negative slips through
      // composition and diversity producing plausible-looking nonsense, and
      // only surfaces much later as an error inside the CLR transform.
      if (value < 0) {
        throw new Error(
          `Row "${row[0]}" contains a negative value: "${cell}". Abundances cannot be negative — this may be a log-transformed or already-normalised table, which this tool cannot use.`,
        );
      }
      return value;
    });
    values.push(numbers);
  }

  // Duplicated feature labels double-count a taxon in every composition plot
  // and inflate richness, without anything looking wrong.
  const duplicateRows = duplicates(rowIds);
  if (duplicateRows.length > 0) {
    throw new Error(
      `The table has duplicate feature IDs: ${duplicateRows.slice(0, 5).join(', ')}${
        duplicateRows.length > 5 ? ', …' : ''
      }. Each feature must appear once.`,
    );
  }

  if (values.length === 0) {
    throw new Error('The file contains a header but no data rows.');
  }

  const orientation = resolveOrientation(
    rowIds,
    columnIds,
    options.knownSampleIds,
  );

  if (orientation.warning) warnings.push(orientation.warning);

  if (orientation.samplesAreRows) {
    return {
      table: {
        featureIds: columnIds,
        sampleIds: rowIds,
        values: transpose(values),
      },
      warnings,
      transposed: true,
    };
  }

  return {
    table: { featureIds: rowIds, sampleIds: columnIds, values },
    warnings,
    transposed: false,
  };
}

function resolveOrientation(
  rowIds: string[],
  columnIds: string[],
  knownSampleIds?: string[],
): { samplesAreRows: boolean; warning?: string } {
  if (!knownSampleIds || knownSampleIds.length === 0) {
    // No ground truth available. Assume the common convention and say so,
    // rather than inferring from shape and hoping.
    return {
      samplesAreRows: false,
      warning:
        'No metadata supplied, so features were assumed to be rows. If this file came from DADA2 (seqtab), samples are rows and the table needs transposing.',
    };
  }

  const known = new Set(knownSampleIds);
  const rowMatches = rowIds.filter((id) => known.has(id)).length;
  const columnMatches = columnIds.filter((id) => known.has(id)).length;

  if (rowMatches === 0 && columnMatches === 0) {
    throw new Error(
      'Neither the row labels nor the column labels match any sample ID in the metadata. ' +
        `Row labels look like: ${rowIds.slice(0, 3).join(', ')}. ` +
        `Column labels look like: ${columnIds.slice(0, 3).join(', ')}.`,
    );
  }

  if (rowMatches > columnMatches) {
    return {
      samplesAreRows: true,
      warning: `Samples were found in the row labels, so the table was transposed (${rowMatches} of ${rowIds.length} rows matched the metadata).`,
    };
  }

  if (columnMatches > rowMatches) {
    const unmatched = columnIds.length - columnMatches;
    return {
      samplesAreRows: false,
      warning:
        unmatched > 0
          ? `${unmatched} column${unmatched === 1 ? '' : 's'} did not match any sample in the metadata.`
          : undefined,
    };
  }

  throw new Error(
    'Row and column labels match the metadata equally well, so the orientation is ambiguous. Supply a table where only one axis carries sample IDs.',
  );
}

/**
 * Choose which of an ordered set of labels to show on a categorical axis.
 *
 * A band axis draws one tick per category, so a few hundred samples produce a
 * black smear of overlapping text. Hiding the axis entirely loses the ability
 * to identify a point; showing every label loses everything. Keeping an evenly
 * spaced subset keeps the axis readable and still orients the reader.
 *
 * @param labels     every category, in axis order
 * @param maxVisible how many labels there is room for
 * @returns the subset to render as ticks
 */
export function thinLabels(labels: string[], maxVisible: number): string[] {
  if (maxVisible < 1) return [];
  if (labels.length <= maxVisible) return labels;

  const step = Math.ceil(labels.length / maxVisible);
  const kept: string[] = [];
  for (let i = 0; i < labels.length; i += step) kept.push(labels[i]);
  return kept;
}

export function transpose(matrix: number[][]): number[][] {
  if (matrix.length === 0) return [];
  const rows = matrix.length;
  const cols = matrix[0].length;
  const out: number[][] = Array.from({ length: cols }, () =>
    new Array<number>(rows).fill(0),
  );
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) out[j][i] = matrix[i][j];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export type MetadataColumnType = 'categorical' | 'continuous';

export interface MetadataColumn {
  name: string;
  type: MetadataColumnType;
  /** Values in sample order; null where blank. */
  values: (string | number | null)[];
  /** Distinct non-null values, for categorical columns. */
  levels?: string[];
}

export interface Metadata {
  sampleIds: string[];
  columns: MetadataColumn[];
}

export interface MetadataParseOptions {
  delimiter?: string;
  /**
   * A numeric column with at most this many distinct values is treated as
   * categorical — encoded groups like 0/1 are labels, not measurements.
   */
  maxNumericLevelsForCategorical?: number;
  /** Name of the column holding sample IDs, when it is known. */
  sampleIdColumn?: string;
  /**
   * Sample IDs from the feature table. When given, the column matching them
   * best is used as the ID column.
   */
  knownSampleIds?: string[];
}

export interface MetadataParseResult extends Metadata {
  /** Which column was used as the sample ID. */
  sampleIdColumn: string;
  warnings: string[];
}

/**
 * Decide which column holds the sample IDs.
 *
 * The first column is the convention but not the rule: curated collections
 * routinely put a study or cohort identifier first, and taking that as the ID
 * gives every row the same value. Falling back to "the first column whose
 * values are all distinct" recovers the intended column without needing the
 * feature table, and matching against known sample IDs is used in preference
 * when they are available.
 */
function chooseSampleIdColumn(
  header: string[],
  rows: string[][],
  options: MetadataParseOptions,
): { index: number; warning?: string } {
  if (options.sampleIdColumn) {
    const index = header.indexOf(options.sampleIdColumn);
    if (index === -1) {
      throw new Error(
        `No metadata column named "${options.sampleIdColumn}". Columns: ${header.join(', ')}.`,
      );
    }
    return { index };
  }

  const known = options.knownSampleIds
    ? new Set(options.knownSampleIds)
    : null;

  if (known && known.size > 0) {
    let best = -1;
    let bestMatches = 0;
    for (let c = 0; c < header.length; c++) {
      const matches = rows.filter((row) => known.has((row[c] ?? '').trim()))
        .length;
      if (matches > bestMatches) {
        bestMatches = matches;
        best = c;
      }
    }
    if (best > 0) {
      return {
        index: best,
        warning: `Using “${header[best]}” as the sample ID column; it matches the feature table, while “${header[0]}” does not.`,
      };
    }
    if (best === 0) return { index: 0 };
  }

  const distinct = (c: number) => {
    const values = rows.map((row) => (row[c] ?? '').trim());
    return (
      !values.some((v) => v === '') && new Set(values).size === values.length
    );
  };

  // The convention holds: the first column identifies samples.
  if (distinct(0)) return { index: 0 };

  /*
   * The first column repeats values, so it cannot be the identifier. Switch
   * only to a column whose NAME says it holds one.
   *
   * The temptation is to take any column whose values happen to be distinct,
   * but that silently reinterprets an ordinary variable as the sample ID and
   * turns a genuine duplicate-ID problem into a wrong analysis. Requiring the
   * name to look like an identifier keeps the recovery narrow: it rescues
   * files whose first column is a study or cohort label — common in curated
   * collections — and refuses everything else.
   */
  const looksLikeId = /^(sample|subject|specimen|run|accession)|(^|[._-])(id|name)$/i;

  for (let c = 1; c < header.length; c++) {
    if (looksLikeId.test(header[c]) && distinct(c)) {
      return {
        index: c,
        warning: `Using “${header[c]}” as the sample ID column; “${header[0]}” repeats values and cannot identify samples.`,
      };
    }
  }

  // Nothing identifiable — fall through to the duplicate check, which reports
  // the repeated values and lists the columns available.
  return { index: 0 };
}

export function parseMetadata(
  text: string,
  options: MetadataParseOptions = {},
): MetadataParseResult {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const maxNumericLevels = options.maxNumericLevelsForCategorical ?? 2;

  const { header, rows, warnings } = splitHeaderAndRows(text, delimiter);

  if (header.length < 2) {
    throw new Error('Metadata needs a sample ID column and at least one variable.');
  }

  const chosen = chooseSampleIdColumn(header, rows, options);
  if (chosen.warning) warnings.push(chosen.warning);

  const idIndex = chosen.index;
  const sampleIds = rows.map((row) => (row[idIndex] ?? '').trim());

  const duplicateIds = duplicates(sampleIds);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Metadata column “${header[idIndex]}” contains duplicate sample IDs: ${duplicateIds.slice(0, 5).join(', ')}. ` +
        `Columns available: ${header.join(', ')}.`,
    );
  }

  const columns: MetadataColumn[] = [];

  for (let c = 0; c < header.length; c++) {
    if (c === idIndex) continue;
    const raw = rows.map((row) => (row[c] ?? '').trim());
    const nonEmpty = raw.filter((v) => v !== '' && v.toUpperCase() !== 'NA');

    const allNumeric =
      nonEmpty.length > 0 && nonEmpty.every((v) => Number.isFinite(Number(v)));
    const distinct = [...new Set(nonEmpty)];

    if (allNumeric && distinct.length > maxNumericLevels) {
      columns.push({
        name: header[c],
        type: 'continuous',
        values: raw.map((v) =>
          v === '' || v.toUpperCase() === 'NA' ? null : Number(v),
        ),
      });
    } else {
      columns.push({
        name: header[c],
        type: 'categorical',
        values: raw.map((v) =>
          v === '' || v.toUpperCase() === 'NA' ? null : v,
        ),
        levels: distinct.sort(),
      });
    }
  }

  return {
    sampleIds,
    columns,
    sampleIdColumn: header[idIndex],
    warnings,
  };
}

export interface JoinResult {
  table: FeatureTable;
  metadata: Metadata;
  warnings: string[];
}

/**
 * Restrict a table and metadata to the samples they share, preserving order.
 * Samples present in only one are reported rather than dropped silently.
 */
export function joinTableAndMetadata(
  table: FeatureTable,
  metadata: Metadata,
): JoinResult {
  const warnings: string[] = [];

  const metadataSet = new Set(metadata.sampleIds);
  const tableSet = new Set(table.sampleIds);

  const shared = table.sampleIds.filter((id) => metadataSet.has(id));

  if (shared.length === 0) {
    throw new Error(
      'No sample IDs are shared between the feature table and the metadata.',
    );
  }

  const onlyInTable = table.sampleIds.filter((id) => !metadataSet.has(id));
  const onlyInMetadata = metadata.sampleIds.filter((id) => !tableSet.has(id));

  if (onlyInTable.length > 0) {
    warnings.push(
      `${onlyInTable.length} sample${onlyInTable.length === 1 ? '' : 's'} in the feature table ${onlyInTable.length === 1 ? 'is' : 'are'} absent from the metadata and ${onlyInTable.length === 1 ? 'was' : 'were'} dropped: ${onlyInTable.slice(0, 5).join(', ')}${onlyInTable.length > 5 ? '…' : ''}`,
    );
  }
  if (onlyInMetadata.length > 0) {
    warnings.push(
      `${onlyInMetadata.length} sample${onlyInMetadata.length === 1 ? '' : 's'} in the metadata ${onlyInMetadata.length === 1 ? 'is' : 'are'} absent from the feature table: ${onlyInMetadata.slice(0, 5).join(', ')}${onlyInMetadata.length > 5 ? '…' : ''}`,
    );
  }

  const tableIndex = new Map(table.sampleIds.map((id, i) => [id, i]));
  const metadataIndex = new Map(metadata.sampleIds.map((id, i) => [id, i]));

  const values = table.values.map((row) =>
    shared.map((id) => row[tableIndex.get(id) as number]),
  );

  const columns = metadata.columns.map((column) => ({
    ...column,
    values: shared.map((id) => column.values[metadataIndex.get(id) as number]),
  }));

  return {
    table: { featureIds: table.featureIds, sampleIds: shared, values },
    metadata: { sampleIds: shared, columns },
    warnings,
  };
}
