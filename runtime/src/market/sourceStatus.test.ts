import { describe, expect, it } from 'vitest';
import type { TradingEvent } from '../types/event';
import type { EventSink } from './instruments/types';
import { SourceStatusTracker } from './sourceStatus';

function makeTracker(startNow = 0) {
  let now = startNow;
  const events: TradingEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  const tracker = new SourceStatusTracker({ eventSink: sink, now: () => now });
  return { tracker, events, advance: (t: number) => (now = t) };
}

describe('SourceStatusTracker', () => {
  it('degrades on failure while usable cached data remains', () => {
    const { tracker, events } = makeTracker(0);
    tracker.recordSuccess('Bitget', 467);
    events.length = 0;
    tracker.recordFailure('Bitget', 'TIMEOUT', undefined, true);
    expect(tracker.get('Bitget')?.state).toBe('DEGRADED');
    expect(events.some((e) => e.event_type === 'SOURCE_STATUS_CHANGED' && e.payload.to === 'DEGRADED')).toBe(true);
  });

  it('recovers to healthy with consecutive_failures reset', () => {
    const { tracker } = makeTracker(0);
    tracker.recordSuccess('Bitget', 10);
    tracker.recordFailure('Bitget', 'TIMEOUT', undefined, true);
    tracker.recordSuccess('Bitget', 10);
    const status = tracker.get('Bitget')!;
    expect(status.state).toBe('HEALTHY');
    expect(status.consecutive_failures).toBe(0);
  });

  it('keeps previous instrument_count on partial failure, flips to FAILED on expiry', () => {
    const { tracker } = makeTracker(0);
    tracker.recordSuccess('OKX', 467);
    tracker.recordFailure('OKX', 'RATE_LIMITED', 429, true);
    expect(tracker.get('OKX')?.instrument_count).toBe(467);
    expect(tracker.get('OKX')?.state).toBe('DEGRADED');

    tracker.recordDataExpired('OKX');
    expect(tracker.get('OKX')?.instrument_count).toBe(0);
    expect(tracker.get('OKX')?.state).toBe('FAILED');
  });

  it('starts INITIALIZING before any success', () => {
    const { tracker } = makeTracker(0);
    expect(tracker.get('Pionex')).toBeUndefined();
    tracker.recordFailure('Pionex', 'NETWORK', undefined, false);
    expect(tracker.get('Pionex')?.state).toBe('FAILED');
  });
});
