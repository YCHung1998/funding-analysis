/**
 * runtime/src/risk/killSwitch.ts
 *
 * Kill Switch (design.md §6–§7, C-16 decided 2026-10-02; tasks.md group 4;
 * specs/kill-switch/spec.md). Three-tier escalation `NONE < L1_STOP_ENTRY <
 * L2_CANCEL_ENTRY < L3_FLATTEN`, higher tier includes lower, escalate-only
 * (manual release returns to `NONE`), event-sourced (rebuilt from
 * `KILL_SWITCH_ACTIVATED` / `KILL_SWITCH_RELEASED` events, no separate
 * table).
 *
 * Like `riskCoordinator.ts`, this module is a thin orchestration layer: it
 * owns the level state machine and the escalation/classification *decision*
 * logic, but never mutates Order/Trade state itself — all of that goes
 * through the injected `KillSwitchExecutionPort` (design.md §8's assumed
 * `paper-execution` command interface: `cancelEntryOrders`,
 * `rejectFurtherEntry`, `startEmergencyExit`, `abortTrade`, `failTrade`).
 * Because `paper-execution-engine` does not exist yet, the caller supplies a
 * `KillSwitchTradeSnapshot[]` on every call describing which trades are
 * currently open and in what status — this coordinator does not keep its
 * own trade list.
 */
import type { TradeStatus } from '../types/status';
import type { TradingEvent, TradingEventType } from '../types/event';
import type { EntryGateSource, RiskConfig } from './types';

export type KillSwitchLevel = 'NONE' | 'L1_STOP_ENTRY' | 'L2_CANCEL_ENTRY' | 'L3_FLATTEN';

const LEVEL_ORDER: Record<KillSwitchLevel, number> = {
  NONE: 0,
  L1_STOP_ENTRY: 1,
  L2_CANCEL_ENTRY: 2,
  L3_FLATTEN: 3,
};

export type ActivateSource = 'MANUAL' | 'AUTO';

/** The three automatic-trigger reasons (design.md Decision 6 (5); spec.md "自動觸發對應層級"). */
export type AutoTriggerReason = 'EXCHANGE_DISCONNECTED' | 'STALE_MARKET_DATA' | 'RECONCILIATION_ERROR';

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/** `paper-execution`'s command interface (design.md §8) — Kill Switch only requests, never mutates Order/Trade state itself. */
export interface KillSwitchExecutionPort {
  cancelEntryOrders(tradeId: string, reason: string): void;
  rejectFurtherEntry(tradeId: string, reason: string): void;
  startEmergencyExit(tradeId: string, reason: string): void;
  abortTrade(tradeId: string, reason: string): void;
  failTrade(tradeId: string, reason: string): void;
}

export interface KillSwitchEventSink {
  emit(event: TradingEvent): void;
}

/** Minimal clock contract (shared shape with `Clock.after`/`VirtualClock.after`). */
export interface KillSwitchClock {
  now(): number;
  after(ms: number, cb: () => void): unknown;
}

/** A non-terminal trade the caller currently knows about, as of the moment it calls into this coordinator. */
export interface KillSwitchTradeSnapshot {
  trade_id: string;
  status: TradeStatus;
  /** Whether this trade has any non-terminal `purpose = 'ENTRY'` order right now. */
  has_open_entry_orders: boolean;
}

export interface KillSwitchDeps {
  execution: KillSwitchExecutionPort;
  eventSink: KillSwitchEventSink;
  clock: KillSwitchClock;
  idGenerator?: () => string;
  tokenGenerator?: () => string;
}

export type ActivateOutcome =
  | { outcome: 'ACTIVATED'; level: KillSwitchLevel }
  | { outcome: 'ALREADY_ACTIVE'; level: KillSwitchLevel };

export type ReleaseOutcome = { outcome: 'RELEASED' } | { outcome: 'REJECTED'; reason: 'KILL_SWITCH_CLEANUP_IN_PROGRESS' };

export type ConfirmFlattenOutcome = { outcome: 'ACTIVATED' } | { outcome: 'REJECTED'; reason: 'FLATTEN_CONFIRMATION_INVALID' };

const TRADES_WITH_OPEN_POSITIONS: readonly TradeStatus[] = ['HEDGED', 'PARTIALLY_HEDGED', 'LEG_IMBALANCE'];
const TRADES_ALREADY_EXITING: readonly TradeStatus[] = ['EXIT_PENDING', 'EMERGENCY_EXIT'];
const UNSENT_TRADE_STATUSES: readonly TradeStatus[] = ['CREATED', 'PRE_FLIGHT'];

