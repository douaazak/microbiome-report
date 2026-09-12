/**
 * Convert the Linz et al. 2017 bog-lake dataset into the flat files
 * microbiome-report reads.
 *
 * Source: McMahonLab/North_Temperate_Lakes-Microbial_Observatory
 *   bogs_OTUtable_07Jan15.csv     6,208 OTUs x 1,387 samples, rarefied to 2,500
 *   bogs_reclassified_11Mar16.csv TaxAss freshwater classifications
 *
 * Paper: Linz AM, Crary BC, Shade A, Owens S, Gilbert JA, Knight R, McMahon KD.
 * Bacterial Community Composition and Dynamics Spanning Five Years in
 * Freshwater Bog Lakes. mSphere 2017;2(3):e00169-17.
 *
 * Two things about this source deserve comment.
 *
 * 1. The repo README calls it a "relative abundance table". It is not — every
 *    column sums to exactly 2,500, so it is rarefied COUNTS. That matters:
 *    richness metrics are valid here, and would not be on proportions.
 *
 * 2. The taxonomy uses the freshwater TaxAss scheme, whose lower ranks are
 *    Lineage / Clade / Tribe rather than Family / Genus / Species, and carries
 *    bootstrap confidence inline as "p__Verrucomicrobia(100)". Both are
 *    normalised below.
 *
 * Usage: node convert-linz2017.mjs [--subset-year 2007] [--out DIR]
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'linz2017');

const args = process.argv.slice(2);
const subsetYear = valueOf('--subset-year');
const outDir = valueOf('--out') ?? join(SRC, subsetYear ? `converted-${subsetYear}` : 'converted');

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Minimal CSV split — this source has no quoted fields or embedded commas. */
const split = (line) => line.split(',');

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

const LAKE_NAMES = {
  CB: 'Crystal Bog', FB: 'Forestry Bog', WS: 'West Sparkling Bog',
  NS: 'North Sparkling Bog', TB: 'Trout Bog', SS: 'South Sparkling Bog',
  HK: "Hell's Kitchen", MA: 'Mary Lake',
};

const LAYER_NAMES = { E: 'Epilimnion', H: 'Hypolimnion', U: 'Unstratified' };

/**
 * Decode a sample name such as "CBE18MAY05" or "TBE02Feb08 R2".
 *
 * Lake and layer are taken positionally (characters 1-2 and 3), exactly as the
 * paper's own script does with substr(). That is deliberate: six sample names
 * in this file deviate from the strict pattern — mixed-case months, one
 * missing a leading zero — and a strict regex would silently drop them,
 * changing the group sizes the published means were computed over.
 */
function decodeSample(raw) {
  const name = raw.trim();
  const lake = name.slice(0, 2).toUpperCase();
  const layer = name.slice(2, 3).toUpperCase();

  // Drop any disambiguation suffix added for a duplicated column before
  // reading the date out of the name.
  const rest = name.slice(3).replace(/\s+dup\d+$/, '');
  const m = /^(\d{1,2})([A-Za-z]{3})(\d{2})(?:\s+R(\d+))?$/.exec(rest);

  let date = '';
  let year = '';
  let month = '';
  let replicate = '';

  if (m) {
    const day = m[1].padStart(2, '0');
    month = MONTHS[m[2].toUpperCase()] ?? '';
    const yy = Number(m[3]);
    year = String(yy < 50 ? 2000 + yy : 1900 + yy);
    date = month ? `${year}-${month}-${day}` : '';
    replicate = m[4] ?? '';
  }

  return {
    id: name,
    lake,
    lakeName: LAKE_NAMES[lake] ?? lake,
    layer,
    layerName: LAYER_NAMES[layer] ?? layer,
    lakeLayer: `${lake}${layer}`,
    year,
    month,
    date,
    replicate,
  };
}

/**
 * Normalise a sample name for matching between the OTU table and the study's
 * metadata sheet.
 *
 * The two disagree on exactly one name: the OTU table has "NSH1JUL08" where
 * the metadata has the correctly zero-padded "NSH01JUL08". Padding the day
 * number reconciles them without hand-coding that one case, and without
 * loosening the match enough to pair up genuinely different samples.
 */
function normaliseName(name) {
  return name
    .trim()
    .replace(/\s+dup\d+$/, '')
    .replace(/^([A-Za-z]{3})(\d)(?!\d)/, (_, prefix, digit) => `${prefix}0${digit}`)
    .toUpperCase();
}

function readOfficialMetadata() {
  const path = join(SRC, 'metadata-official.tsv');
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const header = lines[0].split('\t').map((h) => h.trim());
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    rows.set(normaliseName(cells[0] ?? ''), cells);
  }
  return { header, rows };
}

/** Strip TaxAss bootstrap confidence: "p__Verrucomicrobia(100)" -> value. */
function cleanTaxon(cell) {
  if (!cell) return '';
  const value = cell.replace(/\(\d+\)\s*$/, '').trim();
  const stripped = value.replace(/^[a-z]__/i, '');
  if (!stripped || /^(unclassified|unknown|NA)$/i.test(stripped)) return '';
  return stripped;
}

