import { defineConfig } from 'vitest/config';

export const testInclude = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'server/**/*.test.ts',
  'runtime/**/*.test.ts',
  'test/**/*.test.ts',
];

export default defineConfig({
  test: {
    // Default environment stays 'node' for every existing include pattern.
    // React component tests (src/**/*.test.tsx) opt into jsdom individually
    // via a `// @vitest-environment jsdom` docblock at the top of the file
    // (vitest 5.0.3 dropped `environmentMatchGlobs`; `test.projects` would
    // also work but turns this file into a projects *container* that can no
    // longer run its own inline `include`/tests — the per-file docblock
    // keeps this config file's existing behavior for node tests untouched).
    environment: 'node',
    include: testInclude,
    exclude: ['node_modules/**', 'dist/**'],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/adapters/**', 'server/**', 'runtime/src/**'],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
