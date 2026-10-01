import { describe, expect, it } from 'vitest';
import { normalizePionexInstruments } from './instruments';

// Fixture: 節錄自 GET /api/v1/common/symbols?type=PERP 的真實欄位形狀。
const symbols = [
  {
    symbol: 'BTC_USDT_PERP',
    baseCurrency: 'BTC',
    quoteCurrency: 'USDT',
    status: 'TRADING',
    quoteStep: '0.1',
    baseStep: '0.001',
    minSizeLimit: '0.001',
    minNotional: '5',
  },
  {
    symbol: 'USDT_BTC_PERP',
    baseCurrency: 'USDT',
    quoteCurrency: 'BTC',
    status: 'TRADING',
    quoteStep: '0.00000001',
    baseStep: '1',
    minSizeLimit: '1',
    minNotional: '5',
  },
  {
    symbol: 'OLD_USDT_PERP',
    baseCurrency: 'OLD',
    quoteCurrency: 'USDT',
    status: 'SETTLING',
    quoteStep: '0.01',
    baseStep: '1',
    minSizeLimit: '1',
    minNotional: '5',
  },
];

const indexes = [{ symbol: 'BTC_USDT_PERP', nextFundingTime: 1_700_028_800_000 }];

describe('normalizePionexInstruments', () => {
  const result = normalizePionexInstruments({ symbols, indexes, now: 1000 });
  const byId = new Map(result.map((r) => [r.instrument_id, r]));

  it('[spec] linear BTC_USDT_PERP keeps BTC/USDT:USDT key', () => {
    const btc = byId.get('Pionex:BTC_USDT_PERP')!;
    expect(btc.instrument_key).toBe('BTC/USDT:USDT');
    expect(btc.contract_type).toBe('LINEAR_PERPETUAL');
  });

  it('[spec] reverse-quoted USDT_BTC_PERP becomes INVERSE_PERPETUAL and does not collapse into BTC', () => {
    const inverse = byId.get('Pionex:USDT_BTC_PERP')!;
    expect(inverse.base_asset).toBe('USDT');
    expect(inverse.quote_asset).toBe('BTC');
    expect(inverse.contract_type).toBe('INVERSE_PERPETUAL');
    expect(inverse.instrument_key).not.toBe(byId.get('Pionex:BTC_USDT_PERP')!.instrument_key);
  });

  it('[spec] no period field means interval UNKNOWN', () => {
    expect(byId.get('Pionex:BTC_USDT_PERP')!.funding.interval_source).toBe('UNKNOWN');
    expect(byId.get('Pionex:BTC_USDT_PERP')!.funding.funding_interval_hours).toBeNull();
  });

  it('nextFundingTime from indexes populates funding schedule', () => {
    expect(byId.get('Pionex:BTC_USDT_PERP')!.funding.next_funding_time).toBe(1_700_028_800_000);
  });

  it('unknown native status (SETTLING) maps to UNKNOWN (Pionex has no documented delisting status)', () => {
    expect(byId.get('Pionex:OLD_USDT_PERP')!.status).toBe('UNKNOWN');
  });
});
