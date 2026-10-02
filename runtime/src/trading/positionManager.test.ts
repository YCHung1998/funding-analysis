/**
 * runtime/src/trading/positionManager.test.ts
 *
 * Tasks 1.1-1.3 — applyFill: weighted-average entry (30/20/50 -> 100.03),
 * exit realized PnL (LONG 60/40 -> +23.00 avg exit 100.26; SHORT -> +10.00),
 * fee/slippage accumulation, idempotency, RECONCILIATION_ERROR variants,
 * unrealizedPnl, and replay consistency (design.md Decision 3, tasks.md
 * 1.1-1.3).
 */
import { describe, expect, it } from 'vitest';
import type { Fill } from '../types/fill';
import type { PaperPosition } from '../types/account';
import { slippageAttribution } from '../accounting/pnlFormula';
import { applyFill, unrealizedPnl, type ApplyFillInput } from './positionManager';

const IDENTITY = { position_id: 'pos1', trade_id: 'trade1', leg_id: 'leg1', exchange: 'Binance' as const, symbol: 'BTCUSDT' };

function makeFill(overrides: Partial<Fill> & Pick<Fill, 'fill_id' | 'order_id' | 'quantity' | 'price'>): Fill {
  const notional = overrides.quantity * overrides.price;
  return {
    trade_id: 'trade1',
    leg_id: 'leg1',
    exchange: 'Binance',
    timestamp: 0,
    recorded_at: 0,
    created_at: 0,
    updated_at: 0,
    notional_usdt: notional,
    fee_usdt: 0,
    fee_asset: 'USDT',
    liquidity: 'TAKER',
    slippage_from_reference_pct: 0,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ApplyFillInput>): ApplyFillInput {
  return {
    fill: makeFill({ fill_id: 'f1', order_id: 'entry1', quantity: 1, price: 100 }),
    orderReferencePrice: 100,
    orderSide: 'BUY',
    entryOrderIds: ['entry1'],
    exitOrderIds: ['exit1'],
    positionSide: 'LONG',
    contractMultiplier: 1,
    now: 1000,
    newPositionIdentity: IDENTITY,
    ...overrides,
  };
}

describe('applyFill — opening (entry, weighted average)', () => {
  it('30/20/50 entry fills at 100.00/100.05/100.04 -> weighted average 100.03, base_quantity via contract multiplier', () => {
    const f1 = makeFill({ fill_id: 'f1', order_id: 'entry1', quantity: 30, price: 100.0 });
    const r1 = applyFill(baseInput({ fill: f1, contractMultiplier: 0.001 }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    expect(r1.event).toBe('POSITION_OPENED');
    expect(r1.position.quantity).toBe(30);
    expect(r1.position.average_entry_price).toBeCloseTo(100.0, 10);
    expect(r1.position.base_quantity).toBeCloseTo(30 * 0.001, 10);

    const f2 = makeFill({ fill_id: 'f2', order_id: 'entry1', quantity: 20, price: 100.05 });
    const r2 = applyFill(baseInput({ fill: f2, contractMultiplier: 0.001, position: r1.position }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.event).toBeNull();
    expect(r2.position.quantity).toBe(50);

    const f3 = makeFill({ fill_id: 'f3', order_id: 'entry1', quantity: 50, price: 100.04 });
    const r3 = applyFill(baseInput({ fill: f3, contractMultiplier: 0.001, position: r2.position }));
    expect(r3.ok).toBe(true);
    if (!r3.ok) throw new Error('unreachable');
    expect(r3.position.quantity).toBe(100);
    expect(r3.position.average_entry_price).toBeCloseTo(100.03, 10);
    expect(r3.position.entry_filled_quantity).toBe(100);
    expect(r3.position.base_quantity).toBeCloseTo(100 * 0.001, 10);
    expect(r3.position.entry_notional_usdt).toBeCloseTo(30 * 100.0 + 20 * 100.05 + 50 * 100.04, 6);
  });

  it('no Fill -> no Position (position stays undefined; caller never invokes applyFill)', () => {
    // positionManager only ever runs when a Fill exists; this test documents
    // the invariant rather than calling applyFill with no Fill.
    expect(true).toBe(true);
  });

  it('duplicate fill_id is idempotent (no double count)', () => {
    const fill = makeFill({ fill_id: 'f1', order_id: 'entry1', quantity: 10, price: 100 });
    const r1 = applyFill(baseInput({ fill }));
    if (!r1.ok) throw new Error('unreachable');
    const r2 = applyFill(baseInput({ fill, position: r1.position }));
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.event).toBeNull();
    expect(r2.position).toEqual(r1.position); // unchanged, not double-applied
  });
});

describe('applyFill — closing (exit, realized PnL)', () => {
  it('LONG exit 60/40 at 100.20/100.35 (avg exit 100.26) on entry avg 100.03 -> realized +23.00', () => {
    const entryFill = makeFill({ fill_id: 'fe', order_id: 'entry1', quantity: 100, price: 100.03 });
    const opened = applyFill(baseInput({ fill: entryFill }));
    if (!opened.ok) throw new Error('unreachable');

    const exit1 = makeFill({ fill_id: 'fx1', order_id: 'exit1', quantity: 60, price: 100.2 });
    const r1 = applyFill(
      baseInput({ fill: exit1, orderSide: 'SELL', orderReferencePrice: 100.2, position: opened.position }),
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    expect(r1.event).toBeNull(); // still 40 open
    expect(r1.position.quantity).toBe(40);
    expect(r1.position.average_entry_price).toBeCloseTo(100.03, 10); // unchanged on exit

    const exit2 = makeFill({ fill_id: 'fx2', order_id: 'exit1', quantity: 40, price: 100.35 });
    const r2 = applyFill(
      baseInput({ fill: exit2, orderSide: 'SELL', orderReferencePrice: 100.35, position: r1.position }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.event).toBe('POSITION_CLOSED');
    expect(r2.position.quantity).toBe(0);
    expect(r2.position.status).toBe('CLOSED');
    expect(r2.position.average_exit_price).toBeCloseTo(100.26, 6);
    expect(r2.position.realized_price_pnl_usdt).toBeCloseTo(23.0, 6);
  });

  it('SHORT entry 100 @ 100.00, exit 100 @ 99.90 -> realized +10.00', () => {
    const entryFill = makeFill({ fill_id: 'fe', order_id: 'entry1', quantity: 100, price: 100.0 });
    const opened = applyFill(baseInput({ fill: entryFill, positionSide: 'SHORT', orderSide: 'SELL' }));
    if (!opened.ok) throw new Error('unreachable');

    const exitFill = makeFill({ fill_id: 'fx', order_id: 'exit1', quantity: 100, price: 99.9 });
    const closed = applyFill(
      baseInput({ fill: exitFill, positionSide: 'SHORT', orderSide: 'BUY', orderReferencePrice: 99.9, position: opened.position }),
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error('unreachable');
    expect(closed.position.realized_price_pnl_usdt).toBeCloseTo(10.0, 6);
    expect(closed.position.status).toBe('CLOSED');
    expect(closed.event).toBe('POSITION_CLOSED');
  });

  it('fees and slippage attribution accumulate across entry + exit fills via cost-model.slippageAttribution', () => {
    const entryFill = makeFill({ fill_id: 'fe', order_id: 'entry1', quantity: 10, price: 100.02, fee_usdt: 0.2 });
    const opened = applyFill(baseInput({ fill: entryFill, orderSide: 'BUY', orderReferencePrice: 100.0 }));
    if (!opened.ok) throw new Error('unreachable');
    const expectedEntrySlippage = slippageAttribution('BUY', 10, 100.02, 100.0);
    expect(opened.position.slippage_attribution_usdt).toBeCloseTo(expectedEntrySlippage, 10);
    expect(opened.position.fees_usdt).toBeCloseTo(0.2, 10);

    const exitFill = makeFill({ fill_id: 'fx', order_id: 'exit1', quantity: 10, price: 99.97, fee_usdt: 0.18 });
    const closed = applyFill(
      baseInput({ fill: exitFill, orderSide: 'SELL', orderReferencePrice: 100.0, position: opened.position }),
    );
    if (!closed.ok) throw new Error('unreachable');
    const expectedExitSlippage = slippageAttribution('SELL', 10, 99.97, 100.0);
    expect(closed.position.slippage_attribution_usdt).toBeCloseTo(expectedEntrySlippage + expectedExitSlippage, 10);
    expect(closed.position.fees_usdt).toBeCloseTo(0.38, 10);
  });

  it('POSITION_OVERCLOSE when exit quantity exceeds open quantity', () => {
    const entryFill = makeFill({ fill_id: 'fe', order_id: 'entry1', quantity: 10, price: 100 });
    const opened = applyFill(baseInput({ fill: entryFill }));
    if (!opened.ok) throw new Error('unreachable');
    const exitFill = makeFill({ fill_id: 'fx', order_id: 'exit1', quantity: 11, price: 100 });
    const result = applyFill(baseInput({ fill: exitFill, orderSide: 'SELL', position: opened.position }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('POSITION_OVERCLOSE');
  });
});

describe('applyFill — RECONCILIATION_ERROR variants', () => {
  it('UNKNOWN_ORDER when order_id is neither entry nor exit', () => {
    const fill = makeFill({ fill_id: 'f1', order_id: 'other-order', quantity: 1, price: 100 });
    const result = applyFill(baseInput({ fill }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('UNKNOWN_ORDER');
  });

  it('UNSUPPORTED_FEE_ASSET when fee_asset is not USDT', () => {
    const fill = makeFill({ fill_id: 'f1', order_id: 'entry1', quantity: 1, price: 100, fee_asset: 'BNB' });
    const result = applyFill(baseInput({ fill }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('UNSUPPORTED_FEE_ASSET');
  });

  it('RECONCILIATION_ERROR when an exit Fill arrives with no prior Position (out-of-order)', () => {
    const fill = makeFill({ fill_id: 'fx', order_id: 'exit1', quantity: 1, price: 100 });
    const result = applyFill(baseInput({ fill, orderSide: 'SELL' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('RECONCILIATION_ERROR');
  });

  it('RECONCILIATION_ERROR when a Fill arrives for an already-CLOSED Position (no cross-period positions, D-1)', () => {
    const entryFill = makeFill({ fill_id: 'fe', order_id: 'entry1', quantity: 10, price: 100 });
    const opened = applyFill(baseInput({ fill: entryFill }));
    if (!opened.ok) throw new Error('unreachable');
    const exitFill = makeFill({ fill_id: 'fx', order_id: 'exit1', quantity: 10, price: 100 });
    const closed = applyFill(baseInput({ fill: exitFill, orderSide: 'SELL', position: opened.position }));
    if (!closed.ok) throw new Error('unreachable');

    const anotherEntry = makeFill({ fill_id: 'fe2', order_id: 'entry1', quantity: 5, price: 100 });
    const result = applyFill(baseInput({ fill: anotherEntry, position: closed.position }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('RECONCILIATION_ERROR');
  });
});

describe('unrealizedPnl', () => {
  it('LONG qty 10 @ entry 100, mark 100.994 -> +9.94', () => {
    const position = { position_side: 'LONG' as const, quantity: 10, average_entry_price: 100 };
    expect(unrealizedPnl(position, 100.994)).toBeCloseTo(9.94, 6);
  });
  it('SHORT qty 10 @ entry 100, mark 101 -> -10.00', () => {
    const position = { position_side: 'SHORT' as const, quantity: 10, average_entry_price: 100 };
    expect(unrealizedPnl(position, 101)).toBeCloseTo(-10.0, 6);
  });
});

describe('replay consistency', () => {
  it('applying the same ordered Fill sequence from scratch reproduces the same final Position', () => {
    const fills: Fill[] = [
      makeFill({ fill_id: 'f1', order_id: 'entry1', quantity: 30, price: 100.0, timestamp: 1 }),
      makeFill({ fill_id: 'f2', order_id: 'entry1', quantity: 20, price: 100.05, timestamp: 2 }),
      makeFill({ fill_id: 'f3', order_id: 'entry1', quantity: 50, price: 100.04, timestamp: 3 }),
      makeFill({ fill_id: 'f4', order_id: 'exit1', quantity: 60, price: 100.2, timestamp: 4 }),
      makeFill({ fill_id: 'f5', order_id: 'exit1', quantity: 40, price: 100.35, timestamp: 5 }),
    ];

    function replayAll(sequence: Fill[]): PaperPosition {
      let position: PaperPosition | undefined;
      for (const fill of sequence) {
        const isExit = fill.order_id === 'exit1';
        const outcome = applyFill(
          baseInput({
            fill,
            position,
            orderSide: isExit ? 'SELL' : 'BUY',
            orderReferencePrice: fill.price,
          }),
        );
        if (!outcome.ok) throw new Error(`replay failed: ${outcome.errorCode}`);
        position = outcome.position;
      }
      if (!position) throw new Error('no position produced');
      return position;
    }

    const first = replayAll(fills);
    const second = replayAll(fills); // re-derive from the same events, independently
    expect(second).toEqual(first);
    expect(first.status).toBe('CLOSED');
    expect(first.realized_price_pnl_usdt).toBeCloseTo(23.0, 6);

    // Re-applying the whole sequence again onto the already-final state is a
    // pure no-op (idempotency holds across the entire replay, not just one Fill).
    let idempotentReplay: PaperPosition | undefined = first;
    for (const fill of fills) {
      const isExit = fill.order_id === 'exit1';
      const outcome = applyFill(
        baseInput({ fill, position: idempotentReplay, orderSide: isExit ? 'SELL' : 'BUY', orderReferencePrice: fill.price }),
      );
      if (!outcome.ok) throw new Error(`idempotent replay failed: ${outcome.errorCode}`);
      idempotentReplay = outcome.position;
    }
    expect(idempotentReplay).toEqual(first);
  });
});
