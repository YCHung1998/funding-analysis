/**
 * runtime/src/accounting/tradeResultAssembler.test.ts
 *
 * Task 4.1/4.2 — TradeResult assembly: provisional (funding_confirmed =
 * false) at Trade CLOSED, recompute on every settlement update (2.00 ->
 * 1.90 from tasks.md 4.2), finalized_at/funding_confirmed once every leg
 * settlement reaches a terminal status, MISSED manual-review marker, and
 * exactly one TRADE_COMPLETED emission (shouldEmitTradeCompleted).
 */
import { describe, expect, it } from 'vitest';
import type { LegPnlInput } from './pnlEngine';
import { assembleTradeResult, shouldEmitTradeCompleted, type AssembleTradeResultInput } from './tradeResultAssembler';

function baseInput(overrides: Partial<AssembleTradeResultInput> = {}): AssembleTradeResultInput {
  const legs: LegPnlInput[] = [
    { realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'EXPECTED', expected_cashflow_usdt: 2.0 },
  ];
  return {
    trade_id: 'trade1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    target_notional_per_leg_usdt: 1000,
    actual_long_notional_usdt: 1000,
    actual_short_notional_usdt: 1000,
    leverage: 1,
    allocated_capital_usdt: 1000,
    legs,
    funding_settlement_statuses: ['EXPECTED'],
    max_leg_imbalance_usdt: 0,
    max_leg_imbalance_duration_ms: 0,
    created_at: 1000,
    now: 1000,
    ...overrides,
  };
}

describe('assembleTradeResult — provisional vs final', () => {
  it('provisional result at Trade CLOSED has funding_confirmed = false and no finalized_at', () => {
    const result = assembleTradeResult(baseInput());
    expect(result.funding_confirmed).toBe(false);
    expect(result.finalized_at).toBeUndefined();
    expect(result.net_pnl_usdt).toBeCloseTo(2.0, 10);
  });

  it('recomputes on every settlement update: 2.00 (EXPECTED) -> 1.90 (SETTLED)', () => {
    const provisional = assembleTradeResult(baseInput());
    expect(provisional.funding_pnl_usdt).toBeCloseTo(2.0, 10);

    const settledLegs: LegPnlInput[] = [
      { realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 1.9 },
    ];
    const updated = assembleTradeResult(
      baseInput({ legs: settledLegs, funding_settlement_statuses: ['SETTLED'], created_at: provisional.created_at, now: 2000 }),
    );
    expect(updated.funding_pnl_usdt).toBeCloseTo(1.9, 10);
    expect(updated.created_at).toBe(provisional.created_at); // identity preserved across updates
    expect(updated.updated_at).toBe(2000);
    expect(updated.funding_confirmed).toBe(true);
    expect(updated.finalized_at).toBe(2000);
  });

  it('two legs: finalized only once BOTH reach a terminal settlement status', () => {
    const legs: LegPnlInput[] = [
      { realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 1 },
      { realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'ELIGIBLE', expected_cashflow_usdt: 0.5 },
    ];
    const result = assembleTradeResult(baseInput({ legs, funding_settlement_statuses: ['SETTLED', 'ELIGIBLE'] }));
    expect(result.funding_confirmed).toBe(false);
    expect(result.finalized_at).toBeUndefined();
  });

  it('MISSED leg: finalized_at is set (3 terminal statuses include MISSED) but funding_confirmed stays false, result_reason flags manual review', () => {
    const legs: LegPnlInput[] = [
      { realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 1 },
      { realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'MISSED' },
    ];
    const result = assembleTradeResult(baseInput({ legs, funding_settlement_statuses: ['SETTLED', 'MISSED'], now: 5000 }));
    expect(result.finalized_at).toBe(5000);
    expect(result.funding_confirmed).toBe(false);
    expect(result.funding_pnl_usdt).toBeCloseTo(1, 10); // MISSED leg contributes 0, not borrowed from the other leg
    expect(result.result_reason).toContain('FUNDING_MISSED_MANUAL_REVIEW');
  });
});

