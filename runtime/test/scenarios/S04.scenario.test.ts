/**
 * runtime/test/scenarios/S04.scenario.test.ts
 *
 * Task 4.1 — S04 (tech spec §42): neither leg receives any fill before
 * `max_order_lifetime_ms`, both cancels succeed -> ABORTED with reason
 * ENTRY_TIMEOUT, both legs FAILED, CAPITAL_RELEASED, trade/orders/events
 * remain stored (never deleted). Spec "Two-leg entry coordination"
 * Scenario "S04 both timeout".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade } from './executionHarness';

describe('S04: both legs timeout with zero fill -> ABORTED/ENTRY_TIMEOUT', () => {
  it('releases capital and keeps the trade/orders/events stored', async () => {
    const { harness, orderBook, entryCoordinator } = buildExecutionScenario({}, { max_order_lifetime_ms: 50 });
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(200);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('ABORTED');
    expect(final.legs.every((l) => l.status === 'FAILED')).toBe(true);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const abortEvent = events.find((e) => e.event_type === 'TRADE_STATUS_CHANGED' && (e.payload as { to: string }).to === 'ABORTED');
    expect((abortEvent!.payload as { reason: string }).reason).toBe('ENTRY_TIMEOUT');
    expect(events.map((e) => e.event_type)).toContain('CAPITAL_RELEASED');

    // Nothing is deleted: the trade row and every order/event for it are still readable.
    expect(harness.tradeRepo.getTrade('trade1')).toBeDefined();
    const orderEvents = events.filter((e) => e.event_type === 'ORDER_CREATED');
    expect(orderEvents.length).toBe(2); // one entry order per leg, never removed

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
