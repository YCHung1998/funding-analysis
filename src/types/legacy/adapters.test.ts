import { describe, expect, it } from 'vitest';
import { toLegacyOrderState, toLegacyPositionState } from './adapters';

describe('toLegacyOrderState (v0.2 OrderState -> v0.1 OrderState)', () => {
  it('CREATED | SUBMITTED | ACKNOWLEDGED -> NEW', () => {
    expect(toLegacyOrderState({ order_state: 'CREATED', filled_quantity: 0 })).toBe('NEW');
    expect(toLegacyOrderState({ order_state: 'SUBMITTED', filled_quantity: 0 })).toBe('NEW');
    expect(toLegacyOrderState({ order_state: 'ACKNOWLEDGED', filled_quantity: 0 })).toBe('NEW');
  });

  it('PARTIALLY_FILLED -> PARTIALLY_FILLED', () => {
    expect(toLegacyOrderState({ order_state: 'PARTIALLY_FILLED', filled_quantity: 10 })).toBe('PARTIALLY_FILLED');
  });

  it('CANCEL_REQUESTED with partial fill -> PARTIALLY_FILLED', () => {
    expect(toLegacyOrderState({ order_state: 'CANCEL_REQUESTED', filled_quantity: 30 })).toBe('PARTIALLY_FILLED');
  });

  it('CANCEL_REQUESTED with no fill -> NEW', () => {
    expect(toLegacyOrderState({ order_state: 'CANCEL_REQUESTED', filled_quantity: 0 })).toBe('NEW');
  });

  it('FILLED -> FILLED', () => {
    expect(toLegacyOrderState({ order_state: 'FILLED', filled_quantity: 100 })).toBe('FILLED');
  });

  it('CANCELED | EXPIRED -> CANCELED', () => {
    expect(toLegacyOrderState({ order_state: 'CANCELED', filled_quantity: 0 })).toBe('CANCELED');
    expect(toLegacyOrderState({ order_state: 'EXPIRED', filled_quantity: 0 })).toBe('CANCELED');
  });

  it('REJECTED -> REJECTED', () => {
    expect(toLegacyOrderState({ order_state: 'REJECTED', filled_quantity: 0 })).toBe('REJECTED');
  });
});

describe('toLegacyPositionState (v0.2 TradeStatus -> v0.1 PositionState)', () => {
  it('CREATED | PRE_FLIGHT | ABORTED | CLOSED -> FLAT', () => {
    for (const s of ['CREATED', 'PRE_FLIGHT', 'ABORTED', 'CLOSED'] as const) {
      expect(toLegacyPositionState(s)).toBe('FLAT');
    }
  });

  it('ENTRY_PENDING | PARTIALLY_HEDGED -> OPENING', () => {
    expect(toLegacyPositionState('ENTRY_PENDING')).toBe('OPENING');
    expect(toLegacyPositionState('PARTIALLY_HEDGED')).toBe('OPENING');
  });

  it('HEDGED -> BALANCED_HEDGED', () => {
    expect(toLegacyPositionState('HEDGED')).toBe('BALANCED_HEDGED');
  });

  it('LEG_IMBALANCE -> LEG_IMBALANCE', () => {
    expect(toLegacyPositionState('LEG_IMBALANCE')).toBe('LEG_IMBALANCE');
  });

  it('EXIT_PENDING -> CLOSING', () => {
    expect(toLegacyPositionState('EXIT_PENDING')).toBe('CLOSING');
  });

  it('EMERGENCY_EXIT -> EMERGENCY_EXIT', () => {
    expect(toLegacyPositionState('EMERGENCY_EXIT')).toBe('EMERGENCY_EXIT');
  });

  it('FAILED -> null (no legacy equivalent)', () => {
    expect(toLegacyPositionState('FAILED')).toBeNull();
  });
});
