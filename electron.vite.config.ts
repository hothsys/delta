import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/** Builds the app (desktop main process, preload and the interface) into dist/app/. */
export default defineConfig({
  main: {
    build: { outDir: 'dist/app/main' },
  },
  preload: {
    build: {
      outDir: 'dist/app/preload',
      // Sandboxed preload scripts must be CommonJS.
      rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
    worker: { format: 'es' },
    build: { outDir: 'dist/app/renderer' },
  },
});
