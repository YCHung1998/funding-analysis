/**
 * runtime/test/contracts/executionEngine.contract.ts
 *
 * Reusable contract test suite — spec "Replaceable execution interface",
 * Scenario "Contract suite runs against paper adapter": submit -> ACK ->
 * fill, cancel, getOrder consistency, update notifications. Runs against any
 * `ExecutionEngine` implementation via `makeContext()` (today only
 * `PaperExecutionAdapter`, see `runtime/src/execution/paperExecution.contract.test.ts`;
 * a future Live adapter would reuse this same suite, design.md Goals).
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeId } from '../../src/types/ids';
import type { Fill, PaperOrder } from '../../src/types';
import type { VirtualClock } from '../../src/clock/virtualClock';
import type { ExecutionEngine, OrderRequest } from '../../src/execution/executionInterface';
import { FakeOrderBookSource } from '../fakes/fakeOrderBook';

export interface ExecutionEngineContractContext {
  engine: ExecutionEngine;
  clock: VirtualClock;
  orderBook: FakeOrderBookSource;
  /** Exchange/symbol the context's order book is seeded for. */
  exchange: ExchangeId;
  symbol: string;
}

export function runExecutionEngineContractTests(
  makeContext: () => ExecutionEngineContractContext,
  teardown?: (ctx: ExecutionEngineContractContext) => void,
): void {
  function baseRequest(ctx: ExecutionEngineContractContext, overrides: Partial<OrderRequest> = {}): OrderRequest {
    return {
      client_order_id: 'c-contract-1',
      trade_id: 'trade1',
      leg_id: 'legL',
      purpose: 'ENTRY',
      exchange: ctx.exchange,
      symbol: ctx.symbol,
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 1,
      requested_notional_usdt: 100,
      reference_price: 100,
      estimated_fee_usdt: 0.05,
      estimated_slippage_pct: 0,
      ...overrides,
    };
  }

  describe('ExecutionEngine contract', () => {
    it('submit -> ACK -> fill: order reaches FILLED against sufficient depth', async () => {
      const ctx = makeContext();
      ctx.orderBook.setBook({
        exchange: ctx.exchange,
        symbol: ctx.symbol,
        local_received_timestamp: ctx.clock.now(),
        bids: [{ price: 99.99, qty: 10 }],
        asks: [{ price: 100.0, qty: 10 }],
      });
      const submitted = await ctx.engine.submit(baseRequest(ctx));
      expect(submitted.order_state).toBe('SUBMITTED');

      ctx.clock.advanceTo(ctx.clock.now() + 10_000);
      const final = await ctx.engine.getOrder(submitted.order_id);
      expect(final.order_state).toBe('FILLED');
      expect(final.filled_quantity).toBe(1);
      teardown?.(ctx);
    });

    it('cancel: a non-terminal acknowledged order can be canceled', async () => {
      const ctx = makeContext();
      // No depth: order ACKs but never fills, so cancel has something to act on.
      ctx.orderBook.setBook({
        exchange: ctx.exchange,
        symbol: ctx.symbol,
        local_received_timestamp: ctx.clock.now(),
        bids: [],
        asks: [],
      });
      const submitted = await ctx.engine.submit(baseRequest(ctx, { client_order_id: 'c-contract-2' }));
      ctx.clock.advanceTo(ctx.clock.now() + 1_000);
      const acked = await ctx.engine.getOrder(submitted.order_id);
      expect(acked.order_state).toBe('ACKNOWLEDGED');

      await ctx.engine.cancel(submitted.order_id);
      ctx.clock.advanceTo(ctx.clock.now() + 1_000);
      const canceled = await ctx.engine.getOrder(submitted.order_id);
      expect(canceled.order_state).toBe('CANCELED');
      teardown?.(ctx);
    });

    it('getOrder consistency: returns the same data as the submit/cancel results reference', async () => {
      const ctx = makeContext();
      ctx.orderBook.setBook({
        exchange: ctx.exchange,
        symbol: ctx.symbol,
        local_received_timestamp: ctx.clock.now(),
        bids: [],
        asks: [{ price: 100.0, qty: 10 }],
      });
      const submitted = await ctx.engine.submit(baseRequest(ctx, { client_order_id: 'c-contract-3' }));
      const fetched = await ctx.engine.getOrder(submitted.order_id);
      expect(fetched.order_id).toBe(submitted.order_id);
      expect(fetched.client_order_id).toBe(submitted.client_order_id);
      teardown?.(ctx);
    });

    it('onOrderUpdate: listener is notified with the order and any new fills', async () => {
      const ctx = makeContext();
      ctx.orderBook.setBook({
        exchange: ctx.exchange,
        symbol: ctx.symbol,
        local_received_timestamp: ctx.clock.now(),
        bids: [],
        asks: [{ price: 100.0, qty: 10 }],
      });
      const seen: Array<{ order: PaperOrder; fills: Fill[] }> = [];
      const unsubscribe = ctx.engine.onOrderUpdate((order, fills) => seen.push({ order, fills }));

      const submitted = await ctx.engine.submit(baseRequest(ctx, { client_order_id: 'c-contract-4' }));
      ctx.clock.advanceTo(ctx.clock.now() + 10_000);

      const filledNotification = seen.find((s) => s.order.order_id === submitted.order_id && s.order.order_state === 'FILLED');
      expect(filledNotification).toBeDefined();
      expect(filledNotification!.fills.length).toBeGreaterThan(0);

      unsubscribe();
      teardown?.(ctx);
    });
  });
}
