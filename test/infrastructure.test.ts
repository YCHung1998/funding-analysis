import { describe, expect, it } from 'vitest';
import config from '../vitest.config';
import { NETWORK_DISABLED_MESSAGE } from '../vitest.setup';

describe('test infrastructure', () => {
  it('fetch 在測試中被禁止', () => {
    expect(() => fetch('https://fapi.binance.com/fapi/v1/premiumIndex')).toThrow(NETWORK_DISABLED_MESSAGE);
  });

  it('test.include 含五個納入樣式（含 runtime 與 React tsx 元件測試）', () => {
    // paper-trading-ui change: added 'src/**/*.test.tsx' so React Testing
    // Library component tests (jsdom env, see environmentMatchGlobs below)
    // are discovered alongside the existing four node-environment patterns.
    expect(config.test?.include).toEqual([
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'server/**/*.test.ts',
      'runtime/**/*.test.ts',
      'test/**/*.test.ts',
    ]);
  });

  it('預設環境仍為 node（*.test.tsx 改以檔案內 docblock 宣告 jsdom）', () => {
    expect(config.test?.environment).toBe('node');
  });

  it('排除 node_modules 與 dist', () => {
    expect(config.test?.exclude).toEqual(['node_modules/**', 'dist/**']);
  });

  it('coverage 不設門檻', () => {
    expect(config.test?.coverage).not.toHaveProperty('thresholds');
  });
});
