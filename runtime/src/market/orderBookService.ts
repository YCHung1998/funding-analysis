/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 盤口服務（market-data-stream spec「Order book integrity」）：SNAPSHOT_STREAM /
 * DELTA_STREAM、序號缺口與交叉盤口偵測 → RESYNCING + REST 快照 + `ORDER_BOOK_RESYNC`。
 */
import type { Clock } from '../clock/types';
import type { EventSink } from './instruments/types';
import type { GuardedRestClient } from './http/guardedRestClient';
import type { MarketDataAdapter, OrderBookDelta, OrderBookLevel, OrderBookSnapshot } from './types';

export type OrderBookStatus = 'WARMING_UP' | 'OK' | 'RESYNCING';

export interface OrderBookView {
  status: OrderBookStatus;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  sequence?: number;
  exchange_timestamp?: number;
}

interface BookEntry {
  status: OrderBookStatus;
  bids: Map<number, number>;
  asks: Map<number, number>;
  sequence: number | null;
  exchange_timestamp: number;
}

export interface OrderBookServiceDeps {
  clock: Clock;
  eventSink: EventSink;
  restClient: GuardedRestClient;
  adapterFor(exchange: string): Pick<MarketDataAdapter, 'exchange' | 'rest'>;
}

function applyLevels(book: Map<number, number>, levels: OrderBookLevel[]): void {
  for (const l of levels) {
    if (l.qty === 0) book.delete(l.price);
    else book.set(l.price, l.qty);
  }
}

function toSorted(book: Map<number, number>, desc: boolean): OrderBookLevel[] {
  return [...book.entries()]
    .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
    .map(([price, qty]) => ({ price, qty }));
}

function bestBid(book: Map<number, number>): number | null {
  let best: number | null = null;
  for (const price of book.keys()) if (best === null || price > best) best = price;
  return best;
}

function bestAsk(book: Map<number, number>): number | null {
  let best: number | null = null;
  for (const price of book.keys()) if (best === null || price < best) best = price;
  return best;
}

export class OrderBookService {
  private readonly books = new Map<string, BookEntry>();
  private readonly resyncInFlight = new Set<string>();

  constructor(private readonly deps: OrderBookServiceDeps) {}

  private ensure(instrument_id: string): BookEntry {
    let entry = this.books.get(instrument_id);
    if (!entry) {
      entry = { status: 'WARMING_UP', bids: new Map(), asks: new Map(), sequence: null, exchange_timestamp: 0 };
      this.books.set(instrument_id, entry);
    }
    return entry;
  }

  getOrderBook(instrument_id: string): OrderBookView {
    const entry = this.books.get(instrument_id);
    if (!entry) return { status: 'WARMING_UP', bids: [], asks: [] };
    return {
      status: entry.status,
      bids: toSorted(entry.bids, true),
      asks: toSorted(entry.asks, false),
      sequence: entry.sequence ?? undefined,
      exchange_timestamp: entry.exchange_timestamp,
    };
  }

  applySnapshot(snapshot: OrderBookSnapshot): void {
    const entry = this.ensure(snapshot.symbol);
    entry.bids = new Map(snapshot.bids.map((l) => [l.price, l.qty]));
    entry.asks = new Map(snapshot.asks.map((l) => [l.price, l.qty]));
    entry.sequence = snapshot.sequence ?? null;
    entry.exchange_timestamp = snapshot.exchange_timestamp;
    entry.status = 'OK';
  }

  /** SNAPSHOT_STREAM 模式：每則訊息是完整前 N 檔，直接視同快照。 */
  applyFullSnapshotStream(snapshot: OrderBookSnapshot): void {
    this.applySnapshot(snapshot);
  }

  /** DELTA_STREAM 模式：序號缺口 / 交叉盤口觸發 RESYNCING + REST 回補。 */
  applyDelta(delta: OrderBookDelta, depth: number): void {
    const entry = this.ensure(delta.symbol);

    if (entry.status !== 'OK') return; // 尚未有快照基準，等待快照或已在 RESYNCING 中

    if (entry.sequence !== null && delta.sequence <= entry.sequence) return; // 重複增量忽略

    if (entry.sequence !== null && delta.prev_sequence !== entry.sequence) {
      this.triggerResync(delta.exchange, delta.symbol, depth, 'SEQUENCE_GAP');
      return;
    }

    applyLevels(entry.bids, delta.bids);
    applyLevels(entry.asks, delta.asks);
    entry.sequence = delta.sequence;
    entry.exchange_timestamp = delta.exchange_timestamp;

    const bb = bestBid(entry.bids);
    const ba = bestAsk(entry.asks);
    if (bb !== null && ba !== null && bb >= ba) {
      this.triggerResync(delta.exchange, delta.symbol, depth, 'CROSSED_BOOK');
    }
  }

  private triggerResync(exchange: string, instrument_id: string, depth: number, reason: string): void {
    const entry = this.ensure(instrument_id);
    entry.status = 'RESYNCING';
    entry.sequence = null;
    this.deps.eventSink.emit({
      event_id: crypto.randomUUID(),
      event_type: 'ORDER_BOOK_RESYNC',
      timestamp: this.deps.clock.now(),
      recorded_at: this.deps.clock.now(),
      exchange: exchange as never,
      symbol: instrument_id,
      trade_id: null,
      payload: { reason },
    });
    void this.resyncFromRest(exchange, instrument_id, depth);
  }

  async resyncFromRest(exchange: string, instrument_id: string, depth: number): Promise<void> {
    if (this.resyncInFlight.has(instrument_id)) return;
    this.resyncInFlight.add(instrument_id);
    try {
      const adapter = this.deps.adapterFor(exchange);
      const nativeSymbol = instrument_id.split(':').slice(1).join(':');
      const req = adapter.rest.snapshotOrderBook(nativeSymbol, depth);
      const result = await this.deps.restClient.getJson<unknown>(req);
      const snapshot = adapter.rest.parseOrderBookSnapshot(result.data, nativeSymbol, result.local_received);
      this.applySnapshot(snapshot);
    } finally {
      this.resyncInFlight.delete(instrument_id);
    }
  }
}
