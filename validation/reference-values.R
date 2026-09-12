# Reference values and figures from phyloseq / vegan, for comparison against
# microbiome-report.
#
# The point is a controlled comparison: identical input table, two
# implementations. Any difference is either a bug here or a documented
# methodological difference — and this script prints enough detail to tell
# those apart.
#
# Usage:
#   Rscript reference-values.R
#
# Writes into ./globalpatterns/reference/ :
#   alpha.tsv              per-sample Observed, Chao1, Shannon, Simpson
#   braycurtis.tsv         full Bray-Curtis distance matrix
#   pcoa-eigenvalues.tsv   eigenvalues and variance explained
#   permanova.txt          adonis2 output for SampleType
#   summary.txt            the handful of numbers to eyeball first
#   fig-richness.png       the published plot_richness figure
#   fig-ordination.png     PCoA on Bray-Curtis, coloured by SampleType

for (pkg in c("phyloseq", "vegan")) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    stop(pkg, " is required.")
  }
}

library(phyloseq)
library(vegan)

data(GlobalPatterns)
ps <- GlobalPatterns

out <- "globalpatterns/reference"
dir.create(out, recursive = TRUE, showWarnings = FALSE)

counts <- as(otu_table(ps), "matrix")
if (!taxa_are_rows(ps)) counts <- t(counts)
# vegan wants samples as rows.
mat <- t(counts)
meta <- as(sample_data(ps), "data.frame")

# ---- Alpha diversity -----------------------------------------------------
# estimate_richness is what plot_richness draws, so these are the numbers
# behind the published figure.
alpha <- estimate_richness(ps, measures = c("Observed", "Chao1", "Shannon", "Simpson"))
alpha <- data.frame(SampleID = rownames(alpha), alpha,
                    SampleType = meta[rownames(alpha), "SampleType"],
                    check.names = FALSE)
write.table(alpha, file.path(out, "alpha.tsv"),
            sep = "\t", quote = FALSE, row.names = FALSE)

# ---- Beta diversity ------------------------------------------------------
# Bray-Curtis only. microbiome-report has no phylogenetic tree and therefore
# no UniFrac, so comparing UniFrac ordinations would compare nothing.
bray <- vegdist(mat, method = "bray")
bray_matrix <- as.matrix(bray)
write.table(
  data.frame(SampleID = rownames(bray_matrix), bray_matrix, check.names = FALSE),
  file.path(out, "braycurtis.tsv"), sep = "\t", quote = FALSE, row.names = FALSE
)

# ---- PCoA ----------------------------------------------------------------
pcoa <- cmdscale(bray, k = 5, eig = TRUE)
positive <- pcoa$eig[pcoa$eig > 0]
eigen_table <- data.frame(
  axis = seq_along(pcoa$eig),
  eigenvalue = pcoa$eig,
  # Denominator is the positive eigenvalues only. Bray-Curtis is not
  # Euclidean, so negative eigenvalues are expected and including them would
  # understate every axis.
  variance_explained = pcoa$eig / sum(positive)
)
write.table(eigen_table, file.path(out, "pcoa-eigenvalues.tsv"),
            sep = "\t", quote = FALSE, row.names = FALSE)

# ---- PERMANOVA -----------------------------------------------------------
set.seed(42)
permanova <- adonis2(bray ~ SampleType, data = meta, permutations = 999)
capture.output(permanova, file = file.path(out, "permanova.txt"))

# ---- Figures -------------------------------------------------------------
png(file.path(out, "fig-richness.png"), width = 1400, height = 700, res = 130)
print(plot_richness(ps, x = "SampleType",
                    measures = c("Observed", "Chao1", "Shannon")))
dev.off()

ord <- ordinate(ps, method = "PCoA", distance = "bray")
png(file.path(out, "fig-ordination.png"), width = 1100, height = 850, res = 130)
print(plot_ordination(ps, ord, color = "SampleType") +
        ggplot2::geom_point(size = 4) +
        ggplot2::ggtitle("PCoA on Bray-Curtis"))
dev.off()

# ---- Summary -------------------------------------------------------------
lines <- c(
  "GlobalPatterns reference values (phyloseq + vegan)",
  "==================================================",
  sprintf("Taxa: %d   Samples: %d", ntaxa(ps), nsamples(ps)),
  sprintf("Sample types: %s",
          paste(sort(unique(as.character(meta$SampleType))), collapse = ", ")),
  "",
  "Sequencing depth",
  sprintf("  min %s  median %s  max %s  (%.1f-fold)",
          format(min(sample_sums(ps)), big.mark = ","),
          format(median(sample_sums(ps)), big.mark = ","),
          format(max(sample_sums(ps)), big.mark = ","),
          max(sample_sums(ps)) / min(sample_sums(ps))),
  "",
  "Alpha diversity (Shannon)",
  sprintf("  range %.3f to %.3f", min(alpha$Shannon), max(alpha$Shannon)),
  sprintf("  highest: %s (%s)",
          alpha$SampleID[which.max(alpha$Shannon)],
          alpha$SampleType[which.max(alpha$Shannon)]),
  sprintf("  lowest:  %s (%s)",
          alpha$SampleID[which.min(alpha$Shannon)],
          alpha$SampleType[which.min(alpha$Shannon)]),
  "",
  "Median Shannon by sample type",
  paste0("  ", capture.output(
    print(round(tapply(alpha$Shannon, alpha$SampleType, median), 3))
  )),
  "",
  "Bray-Curtis",
  sprintf("  range %.4f to %.4f", min(bray), max(bray)),
  sprintf("  mean  %.4f", mean(bray)),
  "",
  "PCoA variance explained",
  sprintf("  PCo1 %.1f%%   PCo2 %.1f%%",
          100 * eigen_table$variance_explained[1],
          100 * eigen_table$variance_explained[2]),
  sprintf("  negative eigenvalues: %d of %d",
          sum(pcoa$eig < 0), length(pcoa$eig)),
  "",
  "PERMANOVA (SampleType, 999 permutations)",
  paste0("  ", capture.output(print(permanova)))
)

writeLines(lines, file.path(out, "summary.txt"))
cat(paste(lines, collapse = "\n"), "\n")
