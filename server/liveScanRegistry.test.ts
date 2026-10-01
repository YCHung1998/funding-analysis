import { describe, expect, it } from 'vitest';
import { buildLiveScanCandidates } from './liveScanRegistry';
import type { Instrument } from '../runtime/src/market/instruments/types';

function makeInstrument(overrides: Partial<Instrument>): Instrument {
  return {
    instrument_id: 'Binance:BTCUSDT',
    exchange: 'Binance',
    native_symbol: 'BTCUSDT',
    instrument_key: 'BTC/USDT:USDT',
    base_asset: 'BTC',
    quote_asset: 'USDT',
    settle_asset: 'USDT',
    listed_base_asset: 'BTC',
    price_multiplier: 1,
    qty_unit_in_base: 1,
    multiplier_source: 'NONE',
    contract_type: 'LINEAR_PERPETUAL',
    native_contract_type: 'PERPETUAL',
    status: 'TRADING',
    native_status: 'TRADING',
    ambiguous: false,
    tick_size: 0.1,
    qty_step: 0.001,
    min_qty: 0.001,
    min_notional: 50,
    funding: {
      next_funding_time: 10_000,
      funding_interval_hours: 8,
      interval_source: 'EXCHANGE_FIELD',
      schedule_status: 'VALID',
      exchange_timestamp: 1,
      local_received_timestamp: 1,
      updated_at: 1,
    },
    created_at: 0,
    updated_at: 0,
    status_changed_at: 0,
    last_seen_at: 0,
    ...overrides,
  };
}

const OPTS = { now: 0, funding_alignment_tolerance_ms: 60_000, price_mismatch_tolerance_pct: 0.02 };

