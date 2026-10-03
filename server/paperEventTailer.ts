/**
 * server/paperEventTailer.ts
 *
 * `paper-trading-event-stream` task 1.2 (design.md Decision 1): polls
 * `trading_events` for rows past the last broadcast `seq` and `runtime_health`
 * for `updated_at` changes, invoking injected callbacks so `server/
 * paperWsGateway.ts` can fan the result out to every open connection without
 * owning its own poll loop ("One poller, reused by every connected socket —
 * not one poll loop per client", design.md Decision 1).
 *
 * No internal timer: `pollOnce()` runs exactly one poll cycle synchronously
 * against a freshly-opened reader (matching this repo's per-request
 * `DatabaseSync(path, { readOnly: true })` convention already used by
 * `server/paperReadLayer.ts` and `server.ts`'s health routes — a fresh
 * connection per tick, never a long-lived handle held across Runtime
 * restarts). Callers (`server.ts`) own interval scheduling via `setInterval`;
 * tests call `pollOnce()` directly with no real timers involved.
 *
 * `runtime_health` may not exist yet — its owning change
 * (`runtime-health-reconciliation`) is sequenced on a different branch
 * (design.md Risks / proposal.md Impact "hard dependency... though the
 * `event` push path does not need it"). `readRuntimeHealthRow` throws when
 * the table is missing; this module catches that per-tick and simply skips
 * the health half of the poll — the event half is entirely independent and
 * unaffected (proven by `paperEventTailer.test.ts`'s "missing health table"
 * case).
 *
 * No exchange-name literal appears in this file (hard project convention).
 */
import { getEventsAfter, type PaperReaderDriver } from './paperReadLayer';
import { buildHealthApiPayload, readRuntimeHealthRow, type HealthApiPayload } from '../runtime/src/health/healthPublisher';
import type { TradingEvent } from '../runtime/src/types';

export type TailedEvent = TradingEvent & { seq: number };

/** A `node:sqlite` `DatabaseSync`-shaped reader that can also be closed (matches `openPaperDb`'s return type). */
export interface ClosableReader extends PaperReaderDriver {
  close(): void;
}

export interface PaperEventTailerDeps {
  /** Opens a fresh read-only connection for one poll tick; `undefined` if the DB file doesn't exist yet. */
  openReader: () => ClosableReader | undefined;
  onEvents: (events: TailedEvent[]) => void;
  onHealth: (health: HealthApiPayload) => void;
  now: () => number;
  /** Matches `/api/paper/health`'s own staleness threshold (design.md Decision 1: "3 倍發佈間隔"). */
  healthStaleThresholdMs: number;
  /** Starting watermark for "new" events; default 0. Pass the current max `seq` at startup (`getCurrentMaxSeq`) to avoid replaying history to every connection on server start. */
  initialLastSeq?: number;
  /** Safety cap on rows read in a single poll tick (default 10,000) — not a pagination contract. */
  maxEventsPerPoll?: number;
  onError?: (err: unknown, scope: 'events' | 'health') => void;
}

const DEFAULT_MAX_EVENTS_PER_POLL = 10_000;

export class PaperEventTailer {
  private lastSeq: number;
  private lastHealthUpdatedAt: number | undefined;

  constructor(private readonly deps: PaperEventTailerDeps) {
    this.lastSeq = deps.initialLastSeq ?? 0;
  }

  get lastBroadcastSeq(): number {
    return this.lastSeq;
  }

  /** Runs exactly one poll cycle: events then health, each independently fault-tolerant. */
  pollOnce(): void {
    const reader = this.deps.openReader();
    if (!reader) return; // DB file doesn't exist yet -- both halves skipped this tick, not an error
    try {
      this.pollEvents(reader);
      this.pollHealth(reader);
    } finally {
      reader.close();
    }
  }

  private pollEvents(reader: ClosableReader): void {
    try {
      const limit = this.deps.maxEventsPerPoll ?? DEFAULT_MAX_EVENTS_PER_POLL;
      const page = getEventsAfter(reader, this.lastSeq, limit);
      if (page.items.length === 0) return;
      this.lastSeq = page.items[page.items.length - 1]!.seq;
      this.deps.onEvents(page.items);
    } catch (err) {
      this.deps.onError?.(err, 'events');
    }
  }

  private pollHealth(reader: ClosableReader): void {
    try {
      const row = readRuntimeHealthRow(reader);
      if (!row) return; // table exists but no row published yet
      if (row.updated_at === this.lastHealthUpdatedAt) return; // unchanged since last poll
      this.lastHealthUpdatedAt = row.updated_at;
      const payload = buildHealthApiPayload(row, { nowMs: this.deps.now(), staleThresholdMs: this.deps.healthStaleThresholdMs });
      this.deps.onHealth(payload);
    } catch (err) {
      // Missing `runtime_health` table (owning change not yet applied) throws here;
      // the event path above is unaffected — see "missing health table" test.
      this.deps.onError?.(err, 'health');
    }
  }
}

/** Current max `seq` in `trading_events`, for the WS gateway's `hello` frame (design.md Decision 2). 0 if the table is empty. */
export function getCurrentMaxSeq(reader: PaperReaderDriver): number {
  const row = reader.prepare('SELECT MAX(seq) AS max_seq FROM trading_events').get() as { max_seq: number | null } | undefined;
  return row?.max_seq ?? 0;
}
