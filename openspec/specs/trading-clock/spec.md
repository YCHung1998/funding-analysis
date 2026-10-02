# trading-clock Specification

## Purpose
可注入的時鐘（Clock / VirtualClock / RealClock）：每所各自的 offset 與誤差、參考時間軸選擇、決策截止時間以每腿自己的交易所時鐘換算並取保守值、時鐘不可靠時阻擋進場。由 change `paper-trading-event-loop`（2026-10-01）建立。

## Requirements
### Requirement: Injectable clock is the only time source
Runtime modules SHALL obtain the current time and schedule callbacks exclusively through a `Clock` interface (`now`, `at`, `after`, `cancel`, `offsetMs`). Code under `runtime/src/` other than the real clock implementation MUST NOT call `Date.now()`, `new Date()` without arguments, `setTimeout`, or `setInterval` directly.

#### Scenario: Direct system-time access is detected
- **WHEN** a source file under `runtime/src/` (excluding the RealClock implementation and tests) contains `Date.now(` or `setTimeout(`
- **THEN** the automated check fails and names the offending file

### Requirement: Virtual clock supports deterministic replay
The system SHALL provide a `VirtualClock` whose time only advances through `advanceTo(t)`, firing every scheduled callback with a due time ≤ t in ascending due-time order; callbacks with identical due times SHALL fire in registration order.

#### Scenario: Callbacks fire in time order
- **WHEN** callbacks are scheduled at t=300, t=100 and t=200 and the clock advances to t=300
- **THEN** they fire in the order 100, 200, 300 and `now()` returns 300 inside the last callback

#### Scenario: Same due time keeps registration order
- **WHEN** callback A then callback B are both scheduled at t=100 and the clock advances to t=100
- **THEN** A fires before B

#### Scenario: Cancelled callback does not fire
- **WHEN** a callback scheduled at t=100 is cancelled and the clock advances to t=200
- **THEN** the callback is not invoked

### Requirement: Per-exchange clock calibration
The `RealClock` SHALL keep a separate offset and error bound for every connected exchange, estimated from that exchange's server-time endpoint using the round-trip midpoint (`errorMs = RTT / 2`), on top of a local monotonic time source. It SHALL expose `exchangeNow(ex)`, `toLocal(ex, t)` and `offset(ex)`.

#### Scenario: Offset from round-trip midpoint
- **WHEN** a Bybit server-time request is sent at local 1000, the server reports 1100, and the response arrives at local 1040
- **THEN** Bybit's offset is 1100 − 1020 = 80 ms with error 20 ms, and `exchangeNow('Bybit')` at local 2000 returns 2080

#### Scenario: Offsets are independent per exchange
- **WHEN** Binance's offset is +60 ms and Bybit's is −30 ms
- **THEN** `toLocal('Binance', X) = X − 60` and `toLocal('Bybit', X) = X + 30`

### Requirement: Reference timeline with fallback
`now()` SHALL return time on a reference timeline taken from the first healthy exchange in `reference_clock_priority` (default `['Binance', 'Bybit', 'OKX']`). When the reference exchange's calibration is older than `clock_calibration_max_age_ms` or it is disconnected, the next exchange SHALL become the reference and a `CLOCK_REFERENCE_CHANGED` event SHALL be emitted. Every trading event SHALL record `clock_reference` and `clock_offset_ms`.

#### Scenario: Binance is the default reference
- **WHEN** Binance and Bybit are both calibrated and healthy
- **THEN** `reference()` returns `'Binance'`

#### Scenario: Fallback when Binance is unavailable
- **WHEN** Binance's calibration has expired and Bybit is healthy
- **THEN** `reference()` returns `'Bybit'` and a `CLOCK_REFERENCE_CHANGED` event is recorded

### Requirement: Decisions use each leg's own exchange clock
Deadlines that determine funding eligibility SHALL be computed per leg on that leg's exchange clock, converted to local time with that leg's offset, widened by that leg's error bound, and combined conservatively for the pair (earliest for "before T" deadlines, latest for "after T" deadlines). This SHALL hold whether or not the pair includes the reference exchange.

#### Scenario: Pair without the reference exchange
- **WHEN** a Bybit (offset −30 ms, error 10 ms, guard 5 s) × OKX (offset +40 ms, error 20 ms, guard after 60 s) pair is scheduled while Binance is the reference
- **THEN** `lock_end` equals `max(toLocal('Bybit', T+5000) + 10, toLocal('OKX', T+60000) + 20)` and no Binance offset is used

### Requirement: Unreliable clock blocks new entries
The system SHALL emit `CLOCK_OFFSET_JUMP` when an exchange offset changes by more than `clock_jump_threshold_ms` between calibrations, SHALL force recalibration at the start of SHORTLIST and ARM, and SHALL block new entries with `CLOCK_UNRELIABLE` when any trading leg's `errorMs` exceeds `clock_max_error_ms` or its calibration has expired.

#### Scenario: Large error blocks entry
- **WHEN** Bybit's error bound is 800 ms and `clock_max_error_ms = 500`
- **THEN** opportunities with a Bybit leg are rejected at ARM with `CLOCK_UNRELIABLE`

#### Scenario: Offset jump recorded
- **WHEN** Binance's offset changes from +60 ms to +300 ms with `clock_jump_threshold_ms = 100`
- **THEN** a `CLOCK_OFFSET_JUMP` event with both values is recorded

