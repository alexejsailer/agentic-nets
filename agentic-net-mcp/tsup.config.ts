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
    // The createRequire shim backs esbuild's __require fallback: without it, any
    // stray CJS require() inside the bundled @agenticos/cli sources throws
    // "Dynamic require of X is not supported" at the exact moment the real error
    // it sits next to should have surfaced (proven live on the auth 401 path).
    js: '#!/usr/bin/env node\nimport { createRequire as __agenticosCreateRequire } from "node:module"; const require = __agenticosCreateRequire(import.meta.url);\n',
  },
});
