import { describe, expect, it } from 'vitest';
import { buildInstrumentKey, resolveMultiplier } from './canonical';

describe('resolveMultiplier', () => {
  it('[spec] 1000x prefix resolved to multiplier', () => {
    const result = resolveMultiplier('1000PEPE');
    expect(result.base_asset).toBe('PEPE');
    expect(result.price_multiplier).toBe(1000);
    expect(result.qty_unit_in_base).toBe(1000);
    expect(result.multiplier_source).toBe('PREFIX');
  });

  it('[spec] 10000x and 1000000x prefixes resolved', () => {
    expect(resolveMultiplier('10000SATS').price_multiplier).toBe(10000);
    expect(resolveMultiplier('10000SATS').base_asset).toBe('SATS');
    expect(resolveMultiplier('1000000MOG').price_multiplier).toBe(1000000);
    expect(resolveMultiplier('1000000MOG').base_asset).toBe('MOG');
  });

  it('[spec] Numeric-looking ticker is not a multiplier (1INCH)', () => {
    const result = resolveMultiplier('1INCH');
    expect(result.base_asset).toBe('1INCH');
    expect(result.price_multiplier).toBe(1);
    expect(result.multiplier_source).toBe('NONE');
  });

  it('[spec] no prefix means NONE source', () => {
    const result = resolveMultiplier('BTC');
    expect(result.base_asset).toBe('BTC');
    expect(result.price_multiplier).toBe(1);
    expect(result.multiplier_source).toBe('NONE');
  });

  it('[spec] Override wins over prefix parsing', () => {
    const result = resolveMultiplier('1000X', { base_asset: '1000X', price_multiplier: 1 });
    expect(result.base_asset).toBe('1000X');
    expect(result.price_multiplier).toBe(1);
    expect(result.multiplier_source).toBe('OVERRIDE');
  });
});

describe('buildInstrumentKey', () => {
  it('builds base/quote:settle', () => {
    expect(buildInstrumentKey('BTC', 'USDT', 'USDT')).toBe('BTC/USDT:USDT');
  });

  it('[spec] reverse-quoted contract does not collapse into BTC key', () => {
    expect(buildInstrumentKey('USDT', 'BTC', 'BTC')).not.toBe(buildInstrumentKey('BTC', 'USDT', 'USDT'));
  });
});