describe('buildLiveScanCandidates', () => {
  it('[spec] Reverse contract no longer overrides BTC', () => {
    const btcBinance = makeInstrument({ instrument_id: 'Binance:BTCUSDT', exchange: 'Binance', instrument_key: 'BTC/USDT:USDT' });
    const btcPionex = makeInstrument({
      instrument_id: 'Pionex:BTC_USDT_PERP',
      exchange: 'Pionex',
      native_symbol: 'BTC_USDT_PERP',
      instrument_key: 'BTC/USDT:USDT',
      funding: { ...btcBinance.funding, next_funding_time: 10_400 },
    });
    const usdtBtcPionex = makeInstrument({
      instrument_id: 'Pionex:USDT_BTC_PERP',
      exchange: 'Pionex',
      native_symbol: 'USDT_BTC_PERP',
      instrument_key: 'USDT/BTC:BTC',
      base_asset: 'USDT',
      quote_asset: 'BTC',
      contract_type: 'INVERSE_PERPETUAL',
    });

    const instrumentsByKey = new Map([
      ['BTC/USDT:USDT', [btcBinance, btcPionex]],
      ['USDT/BTC:BTC', [usdtBtcPionex]],
    ]);

    const legData = new Map([
      ['Binance:BTCUSDT', { rate: 0.0001, mark: 60000, volume_24h: 200_000_000 }],
      ['Pionex:BTC_USDT_PERP', { rate: 0.0000163, mark: 60010, volume_24h: 50_000_000 }],
      ['Pionex:USDT_BTC_PERP', { rate: -0.000033, mark: 1, volume_24h: 1_000_000 }],
    ]);

    const result = buildLiveScanCandidates({ instrumentsByKey, legData, ...OPTS });
    const btc = result.find((c) => c.instrument_key === 'BTC/USDT:USDT')!;
    expect(btc).toBeDefined();
    expect(btc.pionex_rate).toBeCloseTo(0.0000163, 12);
  });

  it('[spec] Misaligned best pair excluded (4h vs 8h, not min(T))', () => {
    const binance = makeInstrument({
      instrument_id: 'Binance:XUSDT',
      exchange: 'Binance',
      native_symbol: 'XUSDT',
      instrument_key: 'X/USDT:USDT',
      funding: { ...makeInstrument({}).funding, next_funding_time: 1000, funding_interval_hours: 4 },
    });
    const okx = makeInstrument({
      instrument_id: 'OKX:X-USDT-SWAP',
      exchange: 'OKX',
      native_symbol: 'X-USDT-SWAP',
      instrument_key: 'X/USDT:USDT',
      funding: { ...makeInstrument({}).funding, next_funding_time: 1000 + 4 * 3600 * 1000, funding_interval_hours: 8 },
    });

    const instrumentsByKey = new Map([['X/USDT:USDT', [binance, okx]]]);
    const legData = new Map([
      ['Binance:XUSDT', { rate: 0.0001, mark: 1, volume_24h: 10_000_000 }],
      ['OKX:X-USDT-SWAP', { rate: 0.0005, mark: 1, volume_24h: 10_000_000 }],
    ]);

    const result = buildLiveScanCandidates({ instrumentsByKey, legData, ...OPTS });
    expect(result.find((c) => c.instrument_key === 'X/USDT:USDT')).toBeUndefined();
  });

  it('[spec] Missing volume eliminates instead of defaulting to 10,000,000', () => {
    const a = makeInstrument({ instrument_id: 'Binance:YUSDT', exchange: 'Binance', native_symbol: 'YUSDT', instrument_key: 'Y/USDT:USDT' });
    const b = makeInstrument({
      instrument_id: 'Bybit:YUSDT',
      exchange: 'Bybit',
      native_symbol: 'YUSDT',
      instrument_key: 'Y/USDT:USDT',
      funding: { ...a.funding, next_funding_time: 10_200 },
    });
    const instrumentsByKey = new Map([['Y/USDT:USDT', [a, b]]]);
    const legData = new Map([
      ['Binance:YUSDT', { rate: 0.0001, mark: 1, volume_24h: 5_000_000 }],
      ['Bybit:YUSDT', { rate: 0.0003, mark: 1, volume_24h: null }],
    ]);
    const result = buildLiveScanCandidates({ instrumentsByKey, legData, ...OPTS });
    expect(result.find((c) => c.instrument_key === 'Y/USDT:USDT')).toBeUndefined();
    expect(result.every((c) => c.volume_24h !== 10_000_000)).toBe(true);
  });

  it('candidates with matched pairs include new alignment fields and are ranked by net spread (net-cost-model)', () => {
    const a = makeInstrument({ instrument_id: 'Binance:ZUSDT', exchange: 'Binance', native_symbol: 'ZUSDT', instrument_key: 'Z/USDT:USDT' });
    const b = makeInstrument({
      instrument_id: 'Bybit:ZUSDT',
      exchange: 'Bybit',
      native_symbol: 'ZUSDT',
      instrument_key: 'Z/USDT:USDT',
      funding: { ...a.funding, next_funding_time: 10_300 },
    });
    const instrumentsByKey = new Map([['Z/USDT:USDT', [a, b]]]);
    const legData = new Map([
      ['Binance:ZUSDT', { rate: 0.0001, mark: 1, volume_24h: 50_000_000 }],
      ['Bybit:ZUSDT', { rate: 0.0005, mark: 1, volume_24h: 50_000_000 }],
    ]);
    const result = buildLiveScanCandidates({ instrumentsByKey, legData, ...OPTS });
    expect(result).toHaveLength(1);
    expect(result[0].funding_aligned).toBe(true);
    expect(result[0].rank).toBe(1);
    expect(result[0].long_funding_time).toBeTypeOf('number');
    expect(result[0].short_funding_time).toBeTypeOf('number');
    // net-cost-model 新欄位
    expect(result[0].net_spread_pct).toBeTypeOf('number');
    expect(result[0].pair_net_spreads).toBeDefined();
    expect(result[0].slippage_model.long).toBe('LEGACY_VOLUME_TIER');
    expect(result[0].slippage_model.short).toBe('LEGACY_VOLUME_TIER');
    expect(result[0].fee_config_version).toBeTruthy();
    expect(result[0].entry_basis_pct).toBeTypeOf('number');
  });

  it('[spec] 毛 spread 最大者不再排第一（Q-06 MEW）：best_pair / sort 依淨值而非毛 spread', () => {
    const xLong = makeInstrument({ instrument_id: 'Binance:XUSDT', exchange: 'Binance', native_symbol: 'XUSDT', instrument_key: 'X/USDT:USDT' });
    const xShort = makeInstrument({
      instrument_id: 'Bybit:XUSDT',
      exchange: 'Bybit',
      native_symbol: 'XUSDT',
      instrument_key: 'X/USDT:USDT',
      funding: { ...xLong.funding, next_funding_time: xLong.funding.next_funding_time },
    });
    const yLong = makeInstrument({ instrument_id: 'Binance:YUSDT', exchange: 'Binance', native_symbol: 'YUSDT', instrument_key: 'Y/USDT:USDT' });
    const yShort = makeInstrument({
      instrument_id: 'Bybit:YUSDT',
      exchange: 'Bybit',
      native_symbol: 'YUSDT',
      instrument_key: 'Y/USDT:USDT',
      funding: { ...yLong.funding, next_funding_time: yLong.funding.next_funding_time },
    });

    const instrumentsByKey = new Map([
      ['X/USDT:USDT', [xLong, xShort]],
      ['Y/USDT:USDT', [yLong, yShort]],
    ]);
    // X: 毛 0.0040（較大），量能低 (1M -> 最低一級滑價 0.0005/腿，四筆合計 2.0 USDT)，手續費 2.1 USDT
    //    -> funding 4.0 - slippage 2.0 - fees 2.1 = net -0.1 USDT (< 0)
    // Y: 毛 0.0030（較小），量能高 (150M -> 0.00015/腿，四筆合計 0.6 USDT)，手續費 2.1 USDT
    //    -> funding 3.0 - slippage 0.6 - fees 2.1 = net 0.3 USDT (> 0)：毛 spread 較小但淨值較高
    const legData = new Map([
      ['Binance:XUSDT', { rate: 0, mark: 1, volume_24h: 1_000_000 }],
      ['Bybit:XUSDT', { rate: 0.004, mark: 1, volume_24h: 1_000_000 }],
      ['Binance:YUSDT', { rate: 0, mark: 1, volume_24h: 150_000_000 }],
      ['Bybit:YUSDT', { rate: 0.003, mark: 1, volume_24h: 150_000_000 }],
    ]);

    const result = buildLiveScanCandidates({ instrumentsByKey, legData, ...OPTS });
    const x = result.find((c) => c.instrument_key === 'X/USDT:USDT')!;
    const y = result.find((c) => c.instrument_key === 'Y/USDT:USDT')!;
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    expect(y.rank!).toBeLessThan(x.rank!);
    expect(x.meets_threshold).toBe(false);
    expect(y.meets_threshold).toBe(true);

    // [Integrator review] pct fields MUST reconcile with expected_net_pnl_usdt using a single,
    // consistent single-leg notional (target_notional_per_leg_usdt) — not a mix of 1x and 2x.
    for (const candidate of [x, y]) {
      const notional = candidate.target_notional_per_leg_usdt;
      const reconstructedNetUsdt =
        candidate.spread * notional - candidate.fee_drag_pct * notional - candidate.est_slippage_pct * notional + candidate.entry_basis_pct * 0; // basis=0 in this fixture (mark=mid=1 both legs)
      expect(reconstructedNetUsdt).toBeCloseTo(candidate.expected_net_pnl_usdt, 9);
    }
  });
});
