## ADDED Requirements

### Requirement: SQLite driver abstraction
The runtime SHALL access SQLite only through a `SqliteDriver` interface (`exec`, `prepare`, `transaction(fn)`, `backupTo(path)`, `close`) with a default implementation on `node:sqlite` `DatabaseSync`. `transaction(fn)` SHALL run `fn` synchronously between `BEGIN IMMEDIATE` and `COMMIT`, and SHALL `ROLLBACK` and rethrow if `fn` throws or returns a Promise. The database SHALL be opened with `journal_mode = WAL` and `foreign_keys = ON`. The Runtime process SHALL be the only writer (C-06).

#### Scenario: Rollback on error
- **WHEN** `transaction(fn)` runs `fn` that inserts a trade row and then throws
- **THEN** the trade row does not exist afterwards and the original error is rethrown

#### Scenario: Async callback refused
- **WHEN** `transaction(async () => {...})` is called
- **THEN** the transaction is rolled back and `AsyncTransactionError` is thrown

#### Scenario: Pragmas applied
- **WHEN** a database is opened by the driver
- **THEN** `PRAGMA journal_mode` returns `wal` and `PRAGMA foreign_keys` returns `1`

### Requirement: Reversible migrations
Schema changes SHALL be applied only through numbered migrations (`NNN_name`) each providing `up(db)` and `down(db)`, recorded in `schema_migrations(version, name, applied_at)`. `migrate(db, target?)` SHALL apply pending `up` migrations in ascending order, and `rollback(db, target)` SHALL apply `down` in descending order; each migration SHALL run in its own transaction. Applying `up` then `down` then `up` SHALL yield a schema identical (per `sqlite_master` SQL) to a single `up`.

#### Scenario: Round trip is lossless for schema
- **WHEN** all migrations are applied, rolled back to version 0, and applied again
- **THEN** the `sqlite_master` table/index/trigger definitions equal those after the first application

#### Scenario: Failed migration leaves previous version
- **WHEN** migration `002` throws during `up`
- **THEN** `schema_migrations` still ends at `001`, no object created by `002` exists, and startup fails with the migration name

#### Scenario: Idempotent migrate
- **WHEN** `migrate(db)` is called twice
- **THEN** the second call applies nothing and `schema_migrations` has no duplicate versions

### Requirement: Automatic backup before startup
Before any migration or write at Runtime startup, if the database file exists, the system SHALL copy it to `data/backup/<timestamp>.sqlite` where `<timestamp>` is the Clock time formatted as UTC `YYYYMMDDTHHmmssSSSZ` (tech spec §51.3). If the backup fails, the Runtime SHALL NOT migrate or open the database for writing and SHALL exit with a non-zero code. If the database file does not exist, no backup SHALL be created.

#### Scenario: Backup file created
- **WHEN** the Runtime starts at Clock time 2026-09-30T15:31:02.153Z with an existing `data/runtime.sqlite`
- **THEN** `data/backup/20260930T153102153Z.sqlite` exists and contains the same `trades` rows as the original before migration

#### Scenario: Backup failure blocks startup
- **WHEN** `data/backup/` is not writable
- **THEN** startup aborts with `BACKUP_FAILED`, no migration is applied, and the exit code is non-zero

#### Scenario: Fresh install
- **WHEN** no database file exists
- **THEN** no backup file is created and migrations create a new database

### Requirement: Tables and relationships
Migration `001_initial` SHALL create the tables of tech spec §29 — `market_events`, `funding_rates`, `opportunities`, `trades`, `trade_legs`, `orders`, `fills`, `positions`, `funding_settlements`, `risk_checks`, `trading_events`, `account_snapshots`, `pnl_snapshots` — with columns named after the `trading-schema` fields, timestamps as `INTEGER` epoch ms, rates and amounts as `REAL`, and every entity table having `created_at` and `updated_at` `NOT NULL`. Foreign keys SHALL follow tech spec §30: `trades.opportunity_id → opportunities`, `trade_legs.trade_id → trades`, `orders.leg_id → trade_legs`, `orders.trade_id → trades`, `fills.order_id → orders`, `funding_settlements.leg_id → trade_legs`, `risk_checks.trade_id → trades` (nullable), `positions.leg_id → trade_legs`. `trading_events` SHALL have no foreign keys (the log must never be rejected) and SHALL be indexed on `(trade_id, seq)`, `(event_type, timestamp)`, `order_id`.

