## ADDED Requirements

### Requirement: Runtime health model
The Runtime SHALL maintain a `RuntimeHealth` snapshot with components and allowed values: `engine: STARTING | RUNNING | STOPPING | STOPPED | ERROR` (with `startup_step` while STARTING); `exchanges: Record<ExchangeId, CONNECTED | DEGRADED | DISCONNECTED>` for every exchange in `scan_exchanges`; `market_data: HEALTHY | STALE | DOWN`; `scanner: RUNNING | STOPPED | ERROR`; `risk: ARMED | DISARMED | HALTED`; `paper_execution: ARMED | DISARMED | ERROR`; `database: HEALTHY | DEGRADED | DOWN`; `clock: SYNCED | UNRELIABLE`; `credentials: PRESENT | MISSING | INVALID`; `last_event: { timestamp, event_type, age_ms } | null`; plus `entry_allowed: boolean`, `entry_block_reasons: string[]`, `config_version` and `updated_at` (tech spec §32, §52). Derivation rules SHALL be: `market_data = STALE` when any trading exchange's data age exceeds `data_stale_threshold_ms`, `DOWN` when a trading exchange is `DISCONNECTED`; `database = DEGRADED` when the event queue reports `overflow` or the writer's last flush failed; `clock = UNRELIABLE` when `trading-clock` reports `CLOCK_UNRELIABLE` for any trading exchange; `risk = HALTED` when `EntryHaltPort.isHalted()`. `entry_allowed` SHALL be `true` only when `engine = RUNNING`, `risk = ARMED`, `paper_execution = ARMED`, `market_data = HEALTHY`, `database = HEALTHY`, `clock = SYNCED` and every trading exchange is `CONNECTED`; otherwise each failing condition SHALL appear in `entry_block_reasons`.

#### Scenario: All healthy
- **WHEN** all components report healthy values after ARM
- **THEN** `entry_allowed = true` and `entry_block_reasons = []`

#### Scenario: Stale Bybit data
- **WHEN** Bybit's data age is 3 000 ms with `data_stale_threshold_ms = 2000`
- **THEN** `market_data = 'STALE'`, `entry_allowed = false`, and `entry_block_reasons` contains `MARKET_DATA_STALE`

#### Scenario: Reconciliation halt reflected
- **WHEN** `EntryHaltPort.isHalted()` becomes `true`
- **THEN** `risk = 'HALTED'` and `entry_block_reasons` contains `ENTRY_HALTED`

#### Scenario: Scan-only exchange does not block entry
- **WHEN** Pionex (scan-only) is `DISCONNECTED` while Binance and Bybit are `CONNECTED`
- **THEN** `exchanges.Pionex = 'DISCONNECTED'` and `entry_allowed` is unaffected

### Requirement: Health published through SQLite for read-only server access
The Runtime SHALL upsert the snapshot into table `runtime_health` (single row `id = 1`, JSON `snapshot`, `created_at`, `updated_at`), created by reversible migration `002_runtime_health` together with `reconciliation_runs`, every `health_publish_interval_ms` (default 1 000, via `Clock`) and immediately on any component change. `server.ts` SHALL open the database with `readOnly: true` and expose `GET /api/runtime/health` returning the snapshot and `GET /api/runtime/reconciliation/latest` returning the latest `reconciliation_runs` row with its mismatches. When `updated_at` is older than `3 × health_publish_interval_ms`, or the database or table is missing, the health endpoint SHALL return HTTP 200 with `engine = 'UNREACHABLE'` and `entry_allowed = false`. `server.ts` MUST NOT write to the database.

#### Scenario: Health endpoint returns snapshot
- **WHEN** the Runtime published a snapshot 500 ms ago and `GET /api/runtime/health` is called
- **THEN** the response contains `engine`, `exchanges.Binance`, `exchanges.Bybit`, `market_data`, `scanner`, `risk`, `paper_execution`, `database`, `clock`, `credentials`, `last_event`, `entry_allowed`

#### Scenario: Runtime down
- **WHEN** the last snapshot is 5 000 ms old with the default interval
- **THEN** the endpoint returns `engine = 'UNREACHABLE'` and `entry_allowed = false`

#### Scenario: Server cannot write
- **WHEN** code using the server's database handle executes an `INSERT`
- **THEN** it fails with a read-only error

#### Scenario: No credentials in responses
- **WHEN** `.env.local` contains `BYBIT_API_KEY = 'k-abc123'` and both endpoints are called
- **THEN** neither response body contains `k-abc123` or any key named like `api_key`/`secret`, only `credentials = 'PRESENT'`

#### Scenario: Migration reversible
- **WHEN** migration `002_runtime_health` is applied and rolled back
- **THEN** `runtime_health` and `reconciliation_runs` no longer exist and the schema equals the `001` schema

