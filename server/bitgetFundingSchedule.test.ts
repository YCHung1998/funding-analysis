import { describe, expect, it } from 'vitest';
import { mapBitgetFundingRateSchedule } from './bitgetFundingSchedule';

// Fixture: 節錄自 2026-10-01 GET /api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES
// （不帶 symbol，批次回傳全部合約；已驗證單次請求即可取得所有 symbol，不需逐合約呼叫）。
const response = {
  code: '00000',
  msg: 'success',
  requestTime: 1790836175426,
  data: [
    { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateInterval: '8', nextUpdate: '1790841600000', minFundingRate: '-0.003', maxFundingRate: '0.003' },
    { symbol: 'ETHUSDT', fundingRate: '0.0001', fundingRateInterval: '8', nextUpdate: '1790841600000', minFundingRate: '-0.003', maxFundingRate: '0.003' },
  ],
};

describe('mapBitgetFundingRateSchedule', () => {
  it('[spec] maps nextUpdate / fundingRateInterval into updateFundingSchedule-ready updates', () => {
    const result = mapBitgetFundingRateSchedule(response.data, 1_000_000);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      native_symbol: 'BTCUSDT',
      update: {
        next_funding_time: 1_790_841_600_000,
        funding_interval_hours: 8,
        interval_source: 'EXCHANGE_FIELD',
        exchange_timestamp: 1_000_000,
      },
    });
  });

  it('skips malformed entries without throwing', () => {
    const result = mapBitgetFundingRateSchedule([{ symbol: 'BADUSDT' } as any], 1000);
    expect(result).toEqual([]);
  });
});
