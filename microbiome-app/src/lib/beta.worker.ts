/**
 * Beta diversity, ordination and PERMANOVA, off the main thread.
 *
 * These are the only genuinely expensive analyses in the tool, and PCoA is the
 * worst of them: the Jacobi eigendecomposition costs roughly n^4 in practice,
 * measured at 156 ms for 200 samples, 650 ms for 300, and 1.6 s for 400. At
 * the ~1,400 samples of a real time series that extrapolates to minutes.
 *
 * Run on the main thread that freezes the tab completely — no repaint, no
 * clicks, indistinguishable from a crash. Moving it here keeps the interface
 * alive and lets the work be cancelled, without changing any of the numbers:
 * the same exact algorithms run, just somewhere else.
 */

import {
  betaDiversity,
  pcoa,
  permanova,
  type BetaMetric,
  type PcoaResult,
  type PermanovaResult,
} from 'microbiome-core';

export interface BetaRequest {
  values: number[][];
  sampleIds: string[];
  /** Empty when there is no grouping variable; PERMANOVA is then skipped. */
  groups: string[];
  metric: BetaMetric;
  permutations: number;
}

export type BetaProgress =
  | { type: 'progress'; stage: string }
  | { type: 'done'; result: BetaResult }
  | { type: 'error'; message: string };

export interface BetaResult {
  ordination: PcoaResult;
  test: PermanovaResult | null;
  testError: string | null;
  points: {
    sampleId: string;
    group: string;
    pc1: number;
    pc2: number;
  }[];
}

self.onmessage = (event: MessageEvent<BetaRequest>) => {
  const { values, sampleIds, groups, metric, permutations } = event.data;
  const post = (message: BetaProgress) => self.postMessage(message);

  try {
    post({ type: 'progress', stage: `Computing ${sampleIds.length} × ${sampleIds.length} distances…` });
    const distance = betaDiversity(values, sampleIds, metric);

    post({ type: 'progress', stage: 'Running ordination…' });
    const ordination = pcoa(distance, 2);

    let test: PermanovaResult | null = null;
    let testError: string | null = null;

    if (groups.length > 0) {
      post({ type: 'progress', stage: `PERMANOVA, ${permutations} permutations…` });
      try {
        test = permanova(distance, groups, permutations);
      } catch (error) {
        testError = error instanceof Error ? error.message : String(error);
      }
    }

    post({
      type: 'done',
      result: {
        ordination,
        test,
        testError,
        points: sampleIds.map((sampleId, i) => ({
          sampleId,
          group: groups[i] ?? 'all samples',
          pc1: ordination.coordinates[0]?.[i] ?? 0,
          pc2: ordination.coordinates[1]?.[i] ?? 0,
        })),
      },
    });
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
