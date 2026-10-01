/**
 * runtime/test/helpers/assertTraceability.ts
 *
 * `assertTraceability(db, { trade_id? })` — spec "Traceability assertion
 * helper" (tech spec §42): fails when any entity row lacks
 * `created_at`/`updated_at`, when any entity's current status differs from
 * the `to` of its last transition event, when a status change exists
 * without a corresponding event, or when event `timestamp` values for one
 * trade decrease with increasing `seq`.
 */
import type { SqliteDriver } from '../../src/storage/driver';

export class TraceabilityError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Traceability check failed:\n${issues.join('\n')}`);
    this.name = 'TraceabilityError';
  }
}

interface EntityCheck {
  table: string;
  idColumn: string;
  statusColumn: string;
  /** `event_type` column value(s) whose `payload.to` represents this entity's status after the transition. */
  eventIdColumn: 'trade_id' | 'order_id' | 'leg_id';
}

const ENTITY_CHECKS: EntityCheck[] = [
  { table: 'trades', idColumn: 'trade_id', statusColumn: 'status', eventIdColumn: 'trade_id' },
  { table: 'orders', idColumn: 'order_id', statusColumn: 'order_state', eventIdColumn: 'order_id' },
  { table: 'trade_legs', idColumn: 'leg_id', statusColumn: 'status', eventIdColumn: 'leg_id' },
  { table: 'funding_settlements', idColumn: 'funding_id', statusColumn: 'settlement_status', eventIdColumn: 'trade_id' },
];

interface TradingEventRow {
  seq: number;
  event_type: string;
  timestamp: number;
  trade_id: string | null;
  order_id: string | null;
  leg_id: string | null;
  payload: string;
}

/**
 * Validates traceability for all trades, or just `trade_id` if given.
 * Throws `TraceabilityError` (never returns a value) listing every issue
 * found, naming the offending entity id.
 */
export function assertTraceability(db: SqliteDriver, opts: { trade_id?: string } = {}): void {
  const issues: string[] = [];

  for (const check of ENTITY_CHECKS) {
    const where = opts.trade_id
      ? check.table === 'trades'
        ? `WHERE ${check.idColumn} = ?`
        : `WHERE trade_id = ?`
      : '';
    const params = opts.trade_id ? [opts.trade_id] : [];
    const rows = db.prepare(`SELECT * FROM ${check.table} ${where}`).all(...params) as Record<string, unknown>[];

    for (const row of rows) {
      const id = String(row[check.idColumn]);
      if (row.created_at === null || row.created_at === undefined) {
        issues.push(`${check.table}:${id} missing created_at`);
      }
      if (row.updated_at === null || row.updated_at === undefined) {
        issues.push(`${check.table}:${id} missing updated_at`);
      }

      const currentStatus = row[check.statusColumn];
      const eventRows = db
        .prepare(
          `SELECT * FROM trading_events WHERE ${check.eventIdColumn} = ? ORDER BY seq ASC`,
        )
        .all(check.eventIdColumn === check.idColumn || check.eventIdColumn === 'order_id' || check.eventIdColumn === 'leg_id' ? id : row.trade_id) as TradingEventRow[];

      const relevantEvents = eventRows
        .filter((e) => matchesEntityId(check, e, id))
        .map((e) => ({ event: e, to: effectiveTo(e, check.statusColumn) }))
        .filter((e): e is { event: TradingEventRow; to: unknown } => e.to !== undefined);

      if (relevantEvents.length === 0) {
        issues.push(`${check.table}:${id} has no transition event recording its current status (${String(currentStatus)})`);
        continue;
      }
      const last = relevantEvents[relevantEvents.length - 1];
      if (last.to !== currentStatus) {
        issues.push(
          `${check.table}:${id} current status (${String(currentStatus)}) does not match last event's payload.to (${String(last.to)})`,
        );
      }
    }
  }

  // Chronological ordering: for each trade, event timestamps must not
  // decrease as seq increases.
  const tradeIds = opts.trade_id
    ? [opts.trade_id]
    : (db.prepare(`SELECT DISTINCT trade_id FROM trading_events WHERE trade_id IS NOT NULL`).all() as { trade_id: string }[]).map(
        (r) => r.trade_id,
      );
  for (const tradeId of tradeIds) {
    const events = db.prepare(`SELECT seq, timestamp FROM trading_events WHERE trade_id = ? ORDER BY seq ASC`).all(tradeId) as {
      seq: number;
      timestamp: number;
    }[];
    for (let i = 1; i < events.length; i++) {
      if (events[i].timestamp < events[i - 1].timestamp) {
        issues.push(
          `trade:${tradeId} event timestamps decrease at seq ${events[i].seq} (${events[i].timestamp} < ${events[i - 1].timestamp})`,
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new TraceabilityError(issues);
  }
}

/**
 * The status this event implies the entity transitioned *to*: explicit
 * `payload.to` for a transition event (`makeTransitionEvent`), or
 * `payload.after[statusColumn]` for an entity-creation event (e.g.
 * `TRADE_CREATED`, which has no "from" state and so no `payload.to`).
 */
function effectiveTo(event: TradingEventRow, statusColumn: string): unknown {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  if (payload.to !== undefined) return payload.to;
  const after = payload.after as Record<string, unknown> | undefined;
  return after ? after[statusColumn] : undefined;
}

function matchesEntityId(check: EntityCheck, event: TradingEventRow, id: string): boolean {
  if (check.eventIdColumn === 'order_id') return event.order_id === id;
  if (check.eventIdColumn === 'leg_id') return event.leg_id === id;
  return event.trade_id === id;
}