/**
 * Pure classification of a trade whose entry orders have all reached a
 * terminal state after an L2 cancel (design.md Decision 6 (3); spec.md "L2
 * 後單腿的 Trade 自動走緊急平倉"). Exported standalone so it can be unit
 * tested without the coordinator's event/port plumbing.
 */
export function classifyAfterEntryCancel(
  hedgeRatio: number,
  cfg: Pick<RiskConfig, 'hedge_ratio_hedged_min'>,
): 'ABORTED' | 'HEDGED' | 'LEG_IMBALANCE' {
  if (hedgeRatio <= 0) return 'ABORTED';
  if (hedgeRatio >= cfg.hedge_ratio_hedged_min) return 'HEDGED';
  return 'LEG_IMBALANCE';
}

export class KillSwitchCoordinator {
  private level: KillSwitchLevel = 'NONE';
  private pendingFlatten: { token: string; expiresAt: number; used: boolean } | undefined;
  /** trade_id -> count of outstanding cleanup actions (cancel-in-flight / emergency-exit-in-flight) blocking release. */
  private cleanupInFlight = new Map<string, number>();
  /** order_id -> retry attempts so far. */
  private cancelRetryAttempts = new Map<string, number>();

  constructor(private readonly deps: KillSwitchDeps) {}

  currentLevel(): KillSwitchLevel {
    return this.level;
  }

  /** The `ENTRY_GATE` source to inject into `PreTradeContext.entry_gate_sources` (design.md §7 "與 Risk Engine 的接點只有一個"). */
  entryGateSource(): EntryGateSource {
    return { open: this.level !== 'NONE', reason_code: 'KILL_SWITCH_ACTIVE' };
  }

  private genId(): string {
    return this.deps.idGenerator ? this.deps.idGenerator() : crypto.randomUUID();
  }

  private genToken(): string {
    return this.deps.tokenGenerator ? this.deps.tokenGenerator() : crypto.randomUUID();
  }

  private emit(event_type: TradingEventType, payload: Record<string, unknown>, trade_id: string | null = null): void {
    const timestamp = this.deps.clock.now();
    this.deps.eventSink.emit({
      event_id: this.genId(),
      event_type,
      timestamp,
      trade_id,
      payload,
      recorded_at: timestamp,
    });
  }

  private markCleanupStarted(tradeId: string): void {
    this.cleanupInFlight.set(tradeId, (this.cleanupInFlight.get(tradeId) ?? 0) + 1);
  }

  /** Call once a cancel/emergency-exit this coordinator requested for `tradeId` has fully settled (success or failure). */
  markCleanupComplete(tradeId: string): void {
    const n = this.cleanupInFlight.get(tradeId) ?? 0;
    if (n <= 1) this.cleanupInFlight.delete(tradeId);
    else this.cleanupInFlight.set(tradeId, n - 1);
  }

