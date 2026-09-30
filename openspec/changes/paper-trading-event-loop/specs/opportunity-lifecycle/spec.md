## ADDED Requirements

### Requirement: Opportunity invalidation replaces fixed TTL
An opportunity SHALL remain valid only while all of the following hold; otherwise it SHALL transition to `EXPIRED` (conditions 1, 4) or `REJECTED` (conditions 2, 3, 5) with a recorded reason:
1. its session has not moved past the phase in which it was evaluated;
2. no leg's funding rate has changed by more than `rate_change_tolerance` and the price difference has not changed by more than `price_change_tolerance_pct` since evaluation, and available depth still covers the target quantity;
3. every input's `data_age_ms` ≤ `data_stale_threshold_ms`;
4. `now − detected_at` ≤ `opportunity_max_age_ms`;
5. contract eligibility (settlement-session) still holds.

#### Scenario: Phase change forces re-evaluation
- **WHEN** an opportunity evaluated during SHORTLIST is not re-evaluated when the session enters ARM
- **THEN** it becomes `EXPIRED` with reason `PHASE_CHANGED`

#### Scenario: Funding rate moves beyond tolerance
- **WHEN** `rate_change_tolerance = 0.0002` and one leg's rate changes from 0.0010 to 0.0007 after evaluation
- **THEN** the opportunity becomes `REJECTED` with reason `INPUT_CHANGED`

#### Scenario: Small change keeps opportunity valid
- **WHEN** `rate_change_tolerance = 0.0002` and one leg's rate changes from 0.0010 to 0.0009
- **THEN** the opportunity stays valid

#### Scenario: Stale data
- **WHEN** a leg's latest market data is older than `data_stale_threshold_ms`
- **THEN** the opportunity becomes `REJECTED` with reason `STALE_MARKET_DATA`

#### Scenario: Maximum age exceeded
- **WHEN** `now − detected_at` exceeds `opportunity_max_age_ms`
- **THEN** the opportunity becomes `EXPIRED` with reason `MAX_AGE`

### Requirement: ARM is the final entry decision point
At `arm_at` the system SHALL re-read both legs' predicted funding rates, intervals and funding times, recompute expected net PnL, and only then allow the opportunity to become `SELECTED`; an opportunity whose spread direction flipped or whose net PnL fell below `minimum_expected_net_pnl_usdt` SHALL be rejected.

#### Scenario: Spread flips at ARM
- **WHEN** at ARM the recomputed spread has the opposite sign of the evaluated spread
- **THEN** the opportunity is rejected with reason `SPREAD_FLIPPED`

#### Scenario: Net PnL below threshold at ARM
- **WHEN** at ARM the recomputed expected net PnL is below `minimum_expected_net_pnl_usdt`
- **THEN** the opportunity is rejected with reason `BELOW_MIN_NET_PNL`

### Requirement: Every opportunity state change is recorded
Every opportunity status transition SHALL emit a trading event (`OPPORTUNITY_DETECTED`, `OPPORTUNITY_QUALIFIED`, `OPPORTUNITY_SELECTED`, `OPPORTUNITY_REJECTED`, `OPPORTUNITY_EXPIRED`) with timestamp and reason, including opportunities that are never traded.

#### Scenario: Rejected opportunity remains queryable
- **WHEN** an opportunity is rejected with `EXCHANGE_NOT_TRADABLE`
- **THEN** an `OPPORTUNITY_REJECTED` event with that reason and its `detected_at` exist in the event store
