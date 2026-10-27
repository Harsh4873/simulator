import { defineConfig } from 'vite';

export default defineConfig({
  base: '/simulator/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
