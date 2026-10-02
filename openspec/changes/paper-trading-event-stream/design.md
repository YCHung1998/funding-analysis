## Context

- `paper-trading-ui/design.md` §11 states A-9/A-10 verbatim (this change's contract):

  | ID | Assumption (verbatim) |
  |----|------|
  | A-9 | `GET /api/paper/events?after_seq=&limit=500` → 全域事件補抓，同上排序；`seq` 為 event store 單調遞增序號 |
  | A-10 | WebSocket `/ws/paper` 由 server 推送 `{ type: 'event'; seq; event: TradingEvent } \| { type: 'health'; health: RuntimeHealth } \| { type: 'hello'; last_seq }`；server 只轉發，不保證送達（UI 以 A-9 補抓） |

- `runtime-health-reconciliation/proposal.md`'s 2026-10-03 note (verbatim excerpt): "不實作 `GET
  /api/paper/events`（A-9 全域事件補抓）、`WebSocket /ws/paper`（A-10）；2026-10-03 確認：
  `paper-trading-ui/design.md` 原本假設這兩項由本 change 提供，但本 change 的 Decision 3 明確否決了開
  HTTP/WebSocket 給 server 的替代方案...已決定改由負責 `/api/paper/account`、`/trades`、
  `/trades/:id`、`/trades/:id/events` 的新 change（trade-data 讀取 API，尚待 propose）一併提供". This
  change is that handoff's destination for the event-stream half (the REST half went to the sibling
  `paper-trading-read-api`, per this proposal's Why).
- `runtime-health-reconciliation/design.md` Decision 3: the Runtime publishes `runtime_health` as a
  single overwritten SQLite row (`id = 1`); `server.ts` reads it with `new DatabaseSync(path, {
  readOnly: true })`. That same design's "替代方案" explicitly rejects a Runtime→server HTTP/WebSocket
  channel: "多一個連線與認證面；否決（與 C-06「server 只唯讀 SQLite」一致）". This change's WebSocket
  gateway is server.ts→browser (downstream of the UI), not Runtime→server — it does not reopen that
  rejected alternative; it still reads the Runtime's state exclusively through SQLite.
- `src/features/paperTrading/hooks/usePaperEventStream.ts` (already merged, ground truth for exact
  reconnect/backfill/dedup semantics this server implementation must match — not redesign):
  - States: `CONNECTING → CONNECTED → RECONNECTING → DISCONNECTED`.
  - Reconnect backoff: `Math.min(1000 * 2 ** attempt, 30_000)` with `±20%` jitter (`backoffDelay`).
  - On `open`: resets `reconnectAttempt` to 0, then immediately calls `backfill()` — `GET
    /api/paper/events?after_seq=<lastSeqRef.current>` (0 on first-ever connect) — independent of
    whether/when a `hello` frame arrives.
  - On `message`: `type: 'event'` → ingest (dedup by `event_id`, re-sort by `(timestamp, seq)`,
    truncate to `bufferSize`, default 500); `type: 'health'` → replace local health state; `type:
    'hello'` → `lastSeqRef = max(lastSeqRef, last_seq)` (does not itself trigger a fetch — `open`
    already did).
  - On `close` (not caused by the hook's own cleanup): schedules reconnect via `scheduleReconnect()`.
  - The hook never sends anything but the WebSocket protocol-level ping (no outbound app messages) —
    confirmed by reading the whole file, no `ws.send(...)` call exists.
- Archived `trading-event-store/design.md` Decision 5 (`EventQueue`): the Runtime already buffers
  events in-memory before a batched SQLite flush (default flush interval, exponential-retry on write
  failure) for "observation"-class events; "ledger"-class events (anything touching Trade/Order/
  Position/Capital) commit synchronously in the same transaction as the entity row. Either way, by the
  time a row is visible to a read-only SQLite connection, it is durably committed — there is no
  intermediate state `server.ts` could observe and need to guard against.

## Goals / Non-Goals

**Goals:** satisfy A-9/A-10 exactly as already implemented by `usePaperEventStream.ts`; never require a
Runtime-side code change (`server.ts` discovers new rows by reading SQLite, same as every other route in
this project); bounded server-side memory and connection handling.

**Non-Goals:** control channel; new WS message types; owning `runtime_health`'s schema; REST trade/
account routes (sibling change).

## Decisions

### 1. Detecting new events: polling, not notification

- SQLite (via `node:sqlite`'s `DatabaseSync`) has no push/notify mechanism available to a separate
  read-only connection in a different process space consideration — `server.ts` cannot be told
  synchronously when the Runtime commits a new row. `server/paperEventTailer.ts` polls
  `SELECT * FROM trading_events WHERE seq > :last_broadcast_seq ORDER BY seq ASC` on a short interval
  (default `event_tail_poll_interval_ms = 250`, configurable) and broadcasts any new rows to every open
  WebSocket connection as `{ type: 'event', seq, event }`, then advances `last_broadcast_seq`.
- Same mechanism for `runtime_health`: poll `SELECT updated_at FROM runtime_health WHERE id = 1`; when
  `updated_at` changes from the last-seen value, read the full row and broadcast `{ type: 'health',
  health }` to every connection. One poller, reused by every connected socket — not one poll loop per
  client.
- 250 ms default chosen as a fraction of `runtime-health-reconciliation`'s own health-publish interval
  (design.md there: `health_publish_interval_ms` default 1000) and comfortably under
  `paper-trading-ui/design.md`'s 10 s staleness threshold for Health — events feel "live" without
  polling faster than the Runtime could plausibly write.
- **Alternative considered**: `node:sqlite`'s WAL mode supports readers observing a committed write
  essentially immediately, so a tighter poll (e.g. 50 ms) was considered. **Rejected for this proposal
  as the default** — no merged code depends on sub-250ms latency, and `event_tail_poll_interval_ms`
  being configurable means it can be tightened later without a design change; starting conservative
  avoids needless CPU/IO on an idle Runtime.

### 2. Connection handshake matches the hook's `open`-then-backfill flow exactly

- On a new WebSocket connection, the gateway immediately sends `{ type: 'hello', last_seq:
  <current max seq in trading_events> }` — this is a courtesy the hook uses only to raise its
  `lastSeqRef` floor (e.g. after a hard client-side reset); it is **not** what triggers the client's
  backfill. The client always independently calls `GET /api/paper/events?after_seq=<its own
  lastSeqRef>` right after `open` fires, per Decision 1's Context excerpt — so the gateway does not
  need to compute or send any backlog itself; A-9's REST route is the single source of backfill truth,
  and the WebSocket only needs to start forwarding *new* events from the moment of connection onward.
  This matches A-10's own text: "server 只轉發，不保證送達（UI 以 A-9 補抓）" — delivery guarantees live
  in the REST route, not the socket.
- After `hello`, the gateway subscribes the new connection to the shared tailer's broadcast stream (no
  per-connection backlog query) — simplest implementation that matches what the client already does for
  itself.

### 3. `GET /api/paper/events` reuses the sibling change's read layer, no new cursor type

- `server/paperReadLayer.ts` (from `paper-trading-read-api`) gains one more function,
  `getEventsAfter(afterSeq, limit)`: `SELECT * FROM trading_events WHERE seq > :after_seq ORDER BY seq
  ASC LIMIT :limit`. Response: `{ items: Array<TradingEvent & { seq: number }> }` — **no `next_cursor`**,
  matching `GlobalEventsResponse` in `contracts.ts` exactly (confirmed by reading that file — it is the
  only one of the four paginated-shaped responses without a cursor field). The caller (the hook) simply
  calls again with `after_seq = <max seq in the response>` if it wants more; `seq` itself already serves
  as the resumption token, so no separate opaque cursor is needed for this one route.
- If `paper-trading-read-api` has not been applied/merged yet when this change is implemented, this
  function and its one query can be added directly to this change's own `server/paperEventTailer.ts`
  instead, with no behavioral difference — tasks.md notes this as a sequencing fallback, not a required
  order.

### 4. Backpressure: bounded per-connection queue, drop the connection not the data

- Each WebSocket connection gets a bounded outbound queue (default 1000 messages — matching
  `trading-event-store/design.md` Decision 5's UI-buffer precedent of 1000 for the exact same "don't
  let a slow consumer stall or OOM the writer" problem). If a connection's queue is full when a new
  broadcast arrives, the gateway closes that connection (WebSocket `close` with a policy-violation-ish
  code) rather than dropping messages silently or blocking the broadcast loop for other connections.
- **Why dropping the connection is safe, not data loss**: `usePaperEventStream.ts`'s `close` handler
  already schedules a reconnect with exponential backoff, and the reconnect's `open` handler already
  re-backfills from `lastSeqRef` via A-9 (Decision 2). A forced disconnect is therefore functionally
  identical, from the client's perspective, to a network blip — the existing, already-tested client
  machinery is the resync path, not a new server-side replay buffer per connection.
- **Alternative considered**: per-connection unbounded queue. **Rejected**: an unresponsive browser tab
  could otherwise accumulate unbounded memory server-side for as long as the TCP connection stays half-
  open.

### 5. File layout

```
server/paperEventTailer.ts   poll trading_events + runtime_health, broadcast to subscribers
server/paperWsGateway.ts     connection registry, hello framing, per-socket queue + cap, close-on-full
server.ts                    GET /api/paper/events, WS /ws/paper upgrade handler
```

## Risks / Trade-offs

- [Polling instead of push] → simplest correct implementation given C-06's "SQLite only" constraint;
  interval is configurable if 250 ms proves too coarse once real load is observed.
- [Forced disconnect on backpressure] → deliberately pushes recovery onto the client's already-merged,
  already-tested reconnect+backfill path instead of adding server-side replay-buffer complexity; see
  Decision 4.
- [No message delivery guarantee on the socket itself] → by design, per A-10's own text; A-9 is the
  guarantee.
- [`runtime_health` table owned by a change on a different branch] → the health-push path degrades
  gracefully (no `health` messages sent) if that table doesn't exist yet; `event` push is independent
  and unaffected, per proposal.md Impact's dependency note.

## Migration Plan

- All new files (`server/paperEventTailer.ts`, `server/paperWsGateway.ts`) plus one new GET route and
  one new WS upgrade handler in `server.ts`; no schema migration.
- Develop on `feature-paper-trading-event-stream` (off `develop`), `--no-ff` merge; rollback = `git
  revert -m 1 <merge-commit>`.

## Open Questions

1. **WebSocket upgrade handling under Vite's dev middleware.** `paper-trading-ui/design.md` Risk list
   already flagged this and deferred it: "由上游在 `server.ts` 處理；UI 端 URL 以 `location` 推導，dev
   與 production 相同" — i.e. the frontend assumes `server.ts` handles the upgrade identically in both
   `npm run dev` (Vite middleware mode) and the production build, without specifying how. This change
   needs to confirm, during implementation, that Vite's dev server either passes WebSocket upgrades
   through to the underlying HTTP server untouched or that an explicit `server.ts`-level upgrade
   handler is wired before Vite's own middleware intercepts it — this is an implementation-feasibility
   question for tasks.md's first task to spike, not a design choice to guess at here, since the answer
   depends on the exact Vite version/config already pinned elsewhere in the repo.
2. **Auth/session model**, same as the sibling change's Open Question 1 — not decided here, for the
   same reason (deferred by `paper-trading-ui/design.md` Open Question 4 to the Kill Switch work). A
   WebSocket adds one more surface (anyone who can reach the port can watch the live event/health
   stream) to whatever that future decision covers.
