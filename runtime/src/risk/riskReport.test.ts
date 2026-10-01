import { describe, expect, it } from 'vitest';
import { evaluatePreTrade } from './preTradeRisk';
import { evaluateEntry } from './executionRisk';
import { DEFAULT_RISK_CONFIG, type PreTradeContext, type RiskConfig } from './types';
import {
  changedItems,
  riskCheckResultEvent,
  riskCheckStartedEvent,
  toRiskCheckRows,
  toRiskStatusReport,
} from './riskReport';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

const allPassCtx: PreTradeContext = {
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

describe('toRiskStatusReport', () => {
  it('maps Pre-Trade BLOCK to ABORT/ABORT_PRE_FLIGHT', () => {
    const ctx = { ...allPassCtx, required_capital_usdt: 99999 };
    const evalResult = evaluatePreTrade(ctx, cfg);
    const report = toRiskStatusReport(evalResult);
    expect(report.overall_status).toBe('ABORT');
    expect(report.action_recommendation).toBe('ABORT_PRE_FLIGHT');
    expect(report.failed_reasons).toEqual(['INSUFFICIENT_CAPITAL']);
    expect(report.checks).toHaveLength(15);
  });

  it('maps Pre-Trade ALLOW to PASS/PROCEED_TRADE', () => {
    const report = toRiskStatusReport(evaluatePreTrade(allPassCtx, cfg));
    expect(report.overall_status).toBe('PASS');
    expect(report.action_recommendation).toBe('PROCEED_TRADE');
  });

  it('maps Entry EMERGENCY_EXIT to overall EMERGENCY_EXIT / EMERGENCY_CLOSE_FILLED_LEG with leg_imbalance_detected', () => {
    const evalResult = evaluateEntry(
      {
        now: 0,
        leg_mid_price: { long: 100, short: 100 },
        leg_target_entry_price: { long: 100, short: 100 },
        arm_funding_spread: 0.001,
        current_funding_spread: 0.001,
        order_timeout_occurred: false,
        hedge_state: 'ENTRY_PENDING' as never,
        hedge_ratio: 0,
        both_legs_zero_fill: false,
        leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
        leg_recent_mid_prices: { long: [100, 100.01], short: [100, 100.01] },
      },
      cfg,
    );
    const report = toRiskStatusReport(evalResult);
    expect(report.overall_status).toBe('EMERGENCY_EXIT');
    expect(report.action_recommendation).toBe('EMERGENCY_CLOSE_FILLED_LEG');
    expect(report.leg_imbalance_detected).toBe(true);
  });
});

describe('toRiskCheckRows', () => {
  it('produces one row per item with created_at = updated_at = evaluated_at', () => {
    const evalResult = evaluatePreTrade(allPassCtx, cfg);
    const rows = toRiskCheckRows(evalResult, 'TRADE_CREATION', { opportunity_id: 'opp-1' }, () => 'id-1');
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(row.created_at).toBe(allPassCtx.now);
      expect(row.updated_at).toBe(allPassCtx.now);
      expect(row.stage).toBe('TRADE_CREATION');
      expect(row.opportunity_id).toBe('opp-1');
      expect(row.config_version).toBe(cfg.config_version);
    }
  });

  it('REJECTED Opportunity scenario: 15 rows, DATA_FRESHNESS is FAIL', () => {
    const ctx = { ...allPassCtx, data_age_samples: [{ name: 'x', ageMs: 99999 }] };
    const evalResult = evaluatePreTrade(ctx, cfg);
    const rows = toRiskCheckRows(evalResult, 'TRADE_CREATION', { opportunity_id: 'opp-2' });
    expect(rows).toHaveLength(15);
    const dataFreshness = rows.find((r) => r.check_id === 'DATA_FRESHNESS')!;
    expect(dataFreshness.status).toBe('FAIL');
    expect(dataFreshness.reason).toBe('STALE_MARKET_DATA');
  });
});

