## Context

- ✅ C-06 (技術書 §3, reaffirmed by `runtime-health-reconciliation/proposal.md`): Paper Trading Runtime
  is an independent Node process and the sole writer of the SQLite database; `server.ts` only reads,
  never writes.
- `paper-trading-ui/design.md` §11 (跨 change 假設) states, verbatim, the contract this change must
  satisfy for A-5 through A-8 (A-9/A-10 belong to the sibling change `paper-trading-event-stream`):

  | ID | Assumption (verbatim) |
  |----|------|
  | A-5 | `GET /api/paper/account` → `AccountSnapshot { total_capital_usdt, available_capital_usdt, allocated_capital_usdt, current_positions, max_positions, config_version, snapshot_at, created_at, updated_at }`（規格書 §27；`account_snapshots` 表） |
  | A-6 | `GET /api/paper/trades?scope=current` → `{ items: TradeSummary[] }`；`GET /api/paper/trades?scope=completed&final_status=&cursor=&limit=50` → `{ items: TradeSummary[]; next_cursor: string \| null }`。`TradeSummary` = `Trade` 摘要欄位 + `long_exchange`、`short_exchange`、`hedge_ratio`、`unrealized_pnl_usdt`、`funding_expected_usdt`（current）或 `TradeResult` 摘要（completed，含 `funding_confirmed`、`finalized_at`、`slippage_attribution_usdt`、`final_status`、`result_reason`、`total_trade_duration_ms`）與各腿 `settlement_status` 摘要 |
  | A-7 | `GET /api/paper/trades/:trade_id` → `TradeDetail { trade, legs, orders, fills, funding_settlements, opportunity, result? }`；`margin_usdt` 與 `allocated_capital_usdt` 由 Runtime 提供 |
  | A-8 | `GET /api/paper/trades/:trade_id/events?cursor=&limit=200` → `{ items: Array<TradingEvent & { seq: number }>; next_cursor }`，依 `(timestamp, seq)` 升冪 |

- **A-5 is stale and already superseded by merged code.** `trading-schema-types` landed
  `runtime/src/types/account.ts` with a different `AccountSnapshot` shape than the A-5 prose above:
  `snapshot_id, mode, snapshot_time, total_capital_usdt, reserved_capital_usdt, available_capital_usdt,
  used_margin_usdt, realized_pnl_usdt, open_trade_count, reason, trade_id?, config_version, created_at,
  updated_at` — no `allocated_capital_usdt`, `current_positions`, `max_positions`, or `snapshot_at`.
  `src/features/paperTrading/api/contracts.ts` re-exports this real type as-is (`export type {
  AccountSnapshot }`), and `src/features/paperTrading/components/AccountPanel.tsx` already documents
  the gap in a code comment and renders against the real fields (`reserved_capital_usdt` as "Allocated
  Capital", `open_trade_count` as "Current Positions", "Max Positions" as `—` since there is no
  upstream field). Per this proposal's constraint ("don't redesign shapes already committed to by
  merged frontend code") — **this change returns the real `AccountSnapshot` as defined in
  `runtime/src/types/account.ts`, unchanged**, not the A-5 prose shape. A-6/A-7/A-8's `TradeSummary` /
  `TradeDetail` prose is, by contrast, still accurate to what `contracts.ts`/`fixtures.ts` actually use
  (`CurrentTradeSummary`, `CompletedTradeSummary`, `TradeDetailResponse` — confirmed by reading those
  files directly), so those are followed as originally written.
- Archived `trading-event-store/design.md` Decision 6: replay/pagination conventions order by `seq`
  (not `timestamp`), because cross-exchange clocks can tie or run slightly out of order; `seq` is a
  single global `INTEGER PRIMARY KEY AUTOINCREMENT` on `trading_events`, monotonic across the whole
  database, not per-trade.
- `runtime-health-reconciliation/design.md` Decision 3: `server.ts` opens the DB with
  `new DatabaseSync(path, { readOnly: true })`; this change follows the identical pattern for a
  disjoint set of tables (`trades`, `trade_legs`, `orders`, `fills`, `funding_settlements`,
  `account_snapshots`, `trading_events`, `opportunities`) — no shared file, no ordering dependency
  between the two changes.
