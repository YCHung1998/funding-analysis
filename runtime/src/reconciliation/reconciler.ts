/**
 * runtime/src/reconciliation/reconciler.ts
 *
 * `Reconciler` (design.md Decision 1/2, tasks.md 2.3): Clock-scheduled
 * passes that read a consistent snapshot (one DB transaction per pass —
 * Implementation Notes "`reconciliation_runs` 寫入時機"), run every pure
 * check in `checks.ts`, and for every NEW mismatch (deduplicated by
 * `check_id:entity_id`, Decision 2) append a `RECONCILIATION_ERROR` event
 * and — for a non-terminal affected Trade — transition it to `FAILED` with
 * capital released in the same transaction (mirroring
 * `capitalAtomicity.test.ts`'s `applyTradeTransition(..., { releaseCapitalReason })`
 * pattern). `EntryHaltPort.requestHalt` is called once per pass, AFTER the
 * transaction has committed successfully, so a mid-pass failure can never
 * leave the halt latch "halted" for a write that was itself rolled back.
 *
 * This module deliberately never touches an Order or a Position: no cancel,
 * no close — design.md Non-goals / Decision 2 ("不撤單、不平倉", C-16).
 */
import type { AccountRepository } from '../storage/accountRepository';
import type { SqliteDriver } from '../storage/driver';
import type { EventStore, EventStoreClock, StoredTradingEvent } from '../storage/eventStore';
import type { Ledger } from '../storage/ledger';
import type { OrderRepository } from '../storage/orderRepository';
import type { TradeRepository } from '../storage/tradeRepository';
import { TRADE_TERMINAL_STATUSES } from '../types/status';
import {
  checkCapitalAvailable,
  checkCapitalEventPairing,
  checkCapitalReservedSum,
  checkOrderAvgPrice,
  checkOrderFillSum,
  checkOrderOrphanCreated,
  checkOrderRemaining,
  checkOrderStateQty,
  checkOrderTerminalTime,
  checkPositionFillNet,
  checkProjectionEvent,
  checkTradeClosedNotFlat,
  checkTradeHedgedFlat,
} from './checks';
import type { EntryHaltPort } from './entryHalt';
import type { Mismatch, ProjectionCheckEntry, ReconciliationConfig, ReconciliationSnapshot, TradeSnapshot } from './types';

const TERMINAL = new Set<string>(TRADE_TERMINAL_STATUSES);

/** Order transition event types carrying `payload.to` (design.md Decision 1 PROJECTION_EVENT). `ORDER_CREATED` is excluded — it has no `to`. */
const ORDER_TRANSITION_EVENT_TYPES = new Set([
  'ORDER_SUBMITTED',
  'ORDER_ACK',
  'ORDER_PARTIAL_FILL',
  'ORDER_FILL',
  'ORDER_CANCEL_REQUESTED',
  'ORDER_CANCELED',
  'ORDER_CANCEL_REJECTED',
  'ORDER_REJECTED',
  'ORDER_EXPIRED',
]);

function lastTransitionTo(
  events: readonly StoredTradingEvent[],
  predicate: (e: StoredTradingEvent) => boolean,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (predicate(events[i])) {
      const to = (events[i].payload as { to?: string }).to;
      return to ?? null;
    }
  }
  return null;
}

export interface ReconciliationRunRecord {
  run_id: string;
  started_at: number;
  completed_at: number;
  checks_run: number;
  mismatch_count: number;
  mismatches: Mismatch[];
}

