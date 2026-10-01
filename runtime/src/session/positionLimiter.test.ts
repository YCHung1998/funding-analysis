import { describe, expect, it } from 'vitest';
import { PositionLimiter } from './positionLimiter';

describe('PositionLimiter (settlement-session spec "Position limits across sessions")', () => {
  it('rejects a new opportunity with MAX_POSITIONS once the global limit is reached', () => {
    const limiter = new PositionLimiter({ maxPositions: 2 });
    limiter.recordOpen('session-1');
    limiter.recordOpen('session-2');

    expect(limiter.canOpen('session-3')).toEqual({ allowed: false, reason: 'MAX_POSITIONS' });
  });

  it('allows opening while under the global limit', () => {
    const limiter = new PositionLimiter({ maxPositions: 2 });
    limiter.recordOpen('session-1');

    expect(limiter.canOpen('session-1')).toEqual({ allowed: true });
  });

  it('enforces an optional per-session max independently of the global max', () => {
    const limiter = new PositionLimiter({ maxPositions: 10, maxPositionsPerSession: 1 });
    limiter.recordOpen('session-1');

    expect(limiter.canOpen('session-1')).toEqual({ allowed: false, reason: 'MAX_POSITIONS' });
    expect(limiter.canOpen('session-2')).toEqual({ allowed: true });
  });

  it('frees capacity on recordClose', () => {
    const limiter = new PositionLimiter({ maxPositions: 1 });
    limiter.recordOpen('session-1');
    expect(limiter.canOpen('session-2')).toEqual({ allowed: false, reason: 'MAX_POSITIONS' });

    limiter.recordClose('session-1');
    expect(limiter.canOpen('session-2')).toEqual({ allowed: true });
  });
});
