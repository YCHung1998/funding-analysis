## Why

`src/features/paperTrading/hooks/usePaperEventStream.ts` (change `paper-trading-ui`, already merged)
already connects to `ws(s)://<host>/ws/paper`, reconnects with exponential backoff, and backfills via
`GET /api/paper/events?after_seq=&limit=500` on every reconnect — all fully implemented client-side
against assumptions A-9 and A-10 of `paper-trading-ui/design.md`. No server implements either side, so
today the hook sits permanently in `RECONNECTING`, retrying against a 404/connection-refused `/ws/paper`
forever (harmless — mock mode is what `paper-trading-ui` actually ships with per `assets/HANDOFF.md`'s
2026-10-01 wave-1b entry — but the real-data path is entirely unexercised).

A-9/A-10 were never picked up by any change. `paper-trading-ui/design.md` originally tagged them as
`runtime-health-reconciliation`'s. `runtime-health-reconciliation/proposal.md` explicitly rejects that
in a 2026-10-03 note appended to both its proposal.md and design.md: Decision 3 there already decided
against opening any HTTP/WebSocket channel from the Runtime to `server.ts` (data flows through SQLite
only), and that decision directly conflicts with owning a WebSocket gateway. That note hands A-9/A-10 to
"a new change (trade-data 讀取 API，尚待 propose)" — this change is that handoff's destination, split out
from its sibling `paper-trading-read-api` because: (a) this repo's CLAUDE.md task-count convention
("一個 change 的 tasks 超過 ~12 項時，建議拆成兩個 proposal") and the combined REST+WebSocket surface
does not fit one ~12-task change cleanly; (b) a long-lived WebSocket connection with reconnect/backfill/
backpressure concerns is a materially different implementation shape from request/response GET routes,
so splitting keeps each change's tasks.md internally coherent.

## What Changes

- Add `GET /api/paper/events?after_seq=&limit=500` (A-9): global, cross-trade event catch-up, used by
  the client exclusively for reconnect backfill (confirmed by reading `usePaperEventStream.ts` — it is
  the only caller).
- Add `WebSocket /ws/paper` (A-10) to `server.ts`: on connect, send `{ type: 'hello', last_seq }`; then
  stream every new `trading_events` row as `{ type: 'event', seq, event }`; push `{ type: 'health',
  health }` whenever `runtime_health` changes (reusing `runtime-health-reconciliation`'s published
  table as a second, independent reader — see design.md Decision 3). `server.ts` detects new rows by
  polling SQLite (it has no other way to observe the Runtime's writes — C-06), not by any IPC channel.
- Reuse the sibling change's `server/paperReadLayer.ts` DB handle and `seq`-ordering convention rather
  than opening a second connection or redefining pagination semantics.

## Non-goals

- No control channel, no command sent over the WebSocket (`usePaperEventStream.ts` only ever listens;
  `WebSocket only 收不送`, per `paper-trading-ui/design.md` Decision 5) — commands remain
  `POST /api/paper/control` (A-11), `risk-engine-kill-switch` group 4's.
- Does not touch `GET /api/paper/health` or `GET /api/runtime/reconciliation/latest` —
  `runtime-health-reconciliation`'s, implemented in parallel on a different branch off the same base
  commit; this change only *reads* the `runtime_health` table that change's Health Publisher writes, it
  does not define or own that table's schema.
- Does not implement `GET /api/paper/account`, `/api/paper/trades*` — the sibling change
  `paper-trading-read-api`'s.
- Does not open any channel from the Runtime process to `server.ts` other than the existing SQLite file
  — `runtime-health-reconciliation/design.md` Decision 3 already rejected that alternative for Health,
  and the same reasoning (no new IPC/auth surface, Runtime and server restart independently) applies
  here.
- Does not add message types beyond `event` / `health` / `hello` — `PaperWsMessage` in
  `src/features/paperTrading/api/contracts.ts` is the complete, already-implemented union; this change
  does not extend it.

## Capabilities

### New Capabilities

- `paper-trading-event-stream`: `GET /api/paper/events` global catch-up endpoint, and the `/ws/paper`
  WebSocket gateway (connect handshake, event tailing, health push, slow-consumer handling).

### Modified Capabilities

(none)

## Impact

- **New files**: `server/paperEventTailer.ts` (polls `trading_events` for rows past the last broadcast
  `seq`, polls `runtime_health` for `updated_at` changes), `server/paperWsGateway.ts` (connection
  registry, hello/event/health framing, per-socket outbound queue cap).
- **Modified files**: `server.ts` — one new GET route, one new WebSocket upgrade handler.
- **Not touched**: `runtime/src/`, `runtime/src/types/`, `assets/ARCHITECTURE.md`,
  `runtime-health-reconciliation`'s files, the sibling `paper-trading-read-api` change's files (this
  change only imports its `server/paperReadLayer.ts` DB handle, does not modify it).
- **Depends on**: `paper-trading-read-api` (shared DB handle + `seq` reading convention — soft
  dependency, this change can also stand alone against the same tables if sequenced first, but should
  not duplicate the read-layer module); `runtime-health-reconciliation` (the `runtime_health` table
  this change reads for the `health` push — hard dependency: the table must exist for the health-push
  path to have anything to read, though the `event` push path does not need it).
