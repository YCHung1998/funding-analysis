import { TimerQueue } from '../scheduler/timerQueue';
import { selectReference } from './referenceSelection';
import {
  DEFAULT_CLOCK_CONFIG,
  type Clock,
  type ClockCalibrationConfig,
  type ClockEvent,
  type ClockOffset,
  type ExchangeId,
  type TimerHandle,
} from './types';

/**
 * Test clock: time only advances through `advanceTo(t)` (trading-clock spec
 * "Virtual clock supports deterministic replay"). Per-exchange offsets/errors are set
 * directly via `setExchangeOffset` to simulate desync scenarios (design.md Decision 2),
 * rather than computed from round-trip samples like `RealClock`.
 */
export class VirtualClock implements Clock {
  private currentTime: number;
  private readonly queue = new TimerQueue();
  private readonly offsets = new Map<ExchangeId, ClockOffset>();
  private readonly config: ClockCalibrationConfig;
  private events: ClockEvent[] = [];
  private currentReference: ExchangeId | null = null;

  constructor(start = 0, config: Partial<ClockCalibrationConfig> = {}) {
    this.currentTime = start;
    this.config = { ...DEFAULT_CLOCK_CONFIG, ...config };
  }

  now(): number {
    return this.currentTime;
  }

  exchangeNow(ex: ExchangeId): number {
    return this.currentTime + this.requireOffset(ex).offsetMs;
  }

  toLocal(ex: ExchangeId, exchangeTime: number): number {
    return exchangeTime - this.requireOffset(ex).offsetMs;
  }

  offset(ex: ExchangeId): ClockOffset {
    return this.requireOffset(ex);
  }

  /** Test setter: configure (or update) `ex`'s simulated offset/error. */
  setExchangeOffset(ex: ExchangeId, offset: ClockOffset): void {
    const previous = this.offsets.get(ex);
    this.offsets.set(ex, offset);
    if (previous && Math.abs(offset.offsetMs - previous.offsetMs) > this.config.jumpThresholdMs) {
      this.events.push({
        type: 'CLOCK_OFFSET_JUMP',
        at: this.currentTime,
        exchange: ex,
        previousOffsetMs: previous.offsetMs,
        newOffsetMs: offset.offsetMs,
      });
    }
    this.recomputeReference();
  }

  isReliable(ex: ExchangeId): boolean {
    const offset = this.offsets.get(ex);
    if (!offset) return false;
    if (offset.errorMs > this.config.maxErrorMs) return false;
    if (this.currentTime - offset.calibratedAt > this.config.calibrationMaxAgeMs) return false;
    return true;
  }

  reference(): ExchangeId {
    if (!this.currentReference) this.recomputeReference();
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
        at: this.currentTime,
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
    return this.queue.schedule(time, cb);
  }

  after(ms: number, cb: () => void): TimerHandle {
    return this.queue.schedule(this.currentTime + ms, cb);
  }

  cancel(handle: TimerHandle): void {
    this.queue.cancel(handle);
  }

  /** Advance the clock to `t`, firing every callback due at or before `t` in order. */
  advanceTo(t: number): void {
    if (t < this.currentTime) {
      throw new Error(`VirtualClock cannot move backwards: now=${this.currentTime}, target=${t}`);
    }
    // Set `now()` to the target before firing so callbacks observe the post-advance time,
    // then recompute reference staleness as time passes.
    this.currentTime = t;
    this.queue.fireDueBy(t);
    this.recomputeReference();
  }

  private requireOffset(ex: ExchangeId): ClockOffset {
    const offset = this.offsets.get(ex);
    if (!offset) {
      throw new Error(`VirtualClock: no calibration set for exchange "${ex}" (call setExchangeOffset first)`);
    }
    return offset;
  }
}
