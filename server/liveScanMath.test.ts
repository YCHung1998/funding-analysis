import { describe, expect, it } from 'vitest';
import { computeLiveScanNetPnl, extractBaseSymbol, findBestPair, resolveSettlement } from './liveScanMath';

// [Q-03] 量缺值時假設 1,000 萬（`|| 10000000`）位於 server.ts 的 getOrCreate 閉包，本 change 未抽出、未鎖住；
// 由 instrument-registry / B4 處理時補測試。
//
// instrument-registry change 說明：`extractBaseSymbol` / `findBestPair` / `resolveSettlement` 已不再被
// `server.ts` 呼叫（改由 Instrument Registry + `server/liveScanRegistry.ts#buildLiveScanCandidates` 取代），
// 但本檔刻意保留、不刪除、不修改期望值——它們仍如實描述這三個函式本身的（未變更）行為，做為回退
// 保護與歷史紀錄。下列測試是這些 Q-xx 現況案例在新架構下「修正後」的對應版本（fail-then-pass 證據見
// 各檔案 git history）：
//   - [Q-01] USDT_BTC_PERP 覆蓋 BTC
//     -> runtime/src/market/instruments/canonical.test.ts「reverse-quoted contract does not collapse」
//     -> server/liveScanRegistry.test.ts「Reverse contract no longer overrides BTC」
//   - [Q-01][P6] 1000x 倍數前綴遺失
//     -> runtime/src/market/instruments/canonical.test.ts「1000x prefix resolved to multiplier」
//     -> runtime/src/market/instruments/matching.test.ts「1000x pair normalizes prices」
//   - [Q-02][P1][P2] 不同週期費率直接相減 / 取最早結算時間 min(T)
//     -> runtime/src/market/instruments/matching.test.ts「4h leg and 8h leg at different times rejected」
//     -> server/liveScanRegistry.test.ts「Misaligned best pair excluded」
//   - [Q-02] 無有效結算時間時假設 8 小時
//     -> runtime/src/market/instruments/matching.test.ts「Missing funding time rejected」
//        （registry 以 STALE/MISSING 取代外推，不假設 8h）
//   - [Q-03] SETTLING 腿照樣配對
//     -> runtime/src/adapters/binance/instruments.test.ts「SETTLING maps to DELISTING」
//     -> runtime/src/market/instruments/matching.test.ts「Delisting leg rejected」
//   - [P3] 量缺值時假設 1,000 萬
//     -> server/liveScanRegistry.test.ts「Missing volume eliminates instead of defaulting」
//   - [BE-09] live-klines 符號未驗證、1000x 符號轉換錯誤
//     -> server/liveKlinesResolve.test.ts

const EXCHANGES = ['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'] as const;

describe('extractBaseSymbol', () => {
  it('各所線性合約映射到同一 base', () => {
    expect(extractBaseSymbol('BTCUSDT')).toBe('BTC');
    expect(extractBaseSymbol('BTC_USDT_PERP')).toBe('BTC');
    expect(extractBaseSymbol('BTC-USDT-SWAP')).toBe('BTC');
    expect(extractBaseSymbol('btcusdt')).toBe('BTC');
  });

  it('[Q-01] 現況：反向合約被併成 BTC', () => {
    // 修正後預期：USDT_BTC_PERP 不得映射到 BTC 線性合約（以 Instrument Registry 合約類型區分）
    expect(extractBaseSymbol('USDT_BTC_PERP')).toBe('BTC');
  });

  it('[Q-01][P6] 現況：倍數前綴被丟棄', () => {
    // 修正後預期：保留倍數資訊（instrument_key 與價格倍數），1000PEPE 不得與 PEPE 視為同一合約
    expect(extractBaseSymbol('1000PEPEUSDT')).toBe('PEPE');
    expect(extractBaseSymbol('10000SATSUSDT')).toBe('SATS');
    expect(extractBaseSymbol('1000000MOGUSDT')).toBe('MOG');
  });

  it('非倍數的數字開頭不受影響', () => {
    expect(extractBaseSymbol('1INCHUSDT')).toBe('1INCH');
  });
});

