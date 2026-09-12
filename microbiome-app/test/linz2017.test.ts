/**
 * Validation against published values from an independent study.
 *
 * Linz AM, Crary BC, Shade A, Owens S, Gilbert JA, Knight R, McMahon KD.
 * "Bacterial Community Composition and Dynamics Spanning Five Years in
 * Freshwater Bog Lakes." mSphere 2017;2(3):e00169-17.
 *
 * Their Figure 1 is a boxplot of observed richness per lake, split by lake
 * layer, and the per-lake means and standard deviations behind it were
 * reported in a supplementary table. Those numbers are reproduced below.
 *
 * This is the check that matters, because nothing in the chain is ours: their
 * samples, their sequencing, their mothur pipeline, their rarefaction to 2,500
 * reads, their published summary statistics. If this tool's observed-richness
 * numbers land on theirs, the metric is right for reasons that have nothing to
 * do with how it was implemented here.
 *
 * The data is not committed — it is 17 MB. Fetch it first:
 *   validation/linz2017/bogs_OTUtable_07Jan15.csv
 *   validation/linz2017/bogs_reclassified_11Mar16.csv
 * then: node validation/convert-linz2017.mjs
 * These tests skip when it is absent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { alphaDiversity } from 'microbiome-core';

import { loadDataset } from '../src/lib/load';

const DATA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'validation',
  'linz2017',
  'converted',
);

const present = existsSync(join(DATA, 'feature-table.tsv'));

/**
 * Mean and SD of observed richness per lake, as published.
 * Source: manuscript_plots_accepted_2017-06-07.R, lines 67-100, where the
 * authors recorded each value as an inline comment.
 */
