import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type PreTradeContext } from './types';
import { evaluatePreTrade } from './preTradeRisk';

const base: PreTradeContext = {
  now: 1_700_000_000_000,
  required_capital_usdt: 100,
  available_capital_usdt: 9000,
  non_terminal_trade_count: 0,
  target_notional_per_leg_usdt: 500,
  leverage: 3,
  leg_max_leverage: { long: 10, short: 10 },
  long_funding_rate: 0.0001,
  short_funding_rate: 0.001,
  estimated_net_pnl_usdt: 5,
  leg_estimated_slippage_pct: { long: 0.0003, short: 0.0004 },
  leg_depth_usdt: { long: 5000, short: 5000 },
  leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
  leg_instrument_status: { long: 'TRADING', short: 'TRADING' },
  leg_api_latency_samples_ms: { long: [50, 60, 70], short: [40, 50, 60] },
  funding_time_eligible: true,
  entry_deadline: 1_700_000_100_000,
  same_symbol_existing_exposure: false,
  leg_exchange_existing_notional_usdt: { long: 0, short: 0 },
  data_age_samples: [{ name: 'orderbook', ageMs: 500 }],
  leg_clock_offset: {
    long: { errorMs: 100, calibratedAt: 1_699_999_990_000 },
    short: { errorMs: 100, calibratedAt: 1_699_999_990_000 },
  },
  entry_gate_sources: {},
};

const cfg = { ...DEFAULT_RISK_CONFIG };
const optionalKeys = new Set(['entry_gate_sources']);

describe('review probe: missing input never ALLOWs', () => {
  for (const key of Object.keys(base) as (keyof PreTradeContext)[]) {
    if (optionalKeys.has(key)) continue;
    it(`top-level ${key} = undefined → not ALLOW`, () => {
      const ctx = { ...base, [key]: undefined } as unknown as PreTradeContext;
      expect(evaluatePreTrade(ctx, cfg).action).not.toBe('ALLOW');
    });
  }

  const numericTop = Object.entries(base).filter(([, v]) => typeof v === 'number').map(([k]) => k);
  for (const key of numericTop) {
    it(`top-level ${key} = NaN → not ALLOW`, () => {
      const ctx = { ...base, [key]: Number.NaN } as unknown as PreTradeContext;
      expect(evaluatePreTrade(ctx, cfg).action).not.toBe('ALLOW');
    });
  }

  for (const key of ['leg_depth_usdt', 'leg_estimated_slippage_pct', 'leg_max_leverage', 'leg_exchange_existing_notional_usdt'] as const) {
    it(`${key}.short = NaN → not ALLOW`, () => {
      const ctx = { ...base, [key]: { ...(base[key] as object), short: Number.NaN } } as unknown as PreTradeContext;
      expect(evaluatePreTrade(ctx, cfg).action).not.toBe('ALLOW');
    });
    it(`${key}.short = undefined → not ALLOW`, () => {
      const ctx = { ...base, [key]: { ...(base[key] as object), short: undefined } } as unknown as PreTradeContext;
      expect(evaluatePreTrade(ctx, cfg).action).not.toBe('ALLOW');
    });
  }

  it('empty latency samples → not ALLOW', () => {
    const ctx = { ...base, leg_api_latency_samples_ms: { long: [], short: [40] } } as unknown as PreTradeContext;
    expect(evaluatePreTrade(ctx, cfg).action).not.toBe('ALLOW');
  });

  it('empty data_age_samples → not ALLOW', () => {
    const ctx = { ...base, data_age_samples: [] } as unknown as PreTradeContext;
    expect(evaluatePreTrade(ctx, cfg).action).not.toBe('ALLOW');
  });

  it('same input twice → identical items (determinism)', () => {
    expect(evaluatePreTrade(base, cfg)).toEqual(evaluatePreTrade(base, cfg));
  });

  it('reverse direction spread fails MIN_FUNDING_SPREAD', () => {
    const r = evaluatePreTrade({ ...base, long_funding_rate: 0.0006, short_funding_rate: 0.0002 }, cfg)
      .items.find((i) => i.check_code === 'MIN_FUNDING_SPREAD')!;
    expect(r.status).toBe('FAIL');
  });
});
