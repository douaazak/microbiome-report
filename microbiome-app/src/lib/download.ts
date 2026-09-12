/**
 * Export helpers.
 *
 * Every plot offers both an SVG and the exact numbers behind it. Published
 * comparisons of web-based microbiome tools single out "incomplete retention
 * of key information in exported figures" as a recurring complaint, so vector
 * output that opens in Illustrator or Inkscape — plus the underlying data —
 * is a deliberate feature rather than an afterthought.
 */

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick; revoking immediately can cancel the download in
  // some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The chart's own SVG, from whatever `Plot.plot()` returned.
 *
 * With no legend or title Plot returns the SVG itself. With either it returns
 * a `<figure>` whose legend comes BEFORE the chart — and a swatch legend is
 * made of one tiny `<svg>` per colour. `figure.querySelector('svg')` therefore
 * found a 15×15 swatch, and "Download SVG" on every plot with a legend saved
 * a coloured square. Only a direct child of the figure is the chart.
 */
export function plotSvg(figure: Element): SVGSVGElement | null {
  if (figure instanceof SVGSVGElement) return figure;
  for (const child of figure.children) {
    if (child instanceof SVGSVGElement) return child;
  }
  return null;
}

export function downloadSvg(element: SVGElement | null, filename: string): void {
  if (!element) return;

  const clone = element.cloneNode(true) as SVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  // Observable Plot styles figures with a stylesheet scoped by class name;
  // inlining a white background keeps the exported file legible when opened
  // outside the app.
  if (!clone.getAttribute('style')?.includes('background')) {
    clone.setAttribute(
      'style',
      `${clone.getAttribute('style') ?? ''};background:#ffffff`,
    );
  }

  const source = new XMLSerializer().serializeToString(clone);
  triggerDownload(
    new Blob([source], { type: 'image/svg+xml;charset=utf-8' }),
    filename,
  );
}

export function downloadTsv(
  rows: Record<string, unknown>[],
  filename: string,
): void {
  if (rows.length === 0) return;

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.join('\t')];

  for (const row of rows) {
    lines.push(
      columns
        .map((column) => {
          const value = row[column];
          if (value === null || value === undefined) return '';
          if (typeof value === 'number') {
            return Number.isFinite(value) ? String(value) : '';
          }
          // Tabs and newlines inside a value would corrupt the file.
          return String(value).replace(/[\t\r\n]/g, ' ');
        })
        .join('\t'),
    );
  }

  triggerDownload(
    new Blob([lines.join('\n')], { type: 'text/tab-separated-values' }),
    filename,
  );
}
