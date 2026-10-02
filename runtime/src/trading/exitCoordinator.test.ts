/**
 * runtime/src/trading/exitCoordinator.test.ts
 *
 * Task 3.3 (second half) — `ExitCoordinator.exit()`: `canSubmitExit`
 * rejects `LOCK_WINDOW` (no order, trade unchanged), `NORMAL_EXIT` close,
 * `EXIT_TIMEOUT` when a leg never flattens.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeFeeRateSource } from '../../test/fakes/fakeFeeRates';
import { FakeFundingWindowGuard } from '../../test/fakes/fakeGuard';
import { FakeInstrumentSource } from '../../test/fakes/fakeInstruments';
import { FakeOrderBookSource } from '../../test/fakes/fakeOrderBook';
import { FakePositionReader } from '../../test/fakes/fakePositions';
import { makeTestLedger, type TestLedgerHarness } from '../../test/fakes/testLedger';
import { assertTraceability } from '../../test/helpers/assertTraceability';
import { PaperExecutionAdapter, type PaperExecutionAdapterConfig } from '../execution/paperExecution';
import type { Trade, TradeLeg } from '../types';
import { ExitCoordinator, type ExitCoordinatorConfig } from './exitCoordinator';

const harnesses: TestLedgerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function setup(config: Partial<ExitCoordinatorConfig> = {}, adapterConfig: Partial<PaperExecutionAdapterConfig> = {}) {
  const harness = makeTestLedger({ start: 0 });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const positions = new FakePositionReader();
  const guard = new FakeFundingWindowGuard();

  const execution = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments: new FakeInstrumentSource(),
    feeRates: new FakeFeeRateSource(0.0005),
    positions,
    guard,
    config: {
      seed: 11,
      execution_latency: {
        Binance: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        Bybit: { ack_ms: 12, fill_ms: 6, cancel_ms: 20 },
        Pionex: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        Bitget: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
        OKX: { ack_ms: 10, fill_ms: 5, cancel_ms: 20 },
      },
      max_order_lifetime_ms: 500,
      ack_timeout_ms: 500_000,
      ...adapterConfig,
    },
  });

  const coordinator = new ExitCoordinator({
    clock: harness.clock,
    ledger: harness.ledger,
    execution,
    guard,
    tradeRepo: harness.tradeRepo,
    config: { emergency_exit_timeout_ms: 10_000, ...config },
  });

  return { harness, orderBook, execution, coordinator, guard, positions };
}

/** Builds a HEDGED trade with both legs OPEN and actual_quantity set, as EntryCoordinator would leave it. */
function hedgedTrade(harness: TestLedgerHarness, qty = 10): Trade {
  const trade = harness.tradeRepo.getTrade('trade1')!;
  const now = harness.clock.now();
  const legL: TradeLeg = { ...trade.legs.find((l) => l.leg_id === 'legL')!, status: 'OPEN', actual_quantity: qty, actual_notional_usdt: qty * 100, average_entry_price: 100, updated_at: now };
  const legS: TradeLeg = { ...trade.legs.find((l) => l.leg_id === 'legS')!, status: 'OPEN', actual_quantity: qty, actual_notional_usdt: qty * 100, average_entry_price: 100, updated_at: now };
  harness.tradeRepo.saveTradeLeg(legL);
  harness.tradeRepo.saveTradeLeg(legS);
  const hedged: Trade = { ...trade, status: 'PRE_FLIGHT', legs: [legL, legS], updated_at: now };
  harness.ledger.applyTradeTransition(trade, hedged, 'test setup: pre_flight');
  const entryPending: Trade = { ...hedged, status: 'ENTRY_PENDING', updated_at: now };
  harness.ledger.applyTradeTransition(hedged, entryPending, 'test setup: entry_pending');
  const final: Trade = { ...entryPending, status: 'HEDGED', updated_at: now };
  harness.ledger.applyTradeTransition(entryPending, final, 'test setup: hedged');
  return final;
}

describe('ExitCoordinator.exit', () => {
  it('LOCK_WINDOW refusal: no order created, trade stays HEDGED, reason returned', async () => {
    const { harness, coordinator, guard } = setup();
    hedgedTrade(harness);
    guard.setExitResult({ allowed: false, reason: 'LOCK_WINDOW' });

    const result = await coordinator.exit('trade1');
    expect(result).toEqual({ allowed: false, reason: 'LOCK_WINDOW' });

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('HEDGED');
    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    expect(events.filter((e) => e.event_type === 'ORDER_CREATED')).toHaveLength(0);
    expect(events.filter((e) => e.event_type === 'EXIT_STARTED')).toHaveLength(0);
  });

  it('S01 exit: both EXIT orders fill -> CLOSED with close_reason NORMAL_EXIT, assertTraceability passes', async () => {
    const { harness, orderBook, coordinator, positions } = setup();
    hedgedTrade(harness, 10);
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 10);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });

    const result = await coordinator.exit('trade1');
    expect(result).toEqual({ allowed: true });

    harness.clock.advanceTo(50);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('NORMAL_EXIT');
    expect(final.legs.every((l) => l.status === 'CLOSED')).toBe(true);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    expect(events.map((e) => e.event_type)).toContain('EXIT_STARTED');
    expect(events.map((e) => e.event_type)).toContain('CAPITAL_RELEASED');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('exit() throws for a non-HEDGED trade', async () => {
    const { harness, coordinator } = setup();
    const trade = harness.tradeRepo.getTrade('trade1')!; // status CREATED
    void trade;
    await expect(coordinator.exit('trade1')).rejects.toThrow(/HEDGED/);
  });

  it('EXIT_TIMEOUT: a leg never flattens -> trade FAILED, capital NOT released', async () => {
    const { harness, orderBook, coordinator, positions } = setup({ emergency_exit_timeout_ms: 100 });
    hedgedTrade(harness, 10);
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 10);
    // Binance has liquidity (legL closes fine); Bybit has none at all -> legS never flattens.
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });

    await coordinator.exit('trade1');
    harness.clock.advanceTo(200);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('FAILED');

    const snapshot = harness.accountRepo.getLatestAccountSnapshot('PAPER')!;
    expect(snapshot.reserved_capital_usdt).toBeGreaterThan(0);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const failedEvent = events.find((e) => e.event_type === 'TRADE_STATUS_CHANGED' && (e.payload as { to: string }).to === 'FAILED');
    expect((failedEvent!.payload as { reason: string }).reason).toBe('EXIT_TIMEOUT');
  });

  it('timed-out EXIT order resubmits for the remaining quantity', async () => {
    const { harness, orderBook, coordinator, positions } = setup({}, { max_order_lifetime_ms: 20 });
    hedgedTrade(harness, 10);
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 10);
    // legL only has 4 of 10 available at first; the remainder must be resubmitted after the order times out.
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 4 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });

    await coordinator.exit('trade1');
    harness.clock.advanceTo(50); // legL's first order partially fills 4, times out, cancels with 4 filled/6 remaining
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 50, bids: [{ price: 100, qty: 6 }], asks: [{ price: 100, qty: 10 }] });
    harness.clock.advanceTo(150);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('NORMAL_EXIT');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
