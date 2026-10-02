import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type PreTradeContext, type RiskConfig } from './types';
import { evaluatePreFlight, evaluatePreTrade } from './preTradeRisk';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

const baseCtx: PreTradeContext = {
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

function withCtx(overrides: Partial<PreTradeContext>): PreTradeContext {
  return { ...baseCtx, ...overrides };
}

describe('evaluatePreTrade — all 15 PASS → ALLOW', () => {
  it('passes every check and ALLOWs', () => {
    const evalResult = evaluatePreTrade(baseCtx, cfg);
    expect(evalResult.items).toHaveLength(15);
    expect(evalResult.items.every((i) => i.status === 'PASS')).toBe(true);
    expect(evalResult.action).toBe('ALLOW');
    expect(evalResult.failed_reasons).toEqual([]);
  });
});

describe('CAPITAL', () => {
  it('FAILs when required > available (spec scenario)', () => {
    const ctx = withCtx({ required_capital_usdt: 454, available_capital_usdt: 400 });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'CAPITAL')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('INSUFFICIENT_CAPITAL');
    expect(r.value).toBe('454 / 400');
  });

  it('PASSes when available sufficient', () => {
    const ctx = withCtx({ required_capital_usdt: 454, available_capital_usdt: 9000 });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'CAPITAL')!;
    expect(r.status).toBe('PASS');
  });

  it('INPUT_MISSING when required_capital_usdt is absent', () => {
    const ctx = withCtx({ required_capital_usdt: undefined });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'CAPITAL')!;
    expect(r.status).toBe('FAIL');
    expect(r.value).toBe('UNKNOWN');
    expect(r.reason_code).toBe('INPUT_MISSING');
  });
});

