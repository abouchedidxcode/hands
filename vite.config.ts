import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), lab: resolve(__dirname, 'lab.html') } },
  },
  server: { host: true },
});
