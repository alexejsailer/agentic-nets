import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'bin/agenticos-chat': 'bin/agenticos-chat.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // Bundle @agenticos/cli sources inline (file: dependency, not published to npm)
  noExternal: ['@agenticos/cli'],
  // Keep real npm packages external
  external: [/^[^./](?!.*@agenticos\/cli)/],
  banner: {
    js: '#!/usr/bin/env node\n',
  },
});
