/**
 * runtime/src/execution/paperExecution.partialFill.test.ts
 *
 * Task 2.3 — Partial fills and remainder handling (spec "Partial fills and
 * remainder handling"): tech spec §15 example, GTC re-match on book update,
 * IOC EXPIRED, LIMIT price respected, `enable_partial_fill = false`.
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

function setup(config: Partial<PaperExecutionAdapterConfig> = {}) {
  const harness = makeTestLedger({ start: 0 });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const adapter = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments: new FakeInstrumentSource(),
    feeRates: new FakeFeeRateSource(0.0005),
    positions: new FakePositionReader(),
    guard: new FakeFundingWindowGuard(),
    config: {
      seed: 3,
      execution_latency: {
        Binance: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        Bybit: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        Pionex: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        Bitget: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        OKX: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
      },
      max_order_lifetime_ms: 600_000,
      ack_timeout_ms: 300_000,
      ...config,
    },
  });
  return { harness, orderBook, adapter };
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

describe('PaperExecutionAdapter partial fills (tech spec §15)', () => {
  it('fills what is available and sets PARTIALLY_FILLED with ORDER_PARTIAL_FILL event', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.order_state).toBe('PARTIALLY_FILLED');
    expect(after.filled_quantity).toBe(300);
    expect(after.remaining_quantity).toBe(700);
    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events.map((e) => e.event_type)).toContain('ORDER_PARTIAL_FILL');
  });

  it('GTC: remainder fills on a later order book update -> FILLED with ORDER_FILL', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest({ time_in_force: 'GTC' }));
    harness.clock.advanceTo(1);
    expect((await adapter.getOrder(submitted.order_id)).order_state).toBe('PARTIALLY_FILLED');

    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 1, bids: [], asks: [{ price: 100, qty: 700 }] });
    harness.clock.advanceTo(2);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('FILLED');
    expect(final.filled_quantity).toBe(1000);
    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events.map((e) => e.event_type)).toContain('ORDER_FILL');
  });

  it('IOC: remainder EXPIRED immediately after the first matching pass', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest({ time_in_force: 'IOC' }));
    harness.clock.advanceTo(1);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('EXPIRED');
    expect(final.filled_quantity).toBe(300);
    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events.map((e) => e.event_type)).toContain('ORDER_EXPIRED');
  });

  it('LIMIT price respected: LIMIT BUY 250 @ 100.00 meets asks 100.00x100, 100.01x200 -> only 100 fills', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      local_received_timestamp: 0,
      bids: [],
      asks: [
        { price: 100.0, qty: 100 },
        { price: 100.01, qty: 200 },
      ],
    });
    const submitted = await adapter.submit(
      baseRequest({ order_type: 'LIMIT', requested_price: 100.0, requested_quantity: 250, requested_notional_usdt: 25_000 }),
    );
    harness.clock.advanceTo(1);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.filled_quantity).toBe(100);
    expect(final.remaining_quantity).toBe(150);
    expect(final.order_state).toBe('PARTIALLY_FILLED');
  });

  it('enable_partial_fill = false: no fill in a pass that cannot fill the full remainder', async () => {
    const { harness, orderBook, adapter } = setup({ enable_partial_fill: false });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.order_state).toBe('ACKNOWLEDGED');
    expect(after.filled_quantity).toBe(0);

    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 1, bids: [], asks: [{ price: 100, qty: 1000 }] });
    harness.clock.advanceTo(2);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('FILLED');
    expect(final.filled_quantity).toBe(1000);
  });
});
