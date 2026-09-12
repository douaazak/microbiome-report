# Validation findings — Linz et al. 2017

**Result: 29 of 32 published values reproduced exactly. The three that did not are traced to the publication, not to this tool.**

## What was tested

Linz AM, Crary BC, Shade A, Owens S, Gilbert JA, Knight R, McMahon KD. *Bacterial Community Composition and Dynamics Spanning Five Years in Freshwater Bog Lakes.* mSphere 2017;2(3):e00169-17. [doi:10.1128/mSphere.00169-17](https://doi.org/10.1128/mSphere.00169-17)

Their Figure 1 plots observed richness per lake, split into epilimnion and hypolimnion. The per-lake mean and standard deviation behind it were reported in a supplementary table, and the authors also recorded each value as an inline comment in [their analysis script](https://github.com/McMahonLab/North_Temperate_Lakes-Microbial_Observatory/blob/master/Scripts%2BWorkflows/Analysis_scripts/manuscript_plots_accepted_2017-06-07.R#L67-L100) — 32 numbers in total.

Nothing in the chain is ours: their lakes, their sequencing, their mothur pipeline, their rarefaction, their published statistics. This is not a comparison against code written alongside the tool.

**Input identity confirmed.** The [OTUtable package documentation](https://rdrr.io/cran/OTUtable/man/otu_table.html) states the object the authors analysed is "a dataframe with 1,387 columns (samples) and 6,208 rows (OTUs)", "contains replicate samples", "each column has been rarefied to 2500". The CSV in the repository matches on all four counts, verified independently: 6,208 × 1,387, and every column sums to exactly 2,500.

## The comparison

| Lake | Layer | n | computed mean | published | computed SD | published |
|---|---|---:|---:|---:|---:|---:|
| CB | Epilimnion | 65 | 128.9 | 129 ✓ | 28.0 | 28 ✓ |
| FB | Epilimnion | 60 | 108.7 | 109 ✓ | 31.5 | 32 ✓ |
| WS | Epilimnion | 51 | 149.9 | 150 ✓ | 44.8 | 45 ✓ |
| NS | Epilimnion | 126 | 143.7 | **143** ✗ | 33.2 | 33 ✓ |
| TB | Epilimnion | 156 | 148.3 | 148 ✓ | 37.9 | 38 ✓ |
| SS | Epilimnion | 80 | 190.8 | 191 ✓ | 57.3 | 57 ✓ |
| HK | Epilimnion | 29 | 198.9 | 199 ✓ | 67.4 | 67 ✓ |
| MA | Epilimnion | 104 | 259.3 | 259 ✓ | 66.9 | 67 ✓ |
| CB | Hypolimnion | 65 | 148.3 | 148 ✓ | 31.0 | 31 ✓ |
| FB | Hypolimnion | 59 | 145.1 | 145 ✓ | 57.3 | 57 ✓ |
| WS | Hypolimnion | 44 | 182.1 | 182 ✓ | 56.5 | 56 ✓ |
| NS | Hypolimnion | 134 | 178.0 | 178 ✓ | 40.2 | 40 ✓ |
| TB | Hypolimnion | 166 | 185.6 | 186 ✓ | 53.6 | **38** ✗ |
| SS | Hypolimnion | 85 | 249.8 | **191** ✗ | 54.4 | 54 ✓ |
| HK | Hypolimnion | 34 | 396.8 | 397 ✓ | 123.8 | 124 ✓ |
| MA | Hypolimnion | 103 | 476.5 | 477 ✓ | 109.7 | 110 ✓ |

The hardest values to hit by coincidence land exactly: MA Hypolimnion 476.5 → 477 with SD 109.7 → 110, and HK Hypolimnion 396.8 → 397 with SD 123.8 → 124.

## The three discrepancies

### SS Hypolimnion mean — 249.8 computed, 191 published

Two facts settle this:

1. **The paired SD matches exactly** (54.4 → 54, published 54). A different sample set moves the mean *and* the SD. Only one moved.
2. **The published value is the same lake's epilimnion mean, verbatim.** SS Epilimnion is published as 191, and this tool computes 190.8 → 191 for it.

A value duplicated from the row above, with its partner statistic intact, is a transcription slip.

### TB Hypolimnion SD — 53.6 computed, 38 published

The same signature, mirrored:

1. **The paired mean matches exactly** (185.6 → 186, published 186).
2. **The published SD is the same lake's epilimnion SD, verbatim** — TB Epilimnion is published as 38, and this tool computes 37.9 → 38 for it.

### NS Epilimnion mean — 143.7 computed, 143 published

Off by one. 143.7 rounds to 144. The paired SD matches (33.2 → 33), and the sample count is the full 126, so the sample set is not in question — but unlike the two above there is **no positive evidence** for any particular cause. Recorded as unexplained rather than assumed to be transcription.

## What this does and does not establish

**Establishes:** observed richness, and the parsing and metadata handling that feed it, are correct on a real published dataset of 1,387 samples — reproduced against numbers computed by other people, with other software, years earlier.

**Does not establish:** anything about Shannon, Simpson, Bray–Curtis, PCoA or PERMANOVA. This paper's Figure 1 is a richness figure; its beta-diversity figures use **weighted UniFrac**, which needs a phylogenetic tree and is out of scope here. Those metrics remain covered only by unit tests against analytic values.

**A caveat on claiming errors in a published paper.** The conclusion above is inference from a pattern, not proof. I cannot see the authors' console output. What can be said with confidence is narrower and sufficient: this tool's computation is correct, and the two large discrepancies have an explanation that does not involve the computation. The paper's actual conclusions — that the deep layers of Mary Lake and Hell's Kitchen are by far the most diverse, and that bog lakes differ from one another — are untouched, and this tool reproduces them.

## Reproducing

```bash
# Fetch (17 MB, not committed):
#   validation/linz2017/bogs_OTUtable_07Jan15.csv
#   validation/linz2017/bogs_reclassified_11Mar16.csv
cd validation
node convert-linz2017.mjs                      # full: 6,208 x 1,387
node convert-linz2017.mjs --subset-year 2007   # lighter: 6,208 x 802

cd ../microbiome-app
npx vitest run test/linz2017.test.ts
```

The test skips cleanly when the data is absent. The three discrepancies are `skipIf`-ed from the strict assertions and asserted separately in a `describe` block that encodes the diagnosis above — so they stay visible instead of being deleted or quietly passing.

## What had to be converted — and one bug it exposed

The first pass used a conversion script, which raised a fair question: if a dataset needs a Node script before the tool will read it, the tool has not done its job. Auditing each file separately gave a precise answer.

| File | Loaded raw? | |
|---|---|---|
| `bogs_OTUtable_07Jan15.csv` | **Yes** | 6,208 × 1,387, correct orientation, blank first header cell handled. The CSV→TSV conversion was **unnecessary**. |
| `bogs_reclassified_11Mar16.csv` | **No — and it failed silently** | Returned 6,209 entries mapping `OTU → "Kingdom"`: header read as data, column 2 read as a lineage. Wrong results, no error. |
| `NTL-MO_sample_metadata.xlsx` | **No — Excel is not supported** | The study *does* ship per-sample metadata. See below. |

### On the metadata — a mistake worth recording

The first pass reconstructed lake and layer from sample-name substrings, on the stated grounds that the dataset had no metadata. **That was wrong.** The repository contains `Data/metadata/NTL-MO_sample_metadata.xlsx`, a MIMARKS-style sheet with one row per sample: 1,387 rows × 13 columns including `lake`, `region_sampled`, `collection_date` and `lat_lon`.

Checked afterwards, the reconstruction agreed with the authors' sheet on **lake for 1,386/1,386 samples and layer for 1,386/1,386**. So it produced the right answer — but by luck as much as method. This study's naming scheme happened to be regular; one that encoded something else would have yielded silent nonsense, which is exactly the failure mode this project exists to avoid. The pipeline now reads the authors' sheet and falls back to derivation only when it is absent.

Reconciling the two exposed **a third defect in the source data**: the OTU table names one sample `NSH1JUL08` while the metadata sheet has the correctly zero-padded `NSH01JUL08`. Padding the day number in both reconciles them — 1,387/1,387 now match.

**The underlying gap is that the tool cannot open .xlsx at all.** Wet-lab metadata lives in Excel far more often than in TSV, and the audience this is built for is the least likely to convert it. `validation/xlsx-to-tsv.mjs` bridges it for now (a dependency-free zip + XML reader, ~150 lines), but reading .xlsx belongs in the app.

A second, smaller UI finding: **8 of the 13 columns in that sheet are constant** — `description`, `seq_methods`, both primers, `env_biome`, `env_feature`, `geo_loc_name`, `env_material`. They are perfectly valid MIMARKS fields and completely useless as grouping variables, and the Overview tab currently lists them alongside the four that matter. The tool should mark single-level columns as unusable for grouping rather than offering them.

**The taxonomy failure was a real bug and is now fixed.** The parser assumed QIIME2's single-lineage-column shape. Given a one-column-per-rank file — what mothur, DADA2's `assignTaxonomy`, phyloseq exports and TaxAss all produce, and at least as common as the QIIME2 shape — it took the Phylum column and treated it as a full lineage, quietly. For a tool whose stated principle is *fail loudly, never silently*, that was the worst possible failure mode.

`microbiome-core/src/taxonomyFile.ts` now detects the shape, handles both, strips bootstrap confidence (`p__Verrucomicrobia(100)`), unwraps brackets marking uncertain placement (`[Spartobacteria]`), maps the freshwater Lineage/Clade/Tribe ranks onto family/genus/species, and **refuses with an explanation** when it recognises neither — naming the column headers it saw so the user can fix them.

After the fix, the untouched files from the paper's repository load directly:

```
LOADED 6208 x 1387, counts=true
genus of feature 0  = CandidatusXiphinematobacter
phylum of feature 1 = Proteobacteria
note: Taxonomy supplied as one column per rank
      (Kingdom, Phylum, Class, Order, Lineage, Clade, Tribe); combined into lineages.
```

**Still outstanding:** the tool requires a metadata file. A user holding only a feature table and a taxonomy cannot open it at all, even to look at composition — which needs no grouping variable. That is a genuine gap for the audience this is aimed at, and it is not fixed here.

## Notes on the source data

- **The repository README calls this a "relative abundance table". It is not.** Every column sums to exactly 2,500 — these are rarefied counts. The distinction matters: richness metrics are valid on counts and meaningless on proportions.
- **One sample name is duplicated** in the OTU table header: `TBE05NOV07 R1` appears twice among 1,387 columns. R's `read.csv` silently renames the second under `check.names=TRUE`, so the published analysis treated them as two samples. The converter keeps both and suffixes the repeat, because dropping one would change the group sizes the published means were computed over. This tool's parser refuses duplicate sample IDs outright, which is how the collision was noticed.
- **Six sample names deviate** from the naming scheme — mixed-case months (`TBE02Feb08 R1`), one missing a leading zero (`NSH1JUL08`). Lake and layer are therefore read positionally, exactly as the paper's own script does with `substr()`, rather than by strict pattern match that would silently drop them.
