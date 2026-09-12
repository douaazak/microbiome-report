/**
 * Plain-language findings, generated ONLY from results that pass the stated
 * threshold.
 *
 * The design constraint that matters: this must never manufacture confidence.
 * Three rules are enforced throughout.
 *
 * 1. A finding appears only when its test passed the threshold. Nothing is
 *    reported as "trending" or "approaching significance".
 * 2. Every statement carries its own numbers, so the reader can check it.
 * 3. The ABSENCE of a finding is reported explicitly, with the reminder that
 *    absence of evidence is not evidence of absence — especially at the group
 *    sizes typical of microbiome studies.
 *
 * Wording is associational throughout. Nothing here can establish causation,
 * and the phrasing must not imply otherwise.
 */

import {
  alphaDiversity,
  betaDiversity,
  differentialAbundance,
  kruskalWallis,
  labelAtRank,
  permanova,
  wilcoxonRankSum,
  type AlphaMetric,
  type BetaMetric,
} from 'microbiome-core';

import { completeCases, groupLabels, subsetColumns, type Dataset } from './load';

export interface Finding {
  area: 'Community structure' | 'Diversity' | 'Individual taxa';
  /** The claim, in plain language. */
  statement: string;
  /** The numbers behind it. */
  evidence: string;
  /** How to read it, and what it does not mean. */
  interpretation: string;
}

export interface FindingsReport {
  variable: string;
  groups: string[];
  groupSizes: { level: string; n: number }[];
  alpha: number;
  findings: Finding[];
  /** Analyses that ran but found nothing at the threshold. */
  nullResults: string[];
  /** Analyses that could not run at all, and why. */
  notRun: string[];
}

export interface FindingsOptions {
  alpha?: number;
  betaMetric?: BetaMetric;
  alphaMetric?: AlphaMetric;
  minPrevalence?: number;
  /** PERMANOVA permutations. Fewer on large datasets keeps the wait sane. */
  permutations?: number;
}

