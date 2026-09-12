import * as Plot from '@observablehq/plot';
import { useEffect, useRef, useState } from 'react';

import { downloadSvg, downloadTsv } from '../lib/download';

interface PlotFigureProps {
  /**
   * Observable Plot options. MUST be memoised by the caller — a fresh object
   * every render would re-run the effect on every render.
   */
  options: Plot.PlotOptions;
  /** Base filename for exports, without extension. */
  exportName: string;
  /** The numbers behind the figure, exported alongside the SVG. */
  exportRows?: Record<string, unknown>[];
  caption?: string;
}

export function PlotFigure({
  options,
  exportName,
  exportRows,
  caption,
}: PlotFigureProps) {
  const container = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<SVGElement | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node) return;

    const figure = Plot.plot(options);
    node.replaceChildren(figure);

    setSvg(
      figure instanceof SVGElement
        ? figure
        : (figure.querySelector('svg') as SVGElement | null),
    );

    return () => {
      node.replaceChildren();
    };
  }, [options]);

  return (
    <figure className="plot-figure">
      <div ref={container} />
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
