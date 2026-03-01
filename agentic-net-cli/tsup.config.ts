import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'bin/agenticos': 'bin/agenticos.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // Don't bundle — let Node resolve from node_modules at runtime
  external: [/^[^./]/],
  banner: {
    js: '#!/usr/bin/env node\n',
  },
});
