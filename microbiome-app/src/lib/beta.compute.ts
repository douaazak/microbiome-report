/**
 * Beta diversity, ordination and PERMANOVA — the computation itself.
 *
 * Kept apart from `beta.worker.ts` so the same code can run on either thread.
 * The worker is the normal path; the main thread is the fallback for a
 * browser that refuses to construct a worker at all. A module that installs
 * `self.onmessage` at import time cannot be imported by the main thread
 * without side effects, which is why this is its own file.
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

/**
 * Run the whole beta pipeline, reporting each stage as it starts.
 *
 * `onProgress` is called synchronously, so on the main thread it will not
 * repaint between stages — the caller is responsible for yielding a frame
 * before starting if it wants the first stage shown.
 */
export function computeBeta(
  request: BetaRequest,
  onProgress: (stage: string) => void = () => {},
): BetaResult {
  const { values, sampleIds, groups, metric, permutations } = request;

  onProgress(
    `Computing ${sampleIds.length} × ${sampleIds.length} distances…`,
  );
  const distance = betaDiversity(values, sampleIds, metric);

  onProgress('Running ordination…');
  const ordination = pcoa(distance, 2);

  let test: PermanovaResult | null = null;
  let testError: string | null = null;

  if (groups.length > 0) {
    onProgress(`PERMANOVA, ${permutations} permutations…`);
    try {
      test = permanova(distance, groups, permutations);
    } catch (error) {
      testError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ordination,
    test,
    testError,
    points: sampleIds.map((sampleId, i) => ({
      sampleId,
      group: groups[i] ?? 'all samples',
      pc1: ordination.coordinates[0]?.[i] ?? 0,
      pc2: ordination.coordinates[1]?.[i] ?? 0,
    })),
  };
}
