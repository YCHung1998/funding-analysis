## Why

`src/features/paperTrading/` (change `paper-trading-ui`, already merged) and its design doc
(`openspec/changes/paper-trading-ui/design.md`, contract table assumptions A-5–A-8) already call a
REST surface that nothing implements:

- `GET /api/paper/account` (A-5)
- `GET /api/paper/trades?scope=current` and `?scope=completed&final_status=&cursor=&limit=50` (A-6)
- `GET /api/paper/trades/:trade_id` (A-7)
- `GET /api/paper/trades/:trade_id/events?cursor=&limit=200` (A-8)

`src/features/paperTrading/api/paperApi.ts` issues these requests today; with no server route they
404. The UI currently only works against `VITE_PAPER_DATA_SOURCE=mock` (`assets/HANDOFF.md`,
2026-10-01 wave-1b entry: "後端（Paper 唯讀 API、Health、`/ws/paper`）尚未存在，以
`VITE_PAPER_DATA_SOURCE=mock` 開發").

These four routes were originally tagged in `paper-trading-ui/design.md` as owned by a change called
`trading-schema-storage`. That change was never created: `openspec list` shows only
`runtime-health-reconciliation`, `position-funding-pnl`, `paper-trading-ui`, `paper-execution-engine`
as non-archived, and `openspec/changes/archive/` has no `trading-schema-storage` entry (its
responsibilities — `runtime/src/types/`, the event store, SQLite storage — were absorbed by
`trading-schema-types` and `trading-event-store`, both already archived, neither of which added any
`server.ts` route). So A-5 through A-8 are unplanned and unimplemented, even though the frontend
already depends on them.

This change also supersedes the *shape* of the original A-5/A-6/A-7 assumptions where the already-
merged frontend code has already resolved a mismatch against the real, already-landed
`runtime/src/types/account.ts` `AccountSnapshot` (see design.md Context) — this proposal's response
shapes follow what the merged `AccountPanel.tsx` / `contracts.ts` / `fixtures.ts` actually bind to,
not the stale design-doc prose.

## What Changes

- Add a new read-only data-access module (server-side, not `runtime/src/`) that opens the Runtime's
  SQLite database with `new DatabaseSync(path, { readOnly: true })` — the same pattern
  `runtime-health-reconciliation`'s design.md Decision 3 and proposal.md C-06 reference ("server.ts
  only reads SQLite, never writes, Runtime process is the sole writer").
- Add four read-only GET routes to `server.ts`:
  - `GET /api/paper/account` → `AccountSnapshot` (the real `runtime/src/types/account.ts` shape).
  - `GET /api/paper/trades?scope=current` → `{ items: CurrentTradeSummary[] }`.
  - `GET /api/paper/trades?scope=completed&final_status=&cursor=&limit=` →
    `{ items: CompletedTradeSummary[]; next_cursor: string | null }` (keyset-paginated, see design.md
    Decision 2).
  - `GET /api/paper/trades/:trade_id` → `TradeDetail { trade, legs, orders, fills,
    funding_settlements, opportunity, result? }`.
  - `GET /api/paper/trades/:trade_id/events?cursor=&limit=` → `{ items: Array<TradingEvent & {
    seq: number }>; next_cursor: string | null }` (seq-keyset, see design.md Decision 2).
- Reuse the `seq`-ordered pagination convention from the archived `trading-event-store` design
  (`EventStore.replay` orders by `seq`, not `timestamp`, for stability — design.md Decision 6 there).

## Non-goals

- No write or control endpoints of any kind (`POST`, `PUT`, `DELETE`) — this change only exposes
  already-existing data computed and persisted by the Runtime.
- No new business logic — `hedge_ratio`, `unrealized_pnl_usdt`, `funding_expected_usdt` and every
  `TradeResult` field already exist on the entities the Runtime persists (`runtime/src/types/trade.ts`,
  `result.ts`); this change reads and serializes them, it does not compute them.
- Does not touch `GET /api/paper/health` or `GET /api/runtime/reconciliation/latest` — those belong to
  `runtime-health-reconciliation`, implemented in parallel on a different branch off the same base
  commit; this change does not modify that change's files.
- Does not implement `GET /api/paper/events` (global event catch-up, A-9) or `WebSocket /ws/paper`
  (A-10) — split into the sibling change `paper-trading-event-stream` (see that proposal's Why for the
  reason for the split: this repo's CLAUDE.md task-count convention, and because the event-stream
  surface has a materially different shape — a long-lived connection vs. request/response reads).
- Does not implement the Kill Switch control channel (`POST /api/paper/control`, A-11) — that is
  `risk-engine-kill-switch` group 4's.
- Does not modify `runtime/src/` business logic, `runtime/src/types/`, or any existing `server.ts`
  route.

## Capabilities

### New Capabilities

- `paper-trading-read-api`: read-only SQLite-backed REST routes for Account, Trades (current /
  completed, keyset-paginated), Trade Detail, and per-Trade Event history (keyset-paginated).

### Modified Capabilities

(none)

## Impact

- **New files**: `server/paperReadLayer.ts` (or split into `server/paperReadLayer/{db,account,trades,events}.ts`
  if one file gets unwieldy — left to implementation, see tasks.md), `server/paperCursor.ts` (keyset
  cursor encode/decode, shared with the sibling change's trade-events route).
- **Modified files**: `server.ts` — four new GET routes only, no existing route touched.
- **Not touched**: `runtime/src/` (any business logic), `runtime/src/types/` (no new types — every
  response field already exists on `Trade`, `TradeResult`, `TradeLeg`, `PaperOrder`, `Fill`,
  `FundingSettlement`, `Opportunity`, `TradingEvent`, `AccountSnapshot`), `assets/ARCHITECTURE.md`,
  `runtime-health-reconciliation`'s files.
- **Depends on**: `trading-schema-types` (types, archived), `trading-event-store` (SQLite schema +
  `seq` convention, archived), `paper-execution-engine` (entities being written, in progress/complete),
  `paper-trading-event-loop` (`TradeResult.funding_confirmed` semantics, archived). Does **not**
  depend on `runtime-health-reconciliation` landing first — reads a disjoint set of tables
  (`trades`, `trade_legs`, `orders`, `fills`, `funding_settlements`, `account_snapshots`,
  `trading_events`), not `runtime_health`.
