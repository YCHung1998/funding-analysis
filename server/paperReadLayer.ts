/**
 * server/paperReadLayer.ts
 *
 * `paper-trading-read-api` capability (design.md Decision 1): a dedicated,
 * read-only data-access module for `server.ts`'s four Paper Trading GET
 * routes. Opens the Runtime's SQLite database with
 * `new DatabaseSync(dbPath, { readOnly: true })` (C-06 — the Runtime process
 * is the sole writer; this module only ever `SELECT`s). Lives under
 * `server/`, not `runtime/src/`, to keep "Runtime is the sole writer" a
 * file/directory boundary (design.md Decision 1 "Alternative considered").
 *
 * No exchange-name literal appears in this file (hard project convention
 * mirrored from `runtime/src/market/`'s architecture guard) — every
 * exchange value here is an opaque column value read back from a row.
 *
 * Every exported route function takes the already-opened reader as its
 * first argument (never opens its own connection) — callers (`server.ts`)
 * own the connection lifecycle via `openPaperDb`/`.close()`, mirroring the
 * reader-interface pattern `runtime/src/health/healthPublisher.ts` already
 * established (works with any `{ prepare }` driver, including a real
 * `node:sqlite` `DatabaseSync` opened `{ readOnly: true }`, without forcing
 * every unit test to open one).
 *
 * Error handling (design.md Decision 4): a missing database file, a missing
 * expected table, or (for `/api/paper/account`) no row written yet all
 * surface as `PaperReadLayerUnavailableError` — `server.ts` catches this one
 * error type and maps it to a uniform `503`. An unknown `:trade_id` is a
 * different condition (the data store is fine, the id just doesn't exist)
 * and is signaled by returning `undefined`, which route handlers map to `404`.
 */
import { DatabaseSync } from 'node:sqlite';
import { decodeCursor, encodeCursor } from './paperCursor';
import { boolFromRow, jsonFromRow, optionalFromRow } from '../runtime/src/storage/rowMapping';
import { computeHedgeRatio, type HedgeLegInput } from '../runtime/src/trading/hedgeRatio';
import type {
  AccountSnapshot,
  ExchangeId,
  Fill,
  FundingSettlement,
  Opportunity,
  PaperOrder,
  Trade,
  TradeLeg,
  TradeResult,
  TradeStatus,
  TradingEvent,
} from '../runtime/src/types';

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

export interface PaperReaderStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The minimal read-only surface a `node:sqlite` `DatabaseSync` provides. */
export interface PaperReaderDriver {
  prepare(sql: string): PaperReaderStatement;
}

/**
 * Thrown for every "operational precondition failure" this module detects:
 * the DB file doesn't exist, an expected table is missing, or (account
 * snapshot only) no row has been written yet. `server.ts` maps this to
 * HTTP 503 uniformly (design.md Decision 4) — never an unhandled exception.
 */
export class PaperReadLayerUnavailableError extends Error {
  constructor(message = 'Paper Trading database is not available yet') {
    super(message);
    this.name = 'PaperReadLayerUnavailableError';
  }
}

/**
 * Opens a fresh read-only `node:sqlite` connection; `undefined` if the file
 * doesn't exist yet (fresh install / Runtime never started) — mirrors
 * `runtime-health-reconciliation`'s `server.ts`-local `openPaperDbReadOnly`,
 * kept as a separate copy here (design.md Decision 1) so this capability's
 * connection lifecycle doesn't reach into that change's files.
 */
export function openPaperDb(dbPath: string): DatabaseSync | undefined {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return undefined;
  }
}

function must(reader: PaperReaderDriver | undefined): PaperReaderDriver {
  if (!reader) throw new PaperReadLayerUnavailableError();
  return reader;
}