describe('findBestPair', () => {
  it('取最大 spread 並決定多空（費率低者做多）', () => {
    const result = findBestPair({ Pionex: 0.001, Binance: 0.0001, Bybit: 0.0005 }, EXCHANGES);
    expect(result).not.toBeNull();
    expect(result!.activeExchanges).toEqual(['Pionex', 'Binance', 'Bybit']);
    expect(result!.maxSpread).toBeCloseTo(0.0009, 12);
    expect(result!.bestLongEx).toBe('Binance');
    expect(result!.bestShortEx).toBe('Pionex');
    expect(Object.keys(result!.pairSpreads)).toEqual(['Pionex_Binance', 'Pionex_Bybit', 'Binance_Bybit']);
    expect(result!.pairSpreads.Pionex_Bybit).toBeCloseTo(0.0005, 12);
    expect(result!.pairSpreads.Binance_Bybit).toBeCloseTo(0.0004, 12);
  });

  it('少於兩所有費率時不產生配對', () => {
    expect(findBestPair({ Binance: 0.0001 }, EXCHANGES)).toBeNull();
    expect(findBestPair({}, EXCHANGES)).toBeNull();
  });

  it('所有費率相同時的預設配對', () => {
    const result = findBestPair({ Binance: 0.0001, Bybit: 0.0001 }, EXCHANGES);
    expect(result!.maxSpread).toBe(0);
    expect(result!.bestLongEx).toBe('Binance');
    expect(result!.bestShortEx).toBe('Bybit');
  });

  it('[Q-02][P1] 現況：不同週期費率直接相減', () => {
    // 修正後預期：Bybit 1h 與 Binance 8h 費率須先換算到同一時間基準（或依結算對齊規則淘汰）再比較
    const result = findBestPair({ Bybit: 0.0005, Binance: 0.0001 }, EXCHANGES);
    expect(result!.maxSpread).toBeCloseTo(0.0004, 12);
    expect(result!.bestLongEx).toBe('Binance');
    expect(result!.bestShortEx).toBe('Bybit');
  });
});

describe('computeLiveScanNetPnl', () => {
  it('[Q-05][P4] 現況：量能三級滑價', () => {
    // 修正後預期：滑價依盤口深度逐筆估算（net-cost-model），不以 24h 量三級常數代替
    expect(computeLiveScanNetPnl(0.004, 150_000_000).estSlippagePct).toBeCloseTo(0.0006, 12);
    expect(computeLiveScanNetPnl(0.004, 50_000_000).estSlippagePct).toBeCloseTo(0.0012, 12);
    expect(computeLiveScanNetPnl(0.004, 10_000_000).estSlippagePct).toBeCloseTo(0.002, 12);
  });

  it('量能級距邊界為嚴格大於', () => {
    expect(computeLiveScanNetPnl(0.004, 100_000_000).estSlippagePct).toBeCloseTo(0.0012, 12);
    expect(computeLiveScanNetPnl(0.004, 20_000_000).estSlippagePct).toBeCloseTo(0.002, 12);
  });

  it('[Q-06] 現況：固定 0.20% 費用與淨值計算', () => {
    // 修正後預期：費用依各所實際 taker fee 計算（見 issue/Q-06）
    const result = computeLiveScanNetPnl(0.004, 150_000_000);
    expect(result.feeDragPct).toBe(0.002);
    expect(result.expectedNetPnlPct).toBeCloseTo(0.0014, 12);
    expect(result.expectedNetPnlUsdt).toBeCloseTo(1.4, 9);
    expect(result.meetsThreshold).toBe(true);
  });

  it('門檻判定包含等號', () => {
    expect(computeLiveScanNetPnl(0.002, 150_000_000).meetsThreshold).toBe(true);
    expect(computeLiveScanNetPnl(0.0019, 150_000_000).meetsThreshold).toBe(false);
  });
});

describe('resolveSettlement', () => {
  it('[Q-02][P2] 現況：取最早的未來結算時間', () => {
    // 修正後預期：兩腿結算時間須各自比對並檢查對齊（funding_alignment_tolerance_ms），不得取 min 混用
    const result = resolveSettlement({ Binance: 3_600_000, Bybit: 1_800_000, Pionex: -1 }, {}, 0);
    expect(result.nextFundingTime).toBe(1_800_000);
    expect(result.timeToSettlementSec).toBe(1800);
  });

  it('[Q-02] 現況：無有效結算時間時假設 8 小時（違反 Invariant 4）', () => {
    // 修正後預期：無有效結算時間時標示 STALE / 淘汰，不得以「+ 8h」推算
    const result = resolveSettlement({ Binance: -5 }, {}, 0);
    expect(result.nextFundingTime).toBe(28_800_000);
    expect(result.timeToSettlementSec).toBe(28_800);
  });

  it('週期取最小值，缺值為 8', () => {
    expect(resolveSettlement({}, { Bybit: 4, Binance: 8 }, 0).intervalHours).toBe(4);
    expect(resolveSettlement({}, {}, 0).intervalHours).toBe(8);
  });
});
