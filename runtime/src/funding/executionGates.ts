// TODO(trading-schema-types): 合併後改為 import { TradeHedgeState } from 'runtime/src/types'
export type TradeHedgeState = 'PENDING' | 'PARTIALLY_HEDGED' | 'HEDGED' | 'LEG_IMBALANCE';

export type EntryGateResult = { allowed: true } | { allowed: false; reason: 'ENTRY_DEADLINE_PASSED' };

/** funding-settlement-rules spec "Entry must be hedged before the uncertainty window". */
export function canSubmitEntry(now: number, entryDeadline: number): EntryGateResult {
  return now > entryDeadline ? { allowed: false, reason: 'ENTRY_DEADLINE_PASSED' } : { allowed: true };
}

export type HedgedByCheckResult =
  | { ok: true }
  | { ok: false; nextState: 'LEG_IMBALANCE'; reason: 'NOT_HEDGED_BEFORE_WINDOW' };

/** Called at `hedged_by`: a trade that is not HEDGED goes to LEG_IMBALANCE and the emergency procedure starts. */
export function checkHedgedByDeadline(hedgeState: TradeHedgeState): HedgedByCheckResult {
  if (hedgeState === 'HEDGED') return { ok: true };
  return { ok: false, nextState: 'LEG_IMBALANCE', reason: 'NOT_HEDGED_BEFORE_WINDOW' };
}

export type ReduceGateResult = { allowed: true } | { allowed: false; reason: 'LOCK_WINDOW' };

/**
 * funding-settlement-rules spec "No position reduction inside the lock window": between
 * hedged_by and lock_end, only an emergency reduction may submit a reduce/exit order.
 */
export function canReducePosition(input: {
  now: number;
  hedgedBy: number;
  lockEnd: number;
  isEmergency: boolean;
}): ReduceGateResult {
  const inLockWindow = input.now >= input.hedgedBy && input.now < input.lockEnd;
  if (inLockWindow && !input.isEmergency) {
    return { allowed: false, reason: 'LOCK_WINDOW' };
  }
  return { allowed: true };
}

/** funding-settlement-rules spec "Exit at exit_at without waiting for confirmation". */
export function shouldExitWithoutConfirmation(now: number, exitAt: number): boolean {
  return now >= exitAt;
}
