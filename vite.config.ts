import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Keep one shared Recast module instance in development. Bundling only
    // @recast-navigation/three while excluding recast-navigation duplicates
    // its WASM singleton, so init() never reaches the generator APIs.
    exclude: [
      'recast-navigation',
      '@recast-navigation/core',
      '@recast-navigation/generators',
      '@recast-navigation/three',
    ],
  },
  build: {
    target: 'es2022',
  },
});
