import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// MinerWatch frontend — Vite config.
//
// The build is served by FastAPI under /v2/ (see backend/main.py). When
// you change this base, the static asset hrefs change with it; the dev
// server is unaffected because it serves from /.
//
// In dev mode (`npm run dev`), Vite runs on :5173 and proxies /api/*
// and /sw.js to the FastAPI backend on :8000 so you can call the real
// API and exercise push notifications without CORS gymnastics.
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: false,
      },
      '/sw.js': {
        target: 'http://localhost:8000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Chunk strategy: react + react-dom in their own chunk so they get
    // cached across deploys when only app code changes.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          charts: ['recharts'],
        },
      },
    },
  },
});
