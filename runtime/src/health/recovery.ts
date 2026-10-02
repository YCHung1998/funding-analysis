/**
 * runtime/src/health/recovery.ts
 *
 * Restart recovery (design.md Decision 5, tasks.md 4.2). Paper matching
 * state lives only in memory (`PaperExecutionAdapter`'s `orders` map) so a
 * restart loses it; this module brings the persisted projections back to a
 * consistent state before the Runtime resumes normal operation (main.ts
 * startup step 7, before step 8 Reconcile):
 *
 *  1. Every non-terminal Order is closed via a legal transition only
 *     (`isAllowedTransition` in `types/status.ts`): `SUBMITTED -> REJECTED`;
 *     `ACKNOWLEDGED` / `PARTIALLY_FILLED -> CANCEL_REQUESTED -> CANCELED`
 *     (filled_quantity preserved); `CANCEL_REQUESTED -> CANCELED` directly.
 *     This is the simulated exchange's "restart = every open order is
 *     pulled" semantics (design.md Decision 5).
 *  2. Any Trade still in an entry-side / unsettled-imbalance state
 *     (`CREATED`/`PRE_FLIGHT`/`ENTRY_PENDING`/`PARTIALLY_HEDGED`/
 *     `LEG_IMBALANCE`/`EMERGENCY_EXIT`) is transitioned to `FAILED` (capital
 *     released) and a single `EntryHaltPort.requestHalt({source:
 *     'RUNTIME_RECOVERY', ...})` is issued for the batch — C-16 already
 *     decided automatic action stops at "halt new entries", never an
 *     automatic emergency close (design.md Non-goals / Decision 5). `HEDGED`
 *     / `EXIT_PENDING` Trades are instead handed to
 *     `SettlementRecoveryHandoff.registerRecoveredTrade` — `exit_at` already
 *     past is a normal exit, not a Kill Switch action (design.md Decision 5).
 *  3. Projection consistency: `EventStore.rebuildProjections` replays every
 *     event into a disposable in-memory scratch DB; any Trade whose rebuilt
 *     status disagrees with the live row's status is flagged via the same
 *     `RECONCILIATION_ERROR` event type `reconciler.ts` uses (so it shows up
 *     identically in `reconciliation_runs` consumers) and triggers another
 *     `requestHalt` — this is deliberately a *different* mismatch source
 *     from the ordinary per-pass `checkProjectionEvent` check in
 *     `checks.ts`/`reconciler.ts` (which only reads the live DB, nothing to
 *     rebuild-and-compare): recovery's version is a one-time, startup-only,
 *     rebuild-from-genesis consistency check, not a recurring pass.
 *
 * `settlement-session` (archived `trading-event-store` design.md /
 * current `runtime/src/session/settlementSession.ts`) exposes no "register
 * an already-existing Trade recovered mid-flight" method yet (design.md
 * Open Question 6) — `SettlementRecoveryHandoff` is this module's own small
 * port; main.ts's production wiring supplies a fake/no-op until
 * `settlement-session` grows a real one (same "fake until implemented"
 * precedent as `reconciler.ts` treating `position-accounting` as a fake
 * before `paper-execution-engine` existed).
 */
import { createTradeRepository } from '../storage/tradeRepository';
import type { EventStore, EventStoreClock } from '../storage/eventStore';
import { NodeSqliteDriver, type SqliteDriver } from '../storage/driver';
import type { Ledger } from '../storage/ledger';
import type { OrderRepository } from '../storage/orderRepository';
import type { TradeRepository } from '../storage/tradeRepository';
import { migrate } from '../storage/migrate';
import { migration001 } from '../storage/migrations/001_initial';
import { migration002 } from '../storage/migrations/002_position_accounting_fields';
import { migration003 } from '../storage/migrations/003_runtime_health';
import { TRADE_TERMINAL_STATUSES } from '../types/status';
import type { Trade } from '../types/trade';
import type { PaperOrder } from '../types/order';
import type { EntryHaltPort } from '../reconciliation/entryHalt';

const TERMINAL_TRADE = new Set<string>(TRADE_TERMINAL_STATUSES);
const ORDER_TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
/** Entry-side / unsettled-imbalance Trade states (design.md Decision 5). */
const ENTRY_IN_FLIGHT = new Set(['CREATED', 'PRE_FLIGHT', 'ENTRY_PENDING', 'PARTIALLY_HEDGED', 'LEG_IMBALANCE', 'EMERGENCY_EXIT']);
/** Trades handed to `settlement-session` instead of failed (design.md Decision 5). */
const HANDOFF_TO_SETTLEMENT = new Set(['HEDGED', 'EXIT_PENDING']);

export interface SettlementRecoveryHandoff {
  /** `settlement-session`'s not-yet-existing registration port (design.md Open Question 6); fake until that capability provides one. */
  registerRecoveredTrade(trade: Trade): void;
}

export interface RecoveryRepos {
  trade: TradeRepository;
  order: OrderRepository;
}

export interface RecoveryDeps {
  db: SqliteDriver;
  clock: EventStoreClock;
  eventStore: EventStore;
  ledger: Ledger;
  repos: RecoveryRepos;
  entryHalt: EntryHaltPort;
  settlementHandoff: SettlementRecoveryHandoff;
  /** Injected for tests; defaults to a fresh `NodeSqliteDriver(':memory:')`. */
  scratchDbFactory?: () => SqliteDriver;
  idGenerator?: () => string;
}

