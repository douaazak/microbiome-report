# Validation against published data

The tool passes its own tests. That proves it is self-consistent, not that it is right. This directory checks it against published datasets — analysed by other people, with other software, years earlier — and records every discrepancy.

**None of the data is committed.** Each dataset belongs to its authors; the READMEs below say where to fetch it. The test suites that use it skip cleanly when it is absent.

## Datasets

| Dataset | Domain | What it establishes | Status |
|---|---|---|---|
| [Linz et al. 2017](./FINDINGS.md) — bog lakes | Freshwater, 1,387 samples, 6,208 OTUs | The arithmetic: 29 of 32 published richness values reproduced exactly; the 3 that differ are traced to the publication | ✅ Done |
| [Franzosa et al. 2019](./franzosa2019/README.md) — human gut IBD | Clinical, 220 samples, 3 groups | The biology: lower diversity in Crohn's, PERMANOVA separation, *Faecalibacterium* down and *Escherichia* up | ✅ Done |
| GlobalPatterns (Caporaso et al. 2011) | 9 environment types, ships inside phyloseq | Digit-by-digit comparison with phyloseq/vegan on Shannon, Bray–Curtis, PCoA and PERMANOVA | ⬜ Planned — see below |

Findings for Linz are in [`FINDINGS.md`](./FINDINGS.md); for Franzosa in [`franzosa2019/FINDINGS.md`](./franzosa2019/FINDINGS.md). Between them the two runs exposed real defects that no unit test had caught — a taxonomy parser that silently read the wrong column, a delimiter detector that broke on lineage-shaped names, a metadata parser that assumed the sample ID was in column one, an app that could not open Excel or load without metadata — all since fixed, which is the point of the exercise.

## Files here

| | |
|---|---|
| `convert-linz2017.mjs` | Converts the authors' CSVs into the TSVs the Linz test reads. Now optional for the OTU table, which loads raw; kept because the test fixtures reference its output. |
| `xlsx-to-tsv.mjs` | Dependency-free `.xlsx` reader, written before the app could open Excel. Superseded by `microbiome-core`'s `readXlsx`; kept for reference. |
| `export-globalpatterns.R`, `reference-values.R` | For the planned GlobalPatterns comparison. Not yet run. |

## How to record an outcome

Anything that does not match goes in the dataset's `FINDINGS.md` as one of:

1. **Bug** — the tool is wrong. Fix it, and add a regression test.
2. **Documented difference** — both are defensible (the Chao1 variants, permutation RNG). Write down which convention this tool follows and why.
3. **Not comparable** — different analysis (UniFrac, rarefaction). Say so and move on.

Resist the fourth option, which is to quietly adjust the tool until the numbers agree. If a difference cannot be explained, it is unresolved, and recording it as unresolved is more useful than making it disappear.

---

## Planned: GlobalPatterns

**GlobalPatterns** — Caporaso et al. 2011, *PNAS* 108:4516–4522. 25 environmental samples plus three mock communities, 9 sample types, 19,216 OTUs, sequenced to ~3.1 million reads per sample.

It is worth doing for one reason above all: **it ships inside phyloseq.** The table exported here and the table phyloseq analyses are the same object, so nothing can differ because of upstream processing choices. Any discrepancy is in one of the two implementations, which is the only kind worth chasing. It also has a published alpha-diversity figure — `plot_richness(GlobalPatterns, x = "SampleType", measures = c("Observed", "Chao1", "Shannon"))` on [the manual page](https://rdrr.io/bioc/phyloseq/man/data-GlobalPatterns.html) — to hold the tool's output against.

### Running it

```bash
cd validation
Rscript export-globalpatterns.R    # writes globalpatterns/*.tsv
Rscript reference-values.R          # writes globalpatterns/reference/*
```

Then load the three TSVs into the app and compare.

### What should match, and how closely

| Quantity | Expectation | Why |
|---|---|---|
| **Shannon**, **Simpson** | Identical to ~6 decimal places | Same formula, natural log, no ambiguity |
| **Observed features** | Exact integer match | Just a count of non-zeros |
| **Bray–Curtis distances** | Identical to ~6 decimals | Same formula |
| **PCoA axis 1–2 variance explained** | Within ~0.1% | Same double-centring and eigendecomposition |
| **PCoA coordinates** | Same *structure*, possibly flipped sign | Eigenvector sign is arbitrary — a mirrored plot is correct, not a bug |
| **PERMANOVA pseudo-F, R²** | Identical to ~4 decimals | Deterministic given the distance matrix |
| **PERMANOVA p** | Close, not identical | Permutation test; differs by the RNG, and is bounded below by 1/(perms+1) |

**Chao1 needs care.** Two forms are in circulation — classic `S_obs + F1² / (2·F2)` and bias-corrected `S_obs + F1(F1−1) / (2(F2+1))`. This tool implements the bias-corrected form, because the classic one is undefined with no doubletons. If Chao1 disagrees with `estimate_richness`, check which variant the other side used **before** concluding there is a bug.

**What will legitimately not match:** UniFrac (needs a tree this tool does not use — compare Bray–Curtis only); anything after rarefaction unless both sides rarefy; colours, fonts, point sizes.

### Qualitative checks — the published findings

From the abstract: the tool should recapture "the saline/nonsaline split in environmental samples" and "the split between host-associated and free-living communities". On the Beta diversity tab with Bray–Curtis, coloured by `SampleType`:

- [ ] Host-associated samples (Feces, Skin, Tongue) separate from free-living environmental ones
- [ ] Saline samples (Ocean, Sediment) sit apart from freshwater and soil
- [ ] Mock communities sit apart from everything
- [ ] PERMANOVA on `SampleType` is strongly significant with a large R²

On Alpha diversity, against the published `plot_richness` figure: soil among the highest, mock communities among the lowest, rank order of sample-type medians matching. On Overview: 19,216 features × 26 samples reported as counts, a depth-variation caution, and group sizes matching `table(sample_data(GlobalPatterns)$SampleType)`.
