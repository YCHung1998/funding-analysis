/**
 * runtime/test/scenarios/S07.scenario.test.ts
 *
 * Task 4.1 — S07 (tech spec §42): `price_shift_pct = 0.5` injected on the
 * long exchange before matching, reference 100.00, asks at 100.00 -> fill
 * price 100.50, `actual_slippage_pct = 0.5`. Spec "Execution-layer scenario
 * coverage" Scenario "S07 market spike".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario } from './executionHarness';

describe('S07: market spike (price_shift_pct=0.5) — fill at shifted price with recorded slippage', () => {
  it('fills at 100.50 with actual_slippage_pct=0.5', async () => {
    const { harness, orderBook, execution } = buildExecutionScenario(
      {},
      { enable_failure_injection: true, failure_injection: { Binance: { price_shift_pct: 0.5 } } },
    );

    for (const legId of ['legL', 'legS'] as const) {
      const legBefore = harness.tradeRepo.getTrade('trade1')!.legs.find((l) => l.leg_id === legId)!;
      harness.ledger.applyLegTransition(legBefore, { ...legBefore, status: 'OPENING', updated_at: 0 }, 'scenario setup');
    }

    orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [], asks: [{ price: 100.0, qty: 1000 }] });
    const submitted = await execution.submit({
      client_order_id: 'c-s07',
      trade_id: 'trade1',
      leg_id: 'legL',
      purpose: 'ENTRY',
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      order_type: 'MARKET',
      side: 'BUY',
      position_side: 'LONG',
      reduce_only: false,
      requested_quantity: 100,
      requested_notional_usdt: 10_000,
      reference_price: 100.0,
      estimated_fee_usdt: 5,
      estimated_slippage_pct: 0,
    });
    harness.clock.advanceTo(20);

    const final = await execution.getOrder(submitted.order_id);
    expect(final.order_state).toBe('FILLED');
    expect(final.average_fill_price).toBeCloseTo(100.5, 9);
    expect(final.actual_slippage_pct).toBeCloseTo(0.5, 9);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
