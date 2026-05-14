import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' is required for Electron compatibility (dist files load via file://).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api':       'http://localhost:5050',
      '/socket.io': { target: 'http://localhost:5050', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
