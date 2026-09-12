/**
 * How completely a taxonomy assigns each rank.
 *
 * This exists because of a confusing session with real data: the composition
 * plot defaulted to genus, and on a freshwater environmental dataset only 14%
 * of OTUs carry a genus assignment. The result was a chart of "Unclassified
 * Bacteria", "Unclassified Proteobacteria" and so on — technically correct,
 * and useless. Nothing was wrong with the parsing; nothing told the user that
 * the rank they were looking at was mostly empty.
 *
 * Assignment falls off steeply with depth in environmental data. Reporting
 * that lets the interface choose a sensible starting rank and lets the reader
 * judge whether a plot is worth reading.
 */

import { RANKS, type ParsedLineage, type Rank } from './taxonomy.js';

export interface RankCoverage {
  rank: Rank;
  /** Features with an assignment at this rank. */
  assigned: number;
  total: number;
  /** Assigned / total, in [0, 1]. */
  fraction: number;
}

export interface TaxonomyCoverage {
  byRank: RankCoverage[];
  /**
   * Deepest rank whose assignment fraction meets the threshold — the most
   * informative rank that is still mostly populated.
   */
  bestRank: Rank;
  /**
   * Features whose lineage mentions mitochondria or chloroplast at any rank.
   *
   * These are not bacteria. They are eukaryotic organelles amplified by 16S
   * primers — host tissue in a gut study, algae or plants in an environmental
   * one — and are conventionally removed before analysis. Left in they inflate
   * richness and consume read depth, so their presence is worth reporting.
   */
  organelleFeatures: number;
}

const ORGANELLE = /mitochondri|chloroplast/i;

/**
 * @param lineages   one per feature
 * @param threshold  minimum assigned fraction for a rank to be "usable"
 */
export function taxonomyCoverage(
  lineages: ParsedLineage[],
  threshold = 0.5,
): TaxonomyCoverage {
  const total = lineages.length;

  const byRank: RankCoverage[] = RANKS.map((rank, index) => {
    const assigned = lineages.filter((l) => l.ranks[index] !== null).length;
    return {
      rank,
      assigned,
      total,
      fraction: total > 0 ? assigned / total : 0,
    };
  });

  // Deepest rank still meeting the threshold; domain if none do, since a rank
  // has to be chosen and the shallowest is the safest.
  let bestRank: Rank = RANKS[0];
  for (const entry of byRank) {
    if (entry.fraction >= threshold) bestRank = entry.rank;
  }

  const organelleFeatures = lineages.filter((l) =>
    l.ranks.some((value) => value !== null && ORGANELLE.test(value)),
  ).length;

  return { byRank, bestRank, organelleFeatures };
}

/** Human-readable notes for the diagnostics panel. */
export function describeCoverage(coverage: TaxonomyCoverage): string[] {
  const messages: string[] = [];
  const { byRank, bestRank, organelleFeatures } = coverage;

  const genus = byRank.find((r) => r.rank === 'genus');
  if (genus && genus.total > 0 && genus.fraction < 0.5) {
    messages.push(
      `Only ${(genus.fraction * 100).toFixed(0)}% of features have a genus assignment (${genus.assigned.toLocaleString()} of ${genus.total.toLocaleString()}). Plots at genus level will be dominated by “Unclassified …” groupings; ${bestRank} is the deepest rank that is mostly assigned.`,
    );
  }

  if (organelleFeatures > 0) {
    messages.push(
      `${organelleFeatures.toLocaleString()} feature${organelleFeatures === 1 ? '' : 's'} classified as mitochondria or chloroplast. These are eukaryotic organelles picked up by 16S primers, not bacteria, and are usually removed before analysis — they inflate richness and consume read depth.`,
    );
  }

  return messages;
}