const PUBLISHED = {
  Epilimnion: {
    CB: { mean: 129, sd: 28 },
    FB: { mean: 109, sd: 32 },
    WS: { mean: 150, sd: 45 },
    NS: { mean: 143, sd: 33 },
    TB: { mean: 148, sd: 38 },
    SS: { mean: 191, sd: 57 },
    HK: { mean: 199, sd: 67 },
    MA: { mean: 259, sd: 67 },
  },
  Hypolimnion: {
    CB: { mean: 148, sd: 31 },
    FB: { mean: 145, sd: 57 },
    WS: { mean: 182, sd: 56 },
    NS: { mean: 178, sd: 40 },
    TB: { mean: 186, sd: 38 },
    SS: { mean: 191, sd: 54 },
    HK: { mean: 397, sd: 124 },
    MA: { mean: 477, sd: 110 },
  },
} as const;

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n-1), which is what R's sd() returns. */
function sd(values: number[]): number {
  const m = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/*
 * `describe.skipIf` still EXECUTES the callback in order to collect the test
 * names — it only marks the results skipped. Anything read at the top of that
 * callback therefore runs even when the data is absent, which crashes the
 * suite on a fresh clone. Branching on the condition instead keeps the body
 * from running at all.
 */
if (!present) {
  describe.skip('Linz et al. 2017 published values', () => {
    it('needs validation/linz2017/converted/*.tsv', () => {});
  });
} else {
  describe('Linz et al. 2017 published values', () => {
  const read = (name: string) => readFileSync(join(DATA, name), 'utf8');

  const dataset = loadDataset({
    kind: 'asv',
    tableText: read('feature-table.tsv'),
    taxonomyText: read('taxonomy.tsv'),
    metadataText: read('metadata.tsv'),
  });

  const richness = alphaDiversity(
    dataset.table.values,
    dataset.table.sampleIds,
    ['observed'],
  ).values.observed;

  const column = (name: string) =>
    dataset.metadata.columns.find((c) => c.name === name)!.values.map(String);

  // Grouping uses the study's OWN metadata sheet (NTL-MO_sample_metadata.xlsx,
  // converted by validation/xlsx-to-tsv.mjs), not values reconstructed from
  // sample names. The two agree on all 1,386 samples present in both files,
  // but agreement was partly luck — the naming scheme happened to be regular —
  // and the published means were computed against this sheet.
  const lakes = column('Lake');
  const regions = column('region_sampled');

  /** Their sheet spells the layers in lower case. */
  const REGION: Record<string, string> = {
    Epilimnion: 'epilimnion',
    Hypolimnion: 'hypolimnion',
  };

  function group(layer: string, lake: string): number[] {
    const region = REGION[layer];
    return richness.filter(
      (_, i) => regions[i] === region && lakes[i] === lake,
    );
  }

  it('loads the dataset as rarefied counts', () => {
    expect(dataset.table.featureIds).toHaveLength(6208);
    expect(dataset.table.sampleIds).toHaveLength(1387);
    expect(dataset.isCounts).toBe(true);

    // Every sample rarefied to exactly 2,500 reads.
    for (let j = 0; j < dataset.table.sampleIds.length; j++) {
      let total = 0;
      for (const row of dataset.table.values) total += row[j];
      expect(total).toBe(2500);
    }
  });

  /**
   * Three of the 32 published values are not reproduced. Two of them carry a
   * specific signature pointing at transcription rather than computation:
   * the published number is identical to the SAME LAKE's other-layer value,
   * while its paired statistic matches exactly. A genuinely different sample
   * set would move the mean and the SD together; these move one at a time.
   *
   * They are listed here rather than deleted, and asserted on below, so the
   * discrepancy stays visible and cannot be mistaken for a passing check.
   */
  const KNOWN_DISCREPANCIES = new Set([
    'SS Hypolimnion mean', // published 191 == published SS Epilimnion mean
    'TB Hypolimnion sd', //   published 38  == published TB Epilimnion sd
    'NS Epilimnion mean', //  computed 143.7 rounds to 144; published 143
  ]);

  for (const [layer, lakeValues] of Object.entries(PUBLISHED)) {
    for (const [lake, expected] of Object.entries(lakeValues)) {
      const meanKey = `${lake} ${layer} mean`;
      const sdKey = `${lake} ${layer} sd`;

      it.skipIf(KNOWN_DISCREPANCIES.has(meanKey))(
        `matches published mean richness for ${lake} ${layer} (${expected.mean})`,
        () => {
          const values = group(layer, lake);
          expect(values.length).toBeGreaterThan(0);
          // The paper reports whole numbers, so agreement means agreement
          // after rounding. Anything looser would not be a real check.
          expect(Math.round(mean(values))).toBe(expected.mean);
        },
      );

      it.skipIf(KNOWN_DISCREPANCIES.has(sdKey))(
        `matches published SD of richness for ${lake} ${layer} (${expected.sd})`,
        () => {
          const values = group(layer, lake);
          expect(Math.round(sd(values))).toBe(expected.sd);
        },
      );
    }
  }

  describe('the three unreproduced values', () => {
    it('SS Hypolimnion: SD matches exactly while the mean does not', () => {
      const values = group('Hypolimnion', 'SS');
      // If the sample set differed, both statistics would shift. The SD
      // landing exactly on the published number while the mean is 30% out
      // is what rules that explanation out.
      expect(Math.round(sd(values))).toBe(PUBLISHED.Hypolimnion.SS.sd);
      expect(Math.round(mean(values))).toBe(250);

      // And the published hypolimnion mean is the epilimnion mean verbatim.
      expect(PUBLISHED.Hypolimnion.SS.mean).toBe(PUBLISHED.Epilimnion.SS.mean);
      expect(Math.round(mean(group('Epilimnion', 'SS')))).toBe(
        PUBLISHED.Epilimnion.SS.mean,
      );
    });

    it('TB Hypolimnion: mean matches exactly while the SD does not', () => {
      const values = group('Hypolimnion', 'TB');
      expect(Math.round(mean(values))).toBe(PUBLISHED.Hypolimnion.TB.mean);
      expect(Math.round(sd(values))).toBe(54);

      // Published hypolimnion SD is the epilimnion SD verbatim.
      expect(PUBLISHED.Hypolimnion.TB.sd).toBe(PUBLISHED.Epilimnion.TB.sd);
      expect(Math.round(sd(group('Epilimnion', 'TB')))).toBe(
        PUBLISHED.Epilimnion.TB.sd,
      );
    });

    it('NS Epilimnion: off by one, with no evidenced explanation', () => {
      const values = group('Epilimnion', 'NS');
      const m = mean(values);
      // 143.7 rounds to 144; the paper reports 143. Within transcription
      // range, but unlike the two above there is no positive evidence for
      // any particular cause, so it is recorded as unexplained.
      expect(m).toBeGreaterThan(143);
      expect(m).toBeLessThan(144);
      expect(Math.round(sd(values))).toBe(PUBLISHED.Epilimnion.NS.sd);
    });
  });

  it('reproduces the qualitative finding: Mary Lake hypolimnion is the most diverse', () => {
    const hypoMeans = Object.keys(PUBLISHED.Hypolimnion).map((lake) => ({
      lake,
      value: mean(group('Hypolimnion', lake)),
    }));
    hypoMeans.sort((a, b) => b.value - a.value);
    expect(hypoMeans[0].lake).toBe('MA');
    expect(hypoMeans[1].lake).toBe('HK');
  });
});
}