describe('MAX_POSITIONS', () => {
  it('FAILs at global limit', () => {
    const ctx = withCtx({ non_terminal_trade_count: 3 });
    const localCfg = { ...cfg, max_positions: 3 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MAX_POSITIONS')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('MAX_POSITIONS');
  });

  it('FAILs at per-session limit', () => {
    const ctx = withCtx({ non_terminal_trade_count: 0, non_terminal_trade_count_in_session: 1 });
    const localCfg = { ...cfg, max_positions: 5, max_positions_per_session: 1 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MAX_POSITIONS')!;
    expect(r.status).toBe('FAIL');
  });
});

describe('MAX_NOTIONAL_PER_LEG', () => {
  it('FAILs over limit', () => {
    const ctx = withCtx({ target_notional_per_leg_usdt: 1200 });
    const localCfg = { ...cfg, max_notional_per_leg_usdt: 1000 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MAX_NOTIONAL_PER_LEG')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('MAX_NOTIONAL_EXCEEDED');
  });
});

describe('MAX_LEVERAGE', () => {
  it('FAILs over config max', () => {
    const ctx = withCtx({ leverage: 10 });
    const localCfg = { ...cfg, max_leverage: 5 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MAX_LEVERAGE')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('MAX_LEVERAGE_EXCEEDED');
  });

  it('FAILs over leg instrument max even if under config max', () => {
    const ctx = withCtx({ leverage: 5, leg_max_leverage: { long: 10, short: 4 } });
    const localCfg = { ...cfg, max_leverage: 5 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MAX_LEVERAGE')!;
    expect(r.status).toBe('FAIL');
    expect(r.value).toContain('short');
  });
});

describe('MIN_FUNDING_SPREAD', () => {
  it('FAILs when spread below threshold', () => {
    const ctx = withCtx({ long_funding_rate: 0.0001, short_funding_rate: 0.0004 });
    const localCfg = { ...cfg, minimum_funding_spread_pct: 0.0005 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MIN_FUNDING_SPREAD')!;
    expect(r.status).toBe('FAIL');
  });

  it('FAILs on reversed direction (negative spread)', () => {
    const ctx = withCtx({ long_funding_rate: 0.0006, short_funding_rate: 0.0002 });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'MIN_FUNDING_SPREAD')!;
    expect(r.status).toBe('FAIL');
  });
});

describe('EXPECTED_NET_PNL', () => {
  it('FAILs below minimum', () => {
    const ctx = withCtx({ estimated_net_pnl_usdt: 0.8 });
    const localCfg = { ...cfg, minimum_expected_net_pnl_usdt: 1.0 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'EXPECTED_NET_PNL')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('BELOW_MIN_NET_PNL');
  });
});

describe('MAX_SLIPPAGE', () => {
  it('FAILs when one leg exceeds threshold', () => {
    const ctx = withCtx({ leg_estimated_slippage_pct: { long: 0.0004, short: 0.0012 } });
    const localCfg = { ...cfg, max_slippage_pct: 0.001 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'MAX_SLIPPAGE')!;
    expect(r.status).toBe('FAIL');
    expect(r.value).toContain('short');
  });
});

describe('ORDERBOOK_DEPTH', () => {
  it('FAILs when depth below target x coverage ratio', () => {
    const ctx = withCtx({ target_notional_per_leg_usdt: 1000, leg_depth_usdt: { long: 5200, short: 2400 } });
    const localCfg = { ...cfg, depth_coverage_ratio: 3 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'ORDERBOOK_DEPTH')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('INSUFFICIENT_DEPTH');
  });

  it('PASSes when both legs cover', () => {
    const ctx = withCtx({ target_notional_per_leg_usdt: 1000, leg_depth_usdt: { long: 5200, short: 3100 } });
    const localCfg = { ...cfg, depth_coverage_ratio: 3 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'ORDERBOOK_DEPTH')!;
    expect(r.status).toBe('PASS');
  });

  it('MUST NOT be computed from 24h volume (ctx has no such field)', () => {
    expect('volume_24h' in baseCtx).toBe(false);
  });
});

describe('EXCHANGE_CONNECTIVITY', () => {
  it('FAILs when a leg exchange is DISCONNECTED', () => {
    const ctx = withCtx({ leg_connectivity: { long: 'CONNECTED', short: 'DISCONNECTED' } });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'EXCHANGE_CONNECTIVITY')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('EXCHANGE_DISCONNECTED');
  });

  it('FAILs when an instrument is DELISTED', () => {
    const ctx = withCtx({ leg_instrument_status: { long: 'DELISTED', short: 'TRADING' } });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'EXCHANGE_CONNECTIVITY')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('INSTRUMENT_NOT_TRADING');
  });
});

describe('API_LATENCY', () => {
  it('FAILs over max', () => {
    const ctx = withCtx({ leg_api_latency_samples_ms: { long: [640, 650, 660], short: [100, 110, 120] } });
    const localCfg = { ...cfg, max_api_latency_ms: 500, warn_api_latency_ms: 200 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'API_LATENCY')!;
    expect(r.status).toBe('FAIL');
  });

  it('WARNs between warn and max (does not block ALLOW)', () => {
    const ctx = withCtx({ leg_api_latency_samples_ms: { long: [240, 250, 260], short: [110, 120, 130] } });
    const localCfg = { ...cfg, max_api_latency_ms: 500, warn_api_latency_ms: 200 };
    const result = evaluatePreTrade(ctx, localCfg);
    const r = result.items.find((i) => i.check_code === 'API_LATENCY')!;
    expect(r.status).toBe('WARN');
    expect(result.action).toBe('ALLOW');
  });
});

describe('FUNDING_TIME_ALIGNMENT', () => {
  it('FAILs when ineligible (not aligned)', () => {
    const ctx = withCtx({ funding_time_eligible: false, funding_time_fail_reason: 'FUNDING_NOT_ALIGNED' });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'FUNDING_TIME_ALIGNMENT')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('FUNDING_NOT_ALIGNED');
  });

  it('FAILs when entry window has closed', () => {
    const ctx = withCtx({ funding_time_eligible: true, now: 1_700_000_200_000, entry_deadline: 1_700_000_100_000 });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'FUNDING_TIME_ALIGNMENT')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('ENTRY_WINDOW_CLOSED');
  });
});

describe('EXISTING_EXPOSURE', () => {
  it('FAILs on same-symbol existing non-terminal Trade', () => {
    const ctx = withCtx({ same_symbol_existing_exposure: true });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'EXISTING_EXPOSURE')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('EXISTING_EXPOSURE');
  });

  it('FAILs when exchange exposure exceeds limit', () => {
    const ctx = withCtx({
      same_symbol_existing_exposure: false,
      target_notional_per_leg_usdt: 1000,
      leg_exchange_existing_notional_usdt: { long: 0, short: 2500 },
    });
    const localCfg = { ...cfg, max_exchange_notional_usdt: 3000 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'EXISTING_EXPOSURE')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('EXCHANGE_EXPOSURE_LIMIT');
  });
});

describe('DATA_FRESHNESS', () => {
  it('FAILs when any input is stale', () => {
    const ctx = withCtx({ data_age_samples: [{ name: 'short_orderbook', ageMs: 3500 }] });
    const localCfg = { ...cfg, data_stale_threshold_ms: 2000 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'DATA_FRESHNESS')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('STALE_MARKET_DATA');
    expect(r.value).toContain('3500');
  });
});

