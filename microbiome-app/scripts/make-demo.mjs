/**
 * Generates the demo dataset shipped with the app.
 *
 * Synthetic, but shaped like real 16S output: uneven sequencing depth, a
 * long tail of rare features, a handful of genuinely differential taxa, and
 * lineages that deliberately include the messy cases the parser exists to
 * handle — a skipped Class rank, mixed d__/k__ prefixes, and SILVA-style
 * trailing whitespace.
 *
 * Run: node scripts/make-demo.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');

/** Deterministic LCG, so the demo file is stable across regenerations. */
let seed = 20260901;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}

/** Box-Muller, for log-normal abundances. */
function gaussian() {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const GENERA = [
  ['Bacteroidota', 'Bacteroidia', 'Bacteroidales', 'Bacteroidaceae', 'Bacteroides'],
  ['Bacteroidota', 'Bacteroidia', 'Bacteroidales', 'Rikenellaceae', 'Alistipes'],
  ['Bacteroidota', 'Bacteroidia', 'Bacteroidales', 'Tannerellaceae', 'Parabacteroides'],
  ['Bacillota', 'Clostridia', 'Lachnospirales', 'Lachnospiraceae', 'Blautia'],
  ['Bacillota', 'Clostridia', 'Lachnospirales', 'Lachnospiraceae', 'Roseburia'],
  ['Bacillota', 'Clostridia', 'Oscillospirales', 'Ruminococcaceae', 'Faecalibacterium'],
  ['Bacillota', 'Clostridia', 'Oscillospirales', 'Ruminococcaceae', 'Ruminococcus'],
  ['Bacillota', 'Clostridia', 'Peptostreptococcales', 'Peptostreptococcaceae', 'Romboutsia'],
  ['Bacillota', 'Bacilli', 'Lactobacillales', 'Streptococcaceae', 'Streptococcus'],
  ['Bacillota', 'Bacilli', 'Erysipelotrichales', 'Erysipelotrichaceae', 'Holdemanella'],
  ['Actinomycetota', 'Actinomycetes', 'Bifidobacteriales', 'Bifidobacteriaceae', 'Bifidobacterium'],
  ['Actinomycetota', 'Coriobacteriia', 'Coriobacteriales', 'Eggerthellaceae', 'Eggerthella'],
  ['Pseudomonadota', 'Gammaproteobacteria', 'Enterobacterales', 'Enterobacteriaceae', 'Escherichia-Shigella'],
  ['Pseudomonadota', 'Gammaproteobacteria', 'Burkholderiales', 'Sutterellaceae', 'Sutterella'],
  ['Verrucomicrobiota', 'Verrucomicrobiae', 'Verrucomicrobiales', 'Akkermansiaceae', 'Akkermansia'],
  ['Desulfobacterota', 'Desulfovibrionia', 'Desulfovibrionales', 'Desulfovibrionaceae', 'Bilophila'],
];

const N_PER_GROUP = 20;
const ASVS_PER_GENUS = 4;

const samples = [];
for (let i = 0; i < N_PER_GROUP; i++) samples.push({ id: `H${String(i + 1).padStart(2, '0')}`, group: 'healthy' });
for (let i = 0; i < N_PER_GROUP; i++) samples.push({ id: `D${String(i + 1).padStart(2, '0')}`, group: 'disease' });

// Genera the "disease" group is shifted in. Everything else is background.
const ENRICHED = new Set(['Escherichia-Shigella', 'Streptococcus', 'Eggerthella']);
const DEPLETED = new Set(['Faecalibacterium', 'Roseburia', 'Akkermansia']);

const features = [];
for (const [genusIndex, lineage] of GENERA.entries()) {
  for (let k = 0; k < ASVS_PER_GENUS; k++) {
    features.push({
      id: `ASV_${String(features.length + 1).padStart(3, '0')}`,
      lineage,
      genus: lineage[4],
      // Baseline abundance on a log scale, varying by ASV.
      baseline: 2 + gaussian() * 1.2 - genusIndex * 0.05,
    });
  }
}

const counts = features.map((feature) =>
  samples.map((sample) => {
    let mean = feature.baseline;
    if (sample.group === 'disease') {
      if (ENRICHED.has(feature.genus)) mean += 2.2;
      else if (DEPLETED.has(feature.genus)) mean -= 2.2;
    }
    // Log-normal abundance, then a depth multiplier per sample.
    //
    // The 0.55 SD on the log scale is deliberate. At 0.9 the between-sample
    // noise swamped a genuine 9-fold group difference: raw counts differed
    // clearly (3k vs 29k reads) yet the Wilcoxon p landed at 0.053 and nothing
    // survived FDR. That is a realistic outcome for an underpowered study, but
    // it makes a poor demo of a working tool. 0.55 is still well within the
    // dispersion real 16S data shows.
    const value = Math.exp(mean + gaussian() * 0.55);
    // Roughly 22% of features are absent from any given sample.
    return random() < 0.22 ? 0 : Math.round(value * 40);
  }),
);

// Uneven sequencing depth, which is what real runs look like.
const depthFactor = samples.map(() => 0.4 + random() * 1.8);
for (const row of counts) {
  for (let j = 0; j < row.length; j++) {
    row[j] = Math.round(row[j] * depthFactor[j]);
  }
}

mkdirSync(OUT, { recursive: true });

// Feature table, in QIIME2 export shape (commented header, preceded by a
// provenance comment) so the demo exercises that parsing path.
const tableLines = [
  '# Constructed from biom file',
  `#OTU ID\t${samples.map((s) => s.id).join('\t')}`,
  ...features.map((feature, i) => `${feature.id}\t${counts[i].join('\t')}`),
];
writeFileSync(join(OUT, 'feature-table.tsv'), `${tableLines.join('\n')}\n`);

// Taxonomy, with the awkward cases deliberately included.
const taxonomyLines = ['Feature ID\tTaxon\tConfidence'];
for (const [i, feature] of features.entries()) {
  const [phylum, klass, order, family, genus] = feature.lineage;

  // Every 11th feature uses k__ instead of d__.
  const domainPrefix = i % 11 === 0 ? 'k__' : 'd__';
  // Every 7th feature is missing its Class assignment — the gap that must be
  // padded rather than filled by shifting Order upward.
  const classToken = i % 7 === 3 ? 'c__' : `c__${klass}`;
  // Every 5th feature carries SILVA-style trailing spaces.
  const pad = i % 5 === 0 ? ' ' : '';

  const lineage = [
    `${domainPrefix}Bacteria${pad}`,
    `p__${phylum}${pad}`,
    classToken,
    `o__${order}`,
    `f__${family}`,
    `g__${genus}`,
  ].join(';');

  taxonomyLines.push(`${feature.id}\t${lineage}\t${(0.9 + random() * 0.099).toFixed(3)}`);
}
writeFileSync(join(OUT, 'taxonomy.tsv'), `${taxonomyLines.join('\n')}\n`);

// Metadata, with one continuous variable, one two-level numeric column that
// should be read as categorical, and a missing value.
const metadataLines = ['SampleID\tgroup\tage\tsex\tbatch'];
for (const [i, sample] of samples.entries()) {
  const age = 24 + Math.round(random() * 45);
  const sex = random() < 0.5 ? 'F' : 'M';
  const batch = i % 3 === 0 ? '1' : '2';
  metadataLines.push(
    `${sample.id}\t${sample.group}\t${i === 5 ? 'NA' : age}\t${sex}\t${batch}`,
  );
}
writeFileSync(join(OUT, 'metadata.tsv'), `${metadataLines.join('\n')}\n`);

const totalReads = counts.reduce(
  (sum, row) => sum + row.reduce((a, b) => a + b, 0),
  0,
);
console.log(
  `Wrote ${features.length} features x ${samples.length} samples (${totalReads.toLocaleString()} reads) to public/demo/`,
);
