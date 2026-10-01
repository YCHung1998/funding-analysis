import { defineConfig } from 'vitest/config';

export const testInclude = [
  'src/**/*.test.ts',
  'server/**/*.test.ts',
  'runtime/**/*.test.ts',
  'test/**/*.test.ts',
];

export default defineConfig({
  test: {
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
