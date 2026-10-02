/**
 * runtime/src/execution/paperExecution.matching.test.ts
 *
 * Task 2.2 — `PaperExecutionAdapter` depth-walking integration: tech spec
 * §14 example end to end (Fill rows, average_fill_price, fees), and
 * `INVALID_QUANTITY_STEP` rejection.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeFeeRateSource } from '../../test/fakes/fakeFeeRates';
import { FakeFundingWindowGuard } from '../../test/fakes/fakeGuard';
import { FakeInstrumentSource } from '../../test/fakes/fakeInstruments';
import { FakeOrderBookSource } from '../../test/fakes/fakeOrderBook';
import { FakePositionReader } from '../../test/fakes/fakePositions';
import { makeTestLedger, type TestLedgerHarness } from '../../test/fakes/testLedger';
import type { OrderRequest } from './executionInterface';
import { PaperExecutionAdapter } from './paperExecution';

const harnesses: TestLedgerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function setup(stepSize = 0.001) {
  const harness = makeTestLedger({ start: 0 });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const instruments = new FakeInstrumentSource();
  instruments.setInstrument('Binance', 'BTCUSDT', { step_size: stepSize, contract_multiplier: 1 });
  const adapter = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments,
    feeRates: new FakeFeeRateSource(0.0005),
    positions: new FakePositionReader(),
    guard: new FakeFundingWindowGuard(),
    config: {
      seed: 7,
      execution_latency: {
        Binance: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        Bybit: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        Pionex: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        Bitget: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
        OKX: { ack_ms: 0, fill_ms: 0, cancel_ms: 0 },
      },
      max_order_lifetime_ms: 60_000,
      ack_timeout_ms: 30_000,
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
    requested_quantity: 250,
    requested_notional_usdt: 25000,
    reference_price: 100.0,
    estimated_fee_usdt: 12.5,
    estimated_slippage_pct: 0,
    ...overrides,
  };
}

describe('PaperExecutionAdapter matching (tech spec §14)', () => {
  it('MARKET BUY 250 walks asks 100.00x100, 100.01x200, 100.03x300 -> avg 100.006, two Fills, fee 12.50075', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      local_received_timestamp: 0,
      bids: [],
      asks: [
        { price: 100.0, qty: 100 },
        { price: 100.01, qty: 200 },
        { price: 100.03, qty: 300 },
      ],
    });

    const submitted = await adapter.submit(baseRequest());
    harness.clock.advanceTo(1);
    const final = await adapter.getOrder(submitted.order_id);

    expect(final.order_state).toBe('FILLED');
    expect(final.filled_quantity).toBe(250);
    expect(final.average_fill_price).toBeCloseTo(100.006, 9);
    expect(final.actual_slippage_pct).toBeCloseTo(0.006, 9);
    expect(final.actual_fee_usdt).toBeCloseTo(12.50075, 6);

    const fills = [...harness.orderRepo.listFillsForOrder(submitted.order_id)].sort((a, b) => a.price - b.price);
    expect(fills).toHaveLength(2);
    expect(fills[0].price).toBe(100.0);
    expect(fills[0].quantity).toBe(100);
    expect(fills[1].price).toBe(100.01);
    expect(fills[1].quantity).toBe(150);
  });

  it('MARKET SELL walks bids descending', async () => {
    const { harness, orderBook, adapter } = setup();
    orderBook.setBook({
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      local_received_timestamp: 0,
      bids: [
        { price: 99.99, qty: 100 },
        { price: 99.98, qty: 100 },
      ],
      asks: [],
    });
    const submitted = await adapter.submit(
      baseRequest({ side: 'SELL', position_side: 'SHORT', requested_quantity: 150, requested_notional_usdt: 15000, reference_price: 99.99 }),
    );
    harness.clock.advanceTo(1);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('FILLED');
    expect(final.filled_quantity).toBe(150);
    expect(final.average_fill_price).toBeCloseTo(99.98666666667, 9);
  });

  it('INVALID_QUANTITY_STEP: requested quantity not a multiple of step size is REJECTED at ACK', async () => {
    const { harness, orderBook, adapter } = setup(0.01);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 1000 }] });
    const submitted = await adapter.submit(baseRequest({ requested_quantity: 250.005 }));
    harness.clock.advanceTo(1);
    const final = await adapter.getOrder(submitted.order_id);
    expect(final.order_state).toBe('REJECTED');
    expect(final.rejection_reason).toBe('INVALID_QUANTITY_STEP');
  });
});