- `src/features/paperTrading/api/paperApi.ts` (already merged, ground truth for exact request shapes):
  `getCompletedTrades` sends `scope=completed&limit=50` plus optional `final_status` and `cursor`;
  `getTradeEvents` sends `limit=200` plus optional `cursor`. Both treat `cursor` as an **opaque
  string** — it is only ever stored from a prior `next_cursor` and replayed verbatim, never parsed
  client-side (confirmed by reading `paperApi.test.ts` and `PaperTradingTab.tsx`'s cursor-stack
  usage). This frees the server to choose any internal cursor encoding.

## Goals / Non-Goals

**Goals:** satisfy A-5 (real shape) through A-8 exactly as already consumed by merged frontend code;
read-only, SQLite-backed, zero new business logic; stable pagination under concurrent Runtime writes.

**Non-Goals:** A-9/A-10 (sibling change); A-11 control channel; any new computed field; Health API;
auth/session (Open Question 1).

## Decisions

### 1. Read-layer module boundary

- New files live under `server/` (the existing home for `server.ts` helper modules — e.g.
  `server/liveScanMath.ts`, `server/liveScanRegistry.ts` — not `runtime/src/`, which is Runtime
  business logic this change must not touch).
- `server/paperReadLayer.ts`: opens `new DatabaseSync(dbPath, { readOnly: true })` once per `server.ts`
  process (mirrors `runtime-health-reconciliation`'s pattern) and exposes one function per route:
  `getAccountSnapshot()`, `getCurrentTrades()`, `getCompletedTrades(filter, cursor, limit)`,
  `getTradeDetail(tradeId)`, `getTradeEvents(tradeId, cursor, limit)`. Each function does only
  `SELECT` + row-to-type mapping (reusing the column layout `trading-event-store/design.md` already
  defined — `INTEGER` epoch-ms timestamps, `REAL` amounts, JSON-`TEXT` nested objects) — no joins the
  Runtime hasn't already materialized as columns.
- `server/paperCursor.ts`: `encodeCursor(key)` / `decodeCursor(cursor): Key | null` — shared by this
  change's completed-trades and trade-events routes, and intended for reuse by the sibling change's
  global-events route if its design needs one (it currently doesn't — see that proposal).
- **Alternative considered**: put the read layer under `runtime/src/storage/` next to the repositories
  that already exist there (`tradeRepository.ts`, `orderRepository.ts`, `accountRepository.ts` per
  `trading-event-store/design.md` §7). **Rejected**: those repository modules are part of the
  Runtime's own write path (`Ledger`), imported by Runtime business logic; `server.ts` importing them
  would blur the "Runtime is the sole writer, server.ts only reads SQLite via its own read-only
  connection" boundary C-06 draws, and would make it too easy for a future edit to accidentally call a
  write method from `server.ts`. A separate, `server/`-side, read-only module keeps the boundary a
  file/directory boundary, not just a discipline.

### 2. Pagination: keyset cursors, not offsets

- **Completed trades (A-6)**: `paper-trading-ui/design.md` Decision 6 already fixes the sort order —
  `finalized_at ?? updated_at` descending (server-side). Because the Runtime keeps writing new
  completed trades concurrently with a UI session paging through history, offset pagination
  (`LIMIT/OFFSET`) would skip or duplicate rows as new trades are inserted ahead of the current page.
  Cursor = base64url JSON `{ "sort_key": number, "trade_id": string }` (the `sort_key`/`trade_id` of
  the last row in the page just returned). The query becomes a keyset predicate:
  `WHERE (sort_key, trade_id) < (:cursor.sort_key, :cursor.trade_id) ORDER BY sort_key DESC, trade_id
  DESC LIMIT :limit` (trade_id as tie-breaker for rows sharing the same millisecond). `final_status`
  filters by an additional `WHERE result.final_status = :filter` when present.
- **Trade events (A-8)**: cursor = base64url JSON `{ "seq": number }` — the `seq` of the last row
  returned. Query: `WHERE trade_id = :trade_id AND seq > :cursor.seq ORDER BY seq ASC LIMIT :limit`.
  `seq` alone is sufficient here (no tie-breaker needed — it is already the globally unique, strictly
  monotonic key the archived `trading-event-store` design settled on for exactly this reason:
  "cross-exchange clocks can tie or run slightly out of order").
- A malformed/unparseable `cursor` query param is a client error → `400` with a short message; it is
  never silently treated as "start from the beginning" (that would quietly show stale data as current).
- **Current trades (A-6, no pagination)**: `paper-trading-ui/design.md` Decision 6 keeps this list
  unbounded by design (capped by `max_positions`, defensively truncated client-side at 100) — the
  route returns all current trades in one response, no cursor.
- **Why base64url JSON over a raw numeric string**: completed-trades' key is composite (`sort_key` +
  `trade_id`); encoding both as one opaque token keeps the client-side contract identical
  (`cursor: string | null`) across both paginated routes instead of inventing a different cursor shape
  per route. Trade-events' cursor could have been a bare `seq` string, but using the same
  `encodeCursor`/`decodeCursor` helper for both keeps one reviewed, tested implementation instead of
  two.

### 3. Response shapes follow merged frontend code literally

- `AccountSnapshot`: return `runtime/src/types/account.ts`'s `AccountSnapshot` unchanged (Context
  above) — no `allocated_capital_usdt`/`current_positions`/`max_positions`/`snapshot_at` remapping.
