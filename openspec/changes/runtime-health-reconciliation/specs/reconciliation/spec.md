## ADDED Requirements

### Requirement: Periodic reconciliation schedule
The system SHALL run a reconciliation pass every `reconciliation_interval_ms` (default 5 000) scheduled via `Clock`, plus once during startup before ARM and once after each trade reaches a terminal status. Each pass SHALL read all data inside one read transaction (consistent snapshot) and SHALL be recorded in `reconciliation_runs` (`run_id`, `started_at`, `finished_at`, `status: 'PASS' | 'MISMATCH' | 'ERROR'`, `mismatch_count`, `created_at`, `updated_at`).

#### Scenario: Scheduled passes
- **WHEN** the virtual clock advances 15 000 ms after ARM with the default interval
- **THEN** exactly 3 periodic passes are recorded in `reconciliation_runs`

#### Scenario: Clean state passes
- **WHEN** a pass runs after the tech spec §43 full-success trade
- **THEN** the run is `PASS` with `mismatch_count = 0` and no `RECONCILIATION_ERROR` event exists

### Requirement: Order and fill consistency checks
Each pass SHALL verify for every order: `filled_quantity = Σ fills.quantity` and `average_fill_price = Σ(q × p) / Σ q` (relative tolerance 1e-9), `remaining_quantity = requested_quantity − filled_quantity`; `FILLED ⇒ |filled_quantity − requested_quantity| ≤ reconciliation_qty_epsilon`; `CREATED | SUBMITTED | ACKNOWLEDGED ⇒ filled_quantity = 0`; terminal states ⇒ `terminal_time` set. Each violation SHALL produce a mismatch with check id `ORDER_FILL_SUM`, `ORDER_AVG_PRICE`, `ORDER_REMAINING`, `ORDER_STATE_QTY` or `ORDER_TERMINAL_TIME`.

#### Scenario: Missing fill detected
- **WHEN** an order records `filled_quantity = 1000` but its fills sum to 900
- **THEN** a mismatch `ORDER_FILL_SUM` with `expected = 900`, `actual = 1000` is produced

#### Scenario: Acknowledged order with fills
- **WHEN** an order is `ACKNOWLEDGED` with `filled_quantity = 5`
- **THEN** a mismatch `ORDER_STATE_QTY` is produced

### Requirement: Position and trade consistency checks
Each pass SHALL verify for every leg that the open position quantity in `positions` equals Σ ENTRY fill quantity − Σ EXIT/EMERGENCY_CLOSE fill quantity (tolerance `reconciliation_qty_epsilon`, default 1e-9) (tech spec §31), that trades in `CLOSED` or `ABORTED` have zero open quantity on every leg, and that `HEDGED` trades have non-zero open quantity on both legs. It SHALL also verify that each trade, leg, order and funding settlement's current status equals the `to` of its last transition event (check `PROJECTION_EVENT`).

#### Scenario: Tech spec §31 example
- **WHEN** a leg's orders say 1 000 filled and its position says 900
- **THEN** a mismatch `POSITION_FILL_NET` with `expected = 1000`, `actual = 900` is produced for that leg and trade

#### Scenario: Closed trade with residual position
- **WHEN** a `CLOSED` trade has a leg with open quantity 2
- **THEN** a mismatch `TRADE_CLOSED_NOT_FLAT` is produced

#### Scenario: Projection differs from events
- **WHEN** an order row is `CANCELED` but its last transition event's `to` is `ACKNOWLEDGED`
- **THEN** a mismatch `PROJECTION_EVENT` is produced

### Requirement: Capital consistency and reservation atomicity
Each pass SHALL verify that the latest `AccountSnapshot.reserved_capital_usdt` equals Σ `allocated_capital_usdt` of trades not in `CLOSED` or `ABORTED` (tolerance `reconciliation_usdt_epsilon`, default 1e-6), that `available_capital_usdt = total_capital_usdt − reserved_capital_usdt ≥ 0`, that every trade has exactly one `CAPITAL_RESERVED` event with its `allocated_capital_usdt`, and that every `CLOSED`/`ABORTED` trade has exactly one `CAPITAL_RELEASED` event. Tests SHALL demonstrate that `Ledger.reserveCapitalAndCreateTrade` never over-reserves and never leaves partial writes (tech spec §12).

#### Scenario: Sequential reservations cannot exceed capital
- **WHEN** total capital is 10 000 and two trades each request 6 000 back to back
- **THEN** the first succeeds, the second fails with `INSUFFICIENT_CAPITAL`, and the next pass is `PASS`

#### Scenario: Crash inside reservation
- **WHEN** a fault is injected after the trade row insert but before the snapshot insert
- **THEN** neither row nor any event exists and the next pass is `PASS`

#### Scenario: Reserved capital drift detected
- **WHEN** the latest snapshot says reserved 2 000 while open trades allocate 1 000
- **THEN** a mismatch `CAPITAL_RESERVED_SUM` is produced with no specific trade

### Requirement: Mismatch handling
For each new mismatch the system SHALL append a `RECONCILIATION_ERROR` event (payload `check_id`, `entity_type`, `entity_id`, `expected`, `actual`, `run_id`; `trade_id` set when the mismatch belongs to a trade, otherwise `null`), transition the affected non-terminal trade to `FAILED` with reason `RECONCILIATION_ERROR` (spec §26.2), and call `EntryHaltPort.requestHalt({ source: 'RECONCILIATION', reason: check_id, trade_ids })` which emits `ENTRY_HALT_REQUESTED`. The same `(check_id, entity_id)` mismatch SHALL NOT produce another event while it persists. Reconciliation MUST NOT cancel orders or close positions (C-16 undecided).

#### Scenario: Error halts new entries
- **WHEN** a `POSITION_FILL_NET` mismatch is found on a `HEDGED` trade
- **THEN** a `RECONCILIATION_ERROR` event exists, the trade is `FAILED`, `EntryHaltPort.isHalted()` returns `true`, and Pre-Trade checks querying it block new trades with `ENTRY_HALTED`

#### Scenario: No duplicate events
- **WHEN** the same mismatch persists across three consecutive passes
- **THEN** exactly one `RECONCILIATION_ERROR` event exists for it and each run records `status = 'MISMATCH'`

#### Scenario: No automatic flattening
- **WHEN** a trade becomes `FAILED` due to reconciliation while holding positions
- **THEN** no cancel request and no EXIT or EMERGENCY_CLOSE order is created by reconciliation

### Requirement: Entry halt port
The system SHALL define `EntryHaltPort` with `requestHalt(request)`, `isHalted(): boolean` and `reasons(): HaltRequest[]`, and provide a default `EntryHaltLatch` implementation used until `risk-engine-kill-switch` supplies its own. The latch SHALL persist across restarts (restored from `ENTRY_HALT_REQUESTED` events) and SHALL only be cleared by an explicit operator action recorded as an `ENTRY_HALT_CLEARED` event; automatic clearing MUST NOT occur.

#### Scenario: Halt survives restart
- **WHEN** the Runtime restarts after an `ENTRY_HALT_REQUESTED` event with no clearing event
- **THEN** `isHalted()` returns `true` after startup and the Runtime does not ARM new entries
