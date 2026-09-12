/**
 * Plain-language findings, off the main thread.
 *
 * `buildFindings` runs a distance matrix, PERMANOVA and a full differential
 * abundance pass. On the main thread that froze the Overview tab — the first
 * thing shown after "Analyse" — for as long as those took, which on a
 * thousand-sample table is tens of seconds with no repaint and no way to
 * cancel. The beta tab already does this work in a worker for the same
 * reason; the numbers are identical, only the thread differs.
 */

import { buildFindings, type FindingsOptions, type FindingsReport } from './findings';
import type { Dataset } from './load';

export interface FindingsRequest {
  dataset: Dataset;
  variable: string;
  options?: FindingsOptions;
}

export type FindingsProgress =
  | { type: 'done'; report: FindingsReport }
  | { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<FindingsRequest>) => {
  const { dataset, variable, options } = event.data;
  try {
    const report = buildFindings(dataset, variable, options);
    self.postMessage({ type: 'done', report } satisfies FindingsProgress);
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies FindingsProgress);
  }
};
