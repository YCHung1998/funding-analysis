/**
 * runtime/test/fakes/fakeGuard.ts
 *
 * Fake `FundingWindowGuard` (stands in for `funding-settlement-rules`).
 * Defaults to always-allow; tests override via `setEntryResult` /
 * `setExitResult` to exercise refusal paths (e.g. `ENTRY_DEADLINE_PASSED`,
 * `LOCK_WINDOW`) without implementing the real settlement-session rules.
 */
import type { FundingWindowGuard, GuardResult } from '../../src/execution/executionInterface';

export class FakeFundingWindowGuard implements FundingWindowGuard {
  private entryResult: GuardResult = { allowed: true };
  private exitResult: GuardResult = { allowed: true };

  setEntryResult(result: GuardResult): void {
    this.entryResult = result;
  }

  setExitResult(result: GuardResult): void {
    this.exitResult = result;
  }

  canSubmitEntry(_tradeId: string, _now: number): GuardResult {
    return this.entryResult;
  }

  canSubmitExit(_tradeId: string, _purpose: 'EXIT' | 'EMERGENCY_CLOSE', _now: number): GuardResult {
    return this.exitResult;
  }
}
