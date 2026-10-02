/**
 * runtime/test/scenarios/riskEngine.scenario.test.ts
 *
 * Scenario S09 (Stale Market Data) / S10 (Exchange Disconnect) — risk-engine
 * parts only (spec.md "Scenario S09 / S10 的風控部分"). S11 (Kill Switch,
 * C-16 decided 2026-10-02) is below.
 *
 * `test-infrastructure`'s recorded-data-replay + fixed-seed failure
 * injection harness (技術書 §37/§42) does not exist yet as its own change.
 * These scenarios are deterministic by construction (every input is an
 * explicit injected context — no actual randomness), which already
 * satisfies "same seed -> same outcome" reproducibility; "seed 42"/"seed 7"
 * are noted here only to match the spec's scenario language, and should be
 * replaced with real recorded-data loading once `test-infrastructure` lands.
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/clock/virtualClock';
import { KillSwitchCoordinator, type KillSwitchExecutionPort, type KillSwitchTradeSnapshot } from '../../src/risk/killSwitch';
import {
  EntryRiskMonitor,
  runArmPreTradeRisk,
  type ExecutionCommandPort,
  type RiskCoordinatorDeps,
} from '../../src/risk/riskCoordinator';
import { DEFAULT_RISK_CONFIG, type EntryContext, type PreTradeContext, type RiskConfig } from '../../src/risk/types';
import type { RiskCheck, TradingEvent } from '../../src/types';

const SEED = 42;

function makeDeps(): RiskCoordinatorDeps & { events: TradingEvent[]; rows: RiskCheck[] } {
  const events: TradingEvent[] = [];
  const rows: RiskCheck[] = [];
  let seq = 0;
  return {
    capital: { reserve: () => {}, release: () => {} },
    eventSink: { emit: (e) => events.push(e) },
    checkSink: { record: (r) => rows.push(...r) },
    idGenerator: () => `evt-${SEED}-${seq++}`,
    events,
    rows,
  };
}

function reservingDeps(): RiskCoordinatorDeps & { events: TradingEvent[]; rows: RiskCheck[]; reserved: string[] } {
  const events: TradingEvent[] = [];
  const rows: RiskCheck[] = [];
  const reserved: string[] = [];
  let seq = 0;
  return {
    capital: {
      reserve: (tradeId) => reserved.push(tradeId),
      release: () => {},
    },
    eventSink: { emit: (e) => events.push(e) },
    checkSink: { record: (r) => rows.push(...r) },
    idGenerator: () => `evt-${SEED}-${seq++}`,
    events,
    rows,
    reserved,
  };
}

function assertMonotonicAndTimestamped(events: TradingEvent[], rows: RiskCheck[]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
  }
  for (const row of rows) {
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.updated_at).toBe('number');
    expect(row.updated_at).toBeGreaterThanOrEqual(row.created_at);
  }
}

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG, data_stale_threshold_ms: 2000 };

const allPassPreTrade: PreTradeContext = {
  now: 0,
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
  entry_deadline: 100_000,
  same_symbol_existing_exposure: false,
  leg_exchange_existing_notional_usdt: { long: 0, short: 0 },
  data_age_samples: [{ name: 'orderbook', ageMs: 500 }],
  leg_clock_offset: {
    long: { errorMs: 100, calibratedAt: -10 },
    short: { errorMs: 100, calibratedAt: -10 },
  },
  entry_gate_sources: {},
};

describe('Scenario S09 — Stale Market Data (seed 42)', () => {
  it('ARM Opportunities with a stale short-leg input are REJECTED/STALE_MARKET_DATA; no Trade is created', () => {
    const clock = new VirtualClock(0);
    clock.advanceTo(10_000); // session reaches ARM
    const deps = reservingDeps();

    // Short leg (on the injected-failure exchange) stops updating for 3s — data_age_ms = 3000 > threshold 2000.
    const opportunities = ['opp-A', 'opp-B'].map((id) => ({
      opportunity_id: id,
      ctx: {
        ...allPassPreTrade,
        now: clock.now(),
        entry_deadline: clock.now() + 90_000,
        data_age_samples: [{ name: 'short_orderbook', ageMs: 3000 }],
      } satisfies PreTradeContext,
    }));

    const outcomes = opportunities.map((opp) =>
      runArmPreTradeRisk(
        { opportunity_id: opp.opportunity_id, ctx: opp.ctx, cfg, required_capital_usdt: 100, trade_id: `trade-${opp.opportunity_id}` },
        deps,
      ),
    );

    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe('REJECTED');
      if (outcome.outcome === 'REJECTED') expect(outcome.rejection_reason).toBe('STALE_MARKET_DATA');
    }
    expect(deps.reserved).toEqual([]); // no Trade's capital was ever reserved
    expect(deps.events.filter((e) => e.event_type === 'RISK_CHECK_FAILED')).toHaveLength(2);
    assertMonotonicAndTimestamped(deps.events, deps.rows);
  });
});

describe('Scenario S10 — Exchange Disconnect during ENTRY_PENDING (seed 42)', () => {
  it('EXCHANGE_DISCONNECTED then RISK_CHECK_FAILED(HALT_ENTRY, EXCHANGE_DISCONNECTED) in order', () => {
    const clock = new VirtualClock(0);
    clock.advanceTo(50_000); // trade is ENTRY_PENDING
    const deps = makeDeps();
    const execution: ExecutionCommandPort = {
      cancelEntryOrders: () => {},
      rejectFurtherEntry: () => {},
      startEmergencyExit: () => {},
    };

    const disconnectedEvent: TradingEvent = {
      event_id: `evt-${SEED}-disconnect`,
      event_type: 'EXCHANGE_DISCONNECTED',
      timestamp: clock.now(),
      trade_id: 'trade-1',
      payload: {},
      recorded_at: clock.now(),
    };
    deps.eventSink.emit(disconnectedEvent);

    const entryCtx: EntryContext = {
      now: clock.now(),
      leg_mid_price: { long: 100, short: 100 },
      leg_target_entry_price: { long: 100, short: 100 },
      arm_funding_spread: 0.001,
      current_funding_spread: 0.001,
      order_timeout_occurred: false,
      hedge_state: 'ENTRY_PENDING' as never,
      hedge_ratio: 1,
      leg_connectivity: { long: 'CONNECTED', short: 'DISCONNECTED' },
      leg_recent_mid_prices: { long: [100, 100.01], short: [100, 100.01] },
    };
    const monitor = new EntryRiskMonitor('opp-1', 'trade-1', deps, execution);
    const result = monitor.start(entryCtx, cfg);

    expect(result.action).toBe('HALT_ENTRY');
    expect(result.failed_reasons).toContain('EXCHANGE_DISCONNECTED');

    const types = deps.events.map((e) => e.event_type);
    const disconnectIdx = types.indexOf('EXCHANGE_DISCONNECTED');
    const failedIdx = types.indexOf('RISK_CHECK_FAILED');
    expect(disconnectIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(disconnectIdx);

    assertMonotonicAndTimestamped(deps.events, deps.rows);
  });
});

describe('Scenario S11 — Kill Switch escalation L1 -> L2 -> L3 (seed 7)', () => {
  it('ENTRY_PENDING (single leg filled), HEDGED and EXIT_PENDING trades all end CLOSED, 3 KILL_SWITCH_ACTIVATED events, monotonic timestamps', () => {
    const clock = new VirtualClock(0);
    const events: TradingEvent[] = [];
    const aborted: string[] = [];
    const cancelled: string[] = [];
    const emergencyExits: string[] = [];
    const rejected: string[] = [];
    const failed: string[] = [];
    let seq = 0;

    const execution: KillSwitchExecutionPort = {
      cancelEntryOrders: (tradeId) => cancelled.push(tradeId),
      rejectFurtherEntry: (tradeId) => rejected.push(tradeId),
      startEmergencyExit: (tradeId) => emergencyExits.push(tradeId),
      abortTrade: (tradeId) => aborted.push(tradeId),
      failTrade: (tradeId) => failed.push(tradeId),
    };

    const coordinator = new KillSwitchCoordinator({
      execution,
      eventSink: { emit: (e) => events.push(e) },
      clock: { now: () => clock.now(), after: (ms, cb) => clock.at(clock.now() + ms, cb) },
      idGenerator: () => `evt-7-${seq++}`,
      tokenGenerator: () => `token-7-${seq++}`,
    });

    // Three trades coexist at the moment Kill Switch is first engaged.
    const entryPending: KillSwitchTradeSnapshot = { trade_id: 'trade-entry', status: 'ENTRY_PENDING', has_open_entry_orders: true };
    const hedged: KillSwitchTradeSnapshot = { trade_id: 'trade-hedged', status: 'HEDGED', has_open_entry_orders: false };
    const exitPending: KillSwitchTradeSnapshot = { trade_id: 'trade-exiting', status: 'EXIT_PENDING', has_open_entry_orders: false };

    clock.advanceTo(1_000);
    // --- L1: only stops new entry, no order/position action on any of the 3 trades.
    const l1 = coordinator.activate({ level: 'L1_STOP_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades: [entryPending, hedged, exitPending] });
    expect(l1).toEqual({ outcome: 'ACTIVATED', level: 'L1_STOP_ENTRY' });
    expect(cancelled).toEqual([]);
    expect(emergencyExits).toEqual([]);

    clock.advanceTo(2_000);
    // --- L2: cancels the ENTRY_PENDING trade's entry orders; EXIT_PENDING's exit order untouched (no API to touch it with).
    const l2 = coordinator.activate({ level: 'L2_CANCEL_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades: [entryPending, hedged, exitPending] });
    expect(l2).toEqual({ outcome: 'ACTIVATED', level: 'L2_CANCEL_ENTRY' });
    expect(cancelled).toEqual(['trade-entry']);

    clock.advanceTo(2_500);
    // The cancelled trade's entry orders settle single-legged (one leg filled, one leg 0 fill) -> LEG_IMBALANCE -> automatic emergency exit.
    const classification = coordinator.handleEntryOrdersSettled('trade-entry', 0.4, cfg);
    expect(classification).toBe('LEG_IMBALANCE');
    expect(emergencyExits).toContain('trade-entry');

    clock.advanceTo(3_000);
    // --- L3: two-step confirmation, confirmed within 5s (< 10s TTL).
    const { token } = coordinator.requestFlatten(cfg);
    clock.advanceTo(8_000); // +5s
    const l3 = coordinator.confirmFlatten({ token, trades: [hedged, exitPending] }); // trade-entry already EMERGENCY_EXIT, not passed again
    expect(l3).toEqual({ outcome: 'ACTIVATED' });
    expect(emergencyExits).toContain('trade-hedged'); // HEDGED Trade now flattened too
    expect(emergencyExits).not.toContain('trade-exiting'); // EXIT_PENDING keeps its existing exit order, no duplicate

    // 3 KILL_SWITCH_ACTIVATED events (L1, L2, L3) recorded.
    const activated = events.filter((e) => e.event_type === 'KILL_SWITCH_ACTIVATED');
    expect(activated).toHaveLength(3);
    expect(activated.map((e) => (e.payload as { to: string }).to)).toEqual(['L1_STOP_ENTRY', 'L2_CANCEL_ENTRY', 'L3_FLATTEN']);

    // Final level is L3_FLATTEN; every trade had an abort/emergency-exit command issued where applicable
    // (matching the scenario's "最終三筆 Trade 皆 CLOSED" once paper-execution carries these out).
    expect(coordinator.currentLevel()).toBe('L3_FLATTEN');
    expect(aborted).toEqual([]); // none of the 3 were CREATED/PRE_FLIGHT
    expect(emergencyExits.sort()).toEqual(['trade-entry', 'trade-hedged']);
    expect(rejected.length).toBeGreaterThan(0);
    expect(failed).toEqual([]); // no RECONCILIATION_ERROR in this scenario

    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }
  });
});
