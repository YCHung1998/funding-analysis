## ADDED Requirements

### Requirement: One settlement session per funding time
The system SHALL create one `SettlementSession` for each upcoming funding time T that has at least one eligible candidate pair, and SHALL drive it through the phases `WATCH → SHORTLIST → ARM → ENTRY → LOCK → CONFIRM → DONE` (or `SKIPPED`) using clock-scheduled events only. Every phase transition MUST emit a `SESSION_PHASE_CHANGED` trading event with `from`, `to`, `reason` and timestamp.

#### Scenario: Phases advance on the virtual clock
- **WHEN** a session for T is created with default config and the virtual clock advances from T−31m to T+31s
- **THEN** the session passes WATCH, SHORTLIST, ARM, ENTRY, LOCK, CONFIRM in that order and one `SESSION_PHASE_CHANGED` event is recorded per transition

#### Scenario: Session skipped when nothing qualifies
- **WHEN** at `arm_at` no opportunity in the session is still valid
- **THEN** the session transitions to `SKIPPED` with reason `NO_VALID_OPPORTUNITY` and no trade is created

### Requirement: Phase timetable derived from config and venue rules
Phase times SHALL be computed as: `watch_start = T − watch_lead_ms`, `shortlist_at = T − shortlist_lead_ms`, `arm_at = T − arm_lead_ms`, `entry_open = T − entry_open_lead_ms`, `entry_deadline = T − pair_guard_before − partial_hedge_max_duration_ms − entry_buffer_ms`, `hedged_by = T − pair_guard_before`, `lock_end = T + pair_guard_after`, `exit_at = T + pair_guard_after + exit_buffer_ms`, where `pair_guard_before/after` are the maxima of both legs' venue uncertainty windows. When converted to local scheduling time, each leg's deadline SHALL be converted with that leg's own exchange clock and error bound, taking the earliest value for deadlines before T and the latest value for deadlines after T (trading-clock: Decisions use each leg's own exchange clock). Defaults SHALL be 30 min, 5 min, 60 s, 45 s, entry buffer 5 s, partial hedge 5 s, exit buffer 15 s.

#### Scenario: Binance × Bybit defaults
- **WHEN** the timetable is computed for a Binance (15 s / 15 s) × Bybit (5 s / 5 s) pair with default config
- **THEN** `entry_deadline = T−25s`, `hedged_by = T−15s`, `lock_end = T+15s`, `exit_at = T+30s`

#### Scenario: Wider venue window propagates
- **WHEN** one leg's venue window is 0 s before / 60 s after and the other is 15 s / 15 s
- **THEN** `pair_guard_after = 60 s` and `exit_at = T+75s`

#### Scenario: Invalid config rejected
- **WHEN** config yields `entry_deadline ≤ entry_open` or `entry_open ≥ arm_at`
- **THEN** config validation fails at startup with a message naming the conflicting fields

### Requirement: Contract eligibility for a session
A candidate pair SHALL be eligible only if both exchanges are in `trading_exchanges`, both legs' next funding times are within `funding_alignment_tolerance_ms` of T, and both legs' funding intervals are ≥ 2 hours. Eligibility SHALL be re-evaluated at SHORTLIST and at ARM using freshly read intervals and funding times.

#### Scenario: One-hour contract excluded
- **WHEN** a pair has one leg with a 1-hour funding interval
- **THEN** it is not eligible and the opportunity is rejected with `FUNDING_INTERVAL_TOO_SHORT`

#### Scenario: Interval switches to hourly before ARM
- **WHEN** a pair eligible at SHORTLIST reports a 1-hour interval on one leg at ARM
- **THEN** the opportunity is rejected with `FUNDING_INTERVAL_TOO_SHORT` and no capital is reserved

#### Scenario: Misaligned settlement excluded
- **WHEN** the two legs' next funding times differ by more than `funding_alignment_tolerance_ms`
- **THEN** the pair is rejected with `FUNDING_NOT_ALIGNED`

#### Scenario: Non-trading exchange excluded
- **WHEN** one leg is on an exchange not listed in `trading_exchanges`
- **THEN** the opportunity is recorded and rejected with `EXCHANGE_NOT_TRADABLE`

### Requirement: Single-settlement only
Each trade created by a session SHALL target exactly one funding time T; the session MUST NOT carry a position into another session, and exit SHALL be scheduled at `exit_at` of the same session.

#### Scenario: No roll to next settlement
- **WHEN** a trade is HEDGED through T and the next funding time's predicted spread is still positive
- **THEN** exit is still triggered at `exit_at` of the current session

### Requirement: Position limits across sessions
The system SHALL enforce a global maximum of concurrently open trades (`max_positions`) and an optional per-session maximum (`max_positions_per_session`); an opportunity that would exceed either limit SHALL be rejected with `MAX_POSITIONS`.

#### Scenario: Global limit reached
- **WHEN** `max_positions` trades are open and a new session reaches ARM with a valid opportunity
- **THEN** the opportunity is rejected with `MAX_POSITIONS`