describe('CLOCK_RELIABILITY', () => {
  it('FAILs when errorMs too large', () => {
    const ctx = withCtx({
      leg_clock_offset: {
        long: { errorMs: 100, calibratedAt: baseCtx.now - 10 },
        short: { errorMs: 800, calibratedAt: baseCtx.now - 10 },
      },
    });
    const localCfg = { ...cfg, clock_max_error_ms: 500 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'CLOCK_RELIABILITY')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('CLOCK_UNRELIABLE');
  });

  it('FAILs when calibration is stale', () => {
    const ctx = withCtx({
      now: 1_700_000_200_000,
      leg_clock_offset: {
        long: { errorMs: 10, calibratedAt: 1_700_000_000_000 },
        short: { errorMs: 10, calibratedAt: 1_700_000_000_000 },
      },
    });
    const localCfg = { ...cfg, clock_calibration_max_age_ms: 180_000 };
    const r = evaluatePreTrade(ctx, localCfg).items.find((i) => i.check_code === 'CLOCK_RELIABILITY')!;
    expect(r.status).toBe('FAIL');
  });
});

describe('ENTRY_GATE', () => {
  it('FAILs when a FAILED-trade-pending-review source is open', () => {
    const ctx = withCtx({
      entry_gate_sources: { trade_x: { open: true, reason_code: 'TRADE_FAILED_PENDING_REVIEW' } },
    });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'ENTRY_GATE')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('TRADE_FAILED_PENDING_REVIEW');
  });

  it('FAILs when an injected ENTRY_HALT_REQUESTED source is open', () => {
    const ctx = withCtx({
      entry_gate_sources: { health: { open: true, reason_code: 'RECONCILIATION_ERROR' } },
    });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'ENTRY_GATE')!;
    expect(r.status).toBe('FAIL');
    expect(r.reason_code).toBe('RECONCILIATION_ERROR');
  });

  it('PASSes once the source is cleared', () => {
    const ctx = withCtx({ entry_gate_sources: { trade_x: { open: false, reason_code: 'TRADE_FAILED_PENDING_REVIEW' } } });
    const r = evaluatePreTrade(ctx, cfg).items.find((i) => i.check_code === 'ENTRY_GATE')!;
    expect(r.status).toBe('PASS');
  });
});

describe('BLOCK aggregation', () => {
  it('one FAIL among 14 PASS → ABORT-equivalent BLOCK with failed_reasons = [that one]', () => {
    const ctx = withCtx({ leg_estimated_slippage_pct: { long: 0.0004, short: 0.0012 } });
    const localCfg = { ...cfg, max_slippage_pct: 0.001 };
    const result = evaluatePreTrade(ctx, localCfg);
    expect(result.action).toBe('BLOCK');
    expect(result.failed_reasons).toEqual(['MAX_SLIPPAGE_EXCEEDED']);
  });

  it('multiple FAILs preserve registry order in failed_reasons', () => {
    const ctx = withCtx({ required_capital_usdt: 9999, data_age_samples: [{ name: 'x', ageMs: 99999 }] });
    const result = evaluatePreTrade(ctx, cfg);
    expect(result.failed_reasons[0]).toBe('INSUFFICIENT_CAPITAL');
    expect(result.failed_reasons).toContain('STALE_MARKET_DATA');
  });
});

describe('evaluatePreFlight', () => {
  it('reruns only the 6 ★ checks', () => {
    const result = evaluatePreFlight(baseCtx, cfg);
    expect(result.items).toHaveLength(6);
    expect(result.items.map((i) => i.check_code).sort()).toEqual(
      [
        'EXCHANGE_CONNECTIVITY',
        'API_LATENCY',
        'FUNDING_TIME_ALIGNMENT',
        'DATA_FRESHNESS',
        'CLOCK_RELIABILITY',
        'ENTRY_GATE',
      ].sort(),
    );
  });

  it('FAILs ABORTED-equivalent when stale data found at PRE_FLIGHT', () => {
    const ctx = withCtx({ data_age_samples: [{ name: 'long_mid', ageMs: 4000 }] });
    const localCfg = { ...cfg, data_stale_threshold_ms: 2000 };
    const result = evaluatePreFlight(ctx, localCfg);
    expect(result.action).toBe('BLOCK');
    expect(result.failed_reasons).toEqual(['STALE_MARKET_DATA']);
  });
});
