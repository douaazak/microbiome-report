# Findings — Franzosa et al. 2019 (human gut, IBD)

**Result: the tool reproduces the published biology, and loading the files exposed three real defects — one of them a regression I had introduced two changes earlier.**

Franzosa EA, Sirota-Madi A, Avila-Pacheco J, et al. "Gut microbiome structure and metabolic activity in inflammatory bowel disease." *Nature Microbiology* 2019;4(2):293–305. [doi:10.1038/s41564-018-0306-4](https://doi.org/10.1038/s41564-018-0306-4)

Data via the [curated gut microbiome-metabolome collection](https://github.com/borenstein-lab/microbiome-metabolome-curated-data). 220 samples × 11,720 features, genus-level, relative abundances.

## The biology reproduces

| Check | Result |
|---|---|
| Lower alpha diversity in CD than Control | ✅ |
| PERMANOVA on `Study.Group` significant | ✅ |
| R² within the range clinical studies report | ✅ |
| *Faecalibacterium* depleted in CD vs Control | ✅ |
| *Escherichia* enriched in CD vs Control | ✅ |

That last pair is the canonical IBD signature, reproduced across many independent cohorts. Recovering it from raw published files, with no dataset-specific configuration, is the point of this test.

## Three defects the load exposed

### 1. The sample ID was not in the first column

The metadata's first column is `Dataset` — the study name, identical on every row. The sample ID is in column two, `Sample`. The parser assumed column one and rejected the file for having 220 duplicate sample IDs.

Fixed, but narrowly. The obvious repair — "use the first column whose values are all distinct" — is wrong: it silently reinterprets an ordinary variable as the sample ID and converts a genuine duplicate-ID problem into a wrong analysis. A regression test caught exactly that, picking `group` as the identifier in a file that really did have duplicate IDs.

The rule now: use column one if its values are distinct; otherwise switch only to a column whose **name** looks like an identifier (`Sample`, `Subject`, `SampleID`, `run`, `accession`…) and whose values are distinct; otherwise report the duplicates and list the available columns. That rescues the curated-collection layout and refuses everything else.

### 2. Delimiter detection was picking the wrong character — a regression

The feature names in this table are full lineages: `d__Bacteria;p__Firmicutes_A;c__Clostridia;…`. The header line therefore contains roughly 11,720 tabs and **70,000 semicolons**.

Semicolon support had been added a few changes earlier — a real need, since Excel writes semicolon-separated CSV across most of continental Europe — and it chose the delimiter by counting occurrences. On this file that picks `;`, shattering the header into fragments and producing thousands of duplicate column names.

Counting was the wrong idea. The detector now scores each candidate by **consistency**: a real delimiter yields the same field count on every line, while one appearing inside values does not. Tab wins here on that measure regardless of how many semicolons the names contain.

Worth noting how this surfaced. The semicolon feature was added to fix a genuine problem, was tested, and passed — and it broke a file shape that no test covered. Only real data found it.

### 3. Feature names carried the taxonomy, and it was being ignored

There is no taxonomy file: the lineage lives in the feature ID itself. Without recognising that, every composition bar was labelled with a hundred-character string and could not be collapsed by rank at all.

Lineage-shaped feature IDs are now detected — requiring both rank separators and rank prefixes, so an ID that merely contains a semicolon is not mistaken for one — and parsed directly, with a diagnostic saying so.

## Two mistakes of mine that the run corrected

**The README claimed these were "already genus names".** They are full GTDB-style lineages. I wrote that before looking at the file.

**Two of my own test assertions were wrong**, and both failed on first run:

- I asserted `sampleIds.length > featureIds.length / 10`, which is meaningless — a feature table normally has far more features than samples in either orientation. The transposition had worked correctly.
- I asserted `Sample` would appear in the excluded-columns list. It appears in neither list, because it was consumed as the sample ID rather than kept as a variable. That is correct behaviour; the assertion was not.

## Scope

Unlike the Linz dataset, there is **no table of published per-group statistics** here to check digit by digit. This establishes that the tool recovers a well-established biological signal from real clinical files without configuration — a qualitative check. Linz remains the one that proves the arithmetic.
