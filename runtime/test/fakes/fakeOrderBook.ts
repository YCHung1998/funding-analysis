/**
 * runtime/test/fakes/fakeOrderBook.ts
 *
 * Fake `OrderBookSource` (stands in for `market-data-stream`, design.md Risks
 * "上游 port 尚未實作"). `setBook` replaces a snapshot and notifies
 * subscribers synchronously (no Clock involved — tests advance the
 * `VirtualClock` separately to drive matching latency).
 */
import type { ExchangeId } from '../../src/types/ids';
import type { OrderBookSnapshot, OrderBookSource } from '../../src/execution/executionInterface';

export class FakeOrderBookSource implements OrderBookSource {
  private books = new Map<string, OrderBookSnapshot>();
  private listeners = new Set<(snapshot: OrderBookSnapshot) => void>();

  private key(exchange: ExchangeId, symbol: string): string {
    return `${exchange}:${symbol}`;
  }

  getOrderBook(exchange: ExchangeId, symbol: string): OrderBookSnapshot | undefined {
    return this.books.get(this.key(exchange, symbol));
  }

  /** Test setter: replace the snapshot for `exchange:symbol` and notify subscribers. */
  setBook(snapshot: OrderBookSnapshot): void {
    this.books.set(this.key(snapshot.exchange, snapshot.symbol), snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }

  onUpdate(listener: (snapshot: OrderBookSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
