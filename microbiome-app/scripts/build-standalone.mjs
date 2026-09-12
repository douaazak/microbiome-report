/**
 * Builds a single self-contained HTML file.
 *
 * The point of this tool is that a wet-lab scientist can use it without
 * installing anything and without uploading their data. A single HTML file
 * is the strongest form of that: email it, put it on a shared drive, open it
 * by double-clicking. No server, no npm, no internet.
 *
 * Everything is inlined — CSS, JS, and the demo dataset, since a file:// page
 * cannot fetch its own siblings.
 *
 * Run: node scripts/build-standalone.mjs   (after `vite build`)
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const assets = join(dist, 'assets');

const files = readdirSync(assets);
const jsName = files.find((f) => f.endsWith('.js'));
const cssName = files.find((f) => f.endsWith('.css'));

if (!jsName) {
  throw new Error('No JS bundle found in dist/assets. Run `vite build` first.');
}

const js = readFileSync(join(assets, jsName), 'utf8');
const css = cssName ? readFileSync(join(assets, cssName), 'utf8') : '';

const demo = {
  table: readFileSync(join(root, 'public/demo/feature-table.tsv'), 'utf8'),
  taxonomy: readFileSync(join(root, 'public/demo/taxonomy.tsv'), 'utf8'),
  metadata: readFileSync(join(root, 'public/demo/metadata.tsv'), 'utf8'),
};

/**
 * A literal `</script` anywhere inside an inline script — including inside a
 * string — terminates the block early and corrupts the page. Escaping the
 * slash is invisible to the JS parser and safe in JSON too.
 */
const guard = (text) => text.replaceAll('</script', '<\\/script');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Microbiome Report</title>
<meta name="description" content="Interactive microbiome analysis that runs entirely in your browser. Your data never leaves your computer.">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__DEMO_DATA__=${guard(JSON.stringify(demo))};</script>
<script type="module">${guard(js)}</script>
</body>
</html>
`;

const out = join(dist, 'microbiome-report-standalone.html');
writeFileSync(out, html);

const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`Wrote ${out} (${mb} MB, self-contained)`);