  private hasCleanupInProgress(): boolean {
    for (const n of this.cleanupInFlight.values()) if (n > 0) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // L1 effects — abort unsent trades (design.md Decision 6 (1) 附帶 / spec.md
  // "L1 STOP_ENTRY 只禁止新交易")
  // -------------------------------------------------------------------------
  private applyL1(trades: readonly KillSwitchTradeSnapshot[]): void {
    for (const t of trades) {
      if (UNSENT_TRADE_STATUSES.includes(t.status)) {
        this.deps.execution.abortTrade(t.trade_id, 'KILL_SWITCH');
      }
    }
  }

  // -------------------------------------------------------------------------
  // L2 effects — cancel ENTRY-purpose orders, reject further entry (design.md
  // Decision 6 (2) / spec.md "L2 CANCEL_ENTRY 只撤進場單")
  // -------------------------------------------------------------------------
  private applyL2(trades: readonly KillSwitchTradeSnapshot[]): void {
    for (const t of trades) {
      this.deps.execution.rejectFurtherEntry(t.trade_id, 'KILL_SWITCH');
      if (t.has_open_entry_orders) {
        this.markCleanupStarted(t.trade_id);
        this.deps.execution.cancelEntryOrders(t.trade_id, 'KILL_SWITCH');
      }
    }
  }

  /** `paper-execution` calls this when an ENTRY-purpose cancel it requested is rejected (`ORDER_CANCEL_REJECTED`). Retries up to `kill_switch_cancel_retry_max` times, `kill_switch_cancel_retry_interval_ms` apart; on exhaustion emits `KILL_SWITCH_CANCEL_FAILED`. */
  handleOrderCancelRejected(input: { trade_id: string; order_id: string; reason: string }, cfg: RiskConfig): void {
    const attempts = (this.cancelRetryAttempts.get(input.order_id) ?? 0) + 1;
    this.cancelRetryAttempts.set(input.order_id, attempts);
    if (attempts <= cfg.kill_switch_cancel_retry_max) {
      this.deps.clock.after(cfg.kill_switch_cancel_retry_interval_ms, () => {
        this.deps.execution.cancelEntryOrders(input.trade_id, 'KILL_SWITCH');
      });
      return;
    }
    this.cancelRetryAttempts.delete(input.order_id);
    this.markCleanupComplete(input.trade_id);
    this.emit(
      'KILL_SWITCH_CANCEL_FAILED',
      { trade_id: input.trade_id, order_id: input.order_id, attempts: attempts - 1 },
      input.trade_id,
    );
  }

  /**
   * `paper-execution` calls this once every ENTRY order of `tradeId` has
   * reached a terminal state after an L2 cancel. Classifies per spec §14
   * (design.md Decision 6 (3)) and issues the corresponding command;
   * `close_reason = 'KILL_SWITCH'` is the caller's responsibility to stamp
   * when it executes `abortTrade`/`startEmergencyExit`.
   */
  handleEntryOrdersSettled(tradeId: string, hedgeRatio: number, cfg: RiskConfig): 'ABORTED' | 'HEDGED' | 'LEG_IMBALANCE' {
    this.markCleanupComplete(tradeId);
    const classification = classifyAfterEntryCancel(hedgeRatio, cfg);
    if (classification === 'ABORTED') {
      this.deps.execution.abortTrade(tradeId, 'KILL_SWITCH');
    } else if (classification === 'LEG_IMBALANCE') {
      this.markCleanupStarted(tradeId);
      this.deps.execution.startEmergencyExit(tradeId, 'KILL_SWITCH');
    }
    // HEDGED: no command — trade proceeds normally to its existing exit_at.
    return classification;
  }

  // -------------------------------------------------------------------------
  // L3 effects — flatten everything still open (design.md Decision 6 (4) /
  // spec.md "L3 平掉所有部位")
  // -------------------------------------------------------------------------
  private applyL3(trades: readonly KillSwitchTradeSnapshot[]): void {
    for (const t of trades) {
      if (TRADES_ALREADY_EXITING.includes(t.status)) continue; // keep existing exit/emergency-close orders, no duplicate
      if (TRADES_WITH_OPEN_POSITIONS.includes(t.status)) {
        this.markCleanupStarted(t.trade_id);
        this.deps.execution.startEmergencyExit(t.trade_id, 'KILL_SWITCH');
      }
    }
  }

  private applyEffectsFor(level: KillSwitchLevel, trades: readonly KillSwitchTradeSnapshot[]): void {
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.L1_STOP_ENTRY) this.applyL1(trades);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.L2_CANCEL_ENTRY) this.applyL2(trades);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.L3_FLATTEN) this.applyL3(trades);
  }

  /**
   * Manual or automatic activation at L1 or L2 (L3 MUST go through
   * `requestFlatten`/`confirmFlatten` — spec.md "L3 MUST NOT 由系統自動觸發").
   * Escalate-only: a request at or below the current level is a no-op
   * (`ALREADY_ACTIVE`); an `AUTO` no-op still emits `KILL_SWITCH_TRIGGERED`.
   */
  activate(input: {
    level?: KillSwitchLevel;
    source: ActivateSource;
    reason: string;
    actor?: string;
    trades: readonly KillSwitchTradeSnapshot[];
  }): ActivateOutcome {
    const target = input.level ?? 'L1_STOP_ENTRY';
    if (target === 'L3_FLATTEN') {
      throw new Error('L3_FLATTEN requires requestFlatten()/confirmFlatten() — see spec.md two-step confirmation');
    }
    if (LEVEL_ORDER[target] <= LEVEL_ORDER[this.level]) {
      if (input.source === 'AUTO') {
        this.emit('KILL_SWITCH_TRIGGERED', { current_level: this.level, source: 'AUTO', reason: input.reason });
      }
      return { outcome: 'ALREADY_ACTIVE', level: this.level };
    }
    const from = this.level;
    this.level = target;
    this.emit('KILL_SWITCH_ACTIVATED', { from, to: target, source: input.source, reason: input.reason, actor: input.actor });
    this.applyEffectsFor(target, input.trades);
    return { outcome: 'ACTIVATED', level: target };
  }

  /** Convenience wrapper for the three documented automatic triggers (design.md Decision 6 (5)). `CLOCK_UNRELIABLE` deliberately has no case — it does not trigger Kill Switch. */
  handleAutoTrigger(input: { trigger: AutoTriggerReason; affectedTradeId?: string }, trades: readonly KillSwitchTradeSnapshot[]): ActivateOutcome {
    const outcome = this.activate({ level: 'L1_STOP_ENTRY', source: 'AUTO', reason: input.trigger, trades });
    if (input.trigger === 'RECONCILIATION_ERROR' && input.affectedTradeId) {
      this.deps.execution.failTrade(input.affectedTradeId, 'RECONCILIATION_ERROR');
    }
    return outcome;
  }

  /** Manual release back to `NONE` (spec.md "只能手動解除"). Rejected while any L2/L3 cleanup is still in flight. */
  release(input: { actor: string; reason: string }): ReleaseOutcome {
    if (this.hasCleanupInProgress()) {
      return { outcome: 'REJECTED', reason: 'KILL_SWITCH_CLEANUP_IN_PROGRESS' };
    }
    const from = this.level;
    this.level = 'NONE';
    this.pendingFlatten = undefined;
    this.emit('KILL_SWITCH_RELEASED', { from, actor: input.actor, reason: input.reason });
    return { outcome: 'RELEASED' };
  }

  /** Step 1 of L3's two-step confirmation: issues a one-time code, TTL `kill_switch_flatten_confirm_ttl_ms`. */
  requestFlatten(cfg: Pick<RiskConfig, 'kill_switch_flatten_confirm_ttl_ms'>): { token: string; expiresAt: number } {
    const now = this.deps.clock.now();
    const token = this.genToken();
    const expiresAt = now + cfg.kill_switch_flatten_confirm_ttl_ms;
    this.pendingFlatten = { token, expiresAt, used: false };
    this.emit('KILL_SWITCH_FLATTEN_REQUESTED', { expires_at: expiresAt });
    return { token, expiresAt };
  }

  /** Step 2: confirms with the code from `requestFlatten`. Wrong/used/expired code is rejected and no emergency-close is ever sent. */
  confirmFlatten(input: { token: string; trades: readonly KillSwitchTradeSnapshot[]; actor?: string }): ConfirmFlattenOutcome {
    const now = this.deps.clock.now();
    const pending = this.pendingFlatten;
    const valid = pending !== undefined && !pending.used && pending.token === input.token && now <= pending.expiresAt;
    if (!valid) {
      this.emit('KILL_SWITCH_FLATTEN_REJECTED', { reason: 'FLATTEN_CONFIRMATION_INVALID' });
      return { outcome: 'REJECTED', reason: 'FLATTEN_CONFIRMATION_INVALID' };
    }
    pending.used = true;
    const from = this.level;
    this.level = 'L3_FLATTEN';
    this.emit('KILL_SWITCH_ACTIVATED', { from, to: 'L3_FLATTEN', source: 'MANUAL', reason: 'FLATTEN_CONFIRMED', actor: input.actor });
    this.applyEffectsFor('L3_FLATTEN', input.trades);
    return { outcome: 'ACTIVATED' };
  }

  // -------------------------------------------------------------------------
  // Event-sourced rebuild (spec.md "Kill Switch 狀態可由事件重建")
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the current level from a replayed event stream — no separate
   * persisted state table. MUST be called (and its result installed via
   * `restoreLevel`) before Paper Execution ARMs at Runtime startup.
   */
  static rebuildLevel(events: readonly Pick<TradingEvent, 'event_type' | 'payload'>[]): KillSwitchLevel {
    let level: KillSwitchLevel = 'NONE';
    for (const e of events) {
      if (e.event_type === 'KILL_SWITCH_ACTIVATED') {
        level = e.payload.to as KillSwitchLevel;
      } else if (e.event_type === 'KILL_SWITCH_RELEASED') {
        level = 'NONE';
      }
    }
    return level;
  }

  /** Installs a rebuilt level (e.g. from `rebuildLevel`) without emitting any event. */
  restoreLevel(level: KillSwitchLevel): void {
    this.level = level;
  }
}