export interface RecoveryResult {
  closedOrders: string[];
  failedTrades: string[];
  handedToSettlement: string[];
  projectionMismatches: number;
}

function closeNonTerminalOrder(ledger: Ledger, order: PaperOrder, now: number): void {
  if (ORDER_TERMINAL.has(order.order_state)) return;

  if (order.order_state === 'SUBMITTED') {
    const after: PaperOrder = { ...order, order_state: 'REJECTED', rejection_reason: 'RUNTIME_RESTART', terminal_time: now, updated_at: now };
    ledger.applyOrderTransition(order, after, 'runtime restart recovery: submitted never acknowledged');
    return;
  }

  if (order.order_state === 'ACKNOWLEDGED' || order.order_state === 'PARTIALLY_FILLED') {
    const cancelRequested: PaperOrder = { ...order, order_state: 'CANCEL_REQUESTED', cancel_request_time: now, updated_at: now };
    const { order: afterCancelRequested } = ledger.applyOrderTransition(order, cancelRequested, 'runtime restart recovery: cancel requested');
    const canceled: PaperOrder = { ...afterCancelRequested, order_state: 'CANCELED', cancel_ack_time: now, terminal_time: now, updated_at: now };
    ledger.applyOrderTransition(afterCancelRequested, canceled, 'runtime restart recovery: canceled');
    return;
  }

  if (order.order_state === 'CANCEL_REQUESTED') {
    const canceled: PaperOrder = { ...order, order_state: 'CANCELED', cancel_ack_time: now, terminal_time: now, updated_at: now };
    ledger.applyOrderTransition(order, canceled, 'runtime restart recovery: canceled');
  }
}

export function recoverFromEventStore(deps: RecoveryDeps): RecoveryResult {
  const now = deps.clock.now();
  const genId = deps.idGenerator ?? (() => crypto.randomUUID());
  const trades = deps.repos.trade.listTrades();

  // 1. Close every non-terminal Order via a legal transition.
  const closedOrders: string[] = [];
  for (const trade of trades) {
    for (const order of deps.repos.order.listOrdersForTrade(trade.trade_id)) {
      if (ORDER_TERMINAL.has(order.order_state)) continue;
      closeNonTerminalOrder(deps.ledger, order, now);
      closedOrders.push(order.order_id);
    }
  }

  // 2. In-flight entry Trades -> FAILED + halt; HEDGED/EXIT_PENDING -> settlement handoff.
  const failedTrades: string[] = [];
  const handedToSettlement: string[] = [];
  for (const trade of trades) {
    if (TERMINAL_TRADE.has(trade.status)) continue;
    if (ENTRY_IN_FLIGHT.has(trade.status)) {
      const after: Trade = { ...trade, status: 'FAILED', updated_at: now };
      deps.ledger.applyTradeTransition(trade, after, 'runtime restart recovery: entry in-flight', {
        releaseCapitalReason: 'RUNTIME_RECOVERY',
      });
      failedTrades.push(trade.trade_id);
    } else if (HANDOFF_TO_SETTLEMENT.has(trade.status)) {
      deps.settlementHandoff.registerRecoveredTrade(trade);
      handedToSettlement.push(trade.trade_id);
    }
  }
  if (failedTrades.length > 0) {
    deps.entryHalt.requestHalt({ source: 'RUNTIME_RECOVERY', reason: 'ENTRY_IN_FLIGHT_AT_RESTART', trade_ids: failedTrades });
  }

  // 3. Projection consistency: rebuild from the event store into a scratch
  // DB and compare every live Trade's status against the rebuilt one.
  const scratch = (deps.scratchDbFactory ?? (() => new NodeSqliteDriver(':memory:')))();
  let projectionMismatches = 0;
  try {
    migrate(scratch, [migration001, migration002, migration003]);
    // Disposable comparison-only DB: the event stream only ever recreates
    // entities that were themselves committed through the Ledger (e.g. an
    // `Opportunity` row seeded directly by a test harness, never emitted as
    // an `OPPORTUNITY_*` event, has no event to rebuild it from) — foreign
    // keys are relaxed here so a legitimately-incomplete replay can still be
    // compared, rather than throwing before any mismatch can be reported.
    scratch.exec('PRAGMA foreign_keys = OFF');
    deps.eventStore.rebuildProjections(scratch);
    const rebuiltTradeRepo = createTradeRepository(scratch);
    const mismatchedTradeIds: string[] = [];
    const liveTrades = deps.repos.trade.listTrades();
    for (const live of liveTrades) {
      const rebuilt = rebuiltTradeRepo.getTrade(live.trade_id);
      if (!rebuilt || rebuilt.status !== live.status) {
        projectionMismatches += 1;
        mismatchedTradeIds.push(live.trade_id);
        deps.ledger.appendEvent({
          event_id: genId(),
          event_type: 'RECONCILIATION_ERROR',
          timestamp: now,
          trade_id: live.trade_id,
          payload: {
            check_id: 'PROJECTION_REBUILD_MISMATCH',
            entity_id: live.trade_id,
            details: `live=${live.status} rebuilt=${rebuilt?.status ?? 'MISSING'}`,
          },
        });
      }
    }
    if (mismatchedTradeIds.length > 0) {
      deps.entryHalt.requestHalt({
        source: 'RUNTIME_RECOVERY',
        reason: 'PROJECTION_MISMATCH_AT_RESTART',
        trade_ids: mismatchedTradeIds,
      });
    }
  } finally {
    scratch.close();
  }

  return { closedOrders, failedTrades, handedToSettlement, projectionMismatches };
}
