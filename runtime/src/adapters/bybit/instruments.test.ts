import { describe, expect, it } from 'vitest';
import { normalizeBybitInstruments } from './instruments';

// Fixture: 節錄自 GET /v5/market/instruments-info?category=linear 的真實欄位形狀。
const instrumentsInfo = [
  {
    symbol: 'BTCUSDT',
    baseCoin: 'BTC',
    quoteCoin: 'USDT',
    settleCoin: 'USDT',
    contractType: 'LinearPerpetual',
    status: 'Trading',
    symbolType: 'perpetual',
    fundingInterval: 480,
    priceFilter: { tickSize: '0.1' },
    lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', minNotionalValue: '5' },
  },
  {
    symbol: 'MSTRUSDT',
    baseCoin: 'MSTR',
    quoteCoin: 'USDT',
    settleCoin: 'USDT',
    contractType: 'LinearPerpetual',
    status: 'Trading',
    symbolType: 'stock',
    fundingInterval: 480,
    priceFilter: { tickSize: '0.01' },
    lotSizeFilter: { qtyStep: '1', minOrderQty: '1', minNotionalValue: '5' },
  },
  {
    symbol: 'XUSDT',
    baseCoin: 'X',
    quoteCoin: 'USDT',
    settleCoin: 'USDT',
    contractType: 'LinearPerpetual',
    status: 'Delivering',
    symbolType: 'perpetual',
    fundingInterval: 60,
    priceFilter: { tickSize: '0.001' },
    lotSizeFilter: { qtyStep: '1', minOrderQty: '1' },
  },
];

const tickers = [
  { symbol: 'BTCUSDT', nextFundingTime: '1700028800000' },
  { symbol: 'MSTRUSDT', nextFundingTime: '1700028800000' },
];

describe('normalizeBybitInstruments', () => {
  const result = normalizeBybitInstruments({ instrumentsInfo, tickers, now: 1000 });
  const byId = new Map(result.map((r) => [r.instrument_id, r]));

  it('[spec] symbolType stock maps to TRADFI_PERPETUAL', () => {
    expect(byId.get('Bybit:MSTRUSDT')!.contract_type).toBe('TRADFI_PERPETUAL');
  });

  it('[spec] Delivering maps to DELISTING', () => {
    expect(byId.get('Bybit:XUSDT')!.status).toBe('DELISTING');
    expect(byId.get('Bybit:XUSDT')!.native_status).toBe('Delivering');
  });

  it('[spec] fundingInterval minutes converted to hours', () => {
    expect(byId.get('Bybit:BTCUSDT')!.funding.funding_interval_hours).toBe(8);
    expect(byId.get('Bybit:XUSDT')!.funding.funding_interval_hours).toBe(1);
  });

  it('lotSizeFilter / priceFilter mapped to order spec fields', () => {
    const btc = byId.get('Bybit:BTCUSDT')!;
    expect(btc.tick_size).toBe(0.1);
    expect(btc.qty_step).toBe(0.001);
    expect(btc.min_qty).toBe(0.001);
    expect(btc.min_notional).toBe(5);
  });

  it('missing minNotionalValue becomes null', () => {
    expect(byId.get('Bybit:XUSDT')!.min_notional).toBeNull();
  });
});