export interface ReconcilerClock extends EventStoreClock {
  after(ms: number, cb: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface ReconcilerRepos {
  trade: TradeRepository;
  order: OrderRepository;
  account: AccountRepository;
}

export interface ReconcilerDeps {
  db: SqliteDriver;
  clock: ReconcilerClock;
  repos: ReconcilerRepos;
  eventStore: EventStore;
  ledger: Ledger;
  entryHalt: EntryHaltPort;
  config: ReconciliationConfig;
  /** Injected for tests; defaults to `crypto.randomUUID`. */
  idGenerator?: () => string;
}

export class Reconciler {
  /** check_id:entity_id -> still-unresolved (design.md Decision 2 "去重"). */
  private readonly dedup = new Set<string>();
  private timer: unknown = null;

  constructor(private readonly deps: ReconcilerDeps) {}

  private genId(): string {
    return this.deps.idGenerator ? this.deps.idGenerator() : crypto.randomUUID();
  }

  /** Clock-scheduled (design.md proposal.md "定期對帳"): runs immediately, then every `config.intervalMs`. */
  start(): void {
    const tick = (): void => {
      this.runOnce();
      this.timer = this.deps.clock.after(this.deps.config.intervalMs, tick);
    };
    this.runOnce();
    this.timer = this.deps.clock.after(this.deps.config.intervalMs, tick);
  }

  stop(): void {
    if (this.timer) this.deps.clock.cancel(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // Snapshot build (design.md Decision 1 "一致快照" / "效能")
  // ---------------------------------------------------------------------------

  private buildSnapshot(now: number): ReconciliationSnapshot {
    const { repos, eventStore, config } = this.deps;
    const allTrades = repos.trade.listTrades();
    const relevant = allTrades.filter((t) => !TERMINAL.has(t.status) || now - t.updated_at <= config.lookbackMs);

    const trades: TradeSnapshot[] = [];
    const projections: ProjectionCheckEntry[] = [];
    const capitalEventCounts = new Map<string, { reserved: number; released: number }>();

    for (const trade of relevant) {
      const orders = repos.order.listOrdersForTrade(trade.trade_id);
      const positions = repos.order.listPositionsForTrade(trade.trade_id);
      const ordersWithFills = orders.map((order) => ({ order, fills: repos.order.listFillsForOrder(order.order_id) }));
      trades.push({ trade, positions, orders: ordersWithFills });

      const events = eventStore.replay({ trade_id: trade.trade_id });

      projections.push({
        kind: 'TRADE',
        entity_id: trade.trade_id,
        trade_id: trade.trade_id,
        projected_status: trade.status,
        last_event_to: lastTransitionTo(events, (e) => e.event_type === 'TRADE_STATUS_CHANGED'),
      });
      for (const leg of trade.legs) {
        projections.push({
          kind: 'LEG',
          entity_id: leg.leg_id,
          trade_id: trade.trade_id,
          projected_status: leg.status,
          last_event_to: lastTransitionTo(events, (e) => e.event_type === 'LEG_STATUS_CHANGED' && e.leg_id === leg.leg_id),
        });
      }
      for (const order of orders) {
        projections.push({
          kind: 'ORDER',
          entity_id: order.order_id,
          trade_id: trade.trade_id,
          projected_status: order.order_state,
          last_event_to: lastTransitionTo(
            events,
            (e) => e.order_id === order.order_id && ORDER_TRANSITION_EVENT_TYPES.has(e.event_type),
          ),
        });
      }

      let reserved = 0;
      let released = 0;
      for (const e of events) {
        if (e.event_type === 'CAPITAL_RESERVED') reserved++;
        if (e.event_type === 'CAPITAL_RELEASED') released++;
      }
      capitalEventCounts.set(trade.trade_id, { reserved, released });
    }

    return {
      trades,
      accountSnapshot: repos.account.getLatestAccountSnapshot('PAPER'),
      projections,
      capitalEventCounts,
    };
  }

  // ---------------------------------------------------------------------------
  // Checks (design.md Decision 1 table)
  // ---------------------------------------------------------------------------

  private runChecks(snapshot: ReconciliationSnapshot): { mismatches: Mismatch[]; checksRun: number } {
    const cfg = this.deps.config;
    const mismatches: Mismatch[] = [];
    let checksRun = 0;
    const run = (fn: () => Mismatch[]): void => {
      mismatches.push(...fn());
      checksRun++;
    };

    for (const ts of snapshot.trades) {
      for (const ow of ts.orders) {
        run(() => checkOrderFillSum(ow.order, ow.fills, cfg));
        run(() => checkOrderAvgPrice(ow.order, ow.fills, cfg));
        run(() => checkOrderRemaining(ow.order, cfg));
        run(() => checkOrderStateQty(ow.order, cfg));
        run(() => checkOrderTerminalTime(ow.order));
        run(() => checkOrderOrphanCreated(ow.order));
      }
      for (const p of ts.positions) {
        run(() => checkPositionFillNet(p, cfg));
      }
      run(() => checkTradeClosedNotFlat(ts.trade, ts.positions, cfg));
      run(() => checkTradeHedgedFlat(ts.trade, ts.positions, cfg));
      run(() => checkCapitalEventPairing(ts.trade, snapshot.capitalEventCounts.get(ts.trade.trade_id)));
    }
    run(() => checkCapitalReservedSum(snapshot.trades.map((t) => t.trade), snapshot.accountSnapshot, cfg));
    run(() => checkCapitalAvailable(snapshot.accountSnapshot, cfg));
    for (const entry of snapshot.projections) {
      run(() => checkProjectionEvent(entry));
    }

    return { mismatches, checksRun };
  }

  // ---------------------------------------------------------------------------
  // Mismatch handling (design.md Decision 2)
  // ---------------------------------------------------------------------------

  /**
   * For every mismatch not already in `this.dedup`: append `RECONCILIATION_ERROR`
   * (via `Ledger.appendEvent`, same transaction as the snapshot read/write —
   * design.md Implementation Notes), and — for a non-terminal Trade, at most
   * once per pass — transition it to `FAILED` with capital released.
   * Mismatches that disappeared since the last pass are dropped from
   * `this.dedup` (design.md Decision 2 "mismatch 消失後移除"). Returns the
   * trade_ids any NEW mismatch touched, so the caller can request an entry
   * halt once, after this transaction commits.
   */
  private handleMismatches(mismatches: readonly Mismatch[]): { newCount: number; affectedTradeIds: string[] } {
    const currentKeys = new Set(mismatches.map((m) => `${m.check_id}:${m.entity_id}`));
    for (const key of [...this.dedup]) {
      if (!currentKeys.has(key)) this.dedup.delete(key);
    }

    const newMismatches = mismatches.filter((m) => !this.dedup.has(`${m.check_id}:${m.entity_id}`));
    const affectedTradeIds = new Set<string>();
    const failedThisPass = new Set<string>();

    for (const m of newMismatches) {
      this.dedup.add(`${m.check_id}:${m.entity_id}`);
      this.deps.ledger.appendEvent({
        event_id: this.genId(),
        event_type: 'RECONCILIATION_ERROR',
        timestamp: this.deps.clock.now(),
        trade_id: m.trade_id,
        payload: { check_id: m.check_id, entity_id: m.entity_id, details: m.details },
      });

      if (m.trade_id) {
        affectedTradeIds.add(m.trade_id);
        if (!failedThisPass.has(m.trade_id)) {
          const trade = this.deps.repos.trade.getTrade(m.trade_id);
          if (trade && !TERMINAL.has(trade.status)) {
            failedThisPass.add(m.trade_id);
            const after = { ...trade, status: 'FAILED' as const, updated_at: this.deps.clock.now() };
            this.deps.ledger.applyTradeTransition(trade, after, 'RECONCILIATION_ERROR', { releaseCapitalReason: 'RECONCILIATION_ERROR' });
          }
          // Already-terminal Trade: design.md Decision 2 "已終態的 Trade 只記事件 + 停止進場" — event already appended above, no transition.
        }
      }
    }

    return { newCount: newMismatches.length, affectedTradeIds: [...affectedTradeIds] };
  }

  // ---------------------------------------------------------------------------
  // reconciliation_runs persistence
  // ---------------------------------------------------------------------------

  private saveRun(record: ReconciliationRunRecord): void {
    this.deps.db
      .prepare(
        `INSERT INTO reconciliation_runs (run_id, started_at, completed_at, checks_run, mismatch_count, mismatches, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.run_id,
        record.started_at,
        record.completed_at,
        record.checks_run,
        record.mismatch_count,
        JSON.stringify(record.mismatches),
        record.completed_at,
        record.completed_at,
      );
  }

  /** One reconciliation pass. Throws (and rolls back everything written this pass) if any step fails. */
  runOnce(): ReconciliationRunRecord {
    const { record, newCount, affectedTradeIds, mismatches } = this.deps.db.transaction(() => {
      const started_at = this.deps.clock.now();
      const snapshot = this.buildSnapshot(started_at);
      const { mismatches, checksRun } = this.runChecks(snapshot);
      const { newCount, affectedTradeIds } = this.handleMismatches(mismatches);
      const completed_at = this.deps.clock.now();
      const record: ReconciliationRunRecord = {
        run_id: this.genId(),
        started_at,
        completed_at,
        checks_run: checksRun,
        mismatch_count: mismatches.length,
        mismatches,
      };
      this.saveRun(record);
      return { record, newCount, affectedTradeIds, mismatches };
    });

    // Requested only after the transaction above has committed (so a mid-pass
    // failure, which rolls back the RECONCILIATION_ERROR event / Trade
    // transition / reconciliation_runs row, can never leave the halt latch
    // "halted" for a write that was itself undone).
    if (newCount > 0) {
      this.deps.entryHalt.requestHalt({
        source: 'RECONCILIATION',
        reason: [...new Set(mismatches.map((m) => m.check_id))].join(','),
        trade_ids: affectedTradeIds,
      });
    }

    return record;
  }
}