### Requirement: Startup sequence
`runtime/src/main.ts` SHALL execute, in order: (1) load and validate config (`config_version`); (2) back up and migrate the database (`event-store`); (3) load credentials from `.env.local` and verify permissions via read-only endpoints; (4) connect exchanges and calibrate clocks; (5) validate market data freshness for trading exchanges; (6) load the latest account snapshot, creating an `INITIAL` snapshot from `initial_capital_usdt` if none exists; (7) recover existing paper trades and positions from the event store; (8) run reconciliation; (9) start market data; (10) start scanner; (11) start risk engine; (12) ARM paper execution. Each step SHALL emit `RUNTIME_STARTUP_STEP` (`step`, `name`, `status`, `duration_ms`) and update `engine.startup_step`. Failure modes: invalid config or backup/migration failure → exit with non-zero code before any trading; any key with withdraw permission → refuse to start (`CREDENTIALS_WITHDRAW_ENABLED`); missing keys → continue in public-data mode with `credentials = 'MISSING'` and fees marked estimated (tech spec §52); market data not fresh within `startup_market_data_timeout_ms` (default 30 000) or reconciliation mismatch → keep running with `paper_execution = 'DISARMED'` and emit `RUNTIME_DISARMED`; successful step 12 → emit `RUNTIME_ARMED`.

#### Scenario: Steps in order
- **WHEN** the Runtime starts with valid config, fresh fake market data and no existing database
- **THEN** 12 `RUNTIME_STARTUP_STEP` events are recorded in order 1…12 and `RUNTIME_ARMED` follows

#### Scenario: Withdraw permission refuses start
- **WHEN** the read-only permission check reports withdraw enabled for the Binance key
- **THEN** startup stops at step 3 with `CREDENTIALS_WITHDRAW_ENABLED`, the process exits non-zero, and the error message contains no key value

#### Scenario: Missing credentials
- **WHEN** `.env.local` has no Bybit keys
- **THEN** startup continues, `credentials = 'MISSING'`, and the Runtime can still ARM

#### Scenario: Reconciliation failure at startup
- **WHEN** step 8 finds a mismatch
- **THEN** the Runtime keeps running with `paper_execution = 'DISARMED'`, `RUNTIME_DISARMED` is emitted, and no new trade can be created

### Requirement: Recovery after restart
At step 7 the Runtime SHALL rebuild state from the event store: rebuild projections with `rebuildProjections` into memory and compare them with stored rows (difference → reconciliation mismatch `PROJECTION_EVENT`); close every non-terminal paper order through allowed transitions with `payload.reason = 'RUNTIME_RESTART'`, because the simulated exchange state does not survive a restart (`SUBMITTED → REJECTED` with `rejection_reason = 'RUNTIME_RESTART'`; `ACKNOWLEDGED | PARTIALLY_FILLED → CANCEL_REQUESTED → CANCELED`; `CANCEL_REQUESTED → CANCELED`; a persisted `CREATED` order SHALL be reported as reconciliation mismatch `ORDER_ORPHAN_CREATED`, since `paper-execution` commits `CREATED → SUBMITTED` atomically); move trades that were `ENTRY_PENDING`, `PARTIALLY_HEDGED`, `LEG_IMBALANCE` or `EMERGENCY_EXIT` to `FAILED` with reason `RUNTIME_RESTART_RECOVERY` and request an entry halt; hand `HEDGED` and `EXIT_PENDING` trades to `settlement-session` for rescheduling (exit immediately if their `exit_at` has passed). Recovery MUST NOT create entry orders.

#### Scenario: Orphan order on restart
- **WHEN** the Runtime restarts while an entry order is `ACKNOWLEDGED`
- **THEN** after startup the order is `CANCELED` via `CANCEL_REQUESTED`, `ORDER_CANCEL_REQUESTED` and `ORDER_CANCELED` events with `payload.reason = 'RUNTIME_RESTART'` exist, and its fills and `filled_quantity` are preserved

#### Scenario: Submitted order on restart
- **WHEN** the Runtime restarts while an order is `SUBMITTED`
- **THEN** the order becomes `REJECTED` with `rejection_reason = 'RUNTIME_RESTART'`

#### Scenario: Mid-entry trade fails safe
- **WHEN** the Runtime restarts while a trade is `PARTIALLY_HEDGED`
- **THEN** the trade becomes `FAILED` with reason `RUNTIME_RESTART_RECOVERY`, `ENTRY_HALT_REQUESTED` is emitted, and no order is created

#### Scenario: Hedged trade resumes
- **WHEN** the Runtime restarts while a trade is `HEDGED` and its `exit_at` is 20 s in the future
- **THEN** the trade stays `HEDGED` and is registered with the session manager to exit at `exit_at`

#### Scenario: Browser and server restarts do not affect runtime
- **WHEN** `server.ts` is restarted while the Runtime holds a `HEDGED` trade
- **THEN** the Runtime's trade status and scheduled exit are unchanged and the health endpoint resumes returning the current snapshot
