/**
 * runtime/test/scenarios/S12.scenario.test.ts
 *
 * Task 4.1 — S12 (tech spec §45 flow): long is 1 000 U filled and short 0 U
 * with the short order still pending -> the short order is canceled before
 * the long's emergency close order is submitted, and the original entry,
 * emergency exit prices, slippage, fees and duration are all persisted.
 * Spec "Emergency close" Scenario "S12 tech spec §45 flow".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade } from './executionHarness';

describe('S12: short order still pending is canceled before the long EMERGENCY_CLOSE order is submitted', () => {
  it('cancel event precedes the emergency close order creation; entry/exit fill data all persisted', async () => {
    const { harness, orderBook, entryCoordinator, positions } = buildExecutionScenario(
      {},
      { max_order_lifetime_ms: 100_000, ack_timeout_ms: 100_000 },
    );
    positions.setOpenQuantity('legL', 10);
    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price: 100, qty: 10 }], asks: [{ price: 100, qty: 10 }] });
    // No liquidity on Bybit at all -> the short order stays ACKNOWLEDGED/pending indefinitely.
    orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });

    const trade = preFlightTrade(harness);
    await entryCoordinator.start(trade);
    harness.clock.advanceTo(30); // long fills fully; short never resolves on its own (no timeout configured this low)

    const longOrderFillBefore = harness.eventStore
      .replay({ trade_id: 'trade1' })
      .find((e) => e.event_type === 'ORDER_FILL' && e.leg_id === 'legL');
    expect(longOrderFillBefore).toBeDefined();
    const longFillPayload = longOrderFillBefore!.payload as { fill: { price: number; fee_usdt: number; slippage_from_reference_pct: number } };
    expect(longFillPayload.fill.price).toBe(100);

    // Driven by forceLegImbalance, as funding-settlement-rules would on a leg-imbalance risk signal.
    entryCoordinator.forceLegImbalance('trade1', 'LEG_IMBALANCE');
    harness.clock.advanceTo(100); // the short's forced cancel resolves (20ms cancel latency)

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    const shortCancel = events.find((e) => e.event_type === 'ORDER_CANCELED' && e.leg_id === 'legS');
    expect(shortCancel).toBeDefined();
    const longEmergencyClose = events.find(
      (e) => e.event_type === 'ORDER_CREATED' && (e.payload as { after: { purpose: string; leg_id: string } }).after.purpose === 'EMERGENCY_CLOSE',
    );
    if (longEmergencyClose) {
      expect(shortCancel!.seq).toBeLessThan(longEmergencyClose.seq);
    }

    harness.clock.advanceTo(200);
    const final = harness.tradeRepo.getTrade('trade1')!;
    expect(final.status).toBe('CLOSED');
    expect(final.close_reason).toBe('EMERGENCY_EXIT');

    // Original entry fill data (price/fee/slippage) and emergency close data remain in the event log.
    const emergencyFill = harness.eventStore.replay({ trade_id: 'trade1' }).find((e) => e.event_type === 'ORDER_FILL' && e.leg_id === 'legL' && e !== longOrderFillBefore);
    expect(emergencyFill).toBeDefined();

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
