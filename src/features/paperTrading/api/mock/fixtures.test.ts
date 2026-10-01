import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ACCOUNT,
  FIXTURE_COMPLETED_TRADES,
  FIXTURE_CURRENT_TRADES,
  FIXTURE_GLOBAL_EVENTS,
  FIXTURE_HEALTH,
  FIXTURE_TRADE_DETAILS,
  FIXTURE_TRADE_EVENTS,
} from './fixtures';

describe('paper trading mock fixtures', () => {
  it('provides an AccountSnapshot', () => {
    expect(FIXTURE_ACCOUNT.total_capital_usdt).toBeGreaterThan(0);
    expect(FIXTURE_ACCOUNT.available_capital_usdt).toBeLessThanOrEqual(FIXTURE_ACCOUNT.total_capital_usdt);
  });

  it('provides a RuntimeHealth with a non-empty exchange list', () => {
    expect(FIXTURE_HEALTH.exchanges.length).toBeGreaterThan(0);
  });

  it('has at least one current (non-terminal) trade', () => {
    expect(FIXTURE_CURRENT_TRADES.length).toBeGreaterThan(0);
    for (const t of FIXTURE_CURRENT_TRADES) {
      expect(['CREATED', 'PRE_FLIGHT', 'ENTRY_PENDING', 'PARTIALLY_HEDGED', 'LEG_IMBALANCE', 'HEDGED', 'EXIT_PENDING', 'EMERGENCY_EXIT']).toContain(
        t.status,
      );
    }
  });

  it('covers the 7 required completed-trade scenarios (spec.md mock requirement)', () => {
    const byReason = FIXTURE_COMPLETED_TRADES.map((t) => t.result.result_reason);
    const byStatus = FIXTURE_COMPLETED_TRADES.map((t) => t.result.final_status);

    // normal profit
    expect(byStatus).toContain('PROFIT');
    // 0-fill timeout ABORTED
    expect(byReason).toContain('ENTRY_TIMEOUT');
    // order rejected
    expect(byReason).toContain('ORDER_REJECTED');
    // LEG_IMBALANCE -> EMERGENCY_EXIT
    expect(byStatus).toContain('EMERGENCY_EXIT');
    // closed pending funding (not yet confirmed)
    expect(FIXTURE_COMPLETED_TRADES.some((t) => t.result.funding_confirmed === false)).toBe(true);
    // MISSED settlement somewhere in trade details
    const hasMissed = Object.values(FIXTURE_TRADE_DETAILS).some((d) =>
      d.funding_settlements.some((f) => f.settlement_status === 'MISSED'),
    );
    expect(hasMissed).toBe(true);
  });

  it('has a cancel-rejected scenario represented via events (order cancel rejected)', () => {
    const hasCancelRejected = Object.values(FIXTURE_TRADE_EVENTS).some((events) =>
      events.some((e) => e.event_type === 'ORDER_CANCEL_REJECTED'),
    );
    expect(hasCancelRejected).toBe(true);
  });

  it('every completed trade has a matching trade detail entry', () => {
    for (const t of FIXTURE_COMPLETED_TRADES) {
      expect(FIXTURE_TRADE_DETAILS[t.trade_id]).toBeDefined();
    }
  });

  it('global events are sorted by timestamp ascending', () => {
    const timestamps = FIXTURE_GLOBAL_EVENTS.map((e) => e.timestamp);
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });

  it('no credentials appear anywhere in event payloads (Invariant #2)', () => {
    const serialized = JSON.stringify(FIXTURE_GLOBAL_EVENTS).toLowerCase();
    expect(serialized).not.toMatch(/api[_-]?key|secret/);
  });
});
