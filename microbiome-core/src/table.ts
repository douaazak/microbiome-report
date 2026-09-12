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

function detectDelimiter(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return tabs >= commas ? '\t' : ',';
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

  const header = headerLine.split(delimiter).map((h) => h.trim());
  const rows = lines
    .slice(headerIndex)
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.split(delimiter).map((c) => c.trim()));

  return { header, rows, warnings };
}

/** Parse a feature table from delimited text. */
export function parseFeatureTable(
  text: string,
  options: TableParseOptions = {},
): TableParseResult {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const delimiter = options.delimiter ?? detectDelimiter(firstLine);

  const { header, rows, warnings } = splitHeaderAndRows(text, delimiter);

  if (header.length < 2) {
    throw new Error(
      'The header has fewer than two columns; the file may use a different delimiter.',
    );
  }

  const columnIds = header.slice(1);
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
      return value;
    });
    values.push(numbers);
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
}

export function parseMetadata(
  text: string,
  options: MetadataParseOptions = {},
): Metadata {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const delimiter = options.delimiter ?? detectDelimiter(firstLine);
  const maxNumericLevels = options.maxNumericLevelsForCategorical ?? 2;

  const { header, rows } = splitHeaderAndRows(text, delimiter);

  if (header.length < 2) {
    throw new Error('Metadata needs a sample ID column and at least one variable.');
  }

  const sampleIds = rows.map((row) => row[0]);

  const duplicates = sampleIds.filter(
    (id, i) => sampleIds.indexOf(id) !== i,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Metadata contains duplicate sample IDs: ${[...new Set(duplicates)].join(', ')}.`,
    );
  }

  const columns: MetadataColumn[] = [];

  for (let c = 1; c < header.length; c++) {
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

  return { sampleIds, columns };
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
