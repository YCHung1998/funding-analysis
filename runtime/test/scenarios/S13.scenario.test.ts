/**
 * runtime/test/scenarios/S13.scenario.test.ts
 *
 * Task 4.1 — S13 (tech spec §42): long fills 1 000 U, short fills 950 U —
 * the short remainder of 50 U is resubmitted. Spec "Two-leg entry
 * coordination" Scenarios "S13 partial hedge repaired" (fills 3 000ms
 * later -> ENTRY_PENDING -> PARTIALLY_HEDGED -> HEDGED) and "S13 partial
 * hedge timeout" (does not fill within `partial_hedge_max_duration_ms =
 * 5000` -> LEG_IMBALANCE with reason PARTIAL_HEDGE_TIMEOUT).
 *
 * The short's original order reaching PARTIALLY_FILLED (950/1000) stays
 * non-terminal while GTC-waiting for more depth; per spec
 * ("Classification SHALL occur when every leg's entry orders are
 * terminal"), classification only runs once that order becomes terminal —
 * here via `max_order_lifetime_ms`, matching the "times out with partial
 * fill then resubmits the remainder" reading of this scenario (design.md
 * Implementation Notes point 4 area; also documented inline in
 * entryCoordinator.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade } from './executionHarness';

describe('S13: PARTIALLY_HEDGED repaired by resubmission', () => {
  it('ENTRY_PENDING -> PARTIALLY_HEDGED -> HEDGED once the resubmitted 50U fills', async () => {
    const { harness, orderBook, entryCoordinator } = buildExecutionScenario(
      { partial_hedge_max_duration_ms: 5000 },
      { max_order_lifetime_ms: 30 },
    );
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 9.5 }], asks: [] });

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(60); // short's original order times out (30ms) + cancels (20ms), 9.5/10 filled

    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('PARTIALLY_HEDGED');

    // The resubmitted order for the remaining 0.5 finds depth on the still-unconsumed book snapshot
    // (paper matching does not deduct its own prior fills, design.md Risks) and fills by t~68.
    harness.clock.advanceTo(3060); // well before the 5000ms partial_hedge_max_duration_ms

    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('HEDGED');

    const statuses = harness.eventStore
      .replay({ trade_id: 'trade1' })
      .filter((e) => e.event_type === 'TRADE_STATUS_CHANGED')
      .map((e) => (e.payload as { to: string }).to);
    expect(statuses).toEqual(expect.arrayContaining(['ENTRY_PENDING', 'PARTIALLY_HEDGED', 'HEDGED']));

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});

describe('S13: PARTIALLY_HEDGED timeout', () => {
  it('LEG_IMBALANCE with reason PARTIAL_HEDGE_TIMEOUT when the resubmission never fills within 5000ms', async () => {
    const { harness, orderBook, entryCoordinator, positions } = buildExecutionScenario(
      { partial_hedge_max_duration_ms: 5000, emergency_exit_timeout_ms: 20_000 },
      { max_order_lifetime_ms: 30 },
    );
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 9.5 }], asks: [] });
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 9.5);

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(60);
    expect(harness.tradeRepo.getTrade('trade1')!.status).toBe('PARTIALLY_HEDGED');

    // Clear remaining bid liquidity -> every resubmission times out with 0 new fill; leave enough ask
    // liquidity for the eventual EMERGENCY_CLOSE (BUY, reduce-only) on the short leg to fill.
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 60, bids: [], asks: [{ price: 100, qty: 9.5 }] });
    harness.clock.advanceTo(60 + 5000 + 10);

    const legImbalanceEvent = harness.eventStore
      .replay({ trade_id: 'trade1' })
      .find((e) => e.event_type === 'TRADE_STATUS_CHANGED' && (e.payload as { to: string }).to === 'LEG_IMBALANCE');
    expect(legImbalanceEvent).toBeDefined();
    expect((legImbalanceEvent!.payload as { reason: string }).reason).toBe('PARTIAL_HEDGE_TIMEOUT');

    // Let Emergency Close fully resolve before checking traceability.
    harness.clock.advanceTo(60 + 5000 + 10 + 20_000 + 100);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(['CLOSED', 'FAILED']).toContain(final.status);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