- `CurrentTradeSummary` / `CompletedTradeSummary` / `TradeDetailResponse` /
  `TradeEventsResponse`: return exactly the shapes declared in
  `src/features/paperTrading/api/contracts.ts` (re-read at implementation time in case `paper-trading-
  ui` gains further commits before this change is applied — contracts.ts, not this design doc, is the
  living source of truth per that file's own header comment).
- No field is renamed, computed, or added beyond what the Runtime's entities already carry.

### 4. Error / empty-state handling

- Normal empty state (tables exist, no rows yet — e.g. before the Runtime has created its first
  trade): `200` with `{ items: [] }` (and `next_cursor: null` where applicable). This is indistinguishable
  from "no results for this filter" by design — both are legitimately empty, and the UI's existing
  empty-state rendering already handles it.
- Database file or expected table missing entirely (Runtime has never run; migrations never applied):
  `503` with a short JSON error body — this is an operational precondition failure, not a data
  question, and `503` lets the UI's existing fetch-error path (`AccountPanel`'s `error` prop, etc.)
  render a clear "backend not ready" state instead of a misleading empty list.
- Unknown `:trade_id`: `404`.
- This mirrors `runtime-health-reconciliation/design.md` Decision 3's precedent of a defined response
  for "Runtime hasn't published anything yet" rather than an unhandled exception, adapted to data
  routes (which have no equivalent of Health's "stale but still 200" state — a list of trades is either
  there or it isn't).

## Risks / Trade-offs

- [Cursor encoding tied to this change's choice] → both cursor-consuming routes go through one shared
  `paperCursor.ts`; if a future change needs a different sort key, only that route's query + cursor
  payload shape changes, not the wire contract (`cursor: string | null` stays opaque).
- [Reading the same SQLite file the Runtime is actively writing] → WAL mode (already decided by
  `trading-event-store`) allows one writer + many readers concurrently; this change adds a reader, not
  a second writer.
- [`contracts.ts` drifting further before this change is applied] → tasks.md's first task re-reads
  `contracts.ts` fresh rather than trusting this document's restated shapes verbatim.
- [No auth] → read-only data, low leak risk per `paper-trading-ui/design.md` Open Question 4's own
  assessment; see Open Questions below — not decided here.

## Migration Plan

- All new files (`server/paperReadLayer.ts`, `server/paperCursor.ts`) plus four new `server.ts` routes;
  no existing route touched, no schema migration (reads existing tables as-is).
- Develop on `propose-paper-trading-data-api`'s eventual `feature-paper-trading-read-api` branch (off
  `develop`), `--no-ff` merge; rollback = `git revert -m 1 <merge-commit>` (no data-layer rollback
  needed — no schema change).

## Open Questions

1. **Auth/session model for read routes.** `paper-trading-ui/design.md` Open Question 4 already
   flagged this and explicitly deferred it ("唯讀資料外洩風險低，但控制通道需要保護——建議隨 Kill
   Switch UI 實作一起決定"). This change implements only read routes (no control channel), so per that
   note this is left undecided here too — not guessed. If the project decides authentication is needed
   before this change ships, it constrains `server.ts`'s whole routing setup (not just these four
   routes), so it should be decided once, centrally, rather than per-change.
2. **DB path configuration.** `trading-event-store/design.md` Open Question 3 left the SQLite path as
   `data/runtime.sqlite`, default, overridable by config — not yet confirmed decided by the user in
   `assets/HANDOFF.md` §8. This change's `paperReadLayer.ts` needs the same path `runtime-health-
   reconciliation`'s health publisher resolves to; both should read it from the same config source
   once that's settled, to avoid two independently-hardcoded paths drifting apart.
