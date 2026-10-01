import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealClock } from './realClock';

/** Fake monotonic local clock injected into RealClock so tests are deterministic and hit no network/timers. */
function fakeLocalNow(initial = 0) {
  let t = initial;
  return { fn: () => t, set: (value: number) => (t = value), advance: (ms: number) => (t += ms) };
}

describe('RealClock — per-exchange calibration (trading-clock spec)', () => {
  it('computes offset from the round-trip midpoint', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({}, local.fn);

    local.set(1000);
    clock.calibrate('Bybit', { sentAt: 1000, serverTime: 1100, receivedAt: 1040 });

    const offset = clock.offset('Bybit');
    expect(offset.offsetMs).toBe(80);
    expect(offset.errorMs).toBe(20);

    local.set(2000);
    expect(clock.exchangeNow('Bybit')).toBe(2080);
  });

  it('keeps offsets independent per exchange', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({}, local.fn);

    clock.calibrate('Binance', { sentAt: 0, serverTime: 60, receivedAt: 0 }); // offset +60
    clock.calibrate('Bybit', { sentAt: 0, serverTime: -30, receivedAt: 0 }); // offset -30

    expect(clock.toLocal('Binance', 1000)).toBe(1000 - 60);
    expect(clock.toLocal('Bybit', 1000)).toBe(1000 + 30);
  });

  it('uses a local monotonic source by default (does not throw when constructed with no args)', () => {
    const clock = new RealClock();
    expect(typeof clock.now()).toBe('number');
  });
});

describe('RealClock — reference timeline with fallback (trading-clock spec)', () => {
  it('Binance is the default reference once calibrated', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({}, local.fn);
    clock.calibrate('Binance', { sentAt: 0, serverTime: 0, receivedAt: 0 });
    clock.calibrate('Bybit', { sentAt: 0, serverTime: 0, receivedAt: 0 });

    expect(clock.reference()).toBe('Binance');
  });

  it('falls back when the reference calibration expires', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({ calibrationMaxAgeMs: 60_000 }, local.fn);
    clock.calibrate('Binance', { sentAt: 0, serverTime: 0, receivedAt: 0 });

    local.set(65_000);
    clock.calibrate('Bybit', { sentAt: 65_000, serverTime: 65_000, receivedAt: 65_000 });

    local.set(70_000); // Binance calibration (t=0) now stale, Bybit's (t=65000) is fresh
    expect(clock.reference()).toBe('Bybit');
    expect(clock.drainEvents()).toContainEqual(
      expect.objectContaining({ type: 'CLOCK_REFERENCE_CHANGED', from: 'Binance', to: 'Bybit' }),
    );
  });
});

describe('RealClock — offset jump and reliability (trading-clock spec)', () => {
  it('emits CLOCK_OFFSET_JUMP when an offset changes beyond the threshold', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({ jumpThresholdMs: 100 }, local.fn);
    clock.calibrate('Binance', { sentAt: 0, serverTime: 60, receivedAt: 0 });
    clock.calibrate('Binance', { sentAt: 0, serverTime: 300, receivedAt: 0 });

    expect(clock.drainEvents()).toContainEqual(
      expect.objectContaining({ type: 'CLOCK_OFFSET_JUMP', exchange: 'Binance', previousOffsetMs: 60, newOffsetMs: 300 }),
    );
  });

  it('is unreliable when error exceeds clock_max_error_ms', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({ maxErrorMs: 500 }, local.fn);
    // sentAt=0, receivedAt=1600 => errorMs = RTT/2 = 800
    clock.calibrate('Bybit', { sentAt: 0, serverTime: 800, receivedAt: 1600 });

    expect(clock.isReliable('Bybit')).toBe(false);
  });

  it('is unreliable before any calibration', () => {
    const clock = new RealClock();
    expect(clock.isReliable('OKX')).toBe(false);
  });
});

describe('RealClock — scheduling (shared Clock contract)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('at()/after() schedule via the system timer and cancel() prevents firing', () => {
    const local = fakeLocalNow(0);
    const clock = new RealClock({}, local.fn);
    clock.calibrate('Binance', { sentAt: 0, serverTime: 0, receivedAt: 0 });

    const fired: number[] = [];
    clock.at(100, () => fired.push(100));
    const cancelled = clock.after(50, () => fired.push(999));
    clock.cancel(cancelled);

    vi.advanceTimersByTime(200);

    expect(fired).toEqual([100]);
  });
});