export function buildFindings(
  dataset: Dataset,
  variable: string,
  options: FindingsOptions = {},
): FindingsReport {
  const {
    alpha = 0.05,
    betaMetric = 'braycurtis',
    alphaMetric = 'shannon',
    minPrevalence = 0.1,
    permutations = 999,
  } = options;

  const labels = groupLabels(dataset.metadata, variable);
  const keep = completeCases(labels);
  const groupsPerSample = keep.map((i) => labels[i] as string);
  const groups = [...new Set(groupsPerSample)].sort();
  const groupSizes = groups.map((level) => ({
    level,
    n: groupsPerSample.filter((g) => g === level).length,
  }));

  const findings: Finding[] = [];
  const nullResults: string[] = [];
  const notRun: string[] = [];

  if (groups.length < 2) {
    notRun.push(
      `“${variable}” has only one group with data, so no comparison is possible.`,
    );
    return { variable, groups, groupSizes, alpha, findings, nullResults, notRun };
  }

  const values = subsetColumns(dataset.table.values, keep);
  const sampleIds = keep.map((i) => dataset.table.sampleIds[i]);
  const smallest = Math.min(...groupSizes.map((g) => g.n));

  // ---- Community structure (PERMANOVA) ------------------------------------

  if (keep.length < 3) {
    notRun.push('Community structure needs at least three samples.');
  } else if (smallest < 3) {
    notRun.push(
      `Community structure was not tested: the smallest group has ${smallest} sample${smallest === 1 ? '' : 's'}.`,
    );
  } else {
    const distance = betaDiversity(values, sampleIds, betaMetric);
    const result = permanova(distance, groupsPerSample, permutations);

    if (result.p < alpha) {
      findings.push({
        area: 'Community structure',
        statement: `Overall microbial community composition differs between the ${groups.join(' and ')} groups.`,
        evidence: `PERMANOVA on ${labelForMetric(betaMetric)} distances: pseudo-F = ${result.f.toFixed(2)}, R² = ${result.r2.toFixed(3)}, p = ${formatP(result.p)} (${result.permutations} permutations).`,
        interpretation: `R² means “${variable}” accounts for about ${(result.r2 * 100).toFixed(0)}% of the variation in community composition between samples — the remaining ${(100 - result.r2 * 100).toFixed(0)}% is explained by something else, including individual variation. A significant result says the groups differ on average; it does not say every sample in one group differs from every sample in the other.`,
      });
    } else {
      nullResults.push(
        `Community composition did not differ significantly between groups (PERMANOVA p = ${formatP(result.p)}).`,
      );
    }
  }

  // ---- Alpha diversity ----------------------------------------------------

  const alphaResult = alphaDiversity(
    dataset.table.values,
    dataset.table.sampleIds,
    [alphaMetric],
    { isCounts: dataset.isCounts },
  );

  if (alphaResult.values[alphaMetric] === undefined) {
    notRun.push(
      `${labelForAlpha(alphaMetric)} could not be computed: ${alphaResult.refused[0]?.reason ?? 'unavailable for this input.'}`,
    );
  } else {
    const perGroup = groups.map((g) =>
      keep
        .filter((_, index) => groupsPerSample[index] === g)
        .map((i) => alphaResult.values[alphaMetric][i]),
    );

    if (perGroup.some((g) => g.length < 3)) {
      notRun.push(
        'Diversity was not tested: at least one group has fewer than three samples.',
      );
    } else {
      const test =
        groups.length === 2
          ? wilcoxonRankSum(perGroup[0], perGroup[1])
          : kruskalWallis(perGroup);

      if (test.p < alpha) {
        const medians = perGroup.map(median);
        const highest = medians.indexOf(Math.max(...medians));
        const lowest = medians.indexOf(Math.min(...medians));

        findings.push({
          area: 'Diversity',
          statement: `Within-sample diversity (${labelForAlpha(alphaMetric)}) differs between groups, with “${groups[highest]}” higher than “${groups[lowest]}”.`,
          evidence: `${groups.length === 2 ? 'Wilcoxon rank-sum' : 'Kruskal-Wallis'}: p = ${formatP(test.p)}. Median ${labelForAlpha(alphaMetric)}: ${groups.map((g, i) => `${g} ${medians[i].toFixed(2)}`).join(', ')}.`,
          interpretation:
            'Alpha diversity summarises each whole community as one number, so this says the communities differ in how many taxa they contain and how evenly. It does not identify which taxa are responsible — see the Differential tab for that.',
        });
      } else {
        nullResults.push(
          `${labelForAlpha(alphaMetric)} diversity did not differ significantly between groups (p = ${formatP(test.p)}).`,
        );
      }
    }
  }

  // ---- Individual taxa ----------------------------------------------------

  if (smallest < 3) {
    notRun.push(
      'Differential abundance was not tested: at least one group has fewer than three samples.',
    );
  } else {
    try {
      const result = differentialAbundance(
        values,
        dataset.table.featureIds,
        groupsPerSample,
        { minPrevalence },
      );

      const hits = result.results
        .filter((r) => r.q !== null && r.q < alpha)
        .sort((a, b) => (a.q as number) - (b.q as number));

      if (hits.length > 0) {
        const name = (featureId: string) => {
          const index = dataset.table.featureIds.indexOf(featureId);
          return dataset.lineages
            ? labelAtRank(dataset.lineages[index], 'genus')
            : featureId;
        };

        const top = hits.slice(0, 5).map((hit) => {
          const direction =
            groups.length === 2
              ? hit.groupMeans[groups[1]] > hit.groupMeans[groups[0]]
                ? `higher in ${groups[1]}`
                : `higher in ${groups[0]}`
              : 'differs across groups';
          return `${name(hit.featureId)} (${direction}, q = ${formatP(hit.q as number)})`;
        });

        findings.push({
          area: 'Individual taxa',
          statement: `${hits.length} of ${result.testedCount} tested taxa differ in abundance between groups.`,
          evidence: `CLR transform, then ${groups.length === 2 ? 'Wilcoxon rank-sum' : 'Kruskal-Wallis'} per taxon, Benjamini-Hochberg across taxa at q < ${alpha}. Strongest: ${top.join('; ')}.`,
          interpretation:
            'These are relative abundances, so “higher” means a larger share of the community, not necessarily more cells. A taxon can appear to rise simply because another fell. The q value already accounts for the number of taxa tested.',
        });
      } else {
        nullResults.push(
          `No individual taxon differed significantly between groups after correcting for multiple testing (${result.testedCount} taxa tested at q < ${alpha}).`,
        );
      }
    } catch (error) {
      notRun.push(
        `Differential abundance could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { variable, groups, groupSizes, alpha, findings, nullResults, notRun };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function labelForMetric(metric: BetaMetric): string {
  return metric === 'braycurtis'
    ? 'Bray-Curtis'
    : metric === 'jaccard'
      ? 'Jaccard'
      : 'Aitchison';
}

function labelForAlpha(metric: AlphaMetric): string {
  const labels: Record<AlphaMetric, string> = {
    observed: 'Observed features',
    shannon: 'Shannon',
    simpson: 'Simpson',
    invsimpson: 'Inverse Simpson',
    pielou: "Pielou's evenness",
    chao1: 'Chao1',
  };
  return labels[metric];
}

export function formatP(p: number): string {
  if (!Number.isFinite(p)) return 'n/a';
  if (p < 1e-6) return '< 1e-6';
  if (p < 0.001) return p.toExponential(1);
  return p.toFixed(4);
}
