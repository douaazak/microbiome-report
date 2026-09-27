/**
 * Starting a worker without betting the page on it.
 *
 * The tool ships as one HTML file that people open by double-clicking, so it
 * runs from a `file://` origin. Vite inlines each worker and constructs it
 * from a Blob URL, falling back to a `data:` URL. Chromium allows both from
 * `file://` — verified against the built file — but a browser that refuses,
 * or a page served under a strict Content-Security-Policy, makes
 * `new Worker(...)` throw.
 *
 * That throw used to happen inside a `useEffect` with no `try`/`catch` and no
 * error boundary above it, so React unmounted the whole root: the user got a
 * blank white page the moment "Analyse" succeeded, with no message. Since the
 * Overview tab is the default, that was the entire application gone.
 *
 * `startWorker` turns that into a null, and the caller computes on the main
 * thread instead. Slower and it blocks the tab, but the alternative is
 * nothing at all.
 */
export function startWorker(create: () => Worker): Worker | null {
  try {
    return create();
  } catch {
    return null;
  }
}

/**
 * Yield to the browser once, so a status message painted just before a long
 * synchronous computation is actually on screen before the thread blocks.
 *
 * A plain `setTimeout(fn, 0)` fires after the current task but is not
 * guaranteed to be after a paint; two nested animation frames are, and the
 * timeout is the fallback for a hidden tab, where rAF never fires.
 */
export function afterPaint(run: () => void): () => void {
  let cancelled = false;
  let raf1 = 0;
  let raf2 = 0;

  const go = () => {
    if (cancelled) return;
    cancelled = true;
    run();
  };

  const timer = window.setTimeout(go, 100);

  if (typeof requestAnimationFrame === 'function') {
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        window.clearTimeout(timer);
        go();
      });
    });
  }

  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (raf1) cancelAnimationFrame(raf1);
    if (raf2) cancelAnimationFrame(raf2);
  };
}
