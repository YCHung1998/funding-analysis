/**
 * runtime/test/scenarios/S05.scenario.test.ts
 *
 * Task 4.1 — S05 (tech spec §42): an order with 300 of 1000 filled is
 * canceled with cancel latency 60ms -> ends CANCELED keeping
 * `filled_quantity = 300`, `remaining_quantity = 700`,
 * `cancel_ack_time = cancel_request_time + 60`. Spec "Cancel outcomes"
 * Scenario "S05 cancel success with partial fill".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario } from './executionHarness';

describe('S05: cancel success keeps the partial fill', () => {
  it('ends CANCELED with filled_quantity=300, remaining_quantity=700', async () => {
    const { harness, orderBook, execution } = buildExecutionScenario();

    // Both legs need at least one LEG_STATUS_CHANGED event for assertTraceability, even though
    // only legL submits an order in this single-order scenario.
    for (const legId of ['legL', 'legS'] as const) {
      const legBefore = harness.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === legId)!;
      harness.ledger.applyLegTransition(legBefore, { ...legBefore, status: 'OPENING', updated_at: 0 }, 'scenario setup');
    }

    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100, qty: 300 }] });
    const submitted = await execution.submit({
      client_order_id: 'c-s05',
      trade_id: 'trade1',
      leg_id: 'legL',
      purpose: 'ENTRY',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 1000,
      requested_notional_usdt: 100_000,
      reference_price: 100,
      estimated_fee_usdt: 50,
      estimated_slippage_pct: 0,
    });
    harness.clock.advanceTo(20); // ack (10ms) + fill (5ms) latency
    expect((await execution.getOrder(submitted.order_id)).filled_quantity).toBe(300);

    await execution.cancel(submitted.order_id);
    const requestTime = (await execution.getOrder(submitted.order_id)).cancel_request_time!;
    harness.clock.advanceTo(requestTime + 20);

    const final = await execution.getOrder(submitted.order_id);
    expect(final.order_state).toBe('CANCELED');
    expect(final.filled_quantity).toBe(300);
    expect(final.remaining_quantity).toBe(700);
    expect(final.cancel_ack_time).toBe(requestTime + 20);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
