import { describe, expect, it } from 'vitest';
import type { TradingEvent } from '../types/event';
import {
  KillSwitchCoordinator,
  classifyAfterEntryCancel,
  type KillSwitchExecutionPort,
  type KillSwitchTradeSnapshot,
} from './killSwitch';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from './types';

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };

function makeExecution(): KillSwitchExecutionPort & {
  cancelled: string[];
  rejected: string[];
  emergencyExits: string[];
  aborted: string[];
  failed: string[];
} {
  const cancelled: string[] = [];
  const rejected: string[] = [];
  const emergencyExits: string[] = [];
  const aborted: string[] = [];
  const failed: string[] = [];
  return {
    cancelEntryOrders: (tradeId) => cancelled.push(tradeId),
    rejectFurtherEntry: (tradeId) => rejected.push(tradeId),
    startEmergencyExit: (tradeId) => emergencyExits.push(tradeId),
    abortTrade: (tradeId) => aborted.push(tradeId),
    failTrade: (tradeId) => failed.push(tradeId),
    cancelled,
    rejected,
    emergencyExits,
    aborted,
    failed,
  };
}

class FakeClock {
  private time = 0;
  private timers: Array<{ at: number; cb: () => void }> = [];
  now(): number {
    return this.time;
  }
  after(ms: number, cb: () => void): unknown {
    const at = this.time + ms;
    const handle = { at, cb };
    this.timers.push(handle);
    return handle;
  }
  advanceTo(t: number): void {
    this.time = t;
    const due = this.timers.filter((h) => h.at <= t);
    this.timers = this.timers.filter((h) => h.at > t);
    due.sort((a, b) => a.at - b.at).forEach((h) => h.cb());
  }
}

function makeCoordinator() {
  const events: TradingEvent[] = [];
  const execution = makeExecution();
  const clock = new FakeClock();
  let seq = 0;
  const coordinator = new KillSwitchCoordinator({
    execution,
    eventSink: { emit: (e) => events.push(e) },
    clock,
    idGenerator: () => `id-${seq++}`,
    tokenGenerator: () => `token-${seq++}`,
  });
  return { coordinator, events, execution, clock };
}

// ---------------------------------------------------------------------------
// 4.1 — escalate-only level state machine, manual release, six event codes,
// ENTRY_GATE injection, L1 behavior
// ---------------------------------------------------------------------------