describe('changedItems (continuous-check write-on-change)', () => {
  it('only returns items whose status changed between two evaluations', () => {
    const prev = evaluateEntry(
      {
        now: 0,
        leg_mid_price: { long: 100, short: 100 },
        leg_target_entry_price: { long: 100, short: 100 },
        arm_funding_spread: 0.001,
        current_funding_spread: 0.001,
        order_timeout_occurred: false,
        hedge_state: 'HEDGED',
        hedge_ratio: 1,
        leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
        leg_recent_mid_prices: { long: [100, 100.01], short: [100, 100.01] },
      },
      cfg,
    ).items;
    const curr = evaluateEntry(
      {
        now: 1000,
        leg_mid_price: { long: 100, short: 100.4 },
        leg_target_entry_price: { long: 100, short: 100 },
        arm_funding_spread: 0.001,
        current_funding_spread: 0.001,
        order_timeout_occurred: false,
        hedge_state: 'HEDGED',
        hedge_ratio: 1,
        leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
        leg_recent_mid_prices: { long: [100, 100.01], short: [100, 100.01] },
      },
      cfg,
    ).items;
    const changed = changedItems(prev, curr);
    expect(changed).toHaveLength(1);
    expect(changed[0].check_code).toBe('PRICE_DEVIATION');
  });

  it('S10 scenario: 20 evaluations, only 12th changes → start(7) + 1 + end(7) = 15 writes expected by caller', () => {
    // changedItems is the building block; the coordinator (3.2) composes
    // start/change/end writes. This test locks changedItems' no-op
    // behaviour for 19 identical evaluations.
    const makeEval = (deviated: boolean) =>
      evaluateEntry(
        {
          now: 0,
          leg_mid_price: { long: 100, short: deviated ? 100.4 : 100 },
          leg_target_entry_price: { long: 100, short: 100 },
          arm_funding_spread: 0.001,
          current_funding_spread: 0.001,
          order_timeout_occurred: false,
          hedge_state: 'HEDGED',
          hedge_ratio: 1,
          leg_connectivity: { long: 'CONNECTED', short: 'CONNECTED' },
          leg_recent_mid_prices: { long: [100, 100.01], short: [100, 100.01] },
        },
        cfg,
      ).items;
    const first = makeEval(false);
    let previous = first;
    let changeCount = 0;
    for (let i = 0; i < 19; i++) {
      const deviated = i >= 11; // from the 12th call onward (0-indexed 11), stays deviated
      const current = makeEval(deviated);
      const changed = changedItems(previous, current);
      if (changed.length > 0) changeCount += 1;
      previous = current;
    }
    expect(changeCount).toBe(1);
  });
});

describe('TradingEvents', () => {
  it('riskCheckStartedEvent carries stage/opportunity/clock_offset_ms', () => {
    const event = riskCheckStartedEvent(
      'PRE_TRADE',
      { opportunity_id: 'opp-1', trade_id: null },
      { timestamp: 1000, clock_offset_ms: 5 },
      () => 'evt-1',
    );
    expect(event.event_type).toBe('RISK_CHECK_STARTED');
    expect(event.event_id).toBe('evt-1');
    expect(event.opportunity_id).toBe('opp-1');
    expect(event.trade_id).toBeNull();
    expect(event.clock_offset_ms).toBe(5);
    expect(event.payload.stage).toBe('PRE_TRADE');
  });

  it('riskCheckResultEvent is RISK_CHECK_PASSED when no FAIL', () => {
    const evalResult = evaluatePreTrade(allPassCtx, cfg);
    const event = riskCheckResultEvent(evalResult, { opportunity_id: 'opp-1', trade_id: null }, { timestamp: 1000 });
    expect(event.event_type).toBe('RISK_CHECK_PASSED');
  });

  it('riskCheckResultEvent is RISK_CHECK_FAILED with failed_reasons/action and no credentials', () => {
    const ctx = { ...allPassCtx, data_age_samples: [{ name: 'x', ageMs: 99999 }] };
    const evalResult = evaluatePreTrade(ctx, cfg);
    const event = riskCheckResultEvent(evalResult, { opportunity_id: 'opp-1', trade_id: null }, { timestamp: 1000 });
    expect(event.event_type).toBe('RISK_CHECK_FAILED');
    expect(event.payload.failed_reasons).toEqual(['STALE_MARKET_DATA']);
    expect(event.payload.action).toBe('BLOCK');
    expect(JSON.stringify(event.payload)).not.toMatch(/api[_-]?key|secret|password/i);
  });
});
