# Microbiome Report

Interactive microbiome analysis that runs entirely in a browser tab. Load a feature table and metadata, get composition, diversity and differential abundance — **your data is never uploaded.**

MicrobiomeAnalyst, Nephele, Namco and MiCloud are all servers you upload to. That is structural, not a feature gap, and it is why many hospital IRBs and consent terms rule them out. This tool has no server at all.

## Packages

| | |
|---|---|
| [`microbiome-core`](./microbiome-core) | Parsers and compositional statistics. Pure TypeScript, no DOM, **zero runtime dependencies**. |
| [`microbiome-app`](./microbiome-app) | React interface. Vite, Observable Plot, static build — also buildable as a single self-contained HTML file. |
| [`validation`](./validation) | Checks against published datasets, with findings recorded. |

The core is separate so the statistics can be tested and versioned independently of the interface — and so it is usable on its own.

## Quick start

Requires Node 22 or newer.

```bash
cd microbiome-core && npm install && npm test
cd ../microbiome-app && npm install && npm run dev
```

Open the URL Vite prints, then click **Load demo data**.

To produce a single HTML file that opens by double-clicking — no server, no install, nothing uploaded:

```bash
cd microbiome-app && npm run build:standalone
```

The result is `microbiome-app/dist/microbiome-report-standalone.html`.

## Status

- ✅ Parsers: QIIME2 export, DADA2 seqtab, generic TSV/CSV, MetaPhlAn v3/v4, Excel `.xlsx`
- ✅ Taxonomy in lineage-string or one-column-per-rank form, normalised with diagnostics
- ✅ Alpha diversity, beta diversity, PCoA, PERMANOVA
- ✅ Differential abundance (CLR + Wilcoxon/Kruskal-Wallis + BH)
- ✅ SVG and TSV export on every plot
- ✅ Validated against two published datasets — see [`validation/`](./validation)

## Input files

Only the feature table is required. Taxonomy and metadata each unlock more of the tool, and the interface says which analyses are unavailable without them rather than failing.

Every file may be **TSV, CSV or Excel `.xlsx`** — the delimiter is detected, and `.xlsx` is read in the browser with no conversion step.

### Feature table (required)

Features down the rows, samples across the columns. The first column holds the feature ID; the header row holds the sample IDs.

```
#OTU ID       S001    S002    S003
ASV_1         104     0       57
ASV_2         12      880     3
ASV_3         0       41      219
```

Counts or relative abundances both work, and which one you supplied is detected — abundance-only tables refuse count-only statistics such as Chao1 instead of returning a meaningless number. A transposed table (samples down the rows) is detected and handled. Leading comment lines, as QIIME 2 exports them, are skipped.

For **MetaPhlAn** output, switch Input type to MetaPhlAn and supply the profile directly: the `clade_name` lineages carry their own taxonomy, so no separate taxonomy file is needed.

### Taxonomy (optional)

Without it, features are labelled by ID and everything still runs — you just cannot group by rank. Two layouts are accepted, and which one you have is detected.

Lineage strings, as QIIME 2 and SILVA produce them:

```
Feature ID    Taxon                                          Confidence
ASV_1         d__Bacteria; p__Bacillota; ...; g__Blautia     0.99
```

Or one column per rank, as mothur, DADA2 `assignTaxonomy` and TaxAss produce them:

```
OTU      Kingdom     Phylum       Class          Order   Family   Genus
ASV_1    Bacteria    Bacillota    Clostridia     ...     ...      Blautia
```

Both `d__` and `k__` prefixes are accepted, confidence values in parentheses are stripped, and **a gap in a lineage is never filled by shifting a lower rank up** — a missing Class stays missing.

### Metadata (optional)

One row per sample. The sample-ID column is found by matching against the table's sample IDs, so it does not have to be first or carry a particular name.

```
sample-id    group     timepoint    depth_m
S001         disease   week0        2.5
S002         healthy   week0        11.0
```

Columns are typed as categorical or numeric automatically. Categorical columns become the grouping variables for every comparison; a column that is constant, or unique per sample, is excluded from the grouping menu with the reason given. Samples present in one file but not the other are reported, not silently dropped.

## What it looks like

Load a table — or click **Load demo data** to try it with nothing of your own.

![The loading screen: input type, three file pickers, and a demo data button](docs/screenshots/01-start.png)

Parsing reports what it found and what it had to do, before any analysis. **Overview** then summarises the dataset and states the significant findings, with the non-significant ones named too so absence of evidence is not hidden.

![Overview tab: parse diagnostics, dataset summary, group sizes and headline findings](docs/screenshots/02-overview.png)

**Composition** — stacked relative abundance per sample, grouped by any metadata column, with each group's span bracketed and labelled.

![Composition tab: stacked bar chart of the top genera, grouped by study group](docs/screenshots/03-composition.png)

**Alpha diversity** — within-sample diversity across several metrics, with the group comparison tested.

![Alpha diversity tab: box plots per group with the test result stated](docs/screenshots/04-alpha-diversity.png)

**Beta diversity** — PCoA on Bray–Curtis, Jaccard or Aitchison distance, with PERMANOVA.

![Beta diversity tab: PCoA ordination coloured by group with PERMANOVA result](docs/screenshots/05-beta-diversity.png)

**Differential** — CLR plus Wilcoxon or Kruskal–Wallis per taxon, Benjamini–Hochberg across taxa, as a volcano plot and a sortable table.

![Differential tab: filter controls, volcano plot and results table](docs/screenshots/06-differential.png)

Every figure exports as SVG, and the numbers behind it as TSV.

## Design principles

**Fail loudly, never silently.** Every parse produces diagnostics: mixed `d__`/`k__` prefixes, stripped SILVA whitespace, samples dropped in the metadata join, uneven sequencing depth. The complaints that motivated this tool were all about silent corruption.

**Refuse invalid analyses rather than obliging.** Chao1 is estimated from singletons and doubletons, so on relative abundances it is refused with that reason stated — not computed into a meaningless number.

**Never shift a taxonomic rank to fill a gap.** When a lineage skips Class, Class becomes null and Order stays at Order. Shifting is the bug behind "Phylum jumps to Order" reports, and it is invisible downstream.

## Licence

MIT
