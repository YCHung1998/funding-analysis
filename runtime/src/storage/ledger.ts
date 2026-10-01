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
}
