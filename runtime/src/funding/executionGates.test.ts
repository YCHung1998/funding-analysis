import { describe, expect, it } from 'vitest';
import {
  canReducePosition,
  canSubmitEntry,
  checkHedgedByDeadline,
  shouldExitWithoutConfirmation,
} from './executionGates';

const T = 1_000_000;
const entryDeadline = T - 25_000;
const hedgedBy = T - 15_000;
const lockEnd = T + 15_000;
const exitAt = T + 30_000;

describe('canSubmitEntry (funding-settlement-rules spec "Entry must be hedged before the uncertainty window")', () => {
  it('refuses a new entry request after entry_deadline', () => {
    expect(canSubmitEntry(entryDeadline + 1, entryDeadline)).toEqual({
      allowed: false,
      reason: 'ENTRY_DEADLINE_PASSED',
    });
  });

  it('allows a new entry request at or before entry_deadline', () => {
    expect(canSubmitEntry(entryDeadline, entryDeadline)).toEqual({ allowed: true });
  });
});

describe('checkHedgedByDeadline', () => {
  it('transitions PARTIALLY_HEDGED to LEG_IMBALANCE at hedged_by', () => {
    expect(checkHedgedByDeadline('PARTIALLY_HEDGED')).toEqual({
      ok: false,
      nextState: 'LEG_IMBALANCE',
      reason: 'NOT_HEDGED_BEFORE_WINDOW',
    });
  });

  it('is fine when already HEDGED at hedged_by', () => {
    expect(checkHedgedByDeadline('HEDGED')).toEqual({ ok: true });
  });
});

describe('canReducePosition (funding-settlement-rules spec "No position reduction inside the lock window")', () => {
  it('refuses a normal exit for a HEDGED trade inside [hedged_by, lock_end)', () => {
    expect(canReducePosition({ now: T + 5_000, hedgedBy, lockEnd, isEmergency: false })).toEqual({
      allowed: false,
      reason: 'LOCK_WINDOW',
    });
  });

  it('allows an emergency reduction inside the lock window', () => {
    expect(canReducePosition({ now: T + 3_000, hedgedBy, lockEnd, isEmergency: true })).toEqual({
      allowed: true,
    });
  });

  it('allows a normal exit outside the lock window', () => {
    expect(canReducePosition({ now: lockEnd, hedgedBy, lockEnd, isEmergency: false })).toEqual({
      allowed: true,
    });
  });
});

describe('shouldExitWithoutConfirmation (funding-settlement-rules spec "Exit at exit_at without waiting for confirmation")', () => {
  it('is true once the clock reaches exit_at, regardless of settlement confirmation', () => {
    expect(shouldExitWithoutConfirmation(exitAt, exitAt)).toBe(true);
  });

  it('is false before exit_at', () => {
    expect(shouldExitWithoutConfirmation(exitAt - 1, exitAt)).toBe(false);
  });
});
