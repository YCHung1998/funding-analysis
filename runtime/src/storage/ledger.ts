/**
 * runtime/src/storage/ledger.ts
 *
 * Synchronous ledger transactions (design.md Decision 4, tech spec §35
 * note / §12, spec "Synchronous ledger commits"). Every method commits its
 * entity row(s) and their `TradingEvent`s in one DB transaction. The
 * returned events are handed only to the injected `publishToUi` callback —
 * never to the `EventQueue` — so they are structurally impossible to
 * re-write via `DatabaseWriter` (they were already written by
 * `EventStore.append` inside this same transaction).
 */
import { makeTransitionEvent } from '../types/event';
import type { AccountSnapshot, Fill, PaperOrder, PaperPosition, Trade } from '../types';
import type { TradeLeg } from '../types/trade';
import type { AccountRepository } from './accountRepository';
import type { SqliteDriver } from './driver';
import type { AppendEventInput, EventStore, EventStoreClock, StoredTradingEvent } from './eventStore';
import type { OrderRepository } from './orderRepository';
import type { TradeRepository } from './tradeRepository';

export class InsufficientCapitalError extends Error {
  constructor(
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`INSUFFICIENT_CAPITAL: requested ${requested}, available ${available}`);
    this.name = 'INSUFFICIENT_CAPITAL';
  }
}

export interface LedgerRepos {
  trade: TradeRepository;
  order: OrderRepository;
  account: AccountRepository;
}

export type UiPublisher = (event: StoredTradingEvent) => void;

function nextSnapshot(
  latest: AccountSnapshot,
  delta: Partial<Pick<AccountSnapshot, 'reserved_capital_usdt' | 'available_capital_usdt'>>,
  reason: AccountSnapshot['reason'],
  tradeId: string,
  snapshotTime: number,
): AccountSnapshot {
  return {
    ...latest,
    snapshot_id: crypto.randomUUID(),
    snapshot_time: snapshotTime,
    reason,
    trade_id: tradeId,
    created_at: snapshotTime,
    updated_at: snapshotTime,
    ...delta,
  };
}

