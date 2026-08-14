import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs as a separate process on :8000; in production the
// built assets are served by that same process, so requests are same-origin and
// these proxies are unused.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    outDir: '../server/riverbed/static',
    emptyOutDir: true,
  },
});
