/**
 * runtime/test/scenarios/S06.scenario.test.ts
 *
 * Task 4.1 — S06 (tech spec §42): `cancel_failure_probability = 1.0`, an
 * ACKNOWLEDGED order is canceled -> returns to ACKNOWLEDGED, an
 * ORDER_CANCEL_REJECTED event with `cancel_reject_reason =
 * 'CANCEL_REJECTED_SIMULATED'` exists, `cancel_ack_time` stays unset. Spec
 * "Cancel outcomes" Scenario "S06 cancel failure".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario } from './executionHarness';

describe('S06: cancel failure reverts to the prior state with ORDER_CANCEL_REJECTED', () => {
  it('reverts to ACKNOWLEDGED, cancel_ack_time stays unset', async () => {
    const { harness, orderBook, execution } = buildExecutionScenario(
      {},
      { enable_failure_injection: true, failure_injection: { Binance: { cancel_failure_probability: 1.0 } } },
    );

    for (const legId of ['legL', 'legS'] as const) {
      const legBefore = harness.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === legId)!;
      harness.ledger.applyLegTransition(legBefore, { ...legBefore, status: 'OPENING', updated_at: 0 }, 'scenario setup');
    }

    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [] });
    const submitted = await execution.submit({
      client_order_id: 'c-s06',
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
    harness.clock.advanceTo(10);
    expect((await execution.getOrder(submitted.order_id)).order_state).toBe('ACKNOWLEDGED');

    await execution.cancel(submitted.order_id);
    harness.clock.advanceTo(10 + 20);

    const final = await execution.getOrder(submitted.order_id);
    expect(final.order_state).toBe('ACKNOWLEDGED');
    expect(final.cancel_reject_reason).toBe('CANCEL_REJECTED_SIMULATED');
    expect(final.cancel_ack_time).toBeUndefined();

    const events = harness.eventStore.replay({ trade_id: 'trade1' }).filter((e) => e.order_id === submitted.order_id);
    expect(events.map((e) => e.event_type)).toContain('ORDER_CANCEL_REJECTED');

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
