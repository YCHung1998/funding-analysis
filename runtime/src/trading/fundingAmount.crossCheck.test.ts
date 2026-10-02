/**
 * runtime/src/trading/fundingAmount.crossCheck.test.ts
 *
 * Task 3.2 — integration with `funding-settlement-rules`' state machine
 * (`runtime/src/funding/settlementInference.ts`, already merged via
 * `paper-trading-event-loop`).
 *
 * Deviation from design.md's literal wording, documented here: Decision 1's
 * fallback text says "若狀態機已自帶現金流計算，改為呼叫 fundingAmount 並
 * 保留其既有測試". Doing that literally is structurally impossible:
 * `accounting/fundingMath.ts` (this change's `fundingAmount` depends on it)
 * already imports `computeSettlementCashflow` FROM
 * `funding/settlementInference.ts` (Q-07's actual single source of truth).
 * Making `settlementInference.ts` import back from `trading/fundingAmount.ts`
 * would be a circular import:
 *   funding/settlementInference.ts -> trading/fundingAmount.ts
 *     -> accounting/fundingMath.ts -> funding/settlementInference.ts
 *
 * Since `fundingMath.fundingCashflow` and this change's `fundingAmount` are
 * both thin wrappers around the exact same `computeSettlementCashflow`
 * primitive, there is no formula drift to fix (Q-07 is already satisfied
 * transitively) — rewiring would only add a cycle for no behavioral change.
 * This test instead characterizes the equivalence directly: for any SETTLED
 * transition, `resolveSettlement`'s cashflow and `fundingAmount('SETTLED', ...)`'s
 * `actual_cashflow_usdt` must always agree, keeping the existing "Settled
 * after exit +1.0 USDT" test (settlementInference.test.ts) intact as the
 * state-machine-side authority while this file holds the amount-side one.
 */
import { describe, expect, it } from 'vitest';
import { resolveSettlement } from '../funding/settlementInference';
import { VirtualClock } from '../clock/virtualClock';
import { NodeSqliteDriver } from '../storage/driver';
import { EventStore } from '../storage/eventStore';
import { migrate } from '../storage/migrate';
import { migration001 } from '../storage/migrations/001_initial';
import { tmpDriver } from '../storage/test-helpers';
import { fundingAmount } from './fundingAmount';

describe('fundingAmount <-> funding-settlement-rules equivalence (Q-07, no formula drift)', () => {
  it('SETTLED via resolveSettlement matches fundingAmount("SETTLED", ...) for the same inputs (+1.0 USDT case)', () => {
    const side = 'SHORT' as const;
    const quantity = 100;
    const rate = 0.0001;
    const markPrice = 100;

    const stateMachineResult = resolveSettlement({
      T: 1000,
      now: 1000,
      side,
      quantity,
      heldContinuously: true,
      settledRecord: { rate, markPrice, publishedAt: 1005 },
      settlementConfirmTimeoutMs: 600_000,
    });
    expect(stateMachineResult.status).toBe('SETTLED');
    expect(stateMachineResult.cashflowUsdt).toBeCloseTo(1.0, 10);

    const amountHookResult = fundingAmount('SETTLED', { side, quantity, mark_price: markPrice, funding_rate: rate });
    expect(amountHookResult.actual_cashflow_usdt).toBeCloseTo(stateMachineResult.cashflowUsdt, 10);
  });

  it('agrees across a range of side/quantity/rate/mark combinations (no divergence)', () => {
    const cases = [
      { side: 'LONG' as const, quantity: 10, rate: 0.0005, mark: 2000 },
      { side: 'SHORT' as const, quantity: 0.5, rate: -0.0002, mark: 60000 },
      { side: 'LONG' as const, quantity: 1000, rate: 0.00015, mark: 1.5 },
    ];
    for (const c of cases) {
      const stateMachineResult = resolveSettlement({
        T: 0,
        now: 0,
        side: c.side,
        quantity: c.quantity,
        heldContinuously: true,
        settledRecord: { rate: c.rate, markPrice: c.mark, publishedAt: 0 },
        settlementConfirmTimeoutMs: 600_000,
      });
      const amountHookResult = fundingAmount('SETTLED', { side: c.side, quantity: c.quantity, mark_price: c.mark, funding_rate: c.rate });
      expect(amountHookResult.actual_cashflow_usdt).toBeCloseTo(stateMachineResult.cashflowUsdt, 10);
    }
  });

  it('amount fields merge into the same FUNDING_SETTLED event payload as the transition — no second event (design.md Decision 6/8)', () => {
    const db: NodeSqliteDriver = tmpDriver();
    migrate(db, [migration001]);
    const clock = new VirtualClock(5000);
    const eventStore = new EventStore(db, clock);

    const amounts = fundingAmount('SETTLED', { side: 'SHORT', quantity: 100, mark_price: 100, funding_rate: 0.0001 });
    const event = eventStore.append({
      event_id: 'evt1',
      event_type: 'FUNDING_SETTLED',
      timestamp: clock.now(),
      trade_id: 'trade1',
      leg_id: 'leg1',
      payload: { from: 'ELIGIBLE', to: 'SETTLED', reason: 'SETTLED_RATE_PUBLISHED', ...amounts },
    });

    expect(event.event_type).toBe('FUNDING_SETTLED');
    expect(event.payload.actual_cashflow_usdt).toBeCloseTo(1.0, 10);
    expect(event.payload.settled_funding_rate).toBe(0.0001);
    const all = eventStore.replay({ trade_id: 'trade1' });
    expect(all).toHaveLength(1); // exactly one event, not a separate amount event
    db.close();
  });
});
