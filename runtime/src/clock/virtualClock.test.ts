import { describe, expect, it } from 'vitest';
import { VirtualClock } from './virtualClock';

describe('VirtualClock — deterministic replay (trading-clock spec)', () => {
  it('fires callbacks in time order', () => {
    const clock = new VirtualClock(0);
    const order: number[] = [];
    clock.at(300, () => order.push(300));
    clock.at(100, () => order.push(100));
    clock.at(200, () => order.push(200));

    let nowInsideLast = -1;
    clock.at(300, () => {
      // runs after the 300 above (registration order), still at t=300
      nowInsideLast = clock.now();
    });

    clock.advanceTo(300);

    expect(order).toEqual([100, 200, 300]);
    expect(nowInsideLast).toBe(300);
  });

  it('now() inside an earlier callback reflects that callback\'s own due time, not the advance target (regression)', () => {
    const clock = new VirtualClock(0);
    const seen: number[] = [];
    clock.at(100, () => seen.push(clock.now()));
    clock.at(300, () => seen.push(clock.now()));

    clock.advanceTo(300);

    expect(seen).toEqual([100, 300]);
  });

  it('a callback firing at t can schedule a new timer due at or before the advance target and have it fire in the same advanceTo (regression)', () => {
    const clock = new VirtualClock(0);
    const fired: string[] = [];
    clock.at(100, () => {
      fired.push('A');
      clock.at(150, () => fired.push('B'));
    });

    clock.advanceTo(300);

    expect(fired).toEqual(['A', 'B']);
  });

  it('keeps registration order for the same due time', () => {
    const clock = new VirtualClock(0);
    const order: string[] = [];
    clock.at(100, () => order.push('A'));
    clock.at(100, () => order.push('B'));

    clock.advanceTo(100);

    expect(order).toEqual(['A', 'B']);
  });

  it('does not fire a cancelled callback', () => {
    const clock = new VirtualClock(0);
    let fired = false;
    const handle = clock.at(100, () => (fired = true));
    clock.cancel(handle);

    clock.advanceTo(200);

    expect(fired).toBe(false);
  });

  it('after(ms, cb) schedules relative to current now()', () => {
    const clock = new VirtualClock(1000);
    let fired = false;
    clock.after(50, () => (fired = true));

    clock.advanceTo(1049);
    expect(fired).toBe(false);

    clock.advanceTo(1050);
    expect(fired).toBe(true);
  });
});

describe('VirtualClock — per-exchange offset simulation (trading-clock spec)', () => {
  it('offsets are independent per exchange', () => {
    const clock = new VirtualClock(0);
    clock.setExchangeOffset('Binance', { offsetMs: 60, errorMs: 5, calibratedAt: 0 });
    clock.setExchangeOffset('Bybit', { offsetMs: -30, errorMs: 5, calibratedAt: 0 });

    expect(clock.toLocal('Binance', 1000)).toBe(1000 - 60);
    expect(clock.toLocal('Bybit', 1000)).toBe(1000 + 30);
  });

  it('exchangeNow reflects the configured offset', () => {
    const clock = new VirtualClock(2000);
    clock.setExchangeOffset('Bybit', { offsetMs: 80, errorMs: 20, calibratedAt: 0 });

    expect(clock.exchangeNow('Bybit')).toBe(2080);
  });

  it('Binance is the default reference when both are calibrated and healthy', () => {
    const clock = new VirtualClock(0);
    clock.setExchangeOffset('Binance', { offsetMs: 0, errorMs: 5, calibratedAt: 0 });
    clock.setExchangeOffset('Bybit', { offsetMs: 0, errorMs: 5, calibratedAt: 0 });

    expect(clock.reference()).toBe('Binance');
  });

  it('falls back to the next exchange when the reference calibration expires', () => {
    const clock = new VirtualClock(0, { calibrationMaxAgeMs: 60_000 });
    clock.setExchangeOffset('Binance', { offsetMs: 0, errorMs: 5, calibratedAt: 0 });
    clock.setExchangeOffset('Bybit', { offsetMs: 0, errorMs: 5, calibratedAt: 65_000 });

    clock.advanceTo(70_000); // Binance calibration now stale, Bybit's is fresh

    expect(clock.reference()).toBe('Bybit');
    const events = clock.drainEvents();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'CLOCK_REFERENCE_CHANGED', from: 'Binance', to: 'Bybit' }),
    );
  });

  it('emits CLOCK_OFFSET_JUMP when an offset changes beyond the threshold', () => {
    const clock = new VirtualClock(0, { jumpThresholdMs: 100 });
    clock.setExchangeOffset('Binance', { offsetMs: 60, errorMs: 5, calibratedAt: 0 });
    clock.setExchangeOffset('Binance', { offsetMs: 300, errorMs: 5, calibratedAt: 0 });

    const events = clock.drainEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'CLOCK_OFFSET_JUMP',
        exchange: 'Binance',
        previousOffsetMs: 60,
        newOffsetMs: 300,
      }),
    );
  });

  it('isReliable is false when error exceeds the configured max', () => {
    const clock = new VirtualClock(0, { maxErrorMs: 500 });
    clock.setExchangeOffset('Bybit', { offsetMs: 0, errorMs: 800, calibratedAt: 0 });

    expect(clock.isReliable('Bybit')).toBe(false);
  });

  it('isReliable is false when calibration has never happened', () => {
    const clock = new VirtualClock(0);
    expect(clock.isReliable('OKX')).toBe(false);
  });
});
