import { beforeEach, vi } from 'vitest';
// jest-dom matchers (toBeInTheDocument, ...) for src/**/*.test.tsx (jsdom env);
// a harmless no-op import for the existing node-environment *.test.ts files.
import '@testing-library/jest-dom/vitest';

// 測試一律離線：未自行 mock 的 fetch 呼叫立即拋錯，不產生任何對外連線。
export const NETWORK_DISABLED_MESSAGE = 'Network access is disabled in tests';

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', () => {
    throw new Error(NETWORK_DISABLED_MESSAGE);
  });
});
