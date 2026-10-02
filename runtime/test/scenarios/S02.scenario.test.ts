/**
 * runtime/test/scenarios/S02.scenario.test.ts
 *
 * Task 4.1 — S02 (tech spec §42): long leg fills 300 of 1000, times out and
 * is canceled; short leg fills 1000 fully. Hedge ratio 0.30 -> LEG_IMBALANCE
 * -> Emergency Close -> CLOSED. Spec "Two-leg entry coordination" Scenario
 * "S02 long partial, short full".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade } from './executionHarness';

describe('S02: long partial (times out), short full -> LEG_IMBALANCE -> EMERGENCY_EXIT -> CLOSED', () => {
  it('ends CLOSED with close_reason EMERGENCY_EXIT', async () => {
    const { harness, orderBook, entryCoordinator, positions } = buildExecutionScenario({}, { max_order_lifetime_ms: 50 });
    // Long (Binance) only has 3 of 10 requested available -> 300/1000 = 0.30 ratio (by quantity, default basis).
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 3 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    // position-accounting is out of scope here; the fake reader needs the expected filled quantities
    // so the reduce-only EMERGENCY_CLOSE orders are not rejected.
    positions.setOpenQuantity('legL', 3);
    positions.setOpenQuantity('legS', 10);

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(400);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const statuses = events.filter((e) => e.event_type === 'TRADE_STATUS_CHANGED').map((e) => (e.payload as { to: string }).to);
    expect(statuses).toEqual(expect.arrayContaining(['ENTRY_PENDING', 'LEG_IMBALANCE', 'EMERGENCY_EXIT', 'CLOSED']));

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
