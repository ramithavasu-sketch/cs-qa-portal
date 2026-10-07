import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`        -> normal multi-file build for Vercel/Netlify/any static host
// `npm run build:demo`   -> single self-contained HTML (demo data) for sharing
// `npm run google:build` -> Google Apps Script project in google/ (see scripts/build-google.mjs)
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'demo' || mode === 'google' ? [viteSingleFile()] : [])],
  base: './',
  server: { fs: { allow: ['..', '.'] } },
  build: { outDir: mode === 'demo' ? 'dist-demo' : mode === 'google' ? 'dist-google' : 'dist', chunkSizeWarningLimit: 4000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
}));
