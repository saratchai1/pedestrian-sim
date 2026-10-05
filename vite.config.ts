import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['recast-navigation'],
  },
  build: {
    target: 'es2022',
  },
});