describe('assembleTradeResult — final_status / result_reason priority', () => {
  it('ABORTED/FAILED/EMERGENCY_EXIT take priority over PROFIT/LOSS/BREAK_EVEN classification', () => {
    const result = assembleTradeResult(baseInput({ terminal_outcome: 'EMERGENCY_EXIT' }));
    expect(result.final_status).toBe('EMERGENCY_EXIT');
    expect(result.result_reason).toBe('EMERGENCY_EXIT');
  });

  it('within break_even_tolerance_usdt (default 0.01) -> BREAK_EVEN', () => {
    const legs: LegPnlInput[] = [{ realized_price_pnl_usdt: 0.005, fees_usdt: 0, slippage_attribution_usdt: 0 }];
    const result = assembleTradeResult(baseInput({ legs, funding_settlement_statuses: [] }));
    expect(result.final_status).toBe('BREAK_EVEN');
  });

  it('net > tolerance -> PROFIT; net < -tolerance -> LOSS', () => {
    const profit = assembleTradeResult(
      baseInput({ legs: [{ realized_price_pnl_usdt: 5, fees_usdt: 0, slippage_attribution_usdt: 0 }], funding_settlement_statuses: [] }),
    );
    expect(profit.final_status).toBe('PROFIT');
    const loss = assembleTradeResult(
      baseInput({ legs: [{ realized_price_pnl_usdt: -5, fees_usdt: 0, slippage_attribution_usdt: 0 }], funding_settlement_statuses: [] }),
    );
    expect(loss.final_status).toBe('LOSS');
  });

  it('close_reason KILL_SWITCH still classifies by net value, but result_reason stays KILL_SWITCH (Open Question 3, resolved)', () => {
    const legs: LegPnlInput[] = [{ realized_price_pnl_usdt: -5, fees_usdt: 0, slippage_attribution_usdt: 0 }];
    const result = assembleTradeResult(baseInput({ legs, funding_settlement_statuses: [], close_reason: 'KILL_SWITCH' }));
    expect(result.final_status).toBe('LOSS'); // classified by net, not forced to EMERGENCY_EXIT
    expect(result.result_reason).toBe('KILL_SWITCH');
  });

  it('zero-fill ABORTED: ROI 0, net 0, BREAK_EVEN overridden by terminal_outcome ABORTED', () => {
    const result = assembleTradeResult(
      baseInput({
        legs: [],
        funding_settlement_statuses: [],
        actual_long_notional_usdt: 0,
        actual_short_notional_usdt: 0,
        terminal_outcome: 'ABORTED',
      }),
    );
    expect(result.net_pnl_usdt).toBe(0);
    expect(result.roi_on_notional_pct).toBe(0);
    expect(result.final_status).toBe('ABORTED');
  });
});

describe('shouldEmitTradeCompleted', () => {
  it('true only the moment finalized_at newly becomes set; false before and after', () => {
    const provisional = assembleTradeResult(baseInput());
    expect(shouldEmitTradeCompleted(undefined, provisional)).toBe(false);

    const finalized = assembleTradeResult(
      baseInput({
        legs: [{ realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 1 }],
        funding_settlement_statuses: ['SETTLED'],
        now: 2000,
      }),
    );
    expect(shouldEmitTradeCompleted(provisional, finalized)).toBe(true);

    // Calling again on an already-finalized result must not re-emit (定案後不再自動修改).
    const reassembledSame = assembleTradeResult(
      baseInput({
        legs: [{ realized_price_pnl_usdt: 0, fees_usdt: 0, slippage_attribution_usdt: 0, funding_settlement_status: 'SETTLED', actual_cashflow_usdt: 1 }],
        funding_settlement_statuses: ['SETTLED'],
        now: 3000,
      }),
    );
    expect(shouldEmitTradeCompleted(finalized, reassembledSame)).toBe(false);
  });
});
