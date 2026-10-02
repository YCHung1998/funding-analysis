/**
 * runtime/test/scenarios/S10.scenario.test.ts
 *
 * Task 4.1 — S10 (tech spec §42): the short exchange is in a disconnect
 * window when the entry is submitted and the long leg fills 10 -> the short
 * order is REJECTED with EXCHANGE_DISCONNECTED and the trade reaches CLOSED
 * with close_reason='EMERGENCY_EXIT'. Spec "Execution-layer scenario
 * coverage" Scenario "S10 disconnect during entry".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade } from './executionHarness';

describe('S10: short exchange disconnected during entry -> REJECTED/EXCHANGE_DISCONNECTED -> leg-imbalance path -> CLOSED', () => {
  it('reaches CLOSED with close_reason EMERGENCY_EXIT', async () => {
    const { harness, orderBook, entryCoordinator, positions } = buildExecutionScenario(
      { emergency_exit_timeout_ms: 10_000 },
      { enable_failure_injection: true, failure_injection: { Bybit: { disconnect_windows: [{ start: 0, end: 50 }] } } },
    );
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    positions.setOpenQuantity('legL', 10);

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(100);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const shortRejected = events.find((e) => e.event_type === 'ORDER_REJECTED' && e.leg_id === 'legS');
    expect(shortRejected).toBeDefined();
    expect((shortRejected!.payload as { after: { rejection_reason: string } }).after.rejection_reason).toBe('EXCHANGE_DISCONNECTED');

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
