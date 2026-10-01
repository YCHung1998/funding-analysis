import { afterEach, beforeEach, vi } from 'vitest';
// jest-dom matchers (toBeInTheDocument, ...) for src/**/*.test.tsx (jsdom env);
// a harmless no-op import for the existing node-environment *.test.ts files.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

// `test.globals` is false (see vitest.config.ts), so @testing-library/react's
// own auto-cleanup (which relies on a global `afterEach`) never registers.
// Call it explicitly; it's a no-op without a `document` (node-environment
// tests), so this is safe for every existing *.test.ts file too.
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});

// 測試一律離線：未自行 mock 的 fetch 呼叫立即拋錯，不產生任何對外連線。
export const NETWORK_DISABLED_MESSAGE = 'Network access is disabled in tests';

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', () => {
    throw new Error(NETWORK_DISABLED_MESSAGE);
  });
});
