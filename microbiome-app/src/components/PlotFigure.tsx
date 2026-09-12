import * as Plot from '@observablehq/plot';
import { useEffect, useRef, useState } from 'react';

import { downloadSvg, downloadTsv, plotSvg } from '../lib/download';

interface PlotFigureProps {
  /**
   * Observable Plot options. MUST be memoised by the caller — a fresh object
   * every render would re-run the effect on every render.
   *
   * `width` is supplied here from the measured container, so callers should
   * not set it. Anything they do set is honoured and overrides the measurement.
   */
  options: Plot.PlotOptions;
  /** Base filename for exports, without extension. */
  exportName: string;
  /** The numbers behind the figure, exported alongside the SVG. */
  exportRows?: Record<string, unknown>[];
  caption?: string;
  /**
   * Let the figure exceed the container and scroll sideways instead of being
   * squeezed. Used when every bar must carry a readable label.
   */
  scroll?: boolean;
}

/**
 * Below this the figure is too cramped to be worth drawing; above it the plot
 * simply fills whatever room the layout gives it.
 */
const MIN_WIDTH = 320;

export function PlotFigure({
  options,
  exportName,
  exportRows,
  caption,
  scroll = false,
}: PlotFigureProps) {
  const container = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<SVGElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  /*
   * Width is measured from a zero-height sizer rather than from the element
   * holding the plot. Measuring the plot's own container risks a feedback
   * loop — the plot is sized from the measurement, and the measurement then
   * reflects the plot. The sizer only ever reflects the layout.
   */
  useEffect(() => {
    const node = sizer.current;
    if (!node) return;

    const update = (value: number) => {
      const next = Math.max(MIN_WIDTH, Math.floor(value));
      // Ignore sub-pixel jitter, which would otherwise redraw constantly.
      setWidth((current) =>
        current === null || Math.abs(current - next) > 2 ? next : current,
      );
    };

    update(node.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      update(entries[0].contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = container.current;
    if (!node || width === null) return;

    const figure = Plot.plot({ width, ...options });
    node.replaceChildren(figure);

    setSvg(plotSvg(figure));

    return () => {
      node.replaceChildren();
    };
  }, [options, width]);

  return (
    <figure className="plot-figure">
      <div ref={sizer} aria-hidden="true" className="plot-sizer" />
      <div ref={container} className={scroll ? 'plot-scroll' : undefined} />
      {caption && <figcaption>{caption}</figcaption>}
      <div className="plot-actions">
        <button
          type="button"
          onClick={() => downloadSvg(svg, `${exportName}.svg`)}
          disabled={!svg}
        >
          Download SVG
        </button>
        {exportRows && exportRows.length > 0 && (
          <button
            type="button"
            onClick={() => downloadTsv(exportRows, `${exportName}.tsv`)}
          >
            Download data
          </button>
        )}
      </div>
    </figure>
  );
}
