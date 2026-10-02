## ADDED Requirements

### Requirement: Venue settlement rules provided by adapters
Each exchange adapter SHALL provide a venue rule containing `guard_before_ms`, `guard_after_ms`, the public settled-rate source, and the funding-interval source. Strategy and session code MUST NOT branch on exchange names. Initial values SHALL be Binance 15 000 / 15 000 ms and Bybit 5 000 / 5 000 ms; OKX (future) 0 / 60 000 ms.

#### Scenario: Pair guard uses the wider venue
- **WHEN** a Binance × Bybit pair requests its guards
- **THEN** `pair_guard_before = 15 000 ms` and `pair_guard_after = 15 000 ms`

### Requirement: Entry must be hedged before the uncertainty window
New entry orders MUST NOT be submitted after `entry_deadline`. If a trade is not `HEDGED` at `hedged_by`, it SHALL transition to `LEG_IMBALANCE` and the emergency procedure (spec §15) SHALL start immediately.

#### Scenario: Late entry blocked
- **WHEN** the execution layer requests a new entry order at `entry_deadline + 1 ms`
- **THEN** the request is refused with reason `ENTRY_DEADLINE_PASSED`

#### Scenario: Not hedged at hedged_by
- **WHEN** a trade is `PARTIALLY_HEDGED` at `hedged_by`
- **THEN** it transitions to `LEG_IMBALANCE` with reason `NOT_HEDGED_BEFORE_WINDOW`

### Requirement: No position reduction inside the lock window
Between `hedged_by` and `lock_end`, the system MUST NOT submit exit or reduce-only orders for a `HEDGED` trade, except through the emergency procedure; any such emergency reduction SHALL mark the affected leg's funding settlement `NOT_ELIGIBLE`.

#### Scenario: Normal exit blocked during lock
- **WHEN** a normal exit is requested for a HEDGED trade at T+5s with `lock_end = T+15s`
- **THEN** the request is refused with reason `LOCK_WINDOW`

#### Scenario: Emergency reduction during lock
- **WHEN** a leg is emergency-closed at T+3s
- **THEN** that leg's funding settlement becomes `NOT_ELIGIBLE`

### Requirement: Exit at exit_at without waiting for confirmation
At `exit_at` the system SHALL submit close orders for every `HEDGED` trade of the session regardless of whether the settled funding rate has been published.

#### Scenario: Exit fires before settlement is published
- **WHEN** the clock reaches `exit_at = T+30s` and no settled rate for T has been published yet
- **THEN** close orders are submitted for both legs at T+30s

### Requirement: Funding settlement is inferred from public settled rates
Each leg's `FundingSettlement` SHALL progress `EXPECTED` (created at ARM) → `ELIGIBLE` (at `lock_end`, if the leg was continuously held through `[hedged_by, lock_end]`) → `SETTLED` (when the public source returns a record with funding time T). The settled cashflow SHALL equal mark price at T × position quantity × settled rate, signed by position side (positive rate: LONG pays, SHORT receives). If no settled record is found within `settlement_confirm_timeout_ms` (default 600 000 ms) the status SHALL become `MISSED`. Every settlement SHALL record `settled_rate_published_at − T`.

#### Scenario: Settled after exit
- **WHEN** a SHORT leg of 10 units was held through the lock window, is closed at T+30s, and the settled record (rate 0.0010, mark price 100) appears at T+45s
- **THEN** the settlement becomes `SETTLED` with cashflow +1.0 USDT and publication delay 45 000 ms

#### Scenario: Not held through window
- **WHEN** a leg was flat at any time within `[hedged_by, lock_end]`
- **THEN** its settlement becomes `NOT_ELIGIBLE` with cashflow 0

#### Scenario: Confirmation timeout
- **WHEN** no settled record for T is found by `T + settlement_confirm_timeout_ms`
- **THEN** the settlement becomes `MISSED` and a trading event flags it for manual review

#### Scenario: Missing mark price uses snapshot as estimate
- **WHEN** the settled-rate source has no mark price and the market-state snapshot at T is used
- **THEN** the settlement is `SETTLED` and marked `mark_price_source = 'SNAPSHOT'`

### Requirement: PnL finalization after both legs settle
A trade SHALL become `CLOSED` when both legs are flat, with `TradeResult.funding_confirmed = false`; `finalized_at` SHALL be set only after every leg's settlement is `SETTLED`, `NOT_ELIGIBLE`, or `MISSED` (the last requiring a manual-review flag).

#### Scenario: Closed but pending funding
- **WHEN** both legs are flat at T+31s and neither settlement is SETTLED yet
- **THEN** the trade is `CLOSED`, `funding_confirmed = false`, and `finalized_at` is empty

#### Scenario: Finalized when both settled
- **WHEN** the second leg's settlement becomes SETTLED
- **THEN** `funding_confirmed = true`, `net_pnl_usdt` includes both funding cashflows, and `finalized_at` is set

#### Scenario: NOT_ELIGIBLE counts as confirmed, MISSED does not
- **WHEN** both legs reach a terminal settlement status and one is `SETTLED` while the other is `NOT_ELIGIBLE` (definitively no funding for that leg)
- **THEN** `funding_confirmed = true` and `finalized_at` is set
- **WHEN** any leg is `MISSED` (settled rate never found)
- **THEN** `funding_confirmed = false`, `finalized_at` is set, and the trade is flagged for manual review
