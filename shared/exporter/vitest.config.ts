import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve the workspace types package to its source so tests run without a
  // prior build step.
  resolve: {
    alias: {
      '@civretro/types': fileURLToPath(new URL('../types/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