function selectOne<T>(reader: PaperReaderDriver | undefined, sql: string, params: unknown[] = []): T | undefined {
  const r = must(reader);
  try {
    return r.prepare(sql).get(...params) as T | undefined;
  } catch (err) {
    throw new PaperReadLayerUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

function selectAll<T>(reader: PaperReaderDriver | undefined, sql: string, params: unknown[] = []): T[] {
  const r = must(reader);
  try {
    return r.prepare(sql).all(...params) as T[];
  } catch (err) {
    throw new PaperReadLayerUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Account snapshot (A-5) — task 1.1
// ---------------------------------------------------------------------------

interface AccountSnapshotRow {
  snapshot_id: string;
  mode: AccountSnapshot['mode'];
  snapshot_time: number;
  total_capital_usdt: number;
  reserved_capital_usdt: number;
  available_capital_usdt: number;
  used_margin_usdt: number;
  realized_pnl_usdt: number;
  open_trade_count: number;
  reason: AccountSnapshot['reason'];
  trade_id: string | null;
  config_version: string;
  created_at: number;
  updated_at: number;
}

function rowToAccountSnapshot(row: AccountSnapshotRow): AccountSnapshot {
  return {
    snapshot_id: row.snapshot_id,
    mode: row.mode,
    snapshot_time: row.snapshot_time,
    total_capital_usdt: row.total_capital_usdt,
    reserved_capital_usdt: row.reserved_capital_usdt,
    available_capital_usdt: row.available_capital_usdt,
    used_margin_usdt: row.used_margin_usdt,
    realized_pnl_usdt: row.realized_pnl_usdt,
    open_trade_count: row.open_trade_count,
    reason: row.reason,
    trade_id: optionalFromRow(row.trade_id),
    config_version: row.config_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * `GET /api/paper/account` (A-5, real `AccountSnapshot` shape — design.md
 * Decision 3 / Context "A-5 is stale"). Latest row by `created_at`
 * (spec.md "Latest snapshot returned" scenario), `rowid` as a tie-breaker
 * for same-millisecond writes. No row yet -> `PaperReadLayerUnavailableError`
 * (spec.md "No snapshot yet" -> 503, not an empty-object 200).
 */
export function getAccountSnapshot(reader: PaperReaderDriver | undefined): AccountSnapshot {
  const row = selectOne<AccountSnapshotRow>(
    reader,
    `SELECT * FROM account_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  if (!row) throw new PaperReadLayerUnavailableError('No account snapshot has been written yet');
  return rowToAccountSnapshot(row);
}

// ---------------------------------------------------------------------------
// Trades — shared row mapping (trades / trade_legs)
// ---------------------------------------------------------------------------

interface TradeRow {
  trade_id: string;
  opportunity_id: string;
  strategy_id: string;
  strategy_version: string;
  config_version: string;
  symbol: string;
  mode: Trade['mode'];
  created_at: number;
  updated_at: number;
  entry_started_at: number | null;
  entry_completed_at: number | null;
  exit_started_at: number | null;
  exit_completed_at: number | null;
  status: TradeStatus;
  close_reason: Trade['close_reason'] | null;
  target_notional_per_leg_usdt: number;
  leverage: number;
  allocated_margin_usdt: number;
  allocated_capital_usdt: number;
  expected_pnl_usdt: number;
  realized_pnl_usdt: number | null;
  risk_status: string;
}

interface TradeLegRow {
  leg_id: string;
  trade_id: string;
  exchange: ExchangeId;
  symbol: string;
  direction: TradeLeg['direction'];
  order_side: TradeLeg['order_side'];
  leverage: number;
  target_notional_usdt: number;
  target_quantity: number;
  actual_notional_usdt: number | null;
  actual_quantity: number | null;
  margin_allocated_usdt: number;
  target_entry_price: number;
  average_entry_price: number | null;
  average_exit_price: number | null;
  entry_order_ids: string;
  exit_order_ids: string;
  status: TradeLeg['status'];
  created_at: number;
  updated_at: number;
  entry_started_at: number | null;
  entry_completed_at: number | null;
  exit_started_at: number | null;
  exit_completed_at: number | null;
}

function rowToLeg(row: TradeLegRow): TradeLeg {
  return {
    leg_id: row.leg_id,
    trade_id: row.trade_id,
    exchange: row.exchange,
    symbol: row.symbol,
    direction: row.direction,
    order_side: row.order_side,
    leverage: row.leverage,
    target_notional_usdt: row.target_notional_usdt,
    target_quantity: row.target_quantity,
    actual_notional_usdt: optionalFromRow(row.actual_notional_usdt),
    actual_quantity: optionalFromRow(row.actual_quantity),
    margin_allocated_usdt: row.margin_allocated_usdt,
    target_entry_price: row.target_entry_price,
    average_entry_price: optionalFromRow(row.average_entry_price),
    average_exit_price: optionalFromRow(row.average_exit_price),
    entry_order_ids: jsonFromRow(row.entry_order_ids),
    exit_order_ids: jsonFromRow(row.exit_order_ids),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    entry_started_at: optionalFromRow(row.entry_started_at),
    entry_completed_at: optionalFromRow(row.entry_completed_at),
    exit_started_at: optionalFromRow(row.exit_started_at),
    exit_completed_at: optionalFromRow(row.exit_completed_at),
  };
}

function rowToTrade(row: TradeRow, legs: TradeLeg[]): Trade {
  return {
    trade_id: row.trade_id,
    opportunity_id: row.opportunity_id,
    strategy_id: row.strategy_id,
    strategy_version: row.strategy_version,
    config_version: row.config_version,
    symbol: row.symbol,
    mode: row.mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
    entry_started_at: optionalFromRow(row.entry_started_at),
    entry_completed_at: optionalFromRow(row.entry_completed_at),
    exit_started_at: optionalFromRow(row.exit_started_at),
    exit_completed_at: optionalFromRow(row.exit_completed_at),
    status: row.status,
    close_reason: optionalFromRow(row.close_reason),
    target_notional_per_leg_usdt: row.target_notional_per_leg_usdt,
    leverage: row.leverage,
    allocated_margin_usdt: row.allocated_margin_usdt,
    allocated_capital_usdt: row.allocated_capital_usdt,
    legs,
    expected_pnl_usdt: row.expected_pnl_usdt,
    realized_pnl_usdt: optionalFromRow(row.realized_pnl_usdt),
    risk_status: jsonFromRow(row.risk_status),
  };
}

function legsForTrade(reader: PaperReaderDriver, tradeId: string): TradeLeg[] {
  const rows = selectAll<TradeLegRow>(reader, `SELECT * FROM trade_legs WHERE trade_id = ? ORDER BY leg_id`, [tradeId]);
  return rows.map(rowToLeg);
}

const TRADE_TERMINAL_STATUSES: ReadonlySet<TradeStatus> = new Set(['CLOSED', 'ABORTED', 'FAILED']);
const ALERT_STATUSES: ReadonlySet<TradeStatus> = new Set(['LEG_IMBALANCE', 'EMERGENCY_EXIT', 'FAILED']);

// ---------------------------------------------------------------------------
// Current trades (A-6, task 2.1)
// ---------------------------------------------------------------------------

export interface CurrentTradeSummary extends Trade {
  long_exchange: ExchangeId;
  short_exchange: ExchangeId;
  hedge_ratio: number;
  unrealized_pnl_usdt: number;
  funding_expected_usdt: number;
}

interface PositionLiteRow {
  leg_id: string;
  base_quantity: number;
  average_entry_price: number;
}

/**
 * `hedge_ratio` / `long_exchange` / `short_exchange` / `unrealized_pnl_usdt`
 * / `funding_expected_usdt` are NOT columns on `trades` or `trade_legs`
 * (verified against `runtime/src/storage/migrations/001_initial.ts` — see
 * design.md Implementation Notes "CurrentTradeSummary derived fields" for
 * the full writeup of this drift from proposal.md's Non-goals claim that
 * these "already exist... this change reads and serializes them, it does
 * not compute them"). This derives them from already-persisted raw rows
 * using the Runtime's own existing pure helper (`computeHedgeRatio`,
 * `position-accounting`'s single implementation, C-19 `QUANTITY` basis) —
 * reused, not reforked — rather than inventing new business logic here.
 */
function deriveCurrentTradeFields(
  reader: PaperReaderDriver,
  trade: Trade,
): Pick<CurrentTradeSummary, 'long_exchange' | 'short_exchange' | 'hedge_ratio' | 'unrealized_pnl_usdt' | 'funding_expected_usdt'> {
  const longLeg = trade.legs.find((l) => l.direction === 'LONG');
  const shortLeg = trade.legs.find((l) => l.direction === 'SHORT');

  const positions = selectAll<PositionLiteRow>(
    reader,
    `SELECT leg_id, base_quantity, average_entry_price FROM positions WHERE trade_id = ?`,
    [trade.trade_id],
  );
  const positionByLeg = new Map(positions.map((p) => [p.leg_id, p]));

  const longPos = longLeg ? positionByLeg.get(longLeg.leg_id) : undefined;
  const shortPos = shortLeg ? positionByLeg.get(shortLeg.leg_id) : undefined;
  let hedge_ratio = 0;
  if (longPos && shortPos) {
    const longInput: HedgeLegInput = { base_quantity: longPos.base_quantity, average_entry_price: longPos.average_entry_price };
    const shortInput: HedgeLegInput = { base_quantity: shortPos.base_quantity, average_entry_price: shortPos.average_entry_price };
    hedge_ratio = computeHedgeRatio(longInput, shortInput, 'QUANTITY').hedge_ratio;
  }

  const pnlRow = selectOne<{ unrealized_pnl_usdt: number }>(
    reader,
    `SELECT unrealized_pnl_usdt FROM pnl_snapshots WHERE trade_id = ? ORDER BY snapshot_time DESC, rowid DESC LIMIT 1`,
    [trade.trade_id],
  );

  const fundingRow = selectOne<{ total: number | null }>(
    reader,
    `SELECT SUM(expected_cashflow_usdt) AS total FROM funding_settlements WHERE trade_id = ? AND settlement_status IN ('EXPECTED', 'ELIGIBLE')`,
    [trade.trade_id],
  );

  return {
    long_exchange: (longLeg?.exchange ?? shortLeg?.exchange) as ExchangeId,
    short_exchange: (shortLeg?.exchange ?? longLeg?.exchange) as ExchangeId,
    hedge_ratio,
    unrealized_pnl_usdt: pnlRow?.unrealized_pnl_usdt ?? 0,
    funding_expected_usdt: fundingRow?.total ?? 0,
  };
}

/**
 * `GET /api/paper/trades?scope=current` (A-6, task 2.1). Every trade whose
 * `status` is not terminal, ordered with alert statuses
 * (`LEG_IMBALANCE`/`EMERGENCY_EXIT`/`FAILED`) first and `created_at`
 * descending within each group (`paper-trading-ui/design.md` Decision 6).
 * Unpaginated by design (design.md Decision 2).
 */
export function getCurrentTrades(reader: PaperReaderDriver | undefined): CurrentTradeSummary[] {
  const rows = selectAll<TradeRow>(reader, `SELECT * FROM trades WHERE status NOT IN ('CLOSED', 'ABORTED', 'FAILED')`);
  const r = must(reader);
  const trades = rows.map((row) => rowToTrade(row, legsForTrade(r, row.trade_id)));

  const sorted = [...trades].sort((a, b) => {
    const aAlert = ALERT_STATUSES.has(a.status) ? 0 : 1;
    const bAlert = ALERT_STATUSES.has(b.status) ? 0 : 1;
    if (aAlert !== bAlert) return aAlert - bAlert;
    return b.created_at - a.created_at;
  });

  return sorted.map((trade) => ({ ...trade, ...deriveCurrentTradeFields(r, trade) }));
}

// ---------------------------------------------------------------------------
// Completed trades (A-6, task 2.2)
// ---------------------------------------------------------------------------

export interface CompletedTradeSummary extends Trade {
  result: TradeResult;
}

export interface CompletedTradesFilter {
  final_status?: TradeResult['final_status'];
}

export interface CompletedTradesPage {
  items: CompletedTradeSummary[];
  next_cursor: string | null;
}

interface TradeResultRow {
  trade_id: string;
  symbol: string;
  mode: TradeResult['mode'];
  long_exchange: ExchangeId;
  short_exchange: ExchangeId;
  target_notional_per_leg_usdt: number;
  actual_long_notional_usdt: number;
  actual_short_notional_usdt: number;
  leverage: number;
  entry_duration_ms: number;
  exit_duration_ms: number;
  total_trade_duration_ms: number;
  funding_pnl_usdt: number;
  price_pnl_usdt: number;
  fee_usdt: number;
  slippage_attribution_usdt: number;
  net_pnl_usdt: number;
  roi_on_capital_pct: number;
  roi_on_notional_pct: number;
  max_leg_imbalance_usdt: number;
  max_leg_imbalance_duration_ms: number;
  final_status: TradeResult['final_status'];
  result_reason: string;
  finalized_at: number | null;
  funding_confirmed: number;
  created_at: number;
  updated_at: number;
}

function rowToTradeResult(row: TradeResultRow): TradeResult {
  return {
    trade_id: row.trade_id,
    symbol: row.symbol,
    mode: row.mode,
    long_exchange: row.long_exchange,
    short_exchange: row.short_exchange,
    target_notional_per_leg_usdt: row.target_notional_per_leg_usdt,
    actual_long_notional_usdt: row.actual_long_notional_usdt,
    actual_short_notional_usdt: row.actual_short_notional_usdt,
    leverage: row.leverage,
    entry_duration_ms: row.entry_duration_ms,
    exit_duration_ms: row.exit_duration_ms,
    total_trade_duration_ms: row.total_trade_duration_ms,
    funding_pnl_usdt: row.funding_pnl_usdt,
    price_pnl_usdt: row.price_pnl_usdt,
    fee_usdt: row.fee_usdt,
    slippage_attribution_usdt: row.slippage_attribution_usdt,
    net_pnl_usdt: row.net_pnl_usdt,
    roi_on_capital_pct: row.roi_on_capital_pct,
    roi_on_notional_pct: row.roi_on_notional_pct,
    max_leg_imbalance_usdt: row.max_leg_imbalance_usdt,
    max_leg_imbalance_duration_ms: row.max_leg_imbalance_duration_ms,
    final_status: row.final_status,
    result_reason: row.result_reason,
    finalized_at: optionalFromRow(row.finalized_at),
    funding_confirmed: boolFromRow(row.funding_confirmed),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface CompletedCursorKey {
  sort_key: number;
  trade_id: string;
}

/**
 * `GET /api/paper/trades?scope=completed` (A-6, task 2.2). Sorted by
 * `finalized_at ?? updated_at` descending, `trade_id` as tie-breaker
 * (design.md Decision 2). Keyset pagination over `(sort_key, trade_id)` —
 * stable under concurrent insert (spec.md "Stable under concurrent insert").
 */
export function getCompletedTrades(
  reader: PaperReaderDriver | undefined,
  filter: CompletedTradesFilter,
  cursor: string | null,
  limit: number,
): CompletedTradesPage {
  const r = must(reader);

  let cursorKey: CompletedCursorKey | null = null;
  if (cursor !== null) {
    const decoded = decodeCursor<CompletedCursorKey>(cursor);
    if (decoded === null) throw new MalformedCursorError();
    cursorKey = decoded;
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.final_status) {
    clauses.push('final_status = ?');
    params.push(filter.final_status);
  }
  if (cursorKey) {
    clauses.push('(COALESCE(finalized_at, updated_at), trade_id) < (?, ?)');
    params.push(cursorKey.sort_key, cursorKey.trade_id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const resultRows = selectAll<TradeResultRow>(
    r,
    `SELECT * FROM trade_results
     ${where}
     ORDER BY COALESCE(finalized_at, updated_at) DESC, trade_id DESC
     LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = resultRows.length > limit;
  const page = resultRows.slice(0, limit);

  const items: CompletedTradeSummary[] = page.map((resultRow) => {
    const tradeRow = selectOne<TradeRow>(r, `SELECT * FROM trades WHERE trade_id = ?`, [resultRow.trade_id]);
    if (!tradeRow) throw new PaperReadLayerUnavailableError(`trades row missing for completed trade ${resultRow.trade_id}`);
    const trade = rowToTrade(tradeRow, legsForTrade(r, resultRow.trade_id));
    const result = rowToTradeResult(resultRow);
    return { ...trade, result };
  });

  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last
      ? encodeCursor<CompletedCursorKey>({ sort_key: last.finalized_at ?? last.updated_at, trade_id: last.trade_id })
      : null;

  return { items, next_cursor };
}

export class MalformedCursorError extends Error {
  constructor() {
    super('Malformed cursor');
    this.name = 'MalformedCursorError';
  }
}

// ---------------------------------------------------------------------------
// Trade detail (A-7, task 2.3)
// ---------------------------------------------------------------------------

export interface TradeDetailResponse {
  trade: Trade;
  legs: TradeLeg[];
  orders: PaperOrder[];
  fills: Fill[];
  funding_settlements: FundingSettlement[];
  opportunity: Opportunity;
  result?: TradeResult;
}

interface OpportunityRow {
  opportunity_id: string;
  symbol: string;
  created_at: number;
  detected_at: number;
  expires_at: number;
  updated_at: number;
  long_exchange: ExchangeId;
  short_exchange: ExchangeId;
  long_funding_rate: number;
  short_funding_rate: number;
  funding_spread: number;
  long_funding_time: number;
  short_funding_time: number;
  long_funding_interval_hours: number;
  short_funding_interval_hours: number;
  funding_time_diff_ms: number;
  funding_aligned: number;
  long_price: number;
  short_price: number;
  price_difference_pct: number;
  estimated_fee_pct: number;
  estimated_slippage_pct: number;
  estimated_funding_pnl: number;
  estimated_net_pnl: number;
  liquidity_score: number;
  strategy_version: string;
  status: Opportunity['status'];
  rejection_reason: string | null;
}

function rowToOpportunity(row: OpportunityRow): Opportunity {
  return {
    opportunity_id: row.opportunity_id,
    symbol: row.symbol,
    created_at: row.created_at,
    detected_at: row.detected_at,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    long_exchange: row.long_exchange,
    short_exchange: row.short_exchange,
    long_funding_rate: row.long_funding_rate,
    short_funding_rate: row.short_funding_rate,
    funding_spread: row.funding_spread,
    long_funding_time: row.long_funding_time,
    short_funding_time: row.short_funding_time,
    long_funding_interval_hours: row.long_funding_interval_hours,
    short_funding_interval_hours: row.short_funding_interval_hours,
    funding_time_diff_ms: row.funding_time_diff_ms,
    funding_aligned: boolFromRow(row.funding_aligned),
    long_price: row.long_price,
    short_price: row.short_price,
    price_difference_pct: row.price_difference_pct,
    estimated_fee_pct: row.estimated_fee_pct,
    estimated_slippage_pct: row.estimated_slippage_pct,
    estimated_funding_pnl: row.estimated_funding_pnl,
    estimated_net_pnl: row.estimated_net_pnl,
    liquidity_score: row.liquidity_score,
    strategy_version: row.strategy_version,
    status: row.status,
    rejection_reason: optionalFromRow(row.rejection_reason),
  };
}

interface OrderRow {
  order_id: string;
  client_order_id: string;
  trade_id: string;
  leg_id: string;
  purpose: PaperOrder['purpose'];
  exchange: ExchangeId;
  symbol: string;
  order_type: PaperOrder['order_type'];
  side: PaperOrder['side'];
  position_side: PaperOrder['position_side'];
  reduce_only: number;
  requested_quantity: number;
  requested_notional_usdt: number;
  requested_price: number | null;
  reference_price: number;
  order_state: PaperOrder['order_state'];
  created_at: number;
  updated_at: number;
  submit_time: number | null;
  ack_time: number | null;
  first_fill_time: number | null;
  final_fill_time: number | null;
  cancel_request_time: number | null;
  cancel_ack_time: number | null;
  terminal_time: number | null;
  filled_quantity: number;
  remaining_quantity: number;
  average_fill_price: number | null;
  estimated_fee_usdt: number;
  actual_fee_usdt: number | null;
  estimated_slippage_pct: number;
  actual_slippage_pct: number | null;
  rejection_reason: string | null;
  timeout_reason: string | null;
  cancel_reject_reason: string | null;
}

function rowToOrder(row: OrderRow): PaperOrder {
  return {
    order_id: row.order_id,
    client_order_id: row.client_order_id,
    trade_id: row.trade_id,
    leg_id: row.leg_id,
    purpose: row.purpose,
    exchange: row.exchange,
    symbol: row.symbol,
    order_type: row.order_type,
    side: row.side,
    position_side: row.position_side,
    reduce_only: boolFromRow(row.reduce_only),
    requested_quantity: row.requested_quantity,
    requested_notional_usdt: row.requested_notional_usdt,
    requested_price: optionalFromRow(row.requested_price),
    reference_price: row.reference_price,
    order_state: row.order_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    submit_time: optionalFromRow(row.submit_time),
    ack_time: optionalFromRow(row.ack_time),
    first_fill_time: optionalFromRow(row.first_fill_time),
    final_fill_time: optionalFromRow(row.final_fill_time),
    cancel_request_time: optionalFromRow(row.cancel_request_time),
    cancel_ack_time: optionalFromRow(row.cancel_ack_time),
    terminal_time: optionalFromRow(row.terminal_time),
    filled_quantity: row.filled_quantity,
    remaining_quantity: row.remaining_quantity,
    average_fill_price: optionalFromRow(row.average_fill_price),
    estimated_fee_usdt: row.estimated_fee_usdt,
    actual_fee_usdt: optionalFromRow(row.actual_fee_usdt),
    estimated_slippage_pct: row.estimated_slippage_pct,
    actual_slippage_pct: optionalFromRow(row.actual_slippage_pct),
    rejection_reason: optionalFromRow(row.rejection_reason),
    timeout_reason: optionalFromRow(row.timeout_reason),
    cancel_reject_reason: optionalFromRow(row.cancel_reject_reason),
  };
}

interface FillRow {
  fill_id: string;
  order_id: string;
  trade_id: string;
  leg_id: string;
  exchange: ExchangeId;
  timestamp: number;
  recorded_at: number;
  created_at: number;
  updated_at: number;
  quantity: number;
  price: number;
  notional_usdt: number;
  fee_usdt: number;
  fee_asset: string;
  liquidity: Fill['liquidity'];
  slippage_from_reference_pct: number;
}

function rowToFill(row: FillRow): Fill {
  return {
    fill_id: row.fill_id,
    order_id: row.order_id,
    trade_id: row.trade_id,
    leg_id: row.leg_id,
    exchange: row.exchange,
    timestamp: row.timestamp,
    recorded_at: row.recorded_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    quantity: row.quantity,
    price: row.price,
    notional_usdt: row.notional_usdt,
    fee_usdt: row.fee_usdt,
    fee_asset: row.fee_asset,
    liquidity: row.liquidity,
    slippage_from_reference_pct: row.slippage_from_reference_pct,
  };
}

interface FundingSettlementRow {
  funding_id: string;
  trade_id: string;
  leg_id: string;
  exchange: ExchangeId;
  symbol: string;
  funding_time: number;
  position_notional: number;
  funding_rate: number;
  settled_funding_rate: number | null;
  position_side: FundingSettlement['position_side'];
  expected_cashflow_usdt: number;
  actual_cashflow_usdt: number | null;
  settlement_status: FundingSettlement['settlement_status'];
  created_at: number;
  updated_at: number;
  settlement_timestamp: number | null;
  mark_price_source: FundingSettlement['mark_price_source'] | null;
  settled_rate_published_at: number | null;
  publication_delay_ms: number | null;
}

function rowToFundingSettlement(row: FundingSettlementRow): FundingSettlement {
  return {
    funding_id: row.funding_id,
    trade_id: row.trade_id,
    leg_id: row.leg_id,
    exchange: row.exchange,
    symbol: row.symbol,
    funding_time: row.funding_time,
    position_notional: row.position_notional,
    funding_rate: row.funding_rate,
    settled_funding_rate: optionalFromRow(row.settled_funding_rate),
    position_side: row.position_side,
    expected_cashflow_usdt: row.expected_cashflow_usdt,
    actual_cashflow_usdt: optionalFromRow(row.actual_cashflow_usdt),
    settlement_status: row.settlement_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    settlement_timestamp: optionalFromRow(row.settlement_timestamp),
    mark_price_source: optionalFromRow(row.mark_price_source),
    settled_rate_published_at: optionalFromRow(row.settled_rate_published_at),
    publication_delay_ms: optionalFromRow(row.publication_delay_ms),
  };
}

/**
 * `GET /api/paper/trades/:trade_id` (A-7, task 2.3). `result` is present only
 * once a `trade_results` row exists (spec.md "Open trade has no result" /
 * "Closed trade includes result"). Unknown `trade_id` -> `undefined` (caller
 * maps to 404 — distinct from `PaperReadLayerUnavailableError`'s 503).
 */
export function getTradeDetail(reader: PaperReaderDriver | undefined, tradeId: string): TradeDetailResponse | undefined {
  const r = must(reader);
  const tradeRow = selectOne<TradeRow>(r, `SELECT * FROM trades WHERE trade_id = ?`, [tradeId]);
  if (!tradeRow) return undefined;

  const trade = rowToTrade(tradeRow, legsForTrade(r, tradeId));
  const orders = selectAll<OrderRow>(r, `SELECT * FROM orders WHERE trade_id = ? ORDER BY order_id`, [tradeId]).map(rowToOrder);
  const fills = selectAll<FillRow>(
    r,
    `SELECT * FROM fills WHERE trade_id = ? ORDER BY fill_id`,
    [tradeId],
  ).map(rowToFill);
  const fundingSettlements = selectAll<FundingSettlementRow>(
    r,
    `SELECT * FROM funding_settlements WHERE trade_id = ? ORDER BY funding_id`,
    [tradeId],
  ).map(rowToFundingSettlement);
  const opportunityRow = selectOne<OpportunityRow>(r, `SELECT * FROM opportunities WHERE opportunity_id = ?`, [trade.opportunity_id]);
  if (!opportunityRow) throw new PaperReadLayerUnavailableError(`Opportunity ${trade.opportunity_id} missing for trade ${tradeId}`);
  const opportunity = rowToOpportunity(opportunityRow);

  const resultRow = selectOne<TradeResultRow>(r, `SELECT * FROM trade_results WHERE trade_id = ?`, [tradeId]);
  const result = resultRow ? rowToTradeResult(resultRow) : undefined;

  return {
    trade,
    legs: trade.legs,
    orders,
    fills,
    funding_settlements: fundingSettlements,
    opportunity,
    ...(result ? { result } : {}),
  };
}

// ---------------------------------------------------------------------------
// Trade events (A-8, task 3.1)
// ---------------------------------------------------------------------------

export interface TradeEventsPage {
  items: Array<TradingEvent & { seq: number }>;
  next_cursor: string | null;
}

interface TradingEventRow {
  seq: number;
  event_id: string;
  event_type: TradingEvent['event_type'];
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

function rowToTradingEvent(row: TradingEventRow): TradingEvent & { seq: number } {
  const event: TradingEvent & { seq: number } = {
    seq: row.seq,
    event_id: row.event_id,
    event_type: row.event_type,
    timestamp: row.timestamp,
    trade_id: row.trade_id,
    payload: jsonFromRow(row.payload),
    recorded_at: row.recorded_at,
  };
  if (row.leg_id !== null) event.leg_id = row.leg_id;
  if (row.order_id !== null) event.order_id = row.order_id;
  if (row.position_id !== null) event.position_id = row.position_id;
  if (row.opportunity_id !== null) event.opportunity_id = row.opportunity_id;
  if (row.session_id !== null) event.session_id = row.session_id;
  if (row.exchange !== null) event.exchange = row.exchange as ExchangeId;
  if (row.symbol !== null) event.symbol = row.symbol;
  if (row.clock_offset_ms !== null) event.clock_offset_ms = row.clock_offset_ms;
  if (row.clock_reference !== null) event.clock_reference = row.clock_reference as ExchangeId;
  return event;
}

interface SeqCursorKey {
  seq: number;
}

/**
 * `GET /api/paper/trades/:trade_id/events` (A-8, task 3.1). `seq` ascending
 * (the archived `trading-event-store` design's global monotonic ordering,
 * reused here rather than `timestamp`). Keyset pagination via `paperCursor.ts`
 * (shared with `getCompletedTrades`). Unknown `trade_id` -> `undefined`
 * (caller maps to 404) — checked against `trades`, not inferred from an
 * empty event list (a brand-new trade legitimately has zero events yet).
 */
export function getTradeEvents(
  reader: PaperReaderDriver | undefined,
  tradeId: string,
  cursor: string | null,
  limit: number,
): TradeEventsPage | undefined {
  const r = must(reader);
  const tradeExists = selectOne<{ trade_id: string }>(r, `SELECT trade_id FROM trades WHERE trade_id = ?`, [tradeId]);
  if (!tradeExists) return undefined;

  let cursorKey: SeqCursorKey | null = null;
  if (cursor !== null) {
    const decoded = decodeCursor<SeqCursorKey>(cursor);
    if (decoded === null) throw new MalformedCursorError();
    cursorKey = decoded;
  }

  const clauses = ['trade_id = ?'];
  const params: unknown[] = [tradeId];
  if (cursorKey) {
    clauses.push('seq > ?');
    params.push(cursorKey.seq);
  }

  const rows = selectAll<TradingEventRow>(
    r,
    `SELECT * FROM trading_events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(rowToTradingEvent);
  const last = page[page.length - 1];
  const next_cursor = hasMore && last ? encodeCursor<SeqCursorKey>({ seq: last.seq }) : null;

  return { items: page, next_cursor };
}
