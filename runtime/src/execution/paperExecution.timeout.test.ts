/**
 * runtime/src/execution/paperExecution.timeout.test.ts
 *
 * Task 2.4 — `max_order_lifetime_ms` (tech spec §12 timeline) and
 * `ack_timeout_ms` (late ACK, lost order).
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

function setup(config: Partial<PaperExecutionAdapterConfig>, start = 0, latencyOverrides: { ack_ms?: number; cancel_ms?: number } = {}) {
  const harness = makeTestLedger({ start });
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
      seed: 11,
      execution_latency: {
        Binance: { ack_ms: latencyOverrides.ack_ms ?? 45, fill_ms: 10, cancel_ms: latencyOverrides.cancel_ms ?? 68 },
        Bybit: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Pionex: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Bitget: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        OKX: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
      },
      max_order_lifetime_ms: 60_000,
      ack_timeout_ms: 30_000,
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
    requested_quantity: 10,
    requested_notional_usdt: 1000,
    reference_price: 100,
    estimated_fee_usdt: 0.5,
    estimated_slippage_pct: 0,
    ...overrides,
  };
}

describe('PaperExecutionAdapter order lifetime timeout (tech spec §12)', () => {
  it('no-fill timeline: max_order_lifetime_ms=800, ack 45ms, never fills, cancel latency 68ms -> CANCELED at +868', async () => {
    const { harness, orderBook, adapter } = setup({ max_order_lifetime_ms: 800 }, 1000, { ack_ms: 45, cancel_ms: 68 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 1000, bids: [], asks: [] }); // no depth, never fills
    const submitted = await adapter.submit(baseRequest());
    expect(submitted.submit_time).toBe(1000);

    harness.clock.advanceTo(1045);
    expect((await adapter.getOrder(submitted.order_id)).order_state).toBe('ACKNOWLEDGED');

    harness.clock.advanceTo(1800); // submit_time + max_order_lifetime_ms
    const afterTimeout = await adapter.getOrder(submitted.order_id);
    expect(afterTimeout.order_state).toBe('CANCEL_REQUESTED');
    expect(afterTimeout.cancel_request_time).toBe(1800);

    const timeoutEvents = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(timeoutEvents.map((e) => e.event_type)).toContain('ORDER_TIMEOUT');

    harness.clock.advanceTo(1868); // + cancel latency 68ms
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('CANCELED');
    expect(final.cancel_ack_time).toBe(1868);
    expect(final.filled_quantity).toBe(0);
  });
});

describe('PaperExecutionAdapter ACK timeout', () => {
  it('late ACK: ack_timeout_ms=300, injected ack latency 350ms -> ORDER_ACK_TIMEOUT at t=300, ACKNOWLEDGED at t=350', async () => {
    const { harness, orderBook, adapter } = setup({
      ack_timeout_ms: 300,
      enable_failure_injection: true,
      failure_injection: { Binance: { ack_latency_ms: 350 } },
    });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const submitted = await adapter.submit(baseRequest());

    harness.clock.advanceTo(300);
    const atTimeout = await adapter.getOrder(submitted.order_id);
    expect(atTimeout.order_state).toBe('SUBMITTED');
    const events300 = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events300.map((e) => e.event_type)).toContain('ORDER_ACK_TIMEOUT');

    harness.clock.advanceTo(350);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('ACKNOWLEDGED');
    expect(final.ack_time).toBe(350);
  });

  it('lost order: ack_loss_probability=1, ack_timeout_ms=300 -> REJECTED with ORDER_NOT_FOUND_AFTER_ACK_TIMEOUT at t=300', async () => {
    const { harness, orderBook, adapter } = setup({
      ack_timeout_ms: 300,
      enable_failure_injection: true,
      failure_injection: { Binance: { ack_loss_probability: 1 } },
    });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const submitted = await adapter.submit(baseRequest());

    harness.clock.advanceTo(300);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('REJECTED');
    expect(final.rejection_reason).toBe('ORDER_NOT_FOUND_AFTER_ACK_TIMEOUT');
    expect(final.terminal_time).toBe(300);
  });
});
