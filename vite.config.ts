import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base is configurable for GitHub Pages project sites: set VITE_BASE=/AeroModem/
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        bench: resolve(__dirname, 'bench.html'),
      },
    },
  },
});
