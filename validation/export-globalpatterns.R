# Export the GlobalPatterns dataset to the flat files microbiome-report reads.
#
# GlobalPatterns is from Caporaso et al. 2011, PNAS 108:4516-4522 — 25
# environmental samples plus three mock communities, 9 sample types. It ships
# inside phyloseq, which matters more than it sounds: it means the table this
# script exports and the table phyloseq analyses are byte-for-byte the same
# object. Any difference between the two tools is therefore ours, not a
# preprocessing artefact.
#
# Usage:
#   Rscript export-globalpatterns.R
#
# Writes into ./globalpatterns/ :
#   feature-table.tsv   OTUs x samples counts
#   taxonomy.tsv        Feature ID / Taxon / Confidence (QIIME2 shape)
#   metadata.tsv        SampleID + sample variables

if (!requireNamespace("phyloseq", quietly = TRUE)) {
  stop("phyloseq is required. Install with:\n",
       '  if (!require("BiocManager")) install.packages("BiocManager")\n',
       '  BiocManager::install("phyloseq")')
}

library(phyloseq)

data(GlobalPatterns)
ps <- GlobalPatterns

dir.create("globalpatterns", showWarnings = FALSE)

# ---- Feature table -------------------------------------------------------
# phyloseq stores taxa as rows here, but that is not guaranteed in general,
# so transpose explicitly rather than trusting the orientation.
counts <- as(otu_table(ps), "matrix")
if (!taxa_are_rows(ps)) counts <- t(counts)

feature_table <- data.frame(
  `#OTU ID` = rownames(counts),
  counts,
  check.names = FALSE
)

# Written with the leading comment line a QIIME2 BIOM export carries, so the
# import path being validated is the one real users hit.
con <- file("globalpatterns/feature-table.tsv", "w")
writeLines("# Constructed from biom file", con)
write.table(feature_table, con, sep = "\t", quote = FALSE, row.names = FALSE)
close(con)

# ---- Taxonomy ------------------------------------------------------------
# phyloseq holds taxonomy as one column per rank. Collapse to the semicolon
# separated, prefixed lineage string that QIIME2 emits, so the exported file
# exercises the lineage normaliser rather than side-stepping it.
tax <- as(tax_table(ps), "matrix")

# GlobalPatterns ranks: Kingdom Phylum Class Order Family Genus Species
prefixes <- c(Kingdom = "d__", Phylum = "p__", Class = "c__", Order = "o__",
              Family = "f__", Genus = "g__", Species = "s__")

lineage <- apply(tax, 1, function(row) {
  parts <- character(0)
  for (rank in names(prefixes)) {
    if (!rank %in% colnames(tax)) next
    value <- row[[rank]]
    # Empty and NA assignments become a bare prefix, which is exactly what
    # SILVA and QIIME2 produce and what the parser must treat as unassigned.
    if (is.na(value) || value == "") {
      parts <- c(parts, prefixes[[rank]])
    } else {
      parts <- c(parts, paste0(prefixes[[rank]], value))
    }
  }
  paste(parts, collapse = ";")
})

taxonomy <- data.frame(
  `Feature ID` = rownames(tax),
  Taxon = lineage,
  Confidence = 1,
  check.names = FALSE
)
write.table(taxonomy, "globalpatterns/taxonomy.tsv",
            sep = "\t", quote = FALSE, row.names = FALSE)

# ---- Metadata ------------------------------------------------------------
meta <- as(sample_data(ps), "data.frame")
metadata <- data.frame(SampleID = rownames(meta), meta, check.names = FALSE)

# Sample IDs must survive the round trip untouched; the tool matches on them
# to decide table orientation.
write.table(metadata, "globalpatterns/metadata.tsv",
            sep = "\t", quote = FALSE, row.names = FALSE)

cat(sprintf(
  "Exported %d taxa x %d samples to ./globalpatterns/\n  sample types: %s\n",
  ntaxa(ps), nsamples(ps),
  paste(sort(unique(as.character(meta$SampleType))), collapse = ", ")
))
