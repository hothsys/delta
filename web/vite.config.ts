import { defineConfig } from 'vite';

/** Builds the browser version's local server into dist/app/server/index.js (run with Node). */
export default defineConfig({
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/app/server',
    target: 'node22',
    emptyOutDir: true,
    minify: false,
    rolldownOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
  },
});
