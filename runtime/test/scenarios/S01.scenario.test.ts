/**
 * runtime/test/scenarios/S01.scenario.test.ts
 *
 * Task 4.1 — S01 (tech spec §42): both legs' entry MARKET orders fill
 * completely -> HEDGED, both legs OPEN; `exit()` at `exit_at` closes both
 * legs -> CLOSED/NORMAL_EXIT. Spec "Two-leg entry coordination" Scenario
 * "S01 entry both filled" + "Normal exit" Scenario "S01 exit".
 */
import { describe, expect, it } from 'vitest';
import { assertTraceability } from '../helpers/assertTraceability';
import { buildExecutionScenario, preFlightTrade, setSymmetricBooks } from './executionHarness';

describe('S01: entry both filled -> HEDGED -> exit -> CLOSED/NORMAL_EXIT', () => {
  it('runs the full entry + exit lifecycle', async () => {
    const { harness, orderBook, entryCoordinator, exitCoordinator, positions } = buildExecutionScenario();
    setSymmetricBooks(orderBook, 10, 100);
    const trade = preFlightTrade(harness);

    await entryCoordinator.start(trade);
    harness.clock.advanceTo(50);

    const hedged = harness.tradeRepo.getTrade('trade1')!;
    expect(hedged.status).toBe('HEDGED');
    expect(hedged.legs.every((l) => l.status === 'OPEN')).toBe(true);

    const events = harness.eventStore.replay({ trade_id: 'trade1' });
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['TRADE_STATUS_CHANGED', 'LEG_STATUS_CHANGED', 'HEDGE_RATIO_CHANGED', 'ORDER_FILL']),
    );

    // position-accounting is out of scope for this capability — tell the fake reader
    // the filled quantities so the subsequent reduce-only EXIT orders are accepted.
    positions.setOpenQuantity('legL', 10);
    positions.setOpenQuantity('legS', 10);

    const exitResult = await exitCoordinator.exit('trade1');
    expect(exitResult).toEqual({ allowed: true });
    harness.clock.advanceTo(100);

    const closed = harness.tradeRepo.getTrade('trade1')!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.close_reason).toBe('NORMAL_EXIT');
    expect(closed.legs.every((l) => l.status === 'CLOSED')).toBe(true);

    assertTraceability(harness.db, { trade_id: 'trade1' });
  });
});
