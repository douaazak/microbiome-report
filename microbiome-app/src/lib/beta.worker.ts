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
 *
 * The computation lives in `beta.compute.ts` so the main thread can also run
 * it directly when a browser refuses to give us a worker.
 */

import { computeBeta, type BetaRequest, type BetaResult } from './beta.compute';

export type { BetaRequest, BetaResult };

export type BetaProgress =
  | { type: 'progress'; stage: string }
  | { type: 'done'; result: BetaResult }
  | { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<BetaRequest>) => {
  const post = (message: BetaProgress) => self.postMessage(message);

  try {
    const result = computeBeta(event.data, (stage) =>
      post({ type: 'progress', stage }),
    );
    post({ type: 'done', result });
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
