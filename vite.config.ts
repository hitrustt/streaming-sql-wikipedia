import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * GitHub Pages serves a project site from a subpath (`/<repo>/`), so asset URLs
 * must be built relative to it. `BASE_PATH` is set by the deploy workflow; local
 * dev and any root-hosted deployment fall back to '/'.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // The engine is one chunk and React another, so a UI change does not
    // invalidate the engine in visitors' caches.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
