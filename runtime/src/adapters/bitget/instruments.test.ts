import { describe, expect, it } from 'vitest';
import { normalizeBitgetInstruments } from './instruments';

// Fixture: 節錄自 GET /api/v2/mix/market/contracts?productType=USDT-FUTURES 的真實欄位形狀。
const contracts = [
  {
    symbol: 'BTCUSDT',
    baseCoin: 'BTC',
    quoteCoin: 'USDT',
    symbolType: 'perpetual',
    symbolStatus: 'normal',
    priceEndStep: '1',
    pricePlace: '1',
    sizeMultiplier: '0.001',
    minTradeNum: '0.001',
    minTradeUSDT: '5',
    fundInterval: '8',
  },
  {
    symbol: 'FOOUSDT',
    baseCoin: 'FOO',
    quoteCoin: 'USDT',
    symbolType: 'perpetual',
    symbolStatus: 'off',
    priceEndStep: '1',
    pricePlace: '2',
    sizeMultiplier: '1',
    minTradeNum: '1',
    minTradeUSDT: '5',
    fundInterval: '8',
  },
];

const fundingRateSchedule = [
  { symbol: 'BTCUSDT', nextUpdate: '1700028800000', fundingRateInterval: '8' },
];

describe('normalizeBitgetInstruments', () => {
  const result = normalizeBitgetInstruments({ contracts, fundingRateSchedule, now: 1000 });
  const byId = new Map(result.map((r) => [r.instrument_id, r]));

  it('[spec] tick_size = priceEndStep * 10^-pricePlace', () => {
    expect(byId.get('Bitget:BTCUSDT')!.tick_size).toBeCloseTo(0.1, 12);
  });

  it('[spec] qty_step from sizeMultiplier', () => {
    expect(byId.get('Bitget:BTCUSDT')!.qty_step).toBe(0.001);
  });

  it('normal status maps to TRADING, off maps to UNKNOWN', () => {
    expect(byId.get('Bitget:BTCUSDT')!.status).toBe('TRADING');
    expect(byId.get('Bitget:FOOUSDT')!.status).toBe('UNKNOWN');
  });

  it('[spec] nextUpdate + fundingRateInterval populate funding schedule', () => {
    const btc = byId.get('Bitget:BTCUSDT')!;
    expect(btc.funding.next_funding_time).toBe(1_700_028_800_000);
    expect(btc.funding.funding_interval_hours).toBe(8);
    expect(btc.funding.interval_source).toBe('EXCHANGE_FIELD');
  });

  it('missing funding-rate entry leaves schedule MISSING', () => {
    expect(byId.get('Bitget:FOOUSDT')!.funding.schedule_status).toBe('MISSING');
  });
});
