import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'bin/agenticnets-mcp': 'bin/agenticnets-mcp.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  // Knowledge-pack docs are real .md files bundled as strings (same self-containment
  // guarantee as the statically-imported template JSONs — npx works from the tarball).
  loader: { '.md': 'text' },
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
