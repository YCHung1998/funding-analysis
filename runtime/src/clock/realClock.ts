import { selectReference } from './referenceSelection';
import {
  DEFAULT_CLOCK_CONFIG,
  type CalibrationSample,
  type Clock,
  type ClockCalibrationConfig,
  type ClockEvent,
  type ClockOffset,
  type ExchangeId,
  type TimerHandle,
} from './types';

// This is the ONLY file under runtime/src/ allowed to touch the system clock / timers
// (runtime/test/architecture.test.ts enforces this; trading-clock spec "Injectable clock is the
// only time source"). Every other module receives time through the injected `Clock` interface.

/**
 * Local monotonic-ish epoch clock: anchors `process.hrtime` (immune to NTP/system-clock jumps
 * during the process's lifetime) to the wall-clock epoch captured once at module load.
 */
function createDefaultLocalNow(): () => number {
  const startHr = process.hrtime.bigint();
  const startEpochMs = Date.now();
  return () => startEpochMs + Number((process.hrtime.bigint() - startHr) / 1_000_000n);
}

/**
 * Real clock: per-exchange offset/error from round-trip-midpoint calibration samples
 * (design.md Decision 2), scheduling via real `setTimeout`. `localNow` is injectable so tests
 * can control it deterministically without touching the system clock or real timers.
 */
export class RealClock implements Clock {
  private readonly config: ClockCalibrationConfig;
  private readonly localNow: () => number;
  private readonly offsets = new Map<ExchangeId, ClockOffset>();
  private events: ClockEvent[] = [];
  private currentReference: ExchangeId | null = null;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextHandleId = 1;

  constructor(config: Partial<ClockCalibrationConfig> = {}, localNow: () => number = createDefaultLocalNow()) {
    this.config = { ...DEFAULT_CLOCK_CONFIG, ...config };
    this.localNow = localNow;
  }

  /** Compute and store `ex`'s offset/error from a single server-time round trip. */
  calibrate(ex: ExchangeId, sample: CalibrationSample): ClockOffset {
    const rtt = sample.receivedAt - sample.sentAt;
    const midpoint = (sample.sentAt + sample.receivedAt) / 2;
    const offset: ClockOffset = {
      offsetMs: sample.serverTime - midpoint,
      errorMs: rtt / 2,
      calibratedAt: sample.receivedAt,
    };

    const previous = this.offsets.get(ex);
    this.offsets.set(ex, offset);
    if (previous && Math.abs(offset.offsetMs - previous.offsetMs) > this.config.jumpThresholdMs) {
      this.events.push({
        type: 'CLOCK_OFFSET_JUMP',
        at: this.localNow(),
        exchange: ex,
        previousOffsetMs: previous.offsetMs,
        newOffsetMs: offset.offsetMs,
      });
    }
    this.recomputeReference();
    return offset;
  }

  now(): number {
    // Before any exchange is calibrated there is no offset yet; fall back to local time
    // (offset 0) rather than throwing, so the clock is usable immediately after construction.
    const offsetMs = this.offsets.get(this.reference())?.offsetMs ?? 0;
    return this.localNow() + offsetMs;
  }

  exchangeNow(ex: ExchangeId): number {
    return this.localNow() + this.requireOffset(ex).offsetMs;
  }

  toLocal(ex: ExchangeId, exchangeTime: number): number {
    return exchangeTime - this.requireOffset(ex).offsetMs;
  }

  offset(ex: ExchangeId): ClockOffset {
    return this.requireOffset(ex);
  }

  isReliable(ex: ExchangeId): boolean {
    const offset = this.offsets.get(ex);
    if (!offset) return false;
    if (offset.errorMs > this.config.maxErrorMs) return false;
    if (this.localNow() - offset.calibratedAt > this.config.calibrationMaxAgeMs) return false;
    return true;
  }

  reference(): ExchangeId {
    this.recomputeReference();
    return this.currentReference ?? this.config.referenceClockPriority[0];
  }

  private recomputeReference(): void {
    const { reference, changed } = selectReference(
      this.config.referenceClockPriority,
      (ex) => this.isReliable(ex),
      this.currentReference,
    );
    if (changed) {
      this.events.push({
        type: 'CLOCK_REFERENCE_CHANGED',
        at: this.localNow(),
        from: this.currentReference,
        to: reference,
      });
    }
    this.currentReference = reference;
  }

  drainEvents(): ClockEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  at(time: number, cb: () => void): TimerHandle {
    const delay = Math.max(0, time - this.now());
    return this.schedule(delay, cb);
  }

  after(ms: number, cb: () => void): TimerHandle {
    return this.schedule(Math.max(0, ms), cb);
  }

  cancel(handle: TimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(handle.id);
    }
  }

  private schedule(delay: number, cb: () => void): TimerHandle {
    const id = this.nextHandleId++;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      cb();
    }, delay);
    this.timers.set(id, timer);
    return { id };
  }

  private requireOffset(ex: ExchangeId): ClockOffset {
    const offset = this.offsets.get(ex);
    if (!offset) {
      throw new Error(`RealClock: no calibration for exchange "${ex}" (call calibrate() first)`);
    }
    return offset;
  }
}
