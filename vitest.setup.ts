import { beforeEach, vi } from 'vitest';

// 測試一律離線：未自行 mock 的 fetch 呼叫立即拋錯，不產生任何對外連線。
export const NETWORK_DISABLED_MESSAGE = 'Network access is disabled in tests';

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', () => {
    throw new Error(NETWORK_DISABLED_MESSAGE);
  });
});