#### Scenario: Fill without order rejected
- **WHEN** a fill row references a non-existent `order_id`
- **THEN** the insert fails with a foreign-key error

#### Scenario: Event without trade accepted
- **WHEN** an `OPPORTUNITY_REJECTED` event with `trade_id = NULL` is appended
- **THEN** it is stored

#### Scenario: Timestamps required
- **WHEN** a `trade_legs` row is inserted without `updated_at`
- **THEN** the insert fails with a NOT NULL constraint error

### Requirement: Lossless repository round trip
Repositories SHALL map each `trading-schema` entity to rows and back without loss: nested `Trade.legs` to `trade_legs` rows, `Trade.risk_status` and array fields (`entry_order_ids`, `exit_order_ids`) to JSON `TEXT`, optional fields to `NULL`, booleans to `0/1`. Reading an entity SHALL return a value deep-equal to what was written. Unfinished trades (including `ABORTED` with zero fills) SHALL never be deleted by any repository method; repositories SHALL expose no delete method for `trades`, `orders`, `fills`, `trading_events`.

#### Scenario: Trade with legs round trip
- **WHEN** a `Trade` with two legs, `risk_status` with 9 checks and `entry_order_ids = ['o1','o2']` is saved and loaded
- **THEN** the loaded value deep-equals the saved value

#### Scenario: Unfilled order persists
- **WHEN** an order ends `CANCELED` with `filled_quantity = 0` and its trade ends `ABORTED` with reason `ENTRY_TIMEOUT`
- **THEN** both rows remain queryable by id (spec §12)

