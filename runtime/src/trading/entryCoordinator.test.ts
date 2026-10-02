/**
 * runtime/src/trading/entryCoordinator.test.ts
 *
 * Task 3.2/3.3 — `EntryCoordinator`: PRE_FLIGHT -> ENTRY_PENDING, classification
 * timing, ABORTED (ENTRY_TIMEOUT / ENTRY_REJECTED) with capital release,
 * PARTIALLY_HEDGED resend + timing, canSubmitEntry rejections,
 * forceLegImbalance, Leg status events, and Emergency Close
 * (cancel -> retry -> reduce-only EMERGENCY_CLOSE -> CLOSED/FAILED).
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
import type { Trade } from '../types';
import { EntryCoordinator, type EntryCoordinatorConfig } from './entryCoordinator';

const harnesses: TestLedgerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function setup(config: Partial<EntryCoordinatorConfig> = {}, adapterConfig: Partial<PaperExecutionAdapterConfig> = {}) {
  const harness = makeTestLedger({ start: 0 });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const positions = new FakePositionReader();
  const guard = new FakeFundingWindowGuard();
  const instruments = new FakeInstrumentSource();

  const execution = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments,
    feeRates: new FakeFeeRateSource(0.0005),
    positions,
    guard,
    config: {
      seed: 7,
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

  const coordinator = new EntryCoordinator({
    clock: harness.clock,
    ledger: harness.ledger,
    execution,
    guard,
    instruments,
    tradeRepo: harness.tradeRepo,
    config: {
      partial_hedge_max_duration_ms: 5000,
      emergency_exit_timeout_ms: 10_000,
      ...config,
    },
  });

  return { harness, orderBook, execution, coordinator, guard, instruments, positions };
}

function preFlightTrade(harness: TestLedgerHarness): Trade {
  const trade = harness.tradeRepo.getTrade('trade1')!;
  const now = harness.clock.now();
  const preFlight: Trade = { ...trade, status: 'PRE_FLIGHT', updated_at: now };
  harness.ledger.applyTradeTransition(trade, preFlight, 'test setup');
  return preFlight;
}

function setBooks(orderBook: FakeOrderBookSource, longQty: number, longPrice = 100, shortQty = longQty, shortPrice = 100) {
  // Both sides of each book: asks/bids to fill the ENTRY orders (BUY long on asks, SELL short on bids)
  // and the opposite side to fill any later reduce-only EXIT/EMERGENCY_CLOSE order for that leg.
  orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: longPrice, qty: longQty }], asks: [{ price: longPrice, qty: longQty }] });
  orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: shortPrice, qty: shortQty }], asks: [{ price: shortPrice, qty: shortQty }] });
}

describe('EntryCoordinator.start', () => {
  it('requires trade.status === PRE_FLIGHT', async () => {
    const { harness, coordinator } = setup();
    const created = harness.tradeRepo.getTrade('trade1')!; // status CREATED
    await expect(coordinator.start(created)).rejects.toThrow(/PRE_FLIGHT/);
  });

  it('S01: both legs fill completely -> HEDGED, both legs OPEN, TRADE_STATUS_CHANGED ENTRY_PENDING -> HEDGED', async () => {
    const { harness, orderBook, coordinator } = setup();
    setBooks(orderBook, 10);
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    const afterStart = harness.tradeRepo.getTrade('trade1')!;
    expect(afterStart.status).toBe('ENTRY_PENDING');
    expect(afterStart.legs.every((l) => l.status === 'OPENING')).toBe(true);

    harness.clock.advanceTo(100);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('HEDGED');
    expect(final.legs.every((l) => l.status === 'OPEN')).toBe(true);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const tradeEvents = events.filter((e) => e.event_type === 'TRADE_STATUS_CHANGED').map((e) => (e.payload as { from: string; to: string }));
    expect(tradeEvents).toContainEqual(expect.objectContaining({ from: 'ENTRY_PENDING', to: 'HEDGED' }));
    const legEvents = events.filter((e) => e.event_type === 'LEG_STATUS_CHANGED');
    expect(legEvents.length).toBeGreaterThan(0);
    const hedgeRatioEvents = events.filter((e) => e.event_type === 'HEDGE_RATIO_CHANGED');
    expect(hedgeRatioEvents.length).toBeGreaterThan(0);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('S04: both legs timeout with zero fill -> ABORTED ENTRY_TIMEOUT, both legs FAILED, CAPITAL_RELEASED', async () => {
    const { harness, orderBook, coordinator } = setup({}, { max_order_lifetime_ms: 50 });
    // Empty books on both sides: nothing to match, both orders time out.
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(200);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('ABORTED');
    expect(final.legs.every((l) => l.status === 'FAILED')).toBe(true);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const tradeEvents = events.filter((e) => e.event_type === 'TRADE_STATUS_CHANGED').map((e) => e.payload as { to: string; reason: string });
    const abortEvent = tradeEvents.find((e) => e.to === 'ABORTED');
    expect(abortEvent?.reason).toBe('ENTRY_TIMEOUT');
    expect(events.map((e) => e.event_type)).toContain('CAPITAL_RELEASED');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('S02: long partial (times out, canceled), short fills fully -> ratio 0.30 -> LEG_IMBALANCE -> EMERGENCY_EXIT -> CLOSED', async () => {
    const { harness, orderBook, coordinator, positions } = setup({}, { max_order_lifetime_ms: 50 });
    // Long (Binance) only has 3 available of 10 requested -> 300/1000 = 0.30 ratio (by quantity, default basis).
    // Bids/asks on both sides so the subsequent EMERGENCY_CLOSE (opposite side, reduce-only) can fill too.
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 3 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    // position-accounting is out of scope here; tell the fake PositionReader the expected filled quantities
    // so the reduce-only EMERGENCY_CLOSE orders are not rejected as REDUCE_ONLY_EXCEEDS_POSITION.
    positions.setOpenQuantity('legL', 3);
    positions.setOpenQuantity('legS', 10);
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(300); // past max_order_lifetime_ms so the long remainder cancels

    const afterImbalance = harness.tradeRepo.getTrade('trade1')!;
    expect(['LEG_IMBALANCE', 'EMERGENCY_EXIT', 'CLOSED']).toContain(afterImbalance.status);

    harness.clock.advanceTo(400);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('S03: long fills fully, short REJECTED (zero) -> LEG_IMBALANCE -> EMERGENCY_EXIT -> one EMERGENCY_CLOSE SELL 10 reduce_only -> CLOSED', async () => {
    const { harness, orderBook, coordinator, positions } = setup({ emergency_exit_timeout_ms: 10_000 }, { enable_failure_injection: true, failure_injection: { Bybit: { reject_probability: 1 } } });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [] });
    // position-accounting is out of scope for this coordinator (spec Non-goal); the fake
    // PositionReader must be told about the long leg's filled quantity so its reduce-only
    // EMERGENCY_CLOSE order isn't rejected as REDUCE_ONLY_EXCEEDS_POSITION.
    positions.setOpenQuantity('legL', 10);
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(100);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    // The trade passes through EMERGENCY_EXIT on its way to CLOSED (resolution can be fast once
    // position quantities are known, so the trade may already be CLOSED well before t=100).
    expect(events.map((e) => e.event_type)).toContain('EMERGENCY_EXIT_STARTED');
    const statuses = events.filter((e) => e.event_type === 'TRADE_STATUS_CHANGED').map((e) => (e.payload as { to: string }).to);
    expect(statuses).toEqual(expect.arrayContaining(['LEG_IMBALANCE', 'EMERGENCY_EXIT', 'CLOSED']));

    const closeOrders = events.filter((e) => e.event_type === 'ORDER_CREATED').map((e) => (e.payload as { after: { purpose: string; side: string; reduce_only: boolean; requested_quantity: number } }).after);
    const emergencyOrders = closeOrders.filter((o) => o.purpose === 'EMERGENCY_CLOSE');
    expect(emergencyOrders).toHaveLength(1);
    expect(emergencyOrders[0]).toMatchObject({ side: 'SELL', reduce_only: true, requested_quantity: 10 });

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('S13: PARTIALLY_HEDGED resubmission repairs to HEDGED before the timer fires', async () => {
    // Short's original order only finds 9.5 of 10 and, per spec, stays
    // PARTIALLY_FILLED (non-terminal, awaiting a book update) until it is
    // force-resolved — here via max_order_lifetime_ms (30ms) — at which
    // point classification runs on its terminal (CANCELED, 9.5 filled) state.
    const { harness, orderBook, coordinator } = setup({ partial_hedge_max_duration_ms: 5000 }, { max_order_lifetime_ms: 30 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 9.5 }], asks: [] });
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(60); // past max_order_lifetime_ms(30) + cancel latency(20)
    const partial = harness.tradeRepo.getTrade('trade1')!;
    expect(partial.status).toBe('PARTIALLY_HEDGED');

    // Now the remaining 0.5 becomes available on Bybit; the resubmitted order should pick it up.
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 60, bids: [{ price: 100, qty: 0.5 }], asks: [] });
    harness.clock.advanceTo(3060); // well before partial_hedge_max_duration_ms (5000) from entering PARTIALLY_HEDGED at t~60

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('HEDGED');

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const statuses = events.filter((e) => e.event_type === 'TRADE_STATUS_CHANGED').map((e) => (e.payload as { to: string }).to);
    expect(statuses).toEqual(expect.arrayContaining(['ENTRY_PENDING', 'PARTIALLY_HEDGED', 'HEDGED']));

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('S13: PARTIALLY_HEDGED resubmission does not fill before partial_hedge_max_duration_ms -> LEG_IMBALANCE (reason PARTIAL_HEDGE_TIMEOUT)', async () => {
    const { harness, orderBook, coordinator, positions } = setup(
      { partial_hedge_max_duration_ms: 5000, emergency_exit_timeout_ms: 20_000 },
      { max_order_lifetime_ms: 30 },
    );
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 9.5 }], asks: [] });
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 9.5);
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(60);
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('PARTIALLY_HEDGED');
    // Clear remaining bid liquidity -> every resubmission stays open, eventually hits its own
    // max_order_lifetime_ms and cancels with 0 new fill, but the coordinator's own partial-hedge
    // timer (5000ms from entering PARTIALLY_HEDGED) should fire LEG_IMBALANCE regardless. Leave enough
    // ask liquidity on Bybit so the eventual EMERGENCY_CLOSE (BUY, reduce-only) for the short leg can fill.
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 60, bids: [], asks: [{ price: 100, qty: 9.5 }] });
    harness.clock.advanceTo(60 + 5000 + 10);

    const legImbalanceEvent1 = harness.eventStore
      .replay({ trade_id: 'trade1' })
      .find((e) => e.event_type === 'TRADE_STATUS_CHANGED' && (e.payload as { to: string }).to === 'LEG_IMBALANCE');
    expect(legImbalanceEvent1).toBeDefined();
    expect((legImbalanceEvent1!.payload as { reason: string }).reason).toBe('PARTIAL_HEDGE_TIMEOUT');

    // Let Emergency Close fully resolve (cancel the still-looping resubmission, flatten both legs).
    harness.clock.advanceTo(60 + 5000 + 10 + 20_000 + 100);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(['CLOSED', 'FAILED']).toContain(final.status);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('canSubmitEntry refusal for the resubmission: no new order, stays PARTIALLY_HEDGED until the timer', async () => {
    const { harness, orderBook, coordinator, guard } = setup(
      { partial_hedge_max_duration_ms: 200, emergency_exit_timeout_ms: 10_000 },
      { max_order_lifetime_ms: 30 },
    );
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 9.5 }], asks: [] });
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    // Refuse any further entry submission BEFORE the original short order times out at t~50
    // (the resubmission attempt happens synchronously the instant that order resolves, so the
    // refusal must already be in effect — not applied only after PARTIALLY_HEDGED is observed).
    guard.setEntryResult({ allowed: false, reason: 'ENTRY_DEADLINE_PASSED' });

    harness.clock.advanceTo(60);
    // Stays PARTIALLY_HEDGED (no new order created for the lagging leg) until the timer fires.
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('PARTIALLY_HEDGED');
    const ordersAfterRefusal = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.event_type === 'ORDER_CREATED');
    expect(ordersAfterRefusal).toHaveLength(2); // only the two original entry orders — no resubmission

    harness.clock.advanceTo(60 + 200 + 10);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(['LEG_IMBALANCE', 'EMERGENCY_EXIT', 'CLOSED']).toContain(final.status);
  });

  it('guard refuses canSubmitEntry for a leg at start() — no order created for that leg', async () => {
    const { harness, orderBook, coordinator, guard } = setup({}, { max_order_lifetime_ms: 500 });
    setBooks(orderBook, 10);
    guard.setEntryResult({ allowed: false, reason: 'ENTRY_DEADLINE_PASSED' });
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const orderCreated = events.filter((e) => e.event_type === 'ORDER_CREATED');
    expect(orderCreated).toHaveLength(0);

    harness.clock.advanceTo(10);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('ABORTED');
  });

  it('forceLegImbalance moves an ENTRY_PENDING trade through LEG_IMBALANCE to Emergency Close', async () => {
    const { harness, orderBook, coordinator } = setup({}, { max_order_lifetime_ms: 500 });
    setBooks(orderBook, 10);
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);
    // Immediately force imbalance before any fill settles (orders still ACKNOWLEDGED/in-flight).
    coordinator.forceLegImbalance('trade1', 'NOT_HEDGED_BEFORE_WINDOW');

    harness.clock.advanceTo(100);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(['CLOSED', 'EMERGENCY_EXIT', 'LEG_IMBALANCE']).toContain(final.status);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const legImbalanceEvent = events.find((e) => e.event_type === 'TRADE_STATUS_CHANGED' && (e.payload as { to: string }).to === 'LEG_IMBALANCE');
    expect((legImbalanceEvent!.payload as { reason: string }).reason).toBe('NOT_HEDGED_BEFORE_WINDOW');
  });

  it('forceLegImbalance on a HEDGED trade skips straight to Emergency Close (HEDGED -> EMERGENCY_EXIT)', async () => {
    const { harness, orderBook, coordinator, positions } = setup({}, { max_order_lifetime_ms: 500 });
    setBooks(orderBook, 10);
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 10);
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);
    harness.clock.advanceTo(100);
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('HEDGED');

    coordinator.forceLegImbalance('trade1', 'NOT_HEDGED_BEFORE_WINDOW');
    harness.clock.advanceTo(200);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    // No illegal LEG_IMBALANCE hop is attempted from HEDGED.
    const legImbalanceEvent = events.find((e) => e.event_type === 'TRADE_STATUS_CHANGED' && (e.payload as { to: string }).to === 'LEG_IMBALANCE');
    expect(legImbalanceEvent).toBeUndefined();
  });

  it('S12 tech spec §45 flow: short order still pending is canceled before the long emergency close order is submitted', async () => {
    const { harness, orderBook, coordinator, positions } = setup({}, { max_order_lifetime_ms: 100_000, ack_timeout_ms: 100_000 });
    positions.setOpenQuantity('legL', 10);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    // No liquidity on Bybit at all -> short stays ACKNOWLEDGED/pending indefinitely until force-canceled.
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(30); // long fills fully; short still ACKNOWLEDGED with 0 fill -> triggers zero-fill? No: short never resolves to terminal on its own (no timeout yet).
    // Long filled zero-fill branch does not apply here (long is non-zero); short is simply never terminal, so
    // classification never fires from the natural order-update path. This scenario is driven by forceLegImbalance
    // instead (e.g. as funding-settlement-rules would on a leg-imbalance risk signal).
    coordinator.forceLegImbalance('trade1', 'LEG_IMBALANCE');

    harness.clock.advanceTo(100); // short's cancel resolves (20ms cancel latency)
    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const cancelEvent = events.find((e) => e.event_type === 'ORDER_CANCELED');
    expect(cancelEvent).toBeDefined();

    const emergencyCloseCreated = events.filter(
      (e) => e.event_type === 'ORDER_CREATED' && (e.payload as { after: { purpose: string } }).after.purpose === 'EMERGENCY_CLOSE',
    );
    // The short's cancel event must precede the long's emergency close order creation (cancel-before-close ordering).
    if (emergencyCloseCreated.length > 0) {
      expect(cancelEvent!.seq).toBeLessThan(emergencyCloseCreated[0].seq);
    }

    harness.clock.advanceTo(200);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });

  it('Emergency exit timeout: empty book means the close order never fills -> trade FAILED (EMERGENCY_EXIT_TIMEOUT), capital NOT released', async () => {
    const { harness, orderBook, coordinator, positions } = setup(
      { emergency_exit_timeout_ms: 500 },
      { enable_failure_injection: true, failure_injection: { Bybit: { reject_probability: 1 } } },
    );
    positions.setOpenQuantity('legL', 10);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [] });
    const trade = preFlightTrade(harness);
    await coordinator.start(trade);

    harness.clock.advanceTo(30); // long fills fully, short REJECTED -> LEG_IMBALANCE -> EMERGENCY_EXIT
    // Now clear Binance's book so the EMERGENCY_CLOSE order can never fill.
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 30, bids: [], asks: [] });

    harness.clock.advanceTo(30 + 500 + 10);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('FAILED');

    const snapshot = harness.accountRepo.getLatestAccountSnapshot('PAPER')!;
    expect(snapshot.reserved_capital_usdt).toBeGreaterThan(0); // not released

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
