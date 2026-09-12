# Second validation dataset — Franzosa et al. 2019 (human gut, IBD)

**Franzosa EA, Sirota-Madi A, Avila-Pacheco J, et al.** "Gut microbiome structure and metabolic activity in inflammatory bowel disease." *Nature Microbiology* 2019;4(2):293–305. [doi:10.1038/s41564-018-0306-4](https://doi.org/10.1038/s41564-018-0306-4)

Obtained via the [curated gut microbiome-metabolome collection](https://github.com/borenstein-lab/microbiome-metabolome-curated-data) (Muller, Algavi & Borenstein, *npj Biofilms and Microbiomes* 2022), which reprocessed the published data into plain TSV.

## Why this one

The bog-lake dataset validated the arithmetic against published numbers. This one is chosen for the opposite reason: it is **human, clinical, and shaped differently**, so it exercises paths the first dataset never touched.

| | Linz 2017 (lakes) | Franzosa 2019 (gut) |
|---|---|---|
| Domain | Freshwater environmental | Human faecal, clinical |
| Features | 6,208 OTUs, TaxAss freshwater taxonomy | Genus-level, standard names |
| Genus assignment | 14% | Near-complete |
| Groups | 8 lakes × 3 layers | **CD / UC / Control** |
| Cohorts | One | **Two** (PRISM discovery + independent validation) |
| Covariates | None | Age, calprotectin, antibiotics, steroids, immunosuppressants, mesalamine |

Three specific things it tests that the lake data could not:

1. **A three-group clinical comparison**, which is exactly the case where the differential tab now defaults to a pairwise CD-vs-Control rather than an uninterpretable all-groups test.
2. **Recognisable taxon names.** With genus assignment near-complete, the composition plot should read `Faecalibacterium`, `Bacteroides`, `Escherichia` — not `Unclassified …`. If it does not, that is a bug rather than a property of the data.
3. **A metadata sheet with the mix real studies have**: constant columns (`Dataset`, `DOI`, `Publication.Name`, `Age.Units`), per-sample identifiers (`Sample`, `Subject`), a continuous covariate (`Age`, `Fecal.Calprotectin`), and several binary medication flags. The grouping selector should offer only the medication flags and `Study.Group`, and say why it dropped the rest.

## Getting the data

Download into this directory (none of the data is committed — it is other people's published work, and the tests skip cleanly when it is absent):

| File | |
|---|---|
| [`metadata.tsv`](https://raw.githubusercontent.com/borenstein-lab/microbiome-metabolome-curated-data/main/data/processed_data/FRANZOSA_IBD_2019/metadata.tsv) | per-sample metadata |
| [`genera.tsv`](https://raw.githubusercontent.com/borenstein-lab/microbiome-metabolome-curated-data/main/data/processed_data/FRANZOSA_IBD_2019/genera.tsv) | genus-level abundances |
| [`species.tsv`](https://raw.githubusercontent.com/borenstein-lab/microbiome-metabolome-curated-data/main/data/processed_data/FRANZOSA_IBD_2019/species.tsv) | optional — shotgun species level |

No conversion step. Load `genera.tsv` as the feature table and `metadata.tsv` as the metadata, with no taxonomy file — the feature names are already genus names.

**Expect the tool to transpose it.** This collection stores samples as *rows*, the opposite of the QIIME2 convention. Orientation is resolved by matching against the metadata's sample IDs, and the diagnostics should say `Samples were found in the row labels, so the table was transposed`. If that message is missing, check the result carefully before trusting it.

## What to check

The paper's central claim is that IBD gut microbiomes differ structurally from controls, most strongly in Crohn's disease. Concretely, on the **Beta diversity** tab with `Study.Group`:

- [ ] CD separates from Control; UC sits between them
- [ ] PERMANOVA on `Study.Group` is significant
- [ ] R² is modest — microbiome studies typically report 0.05–0.15, since most variation is between individuals

On **Alpha diversity**:

- [ ] Diversity is lower in CD than Control — the most reproduced finding in the IBD microbiome literature

On **Differential**, comparing **CD vs Control** (the pairwise default):

- [ ] *Faecalibacterium* depleted in CD
- [ ] *Roseburia* depleted in CD
- [ ] *Escherichia* enriched in CD

Those three are the canonical IBD signature and appear across many independent cohorts, so they are a fair qualitative target even though the exact effect sizes here are specific to this study.

On **Overview**:

- [ ] Group sizes roughly CD ≈ 88, UC ≈ 76, Control ≈ 56
- [ ] `Dataset`, `DOI`, `Publication.Name`, `Age.Units` reported as excluded — the same value for every sample
- [ ] `Sample` and `Subject` reported as excluded — a different value for every sample

## Recording the outcome

Same discipline as `../FINDINGS.md`: anything that does not match is a **bug**, a **documented difference**, or **not comparable** — and if it cannot be explained, it is recorded as unexplained rather than quietly adjusted away.

The honest limit of this test: unlike the lake dataset, there is no table of published per-group summary statistics to check against digit by digit. This is a qualitative check that the tool reproduces a well-established biological signal from real clinical data, not a numerical reproduction.
