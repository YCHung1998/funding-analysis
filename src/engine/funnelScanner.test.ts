import { describe, expect, it } from 'vitest';
import { runFunnelScan } from './funnelScanner';

// 固定基準時間：距 08:00 UTC 結算 30 分鐘，1h / 4h / 8h 合約倒數皆為 1800 秒
const NOW = Date.UTC(2026, 0, 1, 7, 30, 0);

describe('runFunnelScan', () => {
  const result = runFunnelScan(NOW, 1000);
  const bySymbol = new Map(result.level1_candidates.map((c) => [c.symbol, c]));

  it('[Q-08] 現況：寫死的宇宙在固定時間下的排名與選擇', () => {
    // 修正後預期：候選宇宙來自 Instrument Registry 與即時資料，而非 RAW_UNIVERSE_SYMBOLS 常數
    expect(result.level1_candidates.map((c) => c.symbol)).toEqual([
      'DOGEUSDT', 'WIFUSDT', 'PEPEUSDT', 'SOLUSDT', 'BTCUSDT',
      'SUIUSDT', 'ETHUSDT', 'APTUSDT', 'TIAUSDT', 'NEARUSDT',
      'LINKUSDT', 'AVAXUSDT', 'OPUSDT', 'ARBUSDT', 'ADAUSDT',
    ]);
    expect(result.level1_candidates.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(result.level1_candidates[0].expected_net_pnl_pct).toBeCloseTo(0.0004, 12);
    expect(result.level1_candidates[0].expected_net_pnl_usdt).toBeCloseTo(0.4, 9);
    expect(result.level1_candidates[1].expected_net_pnl_pct).toBeCloseTo(0.0003, 12);
    expect(result.level2_top3.map((c) => c.symbol)).toEqual(['DOGEUSDT', 'WIFUSDT']);
    expect(result.level2_top3.every((c) => c.funnel_stage === 'Level2_Top3')).toBe(true);
    expect(result.level3_selected.symbol).toBe('DOGEUSDT');
    expect(result.level3_selected.funnel_stage).toBe('Level3_Selected');
  });

  it('淨值為浮點殘差的候選不進入 Level 2', () => {
    const pepe = bySymbol.get('PEPEUSDT')!;
    expect(Math.abs(pepe.expected_net_pnl_pct)).toBeLessThan(1e-15);
    expect(result.level2_top3.map((c) => c.symbol)).not.toContain('PEPEUSDT');
  });

  it('spread 低於 0.10% 被淘汰', () => {
    const eliminated = result.level1_candidates.filter((c) => c.funnel_stage === 'Eliminated').map((c) => c.symbol);
    expect(eliminated).toEqual(['LINKUSDT', 'AVAXUSDT', 'ADAUSDT']);
    expect(bySymbol.get('LINKUSDT')!.elimination_reason).toBe('Spread < 0.10% or below Top 20');
    const others = result.level1_candidates.filter((c) => !eliminated.includes(c.symbol));
    expect(others.every((c) => c.funnel_stage === 'Level1_Top20')).toBe(true);
  });

  it('[Q-06] 現況：固定 0.20% 費用拖累', () => {
    // 修正後預期：費用依各所實際 taker fee 與名目計算（見 issue/Q-06）
    expect(result.level1_candidates.every((c) => c.fee_drag_pct === 0.002)).toBe(true);
  });

  it('結算倒數依週期對齊', () => {
    for (const symbol of ['WIFUSDT', 'PEPEUSDT', 'DOGEUSDT']) {
      const c = bySymbol.get(symbol)!;
      expect(c.time_to_settlement_sec).toBe(1800);
      expect(c.settlement_time).toBe(Date.UTC(2026, 0, 1, 8));
    }
    expect(bySymbol.get('WIFUSDT')!.interval_hours).toBe(1);
    expect(bySymbol.get('PEPEUSDT')!.interval_hours).toBe(4);
    expect(bySymbol.get('DOGEUSDT')!.interval_hours).toBe(8);
  });
});
