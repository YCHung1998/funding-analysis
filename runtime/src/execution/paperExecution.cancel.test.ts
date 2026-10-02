/**
 * runtime/src/execution/paperExecution.cancel.test.ts
 *
 * Task 2.5 — Cancel outcomes (spec "Cancel outcomes" / "Reduce-only close
 * orders and Cancel ≠ Close"): success keeping partial fill, failure
 * reverting to the prior state, fill-before-cancel-arrives, cancel-before-ACK
 * deferral, terminal-order refusal, reduce-only validation, Cancel ≠ Close.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeFeeRateSource } from '../../test/fakes/fakeFeeRates';
import { FakeFundingWindowGuard } from '../../test/fakes/fakeGuard';
import { FakeInstrumentSource } from '../../test/fakes/fakeInstruments';
import { FakeOrderBookSource } from '../../test/fakes/fakeOrderBook';
import { FakePositionReader } from '../../test/fakes/fakePositions';
import { makeTestLedger, type TestLedgerHarness } from '../../test/fakes/testLedger';
import type { OrderRequest } from './executionInterface';
import { PaperExecutionAdapter, type PaperExecutionAdapterConfig } from './paperExecution';

const harnesses: TestLedgerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function setup(config: Partial<PaperExecutionAdapterConfig> = {}, latency: { ack_ms?: number; fill_ms?: number; cancel_ms?: number } = {}) {
  const harness = makeTestLedger({ start: 0 });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const positions = new FakePositionReader();
  const adapter = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments: new FakeInstrumentSource(),
    feeRates: new FakeFeeRateSource(0.0005),
    positions,
    guard: new FakeFundingWindowGuard(),
    config: {
      seed: 21,
      execution_latency: {
        Binance: { ack_ms: latency.ack_ms ?? 0, fill_ms: latency.fill_ms ?? 0, cancel_ms: latency.cancel_ms ?? 60 },
        Bybit: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Pionex: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Bitget: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        OKX: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
      },
      max_order_lifetime_ms: 600_000,
      ack_timeout_ms: 300_000,
      ...config,
    },
  });
  return { harness, orderBook, adapter, positions };
}

function baseRequest(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    client_order_id: 'c1',
    trade_id: 'trade1',
    leg_id: 'legL',
    purpose: 'ENTRY',
    exchange: 'Binance',
    symbol: 'BTCUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    reduce_only: false,
    requested_quantity: 1000,
    requested_notional_usdt: 100_000,
    reference_price: 100,
    estimated_fee_usdt: 50,
    estimated_slippage_pct: 0,
    ...overrides,
  };
}

describe('PaperExecutionAdapter cancel outcomes', () => {
  it('S05 cancel success keeps the partial fill', async () => {
    const { harness, orderBook, adapter } = setup({}, { cancel_ms: 60 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    expect((await adapter.getOrder(submitted.order_id)).filled_quantity).toBe(300);

    await adapter.cancel(submitted.order_id);
    const requested = await adapter.getOrder(submitted.order_id);
    expect(requested.order_state).toBe('CANCEL_REQUESTED');
    const requestTime = requested.cancel_request_time!;

    harness.clock.advanceTo(requestTime + 60);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('CANCELED');
    expect(final.filled_quantity).toBe(300);
    expect(final.remaining_quantity).toBe(700);
    expect(final.cancel_ack_time).toBe(requestTime + 60);
  });

  it('S06 cancel failure reverts to the prior state with ORDER_CANCEL_REJECTED', async () => {
    const { harness, orderBook, adapter } = setup({ enable_failure_injection: true, failure_injection: { Binance: { cancel_failure_probability: 1.0 } } }, { cancel_ms: 60 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    expect((await adapter.getOrder(submitted.order_id)).order_state).toBe('ACKNOWLEDGED');

    await adapter.cancel(submitted.order_id);
    harness.clock.advanceTo(1 + 60);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('ACKNOWLEDGED');
    expect(final.cancel_reject_reason).toBe('CANCEL_REJECTED_SIMULATED');
    expect(final.cancel_ack_time).toBeUndefined();

    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events.map((e) => e.event_type)).toContain('ORDER_CANCEL_REJECTED');
  });

  it('order becoming fully filled before the cancel arrives ends FILLED, not CANCELED', async () => {
    const { harness, orderBook, adapter } = setup({}, { cancel_ms: 60 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    expect((await adapter.getOrder(submitted.order_id)).filled_quantity).toBe(300);

    await adapter.cancel(submitted.order_id);
    const requestTime = (await adapter.getOrder(submitted.order_id)).cancel_request_time!;

    // Remaining 700 arrives 20ms after cancel_request_time (before the 60ms cancel latency resolves).
    harness.clock.advanceTo(requestTime + 20);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: requestTime + 20, bids: [], asks: [{ price: 100, qty: 700 }] });

    harness.clock.advanceTo(requestTime + 60);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('FILLED');
    expect(final.filled_quantity).toBe(1000);
  });

  it('cancel called before ACK is deferred: stays SUBMITTED, then ACKNOWLEDGED->CANCEL_REQUESTED at ack_time, CANCELED at +cancel latency', async () => {
    const { harness, orderBook, adapter } = setup({}, { ack_ms: 45, cancel_ms: 60 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const submitted = await adapter.submit(baseRequest());

    harness.clock.advanceTo(20);
    await adapter.cancel(submitted.order_id);
    expect((await adapter.getOrder(submitted.order_id)).order_state).toBe('SUBMITTED');

    harness.clock.advanceTo(45);
    const atAck = await adapter.getOrder(submitted.order_id);
    expect(atAck.order_state).toBe('CANCEL_REQUESTED');
    expect(atAck.cancel_request_time).toBe(45);

    harness.clock.advanceTo(105);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('CANCELED');
    expect(final.filled_quantity).toBe(0);
  });

  it('canceling a terminal (FILLED) order throws ORDER_NOT_CANCELABLE and writes no event', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 2000 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    expect((await adapter.getOrder(submitted.order_id)).order_state).toBe('FILLED');

    const before = harness.eventStore.replay({ trade_id: 'trade1' }).length;
    await expect(adapter.cancel(submitted.order_id)).rejects.toThrow('ORDER_NOT_CANCELABLE');
    const after = harness.eventStore.replay({ trade_id: 'trade1' }).length;
    expect(after).toBe(before);
  });
});

describe('PaperExecutionAdapter reduce-only validation and Cancel != Close', () => {
  it('REDUCE_ONLY_EXCEEDS_POSITION: EXIT quantity exceeds the leg open position', async () => {
    const { harness, orderBook, adapter, positions } = setup();
    positions.setOpenQuantity('legL', 10);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 99.9, qty: 100 }], asks: [] });
    const submitted = await adapter.submit(
      baseRequest({ purpose: 'EXIT', reduce_only: true, side: 'SELL', requested_quantity: 12, requested_notional_usdt: 1200, reference_price: 99.9 }),
    );
    harness.clock.advanceTo(1);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('REJECTED');
    expect(final.rejection_reason).toBe('REDUCE_ONLY_EXCEEDS_POSITION');
  });

  it('EXIT without reduce_only=true throws INVALID_ORDER_REQUEST and creates no order', async () => {
    const { adapter } = setup();
    await expect(adapter.submit(baseRequest({ purpose: 'EXIT', reduce_only: false, side: 'SELL' }))).rejects.toThrow('INVALID_ORDER_REQUEST');
  });

  it('ENTRY with reduce_only=true throws INVALID_ORDER_REQUEST', async () => {
    const { adapter } = setup();
    await expect(adapter.submit(baseRequest({ purpose: 'ENTRY', reduce_only: true }))).rejects.toThrow('INVALID_ORDER_REQUEST');
  });

  it('Cancel != Close: canceling a partially-filled entry order leaves the position alone (no implicit close order)', async () => {
    const { harness, orderBook, adapter } = setup({}, { cancel_ms: 60 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);

    await adapter.cancel(submitted.order_id);
    const requestTime = (await adapter.getOrder(submitted.order_id)).cancel_request_time!;
    harness.clock.advanceTo(requestTime + 60);

    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('CANCELED');
    expect(final.filled_quantity).toBe(300); // the fill stands; cancel never reduces an existing fill/position
    // No EXIT/EMERGENCY_CLOSE order was ever submitted by cancel() itself — only the one ENTRY order exists.
    const orderEvents = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id !== undefined);
    const distinctOrderIds = new Set(orderEvents.map((e) => e.order_id));
    expect(distinctOrderIds.size).toBe(1);
  });
});
