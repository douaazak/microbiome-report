import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built app works from any subpath, including the
  // project pages URL on GitHub Pages and a file:// open.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      'microbiome-core': fileURLToPath(
        new URL('../microbiome-core/src/index.ts', import.meta.url),
      ),
    },
  },
});