async function readTaxonomy() {
  const map = new Map();
  const rl = createInterface({
    input: createReadStream(join(SRC, 'bogs_reclassified_11Mar16.csv')),
    crlfDelay: Infinity,
  });

  let header = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = split(line);
    if (!header) {
      header = cells.map((c) => c.trim());
      continue;
    }

    const [otu, kingdom, phylum, klass, order, lineageRank, clade, tribe] = cells;

    // TaxAss freshwater ranks map onto the standard seven as follows.
    // Lineage/Clade/Tribe are finer-grained freshwater designations that sit
    // where Family/Genus/Species sit in a conventional taxonomy.
    const ranks = [
      ['d', cleanTaxon(kingdom)],
      ['p', cleanTaxon(phylum)],
      ['c', cleanTaxon(klass)],
      ['o', cleanTaxon(order)],
      ['f', cleanTaxon(lineageRank)],
      ['g', cleanTaxon(clade)],
      ['s', cleanTaxon(tribe)],
    ];

    map.set(otu.trim(), ranks.map(([p, v]) => `${p}__${v}`).join(';'));
  }
  return map;
}

async function main() {
  const taxonomy = await readTaxonomy();
  console.log(`taxonomy: ${taxonomy.size} OTUs`);

  const rl = createInterface({
    input: createReadStream(join(SRC, 'bogs_OTUtable_07Jan15.csv')),
    crlfDelay: Infinity,
  });

  let samples = null;
  let keepIndices = null;
  const featureIds = [];
  const tableLines = [];
  const duplicated = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = split(line);

    if (samples === null) {
      // First column header is blank in this file.
      const all = cells.slice(1).map((c) => c.trim());

      /*
       * The source header contains one duplicated sample name
       * ("TBE05NOV07 R1", twice out of 1,387 columns). R's read.csv with the
       * default check.names=TRUE silently renames the second occurrence, so
       * the published analysis treated them as two distinct samples and the
       * reported group means include both.
       *
       * Both columns are therefore kept, with the repeat suffixed so the
       * collision is visible rather than silent. Dropping one would change
       * the group sizes and put every published mean out of reach.
       */
      const seen = new Map();
      for (let i = 0; i < all.length; i++) {
        const count = (seen.get(all[i]) ?? 0) + 1;
        seen.set(all[i], count);
        if (count > 1) {
          duplicated.push(all[i]);
          all[i] = `${all[i]} dup${count}`;
        }
      }

      const decoded = all.map(decodeSample);
      keepIndices = decoded
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => (subsetYear ? d.year === String(subsetYear) : true))
        .map(({ i }) => i);
      samples = keepIndices.map((i) => decoded[i]);
      tableLines.push(
        `#OTU ID\t${samples.map((s) => s.id).join('\t')}`,
      );
      continue;
    }

    const otu = cells[0].trim();
    featureIds.push(otu);
    const values = keepIndices.map((i) => cells[i + 1] ?? '0');
    tableLines.push(`${otu}\t${values.join('\t')}`);
  }

  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, 'feature-table.tsv'), `${tableLines.join('\n')}\n`);

  const taxLines = ['Feature ID\tTaxon\tConfidence'];
  let missing = 0;
  for (const id of featureIds) {
    const lineage = taxonomy.get(id);
    if (!lineage) missing++;
    taxLines.push(`${id}\t${lineage ?? ''}\t1`);
  }
  writeFileSync(join(outDir, 'taxonomy.tsv'), `${taxLines.join('\n')}\n`);

  /*
   * Metadata comes from the study's own NTL-MO_sample_metadata.xlsx when it
   * has been converted to TSV (see xlsx-to-tsv.mjs), and is reconstructed from
   * sample names only as a fallback.
   *
   * Using the authors' file is the right default even though the two agree:
   * lake and layer derived from sample names match the official values on all
   * 1,386 samples present in both. But agreement was luck as much as method —
   * the naming scheme happened to be regular — and a study that encoded
   * something else in its names would have produced silent nonsense.
   */
  const official = readOfficialMetadata();
  let metaLines;
  let matched = 0;

  if (official) {
    const columns = official.header.filter((h) => h !== official.header[0]);
    metaLines = [['SampleID', ...columns, 'Lake', 'Layer'].join('\t')];

    for (const s of samples) {
      const row = official.rows.get(normaliseName(s.id));
      if (row) matched++;
      metaLines.push(
        [
          s.id,
          ...columns.map((_, i) => row?.[i + 1] ?? ''),
          // Kept alongside so grouping works on short codes as well as the
          // study's long names.
          s.lake,
          s.layer,
        ].join('\t'),
      );
    }
    console.log(
      `metadata: official file matched ${matched}/${samples.length} samples`,
    );
  } else {
    metaLines = ['SampleID\tLake\tLakeName\tLayer\tLayerName\tLakeLayer\tYear\tDate'];
    for (const s of samples) {
      metaLines.push(
        [s.id, s.lake, s.lakeName, s.layer, s.layerName, s.lakeLayer, s.year, s.date].join('\t'),
      );
    }
    console.log('metadata: derived from sample names (official file not found)');
  }

  writeFileSync(join(outDir, 'metadata.tsv'), `${metaLines.join('\n')}\n`);

  const byLakeLayer = new Map();
  for (const s of samples) {
    byLakeLayer.set(s.lakeLayer, (byLakeLayer.get(s.lakeLayer) ?? 0) + 1);
  }

  console.log(`features: ${featureIds.length}`);
  console.log(`samples:  ${samples.length}${subsetYear ? ` (year ${subsetYear})` : ''}`);
  console.log(`taxonomy missing for ${missing} features`);
  if (duplicated.length > 0) {
    console.log(
      `duplicated sample names in source (kept, suffixed): ${duplicated.join(', ')}`,
    );
  }
  console.log(`lake-layers: ${[...byLakeLayer.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`written to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
