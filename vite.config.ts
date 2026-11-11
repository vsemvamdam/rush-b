import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the site from /rush-b/
export default defineConfig({
  base: process.env.BASE_PATH || '/rush-b/',
  plugins: [react()],
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
});
