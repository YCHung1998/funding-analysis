import { describe, expect, it } from 'vitest';
import { pairNetSpreadFor } from './funnelScannerNetSpread';

describe('pairNetSpreadFor (net-cost-model: 前端讀伺服器淨值，不自行以 spread - fee_drag_pct - est_slippage_pct 重算)', () => {
  it('依兩種鍵順序查找 pair_net_spreads', () => {
    const item = { pair_net_spreads: { Binance_Bybit: 0.0003 } };
    expect(pairNetSpreadFor(item, 'Binance' as any, 'Bybit' as any)).toBeCloseTo(0.0003, 9);
    expect(pairNetSpreadFor(item, 'Bybit' as any, 'Binance' as any)).toBeCloseTo(0.0003, 9);
  });

  it('找不到該配對時回傳 undefined（呼叫端不得以毛 spread 自行重算頂替）', () => {
    const item = { pair_net_spreads: { Binance_Bybit: 0.0003 } };
    expect(pairNetSpreadFor(item, 'Binance' as any, 'OKX' as any)).toBeUndefined();
  });

  it('pair_net_spreads 缺失時回傳 undefined', () => {
    expect(pairNetSpreadFor({}, 'Binance' as any, 'Bybit' as any)).toBeUndefined();
  });
});
