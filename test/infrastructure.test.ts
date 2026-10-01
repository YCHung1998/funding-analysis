import { describe, expect, it } from 'vitest';
import config from '../vitest.config';
import { NETWORK_DISABLED_MESSAGE } from '../vitest.setup';

describe('test infrastructure', () => {
  it('fetch 在測試中被禁止', () => {
    expect(() => fetch('https://fapi.binance.com/fapi/v1/premiumIndex')).toThrow(NETWORK_DISABLED_MESSAGE);
  });

  it('test.include 含四個納入樣式（含 runtime）', () => {
    expect(config.test?.include).toEqual([
      'src/**/*.test.ts',
      'server/**/*.test.ts',
      'runtime/**/*.test.ts',
      'test/**/*.test.ts',
    ]);
  });

  it('排除 node_modules 與 dist', () => {
    expect(config.test?.exclude).toEqual(['node_modules/**', 'dist/**']);
  });

  it('coverage 不設門檻', () => {
    expect(config.test?.coverage).not.toHaveProperty('thresholds');
  });
});
