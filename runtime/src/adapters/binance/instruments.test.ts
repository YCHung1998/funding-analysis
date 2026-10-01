import { describe, expect, it } from 'vitest';
import { normalizeBinanceInstruments } from './instruments';

// Fixture: 節錄自 2026-09-30 GET /fapi/v1/exchangeInfo 的真實欄位形狀（去除非必要欄位）。
const exchangeInfo = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '50' },
      ],
    },
    {
      symbol: '1000PEPEUSDT',
      baseAsset: '1000PEPE',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.000001' },
        { filterType: 'LOT_SIZE', stepSize: '1', minQty: '1' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    },
    {
      symbol: 'STORJUSDT',
      baseAsset: 'STORJ',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'SETTLING',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.0001' }],
    },
    {
      symbol: 'MSTRUSDT',
      baseAsset: 'MSTR',
      quoteAsset: 'USDT',
      contractType: 'TRADIFI_PERPETUAL',
      status: 'TRADING',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }],
    },
    {
      symbol: 'WEIRDUSDT',
      baseAsset: 'WEIRD',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'CLOSE',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }],
    },
  ],
};

const fundingInfo = [{ symbol: '1000PEPEUSDT', fundingIntervalHours: 4 }];

const premiumIndex = [
  { symbol: 'BTCUSDT', nextFundingTime: 1_700_028_800_000 },
  { symbol: '1000PEPEUSDT', nextFundingTime: 1_700_028_800_000 },
  { symbol: 'STORJUSDT', nextFundingTime: 0 },
];

describe('normalizeBinanceInstruments', () => {
  const result = normalizeBinanceInstruments({ exchangeInfo, fundingInfo, premiumIndex, now: 1000 });
  const byId = new Map(result.map((r) => [r.instrument_id, r]));

  it('[spec] interval from fundingInfo when listed', () => {
    expect(byId.get('Binance:1000PEPEUSDT')!.funding.funding_interval_hours).toBe(4);
    expect(byId.get('Binance:1000PEPEUSDT')!.funding.interval_source).toBe('EXCHANGE_FIELD');
  });

  it('[spec] symbol absent from fundingInfo defaults to 8h EXCHANGE_DOC_DEFAULT', () => {
    expect(byId.get('Binance:BTCUSDT')!.funding.funding_interval_hours).toBe(8);
    expect(byId.get('Binance:BTCUSDT')!.funding.interval_source).toBe('EXCHANGE_DOC_DEFAULT');
  });

  it('[spec] SETTLING maps to DELISTING, native_status preserved', () => {
    const storj = byId.get('Binance:STORJUSDT')!;
    expect(storj.status).toBe('DELISTING');
    expect(storj.native_status).toBe('SETTLING');
  });

  it('[spec] TRADIFI_PERPETUAL classified separately', () => {
    expect(byId.get('Binance:MSTRUSDT')!.contract_type).toBe('TRADFI_PERPETUAL');
  });

  it('[spec] zero nextFundingTime is missing', () => {
    expect(byId.get('Binance:STORJUSDT')!.funding.next_funding_time).toBeNull();
  });

  it('[spec] 1000x prefix resolved via canonical multiplier parsing', () => {
    const pepe = byId.get('Binance:1000PEPEUSDT')!;
    expect(pepe.base_asset).toBe('PEPE');
    expect(pepe.price_multiplier).toBe(1000);
    expect(pepe.instrument_key).toBe('PEPE/USDT:USDT');
  });

  it('unknown native status maps to UNKNOWN and reports via onUnknown', () => {
    const seen: Array<{ field: string; value: string; nativeSymbol: string }> = [];
    const r = normalizeBinanceInstruments({
      exchangeInfo,
      fundingInfo,
      premiumIndex,
      now: 1000,
      onUnknown: (field, value, nativeSymbol) => seen.push({ field, value, nativeSymbol }),
    });
    const weird = r.find((i) => i.instrument_id === 'Binance:WEIRDUSDT')!;
    expect(weird.status).toBe('UNKNOWN');
    expect(seen).toContainEqual({ field: 'status', value: 'CLOSE', nativeSymbol: 'WEIRDUSDT' });
  });

  it('multiplier_overrides takes precedence', () => {
    const r = normalizeBinanceInstruments({
      exchangeInfo: { symbols: [{ ...exchangeInfo.symbols[1], baseAsset: '1000X', symbol: '1000XUSDT' }] },
      fundingInfo: [],
      premiumIndex: [],
      now: 1000,
      overrides: { 'Binance:1000XUSDT': { base_asset: '1000X', price_multiplier: 1 } },
    });
    expect(r[0].base_asset).toBe('1000X');
    expect(r[0].price_multiplier).toBe(1);
    expect(r[0].multiplier_source).toBe('OVERRIDE');
  });
});
