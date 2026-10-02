/**
 * runtime/src/execution/paperExecution.failureInjection.test.ts
 *
 * Task 2.6 — Simulated latency and reproducible failure injection (spec
 * "Simulated latency and reproducible failure injection"): reject,
 * fill_probability, ack_loss, cancel_failure (task 2.5), disconnect, stale
 * book, liquidity collapse, price spike; same seed -> identical event
 * sequence, different seed -> different sequence.
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

function setup(config: Partial<PaperExecutionAdapterConfig>) {
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
      seed: 42,
      execution_latency: {
        Binance: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        Bybit: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        Pionex: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        Bitget: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        OKX: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
      },
      max_order_lifetime_ms: 600_000,
      ack_timeout_ms: 300_000,
      enable_failure_injection: true,
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

describe('PaperExecutionAdapter failure injection', () => {
  it('reject_probability=1: every order is REJECTED at ack', async () => {
    const { harness, orderBook, adapter } = setup({ failure_injection: { Binance: { reject_probability: 1 } } });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 100 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(10);
    expect((await adapter.getOrder(submitted.order_id)).order_state).toBe('REJECTED');
  });

  it('fill_probability=0: no fill ever occurs on a matching pass', async () => {
    const { harness, orderBook, adapter } = setup({ failure_injection: { Binance: { fill_probability: 0 } } });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 100 }] });
    const submitted = await adapter.submit(baseRequest({ time_in_force: 'GTC' }));
    harness.clock.advanceTo(15);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.order_state).toBe('ACKNOWLEDGED');
    expect(after.filled_quantity).toBe(0);
  });

  it('disconnect_windows: submit during a window -> REJECTED EXCHANGE_DISCONNECTED', async () => {
    const { harness, orderBook, adapter } = setup({ failure_injection: { Binance: { disconnect_windows: [{ start: 0, end: 100 }] } } });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 100 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(10);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.order_state).toBe('REJECTED');
    expect(after.rejection_reason).toBe('EXCHANGE_DISCONNECTED');
  });

  it('liquidity_multiplier: collapsed depth fills less than the unshifted book would', async () => {
    const { harness, orderBook, adapter } = setup({ failure_injection: { Binance: { liquidity_multiplier: 0.1 } } });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 10 }] });
    const submitted = await adapter.submit(baseRequest({ requested_quantity: 10, requested_notional_usdt: 1000 }));
    harness.clock.advanceTo(15);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.filled_quantity).toBe(1); // 10 qty * 0.1 multiplier
    expect(after.order_state).toBe('PARTIALLY_FILLED');
  });

  it('S07 market spike: price_shift_pct=0.5 -> fill at 100.50, actual_slippage_pct=0.5', async () => {
    const { harness, orderBook, adapter } = setup({ failure_injection: { Binance: { price_shift_pct: 0.5 } } });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100.0, qty: 100 }] });
    const submitted = await adapter.submit(baseRequest({ reference_price: 100.0 }));
    harness.clock.advanceTo(15);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.order_state).toBe('FILLED');
    expect(after.average_fill_price).toBeCloseTo(100.5, 9);
    expect(after.actual_slippage_pct).toBeCloseTo(0.5, 9);
  });

  it('stale book: age 3000ms > data_stale_threshold_ms 2000 -> REJECTED STALE_MARKET_DATA', async () => {
    // Force ACK (and so the stale-book check, which runs at ACK time) to
    // land at t=3000, by which point the book (received at t=0) is 3000ms
    // old — past the 2000ms threshold.
    const { harness, orderBook, adapter } = setup({
      data_stale_threshold_ms: 2000,
      failure_injection: { Binance: { ack_latency_ms: 3000 } },
    });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 100 }] });
    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(3000);
    const after = await adapter.getOrder(submitted.order_id);
    expect(after.order_state).toBe('REJECTED');
    expect(after.rejection_reason).toBe('STALE_MARKET_DATA');
  });
});

describe('PaperExecutionAdapter reproducibility', () => {
  function makeFailureHeavyConfig(seed: number): Partial<PaperExecutionAdapterConfig> {
    return {
      seed,
      enable_failure_injection: true,
      failure_injection: {
        Binance: { reject_probability: 0.3, ack_loss_probability: 0.2, fill_probability: 0.6 },
        Bybit: { reject_probability: 0.3, ack_loss_probability: 0.2, fill_probability: 0.6 },
      },
    };
  }

  // Scoped to this capability's own reproducibility guarantee: order/fill
  // events (order_id defined). Excludes harness setup events like
  // CAPITAL_RESERVED/TRADE_CREATED, whose account_snapshot_id/trade creation
  // come from pre-existing Ledger code (crypto.randomUUID()) outside this
  // capability's scope.
  function normalizedEvents(harness: TestLedgerHarness) {
    return harness.eventStore
      .replay()
      .filter((e) => e.order_id !== undefined)
      .map((e) => ({ event_type: e.event_type, timestamp: e.timestamp, order_id: e.order_id, payload: e.payload }));
  }

  async function runScenario(seed: number) {
    const { harness, orderBook, adapter } = setup(makeFailureHeavyConfig(seed));
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 5 }] });
    for (let i = 0; i < 6; i++) {
      await adapter.submit(baseRequest({ client_order_id: `order-${i}`, requested_quantity: 10, requested_notional_usdt: 1000 }));
    }
    harness.clock.advanceTo(100);
    return normalizedEvents(harness);
  }

  it('same seed reproduces an identical event sequence', async () => {
    const runA = await runScenario(42);
    const runB = await runScenario(42);
    expect(runB).toEqual(runA);
  });

  it('different seed differs', async () => {
    const runA = await runScenario(42);
    const runC = await runScenario(43);
    expect(runC).not.toEqual(runA);
  });
});
