## ADDED Requirements

### Requirement: Read-only SQLite access

`server.ts` SHALL read Paper Trading data by opening the Runtime's SQLite database with
`new DatabaseSync(dbPath, { readOnly: true })`, through a dedicated `server/paperReadLayer.ts` module.
`server.ts` MUST NOT write to any table this module reads (`trades`, `trade_legs`, `orders`, `fills`,
`funding_settlements`, `account_snapshots`, `opportunities`, `trading_events`). The Runtime process
remains the sole writer (C-06).

#### Scenario: Server cannot write

- **WHEN** code using the read layer's database handle executes an `INSERT` or `UPDATE`
- **THEN** it fails with a read-only error

#### Scenario: Database not yet created

- **WHEN** the Runtime has never run and the SQLite file does not exist
- **THEN** every route in this capability returns HTTP 503 with a JSON error body, not an unhandled
  exception

### Requirement: Account snapshot endpoint

`GET /api/paper/account` SHALL return HTTP 200 with the latest `account_snapshots` row serialized as
the real `runtime/src/types/account.ts` `AccountSnapshot` shape (`snapshot_id`, `mode`,
`snapshot_time`, `total_capital_usdt`, `reserved_capital_usdt`, `available_capital_usdt`,
`used_margin_usdt`, `realized_pnl_usdt`, `open_trade_count`, `reason`, `trade_id?`, `config_version`,
`created_at`, `updated_at`) — not the superseded `paper-trading-ui/design.md` A-5 prose shape (no
`allocated_capital_usdt`/`current_positions`/`max_positions`/`snapshot_at` fields).

#### Scenario: Latest snapshot returned

- **WHEN** `account_snapshots` has rows with `created_at` 1000, 2000, 3000
- **THEN** `GET /api/paper/account` returns the row with `created_at = 3000`

#### Scenario: No snapshot yet

- **WHEN** the Runtime has started but not yet written an `INITIAL` snapshot
- **THEN** `GET /api/paper/account` returns HTTP 503

### Requirement: Current trades endpoint

`GET /api/paper/trades?scope=current` SHALL return HTTP 200 with `{ items: CurrentTradeSummary[] }`
(`src/features/paperTrading/api/contracts.ts`'s `CurrentTradeSummary` — every `Trade` field plus
`long_exchange`, `short_exchange`, `hedge_ratio`, `unrealized_pnl_usdt`, `funding_expected_usdt`),
limited to trades whose `status` is not a terminal status, ordered with alert statuses
(`LEG_IMBALANCE`, `EMERGENCY_EXIT`, `FAILED`) first and `created_at` descending within each group
(`paper-trading-ui/design.md` Decision 6), unpaginated.

#### Scenario: Alert trades sorted first

- **WHEN** three trades are current: one `HEDGED` (created_at 1000), one `LEG_IMBALANCE` (created_at
  500), one `HEDGED` (created_at 2000)
- **THEN** the response orders them `LEG_IMBALANCE` trade, then the `HEDGED` trade with created_at
  2000, then the `HEDGED` trade with created_at 1000

#### Scenario: No current trades

- **WHEN** no trade is in a non-terminal state
- **THEN** the response is `{ items: [] }` with HTTP 200

### Requirement: Completed trades endpoint with keyset pagination

`GET /api/paper/trades?scope=completed` SHALL return HTTP 200 with `{ items:
CompletedTradeSummary[]; next_cursor: string | null }`, sorted by `finalized_at ?? updated_at`
descending with `trade_id` as a tie-breaker, default `limit = 50` (query param `limit` overrides).
An optional `final_status` query param (one of `PROFIT | LOSS | BREAK_EVEN | ABORTED | FAILED |
EMERGENCY_EXIT`) filters by `TradeResult.final_status`. An optional opaque `cursor` query param (from
a prior response's `next_cursor`) resumes after that row via a keyset predicate on `(sort_key,
trade_id)` — not `LIMIT/OFFSET` — so that trades the Runtime finalizes while a client is mid-pagination
cannot cause the client to skip or duplicate rows already seen or not yet seen. `next_cursor` is `null`
on the last page. An unparseable `cursor` value SHALL return HTTP 400.

#### Scenario: First page

- **WHEN** 75 trades are completed and `GET /api/paper/trades?scope=completed&limit=50` is called with
  no cursor
- **THEN** the response has 50 items (the 50 most recently finalized) and a non-null `next_cursor`

#### Scenario: Second page via cursor

- **WHEN** the first page's `next_cursor` is passed back as `cursor`
- **THEN** the response has the remaining 25 items and `next_cursor: null`

#### Scenario: Stable under concurrent insert

- **WHEN** a client holds a cursor after page 1 (50 items) and the Runtime finalizes a new trade before
  page 2 is requested
- **THEN** page 2 still returns exactly the 25 trades that existed after the cursor's row at the time
  page 1 was fetched, unaffected by the newly inserted trade

#### Scenario: Filtered by final_status

- **WHEN** `final_status=EMERGENCY_EXIT` is passed
- **THEN** every item in the response has `result.final_status = 'EMERGENCY_EXIT'`

#### Scenario: Malformed cursor rejected

- **WHEN** `cursor=not-valid-base64` is passed
- **THEN** the response is HTTP 400, not a silently-reset-to-first-page response

### Requirement: Trade detail endpoint

`GET /api/paper/trades/:trade_id` SHALL return HTTP 200 with `TradeDetail { trade, legs, orders,
fills, funding_settlements, opportunity, result? }` (`src/features/paperTrading/api/contracts.ts`'s
`TradeDetailResponse`) for an existing `trade_id`, where `result` is present only once the trade has a
`trade_results` row (omitted while the trade is still open). An unknown `trade_id` SHALL return HTTP
404.

#### Scenario: Open trade has no result

- **WHEN** `trade_id` refers to a `HEDGED` trade
- **THEN** the response includes `trade`, `legs`, `orders`, `fills`, `funding_settlements`,
  `opportunity`, and omits `result`

#### Scenario: Closed trade includes result

- **WHEN** `trade_id` refers to a `CLOSED` trade with a `trade_results` row
- **THEN** the response includes `result` with that row's fields

#### Scenario: Unknown trade

- **WHEN** `trade_id` does not exist in `trades`
- **THEN** the response is HTTP 404

### Requirement: Per-trade event history with keyset pagination

`GET /api/paper/trades/:trade_id/events` SHALL return HTTP 200 with `{ items: Array<TradingEvent &
{ seq: number }>; next_cursor: string | null }`, filtered to events whose `trade_id` matches, ordered
by `seq` ascending (the archived `trading-event-store` design's global monotonic ordering, reused
here rather than `timestamp` — exchange clocks can tie or run slightly out of order), default `limit =
200`. An optional opaque `cursor` (from a prior `next_cursor`) resumes strictly after that `seq`. An
unparseable `cursor` SHALL return HTTP 400. An unknown `trade_id` SHALL return HTTP 404.

#### Scenario: Ascending by seq

- **WHEN** a trade has events with `seq` 10, 15, 22 (in that insertion order)
- **THEN** the response's `items` are ordered `seq` 10, 15, 22

#### Scenario: Pagination resumes after seq

- **WHEN** the first page's last item has `seq = 15` and its `next_cursor` is passed back
- **THEN** the second page's items all have `seq > 15`

#### Scenario: Unknown trade

- **WHEN** `trade_id` does not exist
- **THEN** the response is HTTP 404
