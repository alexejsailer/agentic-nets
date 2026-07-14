import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite doesn't know .md; mirror tsup's `loader: {'.md': 'text'}` so the hermetic tests
  // (which import the real server → knowledge registry) see the same bundled strings.
  plugins: [
    {
      name: 'md-as-text',
      enforce: 'pre',
      load(id: string) {
        if (id.endsWith('.md')) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
        }
        return null;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
