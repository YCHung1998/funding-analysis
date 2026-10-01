// TODO(trading-schema-types): 合併後改為 import { ExchangeId } from 'runtime/src/types'
export type ExchangeId = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

/** Opaque handle returned by `at`/`after`, used to cancel a scheduled callback. */
export interface TimerHandle {
  readonly id: number;
}

/** Per-exchange offset/error estimate, as kept by `RealClock` (design.md Decision 2). */
export interface ClockOffset {
  /** exchangeTime = localTime + offsetMs */
  offsetMs: number;
  /** half the round-trip time of the calibration sample (or simulated error in VirtualClock) */
  errorMs: number;
  /** local time (per this Clock's `now()`) at which this offset was measured */
  calibratedAt: number;
}

/**
 * A single server-time sample used to compute an offset via the round-trip midpoint
 * (design.md Decision 2 / trading-clock spec "Offset from round-trip midpoint").
 */
export interface CalibrationSample {
  /** local time the request was sent */
  sentAt: number;
  /** server-reported time in the response */
  serverTime: number;
  /** local time the response arrived */
  receivedAt: number;
}

export type ClockEvent =
  | {
      type: 'CLOCK_REFERENCE_CHANGED';
      at: number;
      from: ExchangeId | null;
      to: ExchangeId;
    }
  | {
      type: 'CLOCK_OFFSET_JUMP';
      at: number;
      exchange: ExchangeId;
      previousOffsetMs: number;
      newOffsetMs: number;
    };

export interface ClockCalibrationConfig {
  /** `reference_clock_priority`; default ['Binance', 'Bybit', 'OKX'] */
  referenceClockPriority: ExchangeId[];
  /** `clock_calibration_max_age_ms`; default 60_000 (align with `clock_calibration_interval_ms` default) */
  calibrationMaxAgeMs: number;
  /** `clock_jump_threshold_ms`; default 100 */
  jumpThresholdMs: number;
  /** `clock_max_error_ms`; default 500 */
  maxErrorMs: number;
}

export const DEFAULT_CLOCK_CONFIG: ClockCalibrationConfig = {
  referenceClockPriority: ['Binance', 'Bybit', 'OKX'],
  calibrationMaxAgeMs: 60_000,
  jumpThresholdMs: 100,
  maxErrorMs: 500,
};

/**
 * Injectable time source (design.md Decision 2 / trading-clock spec.md).
 * `runtime/src/` code MUST obtain time and scheduling exclusively through this interface;
 * only `clock/realClock.ts` may call `Date.now()` / `setTimeout` directly.
 */
export interface Clock {
  /** Reference timeline time (epoch ms), from the current `reference()` exchange. */
  now(): number;
  /** This exchange's own clock time, in epoch ms. */
  exchangeNow(ex: ExchangeId): number;
  /** Convert a timestamp on `ex`'s clock to the equivalent local scheduling time. */
  toLocal(ex: ExchangeId, exchangeTime: number): number;
  /** Current offset/error estimate for `ex`. Throws if never calibrated. */
  offset(ex: ExchangeId): ClockOffset;
  /** The exchange currently used as the reference timeline. */
  reference(): ExchangeId;
  /** Schedule `cb` to fire when `now()` reaches `time` (reference timeline). */
  at(time: number, cb: () => void): TimerHandle;
  /** Schedule `cb` to fire `ms` from now (reference timeline). */
  after(ms: number, cb: () => void): TimerHandle;
  /** Cancel a previously scheduled callback; no-op if already fired or cancelled. */
  cancel(handle: TimerHandle): void;
  /** Whether `ex`'s calibration is fresh enough and precise enough to trade on. */
  isReliable(ex: ExchangeId): boolean;
  /** Drain and return clock events (`CLOCK_REFERENCE_CHANGED`, `CLOCK_OFFSET_JUMP`) recorded since the last drain. */
  drainEvents(): ClockEvent[];
}
