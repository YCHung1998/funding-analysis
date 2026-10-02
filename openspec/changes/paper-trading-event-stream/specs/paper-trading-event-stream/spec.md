## ADDED Requirements

### Requirement: Global event catch-up endpoint

`GET /api/paper/events?after_seq=&limit=` SHALL return HTTP 200 with `{ items: Array<TradingEvent &
{ seq: number }> }` — events from any trade, not just one — ordered by `seq` ascending, strictly
greater than the `after_seq` query param (default `0`), default `limit = 500`. The response SHALL NOT
include a `next_cursor` field; the caller resumes by calling again with `after_seq` set to the highest
`seq` already received.

#### Scenario: Backfill after a seq

- **WHEN** events exist with `seq` 1 through 10 and `GET /api/paper/events?after_seq=5` is called
- **THEN** the response's `items` are the events with `seq` 6 through 10, ascending

#### Scenario: No new events

- **WHEN** `after_seq` equals the current maximum `seq`
- **THEN** the response is `{ items: [] }` with HTTP 200

#### Scenario: Default after_seq

- **WHEN** `GET /api/paper/events` is called with no `after_seq`
- **THEN** it behaves as `after_seq=0` (every event, up to `limit`)

### Requirement: WebSocket event and health gateway

`server.ts` SHALL accept WebSocket connections at `/ws/paper`. On connect, it SHALL immediately send
`{ type: 'hello', last_seq }` where `last_seq` is the current maximum `seq` in `trading_events`. It
SHALL then forward every new `trading_events` row, detected by polling, as `{ type: 'event', seq,
event: TradingEvent }` in `seq` order, and SHALL forward every change to the `runtime_health` row
(detected by polling), as `{ type: 'health', health: RuntimeHealth }`. The gateway SHALL NOT process
any inbound application message from the client (the channel is send-only from the server's side,
besides WebSocket protocol-level pings) and SHALL NOT guarantee delivery of any given event to a given
connection — clients are responsible for detecting gaps and backfilling via `GET /api/paper/events`.

#### Scenario: Hello on connect

- **WHEN** a client opens a WebSocket connection to `/ws/paper` while `trading_events` has a maximum
  `seq` of 42
- **THEN** the first frame the client receives is `{ type: 'hello', last_seq: 42 }`

#### Scenario: New event forwarded

- **WHEN** a client is connected and the Runtime commits a new `trading_events` row with `seq = 43`
- **THEN** within one poll interval the client receives `{ type: 'event', seq: 43, event: <that row> }`

#### Scenario: Health change forwarded

- **WHEN** a client is connected and `runtime_health.updated_at` changes
- **THEN** within one poll interval the client receives `{ type: 'health', health: <the new row> }`

#### Scenario: Missing health table degrades gracefully

- **WHEN** the `runtime_health` table does not exist (its owning change not yet applied)
- **THEN** `event` messages are still forwarded normally and no `health` message is ever sent — the
  connection is not closed or errored because of the missing table

#### Scenario: Inbound message ignored

- **WHEN** a connected client sends any application-level WebSocket message
- **THEN** the gateway does not act on it (no response, no state change) beyond the protocol-level
  pong a server would already send for a ping

### Requirement: Bounded per-connection delivery with drop-on-overflow

Each WebSocket connection SHALL have a bounded outbound queue of at most `event_stream_queue_limit`
messages (default 1000). When a broadcast would exceed a connection's queue limit, the gateway SHALL
close that connection rather than drop individual messages silently or block delivery to other
connections.

#### Scenario: Slow consumer disconnected

- **WHEN** a connection's outbound queue has reached 1000 pending messages and a new broadcast arrives
- **THEN** that connection is closed; other connected clients continue receiving broadcasts
  uninterrupted

#### Scenario: Reconnect recovers via backfill

- **WHEN** a client is disconnected per the previous scenario and reconnects
- **THEN** it receives a fresh `hello`, and its own backfill request (`GET /api/paper/events?
  after_seq=<its last known seq>`) returns every event it missed while disconnected
