/**
 * runtime/test/scenarios/S03.scenario.test.ts
 *
 * Task 4.1 — S03 (tech spec §42): long leg fills 10 fully, short leg is
 * REJECTED (zero fill) -> ENTRY_PENDING -> LEG_IMBALANCE -> EMERGENCY_EXIT,
 * one reduce-only EMERGENCY_CLOSE SELL 10 order, then CLOSED. Spec
 * "Emergency close" Scenario "S03 long full, short reject".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade } from './executionHarness';

describe('S03: long full, short REJECTED -> LEG_IMBALANCE -> EMERGENCY_EXIT -> one EMERGENCY_CLOSE -> CLOSED', () => {
  it('submits exactly one reduce-only EMERGENCY_CLOSE SELL 10 order', async () => {
    const { harness, orderBook, entryCoordinator, positions } = buildExecutionScenario(
      { emergency_exit_timeout_ms: 10_000 },
      { enable_failure_injection: true, failure_injection: { Bybit: { reject_probability: 1 } } },
    );
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [] });
    positions.setOpenQuantity('legL', 10);

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(100);

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    expect(events.map((e) => e.event_type)).toContain('EMERGENCY_EXIT_STARTED');
    const closeOrders = events
      .filter((e) => e.event_type === 'ORDER_CREATED')
      .map((e) => (e.payload as { after: { purpose: string; side: string; reduce_only: boolean; requested_quantity: number } }).after)
      .filter((o) => o.purpose === 'EMERGENCY_CLOSE');
    expect(closeOrders).toHaveLength(1);
    expect(closeOrders[0]).toMatchObject({ side: 'SELL', reduce_only: true, requested_quantity: 10 });

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
