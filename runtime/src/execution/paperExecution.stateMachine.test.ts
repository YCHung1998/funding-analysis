/**
 * runtime/src/execution/paperExecution.stateMachine.test.ts
 *
 * Task 2.1 — Order state machine per C-14 (spec "Order state machine per
 * C-14"): every transition via `Ledger.applyOrderTransition`/`createOrder`;
 * timestamps set at the right moments; `REJECTED` keeps its reason.
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

function setup(config: Partial<PaperExecutionAdapterConfig> = {}, start = 1000) {
  const harness = makeTestLedger({ start });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const guard = new FakeFundingWindowGuard();
  const adapter = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments: new FakeInstrumentSource(),
    feeRates: new FakeFeeRateSource(0.0005),
    positions: new FakePositionReader(),
    guard,
    config: {
      seed: 1,
      execution_latency: {
        Binance: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
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

describe('PaperExecutionAdapter order state machine (C-14)', () => {
  it('normal lifecycle timestamps: submit at t=1000, ack latency 45ms, fill latency 10ms, sufficient depth', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      local_received_timestamp: 1000,
      bids: [],
      asks: [{ price: 100.0, qty: 100 }],
    });

    const submitted = await adapter.submit(baseRequest());
    expect(submitted.order_state).toBe('SUBMITTED');
    expect(submitted.submit_time).toBe(1000);

    harness.clock.advanceTo(1045);
    const acked = await adapter.getOrder(submitted.order_id);
    expect(acked.order_state).toBe('ACKNOWLEDGED');
    expect(acked.ack_time).toBe(1045);

    harness.clock.advanceTo(1055);
    const filled = await adapter.getOrder(submitted.order_id);
    expect(filled.order_state).toBe('FILLED');
    expect(filled.first_fill_time).toBe(1055);
    expect(filled.final_fill_time).toBe(1055);
    expect(filled.terminal_time).toBe(1055);

    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(['ORDER_CREATED', 'ORDER_SUBMITTED', 'ORDER_ACK', 'ORDER_FILL']);
  });

  it('rejected order keeps rejection_reason, terminal_time, and emits ORDER_REJECTED', async () => {
    const { harness, orderBook, adapter } = setup({
      enable_failure_injection: true,
      failure_injection: { Binance: { reject_probability: 1 } },
    });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 1000, bids: [], asks: [{ price: 100, qty: 100 }] });

    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1045);
    const rejected = await adapter.getOrder(submitted.order_id);
    expect(rejected.order_state).toBe('REJECTED');
    expect(rejected.rejection_reason).toBeDefined();
    expect(rejected.terminal_time).toBeDefined();

    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events.map((e) => e.event_type)).toContain('ORDER_REJECTED');
  });

  it('every transition is traceable: current order_state matches the last event payload.to', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 1000, bids: [], asks: [{ price: 100, qty: 100 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1100);
    const final = await adapter.getOrder(submitted.order_id);

    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    const last = events[events.length - 1];
    expect((last.payload as { to?: string }).to ?? (last.payload as { after?: { order_state?: string } }).after?.order_state).toBe(
      final.order_state,
    );
  });
});
