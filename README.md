# Microbiome Report

Interactive microbiome analysis that runs entirely in a browser tab. Load a feature table and metadata, get composition, diversity and differential abundance — **your data is never uploaded.**

MicrobiomeAnalyst, Nephele, Namco and MiCloud are all servers you upload to. That is structural, not a feature gap, and it is why many hospital IRBs and consent terms rule them out. This tool has no server at all.

## Packages

| | |
|---|---|
| [`microbiome-core`](./microbiome-core) | Parsers and compositional statistics. Pure TypeScript, no DOM, **zero runtime dependencies**, 105 tests. |
| [`microbiome-app`](./microbiome-app) | React interface. Vite, Observable Plot, static build. |

The core is separate so the statistics can be tested and versioned independently of the interface — and so it is usable on its own.

## Quick start

```bash
cd microbiome-core && npm install && npm test
cd ../microbiome-app && npm install && npm run dev
```

Open the URL Vite prints, then click **Load demo data**.

## Status

- ✅ Parsers: QIIME2 export, DADA2 seqtab, generic TSV/CSV, MetaPhlAn v3/v4
- ✅ Taxonomy normalisation with diagnostics
- ✅ Alpha diversity, beta diversity, PCoA, PERMANOVA
- ✅ Differential abundance (CLR + Wilcoxon/Kruskal-Wallis + BH)
- ✅ SVG and TSV export on every plot
- ⬜ MaAsLin 3 via WebR, for covariates and repeated measures
- ⬜ Container with DADA2, for raw FASTQ processing

## Design principles

**Fail loudly, never silently.** Every parse produces diagnostics: mixed `d__`/`k__` prefixes, stripped SILVA whitespace, samples dropped in the metadata join, uneven sequencing depth. The complaints that motivated this tool were all about silent corruption.

**Refuse invalid analyses rather than obliging.** Chao1 is estimated from singletons and doubletons, so on relative abundances it is refused with that reason stated — not computed into a meaningless number.

**Never shift a taxonomic rank to fill a gap.** When a lineage skips Class, Class becomes null and Order stays at Order. Shifting is the bug behind "Phylum jumps to Order" reports, and it is invisible downstream.

## Licence

MIT
