/**
 * runtime/src/storage/eventStore.ts
 *
 * Append-only Event Store (design.md §7, spec "Append-only event store" /
 * "Replay and projection rebuild"). `append` validates, assigns a
 * monotonically increasing `seq`, and stamps `recorded_at` from the Clock at
 * write time (never copying the event's own `timestamp`). `replay` reads
 * events back ordered by `seq`. `rebuildProjections` reconstructs every
 * projection table solely from `payload.after` / `payload.snapshot` /
 * `payload.fill` snapshots carried by the events themselves.
 */
import { NO_TRADE_EVENT_TYPES, TRADING_EVENT_TYPES, type TradingEvent, type TradingEventType } from '../types/event';
import { assertNoCredentials } from '../types/validate';
import { createAccountRepository } from './accountRepository';
import type { SqliteDriver } from './driver';
import { createOrderRepository } from './orderRepository';
import { createTradeRepository } from './tradeRepository';

export interface StoredTradingEvent extends TradingEvent {
  seq: number;
}

export type AppendEventInput = Omit<TradingEvent, 'recorded_at'> & { recorded_at?: number };

export class EventValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Event validation failed: ${issues.join('; ')}`);
    this.name = 'EventValidationError';
  }
}

const VALID_EVENT_TYPES: ReadonlySet<TradingEventType> = new Set(TRADING_EVENT_TYPES);

function validateEvent(event: AppendEventInput): string[] {
  const issues: string[] = [];
  if (!event.event_id) issues.push('MISSING_EVENT_ID');
  if (!VALID_EVENT_TYPES.has(event.event_type)) issues.push(`UNKNOWN_EVENT_TYPE:${event.event_type}`);
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) issues.push('INVALID_TIMESTAMP');
  if (event.trade_id === null && !NO_TRADE_EVENT_TYPES.has(event.event_type)) {
    issues.push(`TRADE_ID_REQUIRED:${event.event_type}`);
  }
  if (event.payload === null || typeof event.payload !== 'object') issues.push('INVALID_PAYLOAD');
  return issues;
}

export interface EventStoreClock {
  now(): number;
}

export interface ReplayFilter {
  trade_id?: string;
  from_seq?: number;
  to_seq?: number;
}

interface TradingEventRow {
  seq: number;
  event_id: string;
  event_type: TradingEventType;
  timestamp: number;
  trade_id: string | null;
  leg_id: string | null;
  order_id: string | null;
  position_id: string | null;
  opportunity_id: string | null;
  session_id: string | null;
  exchange: string | null;
  symbol: string | null;
  payload: string;
  recorded_at: number;
  clock_offset_ms: number | null;
  clock_reference: string | null;
}

function rowToStoredEvent(row: TradingEventRow): StoredTradingEvent {
  const event: StoredTradingEvent = {
    seq: row.seq,
    event_id: row.event_id,
    event_type: row.event_type,
    timestamp: row.timestamp,
    trade_id: row.trade_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    recorded_at: row.recorded_at,
  };
  if (row.leg_id !== null) event.leg_id = row.leg_id;
  if (row.order_id !== null) event.order_id = row.order_id;
  if (row.position_id !== null) event.position_id = row.position_id;
  if (row.opportunity_id !== null) event.opportunity_id = row.opportunity_id;
  if (row.session_id !== null) event.session_id = row.session_id;
  if (row.exchange !== null) event.exchange = row.exchange as TradingEvent['exchange'];
  if (row.symbol !== null) event.symbol = row.symbol;
  if (row.clock_offset_ms !== null) event.clock_offset_ms = row.clock_offset_ms;
  if (row.clock_reference !== null) event.clock_reference = row.clock_reference as TradingEvent['clock_reference'];
  return event;
}

/**
 * Dispatch table for `rebuildProjections`: maps a `TradingEventType` to the
 * repository call that reconstructs the projection row(s) it carries. Every
 * event type that is NOT a pure entity-creation/transition event (and thus
 * carries no `payload.after`/`payload.snapshot`/`payload.fill`) is simply
 * absent here and ignored during rebuild.
 */
function applyToProjections(
  event: StoredTradingEvent,
  repos: {
    trade: ReturnType<typeof createTradeRepository>;
    order: ReturnType<typeof createOrderRepository>;
    account: ReturnType<typeof createAccountRepository>;
  },
): void {
  const payload = event.payload as Record<string, unknown>;
  switch (event.event_type) {
    case 'OPPORTUNITY_DETECTED':
    case 'OPPORTUNITY_QUALIFIED':
    case 'OPPORTUNITY_SELECTED':
    case 'OPPORTUNITY_REJECTED':
    case 'OPPORTUNITY_EXPIRED':
      if (payload.after) repos.trade.saveOpportunity(payload.after as Parameters<typeof repos.trade.saveOpportunity>[0]);
      break;
    case 'TRADE_CREATED':
    case 'TRADE_STATUS_CHANGED':
      if (payload.after) repos.trade.saveTrade(payload.after as Parameters<typeof repos.trade.saveTrade>[0]);
      break;
    case 'LEG_STATUS_CHANGED':
      if (payload.after) repos.trade.saveTradeLeg(payload.after as Parameters<typeof repos.trade.saveTradeLeg>[0]);
      break;
    case 'RISK_CHECK_STARTED':
    case 'RISK_CHECK_PASSED':
    case 'RISK_CHECK_FAILED':
      if (payload.after) repos.trade.saveRiskCheck(payload.after as Parameters<typeof repos.trade.saveRiskCheck>[0]);
      break;
    case 'ORDER_CREATED':
    case 'ORDER_SUBMITTED':
    case 'ORDER_ACK':
    case 'ORDER_ACK_TIMEOUT':
    case 'ORDER_PARTIAL_FILL':
    case 'ORDER_FILL':
    case 'ORDER_TIMEOUT':
    case 'ORDER_CANCEL_REQUESTED':
    case 'ORDER_CANCELED':
    case 'ORDER_CANCEL_REJECTED':
    case 'ORDER_REJECTED':
    case 'ORDER_EXPIRED':
      if (payload.after) repos.order.saveOrder(payload.after as Parameters<typeof repos.order.saveOrder>[0]);
      if (payload.fill) repos.order.saveFill(payload.fill as Parameters<typeof repos.order.saveFill>[0]);
      break;
    case 'POSITION_OPENED':
    case 'POSITION_CLOSED':
      if (payload.after) repos.order.savePosition(payload.after as Parameters<typeof repos.order.savePosition>[0]);
      break;
    case 'FUNDING_SETTLED':
    case 'FUNDING_STATUS_CHANGED':
      if (payload.after) repos.order.saveFundingSettlement(payload.after as Parameters<typeof repos.order.saveFundingSettlement>[0]);
      break;
    case 'CAPITAL_RESERVED':
    case 'CAPITAL_RELEASED':
      if (payload.snapshot) repos.account.saveAccountSnapshot(payload.snapshot as Parameters<typeof repos.account.saveAccountSnapshot>[0]);
      break;
    default:
      break;
  }
}

export class EventStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: EventStoreClock,
    private readonly knownSecrets: readonly string[] = [],
  ) {}

  append(event: AppendEventInput): StoredTradingEvent {
    const issues = validateEvent(event);
    if (issues.length > 0) {
      throw new EventValidationError(issues);
    }
    assertNoCredentials(event, this.knownSecrets);

    const recorded_at = this.clock.now();
    const stmt = this.db.prepare(
      `INSERT INTO trading_events (
        event_id, event_type, timestamp, trade_id, leg_id, order_id, position_id,
        opportunity_id, session_id, exchange, symbol, payload, recorded_at,
        clock_offset_ms, clock_reference
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const info = stmt.run(
      event.event_id,
      event.event_type,
      event.timestamp,
      event.trade_id,
      event.leg_id ?? null,
      event.order_id ?? null,
      event.position_id ?? null,
      event.opportunity_id ?? null,
      event.session_id ?? null,
      event.exchange ?? null,
      event.symbol ?? null,
      JSON.stringify(event.payload),
      recorded_at,
      event.clock_offset_ms ?? null,
      event.clock_reference ?? null,
    );
    const seq = Number(info.lastInsertRowid);
    return { ...event, recorded_at, seq };
  }

  replay(filter: ReplayFilter = {}): StoredTradingEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.trade_id !== undefined) {
      clauses.push('trade_id = ?');
      params.push(filter.trade_id);
    }
    if (filter.from_seq !== undefined) {
      clauses.push('seq >= ?');
      params.push(filter.from_seq);
    }
    if (filter.to_seq !== undefined) {
      clauses.push('seq <= ?');
      params.push(filter.to_seq);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM trading_events ${where} ORDER BY seq ASC`).all(...params) as TradingEventRow[];
    return rows.map(rowToStoredEvent);
  }

  /**
   * Reconstructs projection tables in `targetDb` (which must already have
   * the `001_initial` schema applied) from every event in this store,
   * ordered by `seq`.
   */
  rebuildProjections(targetDb: SqliteDriver): void {
    const repos = {
      trade: createTradeRepository(targetDb),
      order: createOrderRepository(targetDb),
      account: createAccountRepository(targetDb),
    };
    const events = this.replay();
    for (const event of events) {
      applyToProjections(event, repos);
    }
  }
}
