export interface PositionLimitConfig {
  maxPositions: number;
  maxPositionsPerSession?: number;
}

export type PositionGateResult = { allowed: true } | { allowed: false; reason: 'MAX_POSITIONS' };

/**
 * Tracks open trade counts across sessions to enforce `max_positions` (global) and
 * `max_positions_per_session` (optional) — settlement-session spec "Position limits across
 * sessions". The session/trade lifecycle itself is out of scope here; callers call
 * `recordOpen`/`recordClose` as trades open and close.
 */
export class PositionLimiter {
  private openCount = 0;
  private readonly perSession = new Map<string, number>();

  constructor(private readonly config: PositionLimitConfig) {}

  canOpen(sessionId: string): PositionGateResult {
    if (this.openCount >= this.config.maxPositions) {
      return { allowed: false, reason: 'MAX_POSITIONS' };
    }
    const perSessionMax = this.config.maxPositionsPerSession;
    if (perSessionMax !== undefined && (this.perSession.get(sessionId) ?? 0) >= perSessionMax) {
      return { allowed: false, reason: 'MAX_POSITIONS' };
    }
    return { allowed: true };
  }

  recordOpen(sessionId: string): void {
    this.openCount += 1;
    this.perSession.set(sessionId, (this.perSession.get(sessionId) ?? 0) + 1);
  }

  recordClose(sessionId: string): void {
    this.openCount = Math.max(0, this.openCount - 1);
    this.perSession.set(sessionId, Math.max(0, (this.perSession.get(sessionId) ?? 0) - 1));
  }
}