### Requirement: Append-only event store
`EventStore.append(event)` SHALL validate the event (`trading-schema` validator and `assertNoCredentials` with the Runtime's known secrets), assign a monotonically increasing `seq`, set `recorded_at` from the Clock at write time (never copying `timestamp`), and insert it. Updates and deletes on `trading_events` SHALL be rejected by database triggers. An event failing validation SHALL NOT be written and SHALL raise an error.

#### Scenario: recorded_at differs from timestamp
- **WHEN** an event with `timestamp = 1_700_000_000_100` is appended while the Clock reads `1_700_000_000_140`
- **THEN** the stored row has `timestamp = 1_700_000_000_100` and `recorded_at = 1_700_000_000_140`

#### Scenario: Update blocked
- **WHEN** `UPDATE trading_events SET event_type = 'X'` is executed
- **THEN** it fails with `trading_events is append-only`

#### Scenario: Credential leak blocked
- **WHEN** an event payload contains key `api_secret`
- **THEN** `append` throws `CredentialLeakError` and the row count of `trading_events` is unchanged

#### Scenario: Monotonic sequence
- **WHEN** three events are appended
- **THEN** their `seq` values are strictly increasing

### Requirement: Replay and projection rebuild
The event store SHALL provide `replay({ trade_id?, from_seq?, to_seq? })` returning events ordered by `seq`, and `rebuildProjections(targetDb)` that reconstructs `opportunities`, `trades`, `trade_legs`, `orders`, `fills`, `positions`, `funding_settlements` and `account_snapshots` solely from `payload.after` snapshots of transition events and entity-creation events. For every trade, the rebuilt rows SHALL equal the stored projection rows.

#### Scenario: Full trade replay
- **WHEN** the tech spec §43 full-success trade (2 orders, 2 ACK, 2 fills, hedge, funding, 2 exit fills, position 0) has been recorded and `rebuildProjections` runs into an empty database
- **THEN** every rebuilt row equals the original row for that trade

#### Scenario: No-fill trade replay
- **WHEN** the tech spec §44 no-fill trade is replayed
- **THEN** the rebuilt trade is `ABORTED` with reason `ENTRY_TIMEOUT`, its order is `CANCELED` with `filled_quantity = 0`, and the replayed event types are in order `TRADE_CREATED, …, ORDER_SUBMITTED, ORDER_ACK, ORDER_TIMEOUT, ORDER_CANCEL_REQUESTED, ORDER_CANCELED, TRADE_STATUS_CHANGED`

### Requirement: Non-blocking event queue
`EventQueue.publish(event)` SHALL return synchronously without awaiting any I/O. Consumers (`DatabaseWriter`, `UiBroadcaster`, `AnalyticsWriter`) SHALL each have an independent buffer. `DatabaseWriter` SHALL flush in batches every `event_flush_interval_ms` (default 50, scheduled via Clock) or when `event_flush_batch_size` (default 100) events are pending, retrying failed batches. A slow or throwing UI or analytics consumer MUST NOT delay publishing or the database writer. Database-bound events MUST NOT be dropped: when the database buffer exceeds `event_queue_max` (default 10 000) the queue SHALL report `overflow = true` via `getStatus()` (consumed by `runtime-health`) while keeping the events; UI-bound events MAY drop the oldest entries and SHALL count drops.

#### Scenario: Publish does not wait for UI
- **WHEN** the UI broadcaster takes 2 000 ms per event and 10 events are published
- **THEN** every `publish` call returns synchronously and all 10 events are in `trading_events` after one flush interval on the virtual clock

#### Scenario: Throwing consumer isolated
- **WHEN** the analytics writer throws on every event
- **THEN** the database writer still persists all events and `getStatus().consumerErrors.analytics > 0`

#### Scenario: Overflow keeps database events
- **WHEN** the database writer is failing and 10 001 events are published with `event_queue_max = 10000`
- **THEN** `getStatus().overflow = true`, no database-bound event is discarded, and after the writer recovers all 10 001 events are stored in publish order

### Requirement: Synchronous ledger commits
Changes affecting capital or positions SHALL be committed synchronously inside the trading core, together with their events, in one transaction via `Ledger` (tech spec §35 note, §12): `reserveCapitalAndCreateTrade(trade, amount)` (inserts trade + legs, appends `AccountSnapshot{reason:'CAPITAL_RESERVED'}`, events `CAPITAL_RESERVED` and `TRADE_CREATED`), `releaseCapital(trade_id, reason)`, `applyOrderTransition(order, event)`, and `applyFill(fill, order, position, events)` (fill row + order row + position row + events). Events committed this way SHALL be passed to the UI broadcaster only (not re-written). Reservation SHALL fail with `INSUFFICIENT_CAPITAL` and write nothing when `amount > available_capital_usdt` of the latest snapshot.

#### Scenario: Reservation before fills
- **WHEN** capital is 10 000 and a trade reserves 1 000
- **THEN** the latest snapshot shows `reserved_capital_usdt = 1000`, `available_capital_usdt = 9000` before any order is filled (tech spec §12)

#### Scenario: Over-reservation refused
- **WHEN** available capital is 5 000 and a reservation of 6 000 is requested
- **THEN** it fails with `INSUFFICIENT_CAPITAL`, and no trade row, snapshot or event is written

#### Scenario: Fill and position are atomic
- **WHEN** `applyFill` fails while writing the position row
- **THEN** neither the fill row, the order update, nor the `ORDER_FILL` event exist

#### Scenario: Release returns capital
- **WHEN** a trade that reserved 1 000 is released with reason `TRADE_ABORTED`
- **THEN** a snapshot with `reason = 'CAPITAL_RELEASED'` shows `reserved_capital_usdt` reduced by 1 000 and a `CAPITAL_RELEASED` event exists

### Requirement: Traceability assertion helper
The test helpers SHALL provide `assertTraceability(db, { trade_id? })` which fails when any entity row lacks `created_at`/`updated_at`, when any entity's current status differs from the `to` of its last transition event, when a status change exists without a corresponding event, or when event `timestamp` values for one trade decrease with increasing `seq` (tech spec §42).

#### Scenario: Missing event detected
- **WHEN** an order row is updated to `CANCELED` without an `ORDER_CANCELED` event
- **THEN** `assertTraceability` fails naming the order id and missing transition

#### Scenario: Clean trade passes
- **WHEN** a trade was recorded only through `Ledger` and `EventStore`
- **THEN** `assertTraceability` passes