export class Ledger {
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: EventStoreClock,
    private readonly repos: LedgerRepos,
    private readonly eventStore: EventStore,
    private readonly publishToUi: UiPublisher = () => {},
  ) {}

  reserveCapitalAndCreateTrade(trade: Trade, amount: number): { trade: Trade; snapshot: AccountSnapshot; events: StoredTradingEvent[] } {
    return this.db.transaction(() => {
      const latest = this.repos.account.getLatestAccountSnapshot(trade.mode);
      const available = latest?.available_capital_usdt ?? 0;
      if (amount > available) {
        throw new InsufficientCapitalError(amount, available);
      }
      const now = this.clock.now();
      const snapshot = nextSnapshot(
        latest!,
        { reserved_capital_usdt: latest!.reserved_capital_usdt + amount, available_capital_usdt: available - amount },
        'CAPITAL_RESERVED',
        trade.trade_id,
        now,
      );
      this.repos.account.saveAccountSnapshot(snapshot);
      this.repos.trade.saveTrade(trade);

      const capitalEvent = this.eventStore.append({
        event_id: crypto.randomUUID(),
        event_type: 'CAPITAL_RESERVED',
        timestamp: now,
        trade_id: trade.trade_id,
        payload: { snapshot, reason: 'CAPITAL_RESERVED' },
      });
      const tradeEvent = this.eventStore.append({
        event_id: crypto.randomUUID(),
        event_type: 'TRADE_CREATED',
        timestamp: now,
        trade_id: trade.trade_id,
        payload: { after: trade },
      });
      const events = [capitalEvent, tradeEvent];
      for (const e of events) this.publishToUi(e);
      return { trade, snapshot, events };
    });
  }

  releaseCapital(tradeId: string, reason: string): { snapshot: AccountSnapshot; events: StoredTradingEvent[] } {
    return this.db.transaction(() => {
      const trade = this.repos.trade.getTrade(tradeId);
      if (!trade) throw new Error(`releaseCapital: unknown trade ${tradeId}`);
      const amount = trade.allocated_capital_usdt;
      const latest = this.repos.account.getLatestAccountSnapshot(trade.mode);
      if (!latest) throw new Error('releaseCapital: no account snapshot exists');
      const now = this.clock.now();
      const snapshot = nextSnapshot(
        latest,
        { reserved_capital_usdt: latest.reserved_capital_usdt - amount, available_capital_usdt: latest.available_capital_usdt + amount },
        'CAPITAL_RELEASED',
        tradeId,
        now,
      );
      this.repos.account.saveAccountSnapshot(snapshot);
      const event = this.eventStore.append({
        event_id: crypto.randomUUID(),
        event_type: 'CAPITAL_RELEASED',
        timestamp: now,
        trade_id: tradeId,
        payload: { snapshot, reason },
      });
      this.publishToUi(event);
      return { snapshot, events: [event] };
    });
  }

  /**
   * Order creation (paper-execution-engine spec "Order state machine per
   * C-14": "`CREATED → SUBMITTED` SHALL be committed in the same transaction
   * as the order's creation inside `submit`"). `ORDER_CREATED` has no `from`
   * state in `ORDER_TRANSITIONS`, so it is appended directly here — mirroring
   * `reserveCapitalAndCreateTrade`'s `TRADE_CREATED` — immediately followed,
   * in the same transaction, by the `CREATED → SUBMITTED` transition event
   * via the same machinery `applyOrderTransition` uses. `created` is never
   * persisted on its own row; only `submitted` is written.
   */
  createOrder(created: PaperOrder, submitted: PaperOrder, reason: string): { order: PaperOrder; events: StoredTradingEvent[] } {
    return this.db.transaction(() => {
      const createdEvent = this.eventStore.append({
        event_id: crypto.randomUUID(),
        event_type: 'ORDER_CREATED',
        timestamp: created.created_at,
        trade_id: created.trade_id,
        leg_id: created.leg_id,
        order_id: created.order_id,
        payload: { after: created },
      });
      this.repos.order.saveOrder(submitted);
      const transitionEvent = makeTransitionEvent('ORDER', created as never, submitted as never, reason, this.clock);
      const submittedEvent = this.eventStore.append(transitionEvent as AppendEventInput);
      const events = [createdEvent, submittedEvent];
      for (const e of events) this.publishToUi(e);
      return { order: submitted, events };
    });
  }

  applyOrderTransition(before: PaperOrder, after: PaperOrder, reason: string): { order: PaperOrder; event: StoredTradingEvent } {
    return this.db.transaction(() => {
      this.repos.order.saveOrder(after);
      const transitionEvent = makeTransitionEvent('ORDER', before as never, after as never, reason, this.clock);
      const event = this.eventStore.append(transitionEvent as AppendEventInput);
      this.publishToUi(event);
      return { order: after, event };
    });
  }

  applyFill(params: {
    fill: Fill;
    orderBefore: PaperOrder;
    orderAfter: PaperOrder;
    reason: string;
    position?: PaperPosition;
    positionEventType?: 'POSITION_OPENED' | 'POSITION_CLOSED';
  }): { fill: Fill; order: PaperOrder; position?: PaperPosition; events: StoredTradingEvent[] } {
    const { fill, orderBefore, orderAfter, reason, position, positionEventType } = params;
    return this.db.transaction(() => {
      this.repos.order.saveFill(fill);
      this.repos.order.saveOrder(orderAfter);
      if (position) this.repos.order.savePosition(position);

      const transitionEvent = makeTransitionEvent('ORDER', orderBefore as never, orderAfter as never, reason, this.clock);
      const fillEvent = this.eventStore.append({
        ...(transitionEvent as AppendEventInput),
        payload: { ...transitionEvent.payload, fill },
      });
      const events = [fillEvent];

      if (position && positionEventType) {
        const positionEvent = this.eventStore.append({
          event_id: crypto.randomUUID(),
          event_type: positionEventType,
          timestamp: this.clock.now(),
          trade_id: position.trade_id,
          position_id: position.position_id,
          payload: { after: position },
        });
        events.push(positionEvent);
      }

      for (const e of events) this.publishToUi(e);
      return { fill, order: orderAfter, position, events };
    });
  }

  /**
   * Trade status transition (`paper-execution-engine` design.md Decision 6:
   * "Coordinator 以 makeTransitionEvent 產生事件，經 Ledger 同步寫入" and
   * "進入 ABORTED、CLOSED 時同一 transaction 呼叫 releaseCapital"). When
   * `releaseCapitalReason` is given, the capital release is committed in the
   * SAME transaction as the trade row + `TRADE_STATUS_CHANGED` event (not by
   * calling the separate `releaseCapital` method, to avoid nesting
   * `db.transaction`).
   */
  applyTradeTransition(
    before: Trade,
    after: Trade,
    reason: string,
    opts: { releaseCapitalReason?: string } = {},
  ): { trade: Trade; events: StoredTradingEvent[] } {
    return this.db.transaction(() => {
      this.repos.trade.saveTrade(after);
      const transitionEvent = makeTransitionEvent('TRADE', before as never, after as never, reason, this.clock);
      const event = this.eventStore.append(transitionEvent as AppendEventInput);
      const events: StoredTradingEvent[] = [event];

      if (opts.releaseCapitalReason) {
        const latest = this.repos.account.getLatestAccountSnapshot(after.mode);
        if (!latest) throw new Error('applyTradeTransition: no account snapshot exists');
        const amount = after.allocated_capital_usdt;
        const now = this.clock.now();
        const snapshot = nextSnapshot(
          latest,
          { reserved_capital_usdt: latest.reserved_capital_usdt - amount, available_capital_usdt: latest.available_capital_usdt + amount },
          'CAPITAL_RELEASED',
          after.trade_id,
          now,
        );
        this.repos.account.saveAccountSnapshot(snapshot);
        const capitalEvent = this.eventStore.append({
          event_id: crypto.randomUUID(),
          event_type: 'CAPITAL_RELEASED',
          timestamp: now,
          trade_id: after.trade_id,
          payload: { snapshot, reason: opts.releaseCapitalReason },
        });
        events.push(capitalEvent);
      }

      for (const e of events) this.publishToUi(e);
      return { trade: after, events };
    });
  }

  /** Leg status transition (design.md Decision 6); `LEG_STATUS_CHANGED` event via `makeTransitionEvent`. */
  applyLegTransition(before: TradeLeg, after: TradeLeg, reason: string): { leg: TradeLeg; event: StoredTradingEvent } {
    return this.db.transaction(() => {
      this.repos.trade.saveTradeLeg(after);
      const transitionEvent = makeTransitionEvent('LEG', before as never, after as never, reason, this.clock);
      const event = this.eventStore.append(transitionEvent as AppendEventInput);
      this.publishToUi(event);
      return { leg: after, event };
    });
  }

  /** Generic single-event commit (e.g. `HEDGE_RATIO_CHANGED`, `EMERGENCY_EXIT_STARTED`, `EXIT_STARTED` — observational, not a state transition). */
  appendEvent(input: AppendEventInput): StoredTradingEvent {
    return this.db.transaction(() => {
      const event = this.eventStore.append(input);
      this.publishToUi(event);
      return event;
    });
  }
}