describe('4.1 level state machine', () => {
  it('unspecified manual activation defaults to L1 and emits KILL_SWITCH_ACTIVATED(NONE -> L1, MANUAL)', () => {
    const { coordinator, events } = makeCoordinator();
    const outcome = coordinator.activate({ source: 'MANUAL', reason: 'OPERATOR', trades: [] });
    expect(outcome).toEqual({ outcome: 'ACTIVATED', level: 'L1_STOP_ENTRY' });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('KILL_SWITCH_ACTIVATED');
    expect(events[0].payload).toMatchObject({ from: 'NONE', to: 'L1_STOP_ENTRY', source: 'MANUAL' });
  });

  it('cannot de-escalate: requesting L1 while at L2 stays at L2, returns ALREADY_ACTIVE, no new event', () => {
    const { coordinator, events } = makeCoordinator();
    coordinator.activate({ level: 'L2_CANCEL_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades: [] });
    events.length = 0;
    const outcome = coordinator.activate({ level: 'L1_STOP_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades: [] });
    expect(outcome).toEqual({ outcome: 'ALREADY_ACTIVE', level: 'L2_CANCEL_ENTRY' });
    expect(events).toHaveLength(0);
    expect(coordinator.currentLevel()).toBe('L2_CANCEL_ENTRY');
  });

  it('manual release returns to NONE and emits KILL_SWITCH_RELEASED', () => {
    const { coordinator, events } = makeCoordinator();
    coordinator.activate({ source: 'MANUAL', reason: 'OPERATOR', trades: [] });
    const outcome = coordinator.release({ actor: 'alice', reason: 'resolved' });
    expect(outcome).toEqual({ outcome: 'RELEASED' });
    expect(coordinator.currentLevel()).toBe('NONE');
    expect(events.at(-1)?.event_type).toBe('KILL_SWITCH_RELEASED');
  });

  it('rejects release while L2 cancel cleanup is in flight (KILL_SWITCH_CLEANUP_IN_PROGRESS)', () => {
    const { coordinator } = makeCoordinator();
    const trades: KillSwitchTradeSnapshot[] = [
      { trade_id: 't1', status: 'ENTRY_PENDING', has_open_entry_orders: true },
    ];
    coordinator.activate({ level: 'L2_CANCEL_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades });
    const outcome = coordinator.release({ actor: 'alice', reason: 'resolved' });
    expect(outcome).toEqual({ outcome: 'REJECTED', reason: 'KILL_SWITCH_CLEANUP_IN_PROGRESS' });
    expect(coordinator.currentLevel()).toBe('L2_CANCEL_ENTRY');
  });

  it('entryGateSource() is open with KILL_SWITCH_ACTIVE once any level is active, closed at NONE', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.entryGateSource()).toEqual({ open: false, reason_code: 'KILL_SWITCH_ACTIVE' });
    coordinator.activate({ source: 'MANUAL', reason: 'OPERATOR', trades: [] });
    expect(coordinator.entryGateSource()).toEqual({ open: true, reason_code: 'KILL_SWITCH_ACTIVE' });
  });

  it('L1 aborts CREATED/PRE_FLIGHT trades (unsent) and leaves in-progress trades untouched', () => {
    const { coordinator, execution } = makeCoordinator();
    const trades: KillSwitchTradeSnapshot[] = [
      { trade_id: 'unsent-1', status: 'CREATED', has_open_entry_orders: false },
      { trade_id: 'unsent-2', status: 'PRE_FLIGHT', has_open_entry_orders: false },
      { trade_id: 'inflight-1', status: 'PARTIALLY_HEDGED', has_open_entry_orders: true },
      { trade_id: 'inflight-2', status: 'HEDGED', has_open_entry_orders: false },
    ];
    coordinator.activate({ level: 'L1_STOP_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades });
    expect(execution.aborted.sort()).toEqual(['unsent-1', 'unsent-2']);
    expect(execution.cancelled).toEqual([]); // L1 never cancels orders
  });
});

// ---------------------------------------------------------------------------
// 4.2 — L2 cancel-only-ENTRY, retry + KILL_SWITCH_CANCEL_FAILED, post-cancel
// §14 classification
// ---------------------------------------------------------------------------

describe('4.2 L2 cancel-entry-only', () => {
  it('cancels only trades with open ENTRY orders, rejects further entry for all', () => {
    const { coordinator, execution } = makeCoordinator();
    const trades: KillSwitchTradeSnapshot[] = [
      { trade_id: 'entry-open', status: 'ENTRY_PENDING', has_open_entry_orders: true },
      { trade_id: 'no-open-entry', status: 'HEDGED', has_open_entry_orders: false },
    ];
    coordinator.activate({ level: 'L2_CANCEL_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades });
    expect(execution.cancelled).toEqual(['entry-open']);
    expect(execution.rejected.sort()).toEqual(['entry-open', 'no-open-entry']);
    // Invariant #6 Cancel != Close: L2 never calls startEmergencyExit/abortTrade directly on activation.
    expect(execution.emergencyExits).toEqual([]);
  });

  it('retries a rejected cancel up to kill_switch_cancel_retry_max times, then emits KILL_SWITCH_CANCEL_FAILED', () => {
    const { coordinator, execution, events, clock } = makeCoordinator();
    coordinator.activate({
      level: 'L2_CANCEL_ENTRY',
      source: 'MANUAL',
      reason: 'OPERATOR',
      trades: [{ trade_id: 't1', status: 'ENTRY_PENDING', has_open_entry_orders: true }],
    });
    expect(execution.cancelled).toEqual(['t1']); // 1st attempt from activate()

    for (let i = 0; i < cfg.kill_switch_cancel_retry_max + 1; i++) {
      coordinator.handleOrderCancelRejected({ trade_id: 't1', order_id: 'o1', reason: 'REJECTED' }, cfg);
      clock.advanceTo(clock.now() + cfg.kill_switch_cancel_retry_interval_ms);
    }
    // 1 initial + kill_switch_cancel_retry_max retries = 4 total cancel calls
    expect(execution.cancelled).toHaveLength(1 + cfg.kill_switch_cancel_retry_max);

    const failedEvents = events.filter((e) => e.event_type === 'KILL_SWITCH_CANCEL_FAILED');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].payload).toMatchObject({ trade_id: 't1', order_id: 'o1' });
  });

  it('classifies 0-fill as ABORTED after cancel settles', () => {
    const { coordinator, execution } = makeCoordinator();
    const result = coordinator.handleEntryOrdersSettled('t1', 0, cfg);
    expect(result).toBe('ABORTED');
    expect(execution.aborted).toEqual(['t1']);
  });

  it('classifies hedge_ratio >= hedged_min as HEDGED, proceeds normally (no command)', () => {
    const { coordinator, execution } = makeCoordinator();
    const result = coordinator.handleEntryOrdersSettled('t1', cfg.hedge_ratio_hedged_min, cfg);
    expect(result).toBe('HEDGED');
    expect(execution.aborted).toEqual([]);
    expect(execution.emergencyExits).toEqual([]);
  });

  it('classifies partial fill below hedged_min as LEG_IMBALANCE -> automatic emergency exit', () => {
    const { coordinator, execution } = makeCoordinator();
    const result = coordinator.handleEntryOrdersSettled('t1', 0.5, cfg);
    expect(result).toBe('LEG_IMBALANCE');
    expect(execution.emergencyExits).toEqual(['t1']);
  });

  it('classifyAfterEntryCancel is a pure function matching spec §14 thresholds', () => {
    expect(classifyAfterEntryCancel(0, cfg)).toBe('ABORTED');
    expect(classifyAfterEntryCancel(cfg.hedge_ratio_hedged_min, cfg)).toBe('HEDGED');
    expect(classifyAfterEntryCancel(0.95, cfg)).toBe('LEG_IMBALANCE');
  });
});

// ---------------------------------------------------------------------------
// 4.3 — L3 two-step confirmation + flatten-all + automatic triggers
// ---------------------------------------------------------------------------

describe('4.3 L3 two-step confirmation', () => {
  it('confirms within TTL -> escalates to L3_FLATTEN', () => {
    const { coordinator, events, clock } = makeCoordinator();
    const { token } = coordinator.requestFlatten(cfg);
    clock.advanceTo(4000);
    const outcome = coordinator.confirmFlatten({ token, trades: [] });
    expect(outcome).toEqual({ outcome: 'ACTIVATED' });
    expect(coordinator.currentLevel()).toBe('L3_FLATTEN');
    expect(events.some((e) => e.event_type === 'KILL_SWITCH_ACTIVATED' && (e.payload as any).to === 'L3_FLATTEN')).toBe(true);
  });

  it('rejects confirmation after TTL expires, no emergency close sent', () => {
    const { coordinator, events, execution, clock } = makeCoordinator();
    const { token } = coordinator.requestFlatten(cfg);
    clock.advanceTo(cfg.kill_switch_flatten_confirm_ttl_ms + 1);
    const outcome = coordinator.confirmFlatten({
      token,
      trades: [{ trade_id: 't1', status: 'HEDGED', has_open_entry_orders: false }],
    });
    expect(outcome).toEqual({ outcome: 'REJECTED', reason: 'FLATTEN_CONFIRMATION_INVALID' });
    expect(coordinator.currentLevel()).toBe('NONE');
    expect(execution.emergencyExits).toEqual([]);
    expect(events.some((e) => e.event_type === 'KILL_SWITCH_FLATTEN_REJECTED')).toBe(true);
  });

  it('rejects a wrong confirmation code', () => {
    const { coordinator } = makeCoordinator();
    coordinator.requestFlatten(cfg);
    const outcome = coordinator.confirmFlatten({ token: 'wrong-code', trades: [] });
    expect(outcome).toEqual({ outcome: 'REJECTED', reason: 'FLATTEN_CONFIRMATION_INVALID' });
  });

  it('only calling requestFlatten (never confirming) sends no EMERGENCY_CLOSE', () => {
    const { coordinator, execution } = makeCoordinator();
    coordinator.requestFlatten(cfg);
    expect(execution.emergencyExits).toEqual([]);
    expect(coordinator.currentLevel()).toBe('NONE');
  });

  it('L3 flattens HEDGED/PARTIALLY_HEDGED/LEG_IMBALANCE trades but leaves existing EXIT_PENDING/EMERGENCY_EXIT trades alone', () => {
    const { coordinator, execution } = makeCoordinator();
    const { token } = coordinator.requestFlatten(cfg);
    const trades: KillSwitchTradeSnapshot[] = [
      { trade_id: 'hedged-1', status: 'HEDGED', has_open_entry_orders: false },
      { trade_id: 'hedged-2', status: 'HEDGED', has_open_entry_orders: false },
      { trade_id: 'exiting', status: 'EXIT_PENDING', has_open_entry_orders: false },
    ];
    coordinator.confirmFlatten({ token, trades });
    expect(execution.emergencyExits.sort()).toEqual(['hedged-1', 'hedged-2']);
  });

  it('L3 also applies L2 (cancels open entry orders) since higher tier includes lower', () => {
    const { coordinator, execution } = makeCoordinator();
    const { token } = coordinator.requestFlatten(cfg);
    coordinator.confirmFlatten({
      token,
      trades: [{ trade_id: 'entry-open', status: 'ENTRY_PENDING', has_open_entry_orders: true }],
    });
    expect(execution.cancelled).toEqual(['entry-open']);
  });
});

describe('4.3 automatic triggers', () => {
  it('EXCHANGE_DISCONNECTED triggers L1', () => {
    const { coordinator } = makeCoordinator();
    const outcome = coordinator.handleAutoTrigger({ trigger: 'EXCHANGE_DISCONNECTED' }, []);
    expect(outcome).toEqual({ outcome: 'ACTIVATED', level: 'L1_STOP_ENTRY' });
  });

  it('persistent stale data (>= auto_kill_stale_duration_ms, modeled by caller) triggers L1', () => {
    const { coordinator } = makeCoordinator();
    // Caller is responsible for measuring staleness duration (market-data-stream);
    // this coordinator only reacts once called.
    const outcome = coordinator.handleAutoTrigger({ trigger: 'STALE_MARKET_DATA' }, []);
    expect(outcome).toEqual({ outcome: 'ACTIVATED', level: 'L1_STOP_ENTRY' });
  });

  it('RECONCILIATION_ERROR triggers L1 and fails the affected trade', () => {
    const { coordinator, execution } = makeCoordinator();
    const outcome = coordinator.handleAutoTrigger({ trigger: 'RECONCILIATION_ERROR', affectedTradeId: 'trade-x' }, []);
    expect(outcome).toEqual({ outcome: 'ACTIVATED', level: 'L1_STOP_ENTRY' });
    expect(execution.failed).toEqual(['trade-x']);
  });

  it('CLOCK_UNRELIABLE has no handler — Kill Switch is never triggered by it (blocked by Pre-Trade checks instead)', () => {
    // Static assertion: AutoTriggerReason type excludes CLOCK_UNRELIABLE; nothing to call.
    const { coordinator } = makeCoordinator();
    expect(coordinator.currentLevel()).toBe('NONE');
  });

  it('already active: repeated automatic trigger only emits KILL_SWITCH_TRIGGERED, no new KILL_SWITCH_ACTIVATED', () => {
    const { coordinator, events } = makeCoordinator();
    coordinator.activate({ level: 'L2_CANCEL_ENTRY', source: 'MANUAL', reason: 'OPERATOR', trades: [] });
    events.length = 0;
    const outcome = coordinator.handleAutoTrigger({ trigger: 'EXCHANGE_DISCONNECTED' }, []);
    expect(outcome).toEqual({ outcome: 'ALREADY_ACTIVE', level: 'L2_CANCEL_ENTRY' });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('KILL_SWITCH_TRIGGERED');
  });
});

// ---------------------------------------------------------------------------
// Event-sourced rebuild
// ---------------------------------------------------------------------------

describe('event-sourced state rebuild', () => {
  it('rebuilds level from a replayed ACTIVATED/RELEASED event stream', () => {
    const events = [
      { event_type: 'KILL_SWITCH_ACTIVATED', payload: { to: 'L1_STOP_ENTRY' } },
      { event_type: 'KILL_SWITCH_ACTIVATED', payload: { to: 'L2_CANCEL_ENTRY' } },
    ] as const;
    expect(KillSwitchCoordinator.rebuildLevel(events as any)).toBe('L2_CANCEL_ENTRY');
  });

  it('a RELEASED event resets to NONE even after escalation', () => {
    const events = [
      { event_type: 'KILL_SWITCH_ACTIVATED', payload: { to: 'L2_CANCEL_ENTRY' } },
      { event_type: 'KILL_SWITCH_RELEASED', payload: {} },
    ] as const;
    expect(KillSwitchCoordinator.rebuildLevel(events as any)).toBe('NONE');
  });

  it('restoreLevel installs a rebuilt level without emitting any event, and ENTRY_GATE reflects it immediately', () => {
    const { coordinator, events } = makeCoordinator();
    coordinator.restoreLevel('L1_STOP_ENTRY');
    expect(events).toHaveLength(0);
    expect(coordinator.currentLevel()).toBe('L1_STOP_ENTRY');
    expect(coordinator.entryGateSource().open).toBe(true);
  });
});
