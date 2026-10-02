/**
 * runtime/src/storage/orderRepository.ts
 *
 * `orders` + `fills` + `positions` + `funding_settlements` (design.md §7).
 * No method deletes rows (spec "Lossless repository round trip").
 */
import type { ExchangeId } from '../types/ids';
import type { Fill } from '../types/fill';
import type { FundingSettlement } from '../types/funding';
import type { PaperOrder } from '../types/order';
import type { PaperPosition } from '../types/account';
import type { SqliteDriver } from './driver';
import { boolFromRow, boolToRow, optionalFromRow, optionalToRow } from './rowMapping';

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

const ORDER_COLUMNS = [
  'order_id',
  'client_order_id',
  'trade_id',
  'leg_id',
  'purpose',
  'exchange',
  'symbol',
  'order_type',
  'side',
  'position_side',
  'reduce_only',
  'requested_quantity',
  'requested_notional_usdt',
  'requested_price',
  'reference_price',
  'order_state',
  'created_at',
  'updated_at',
  'submit_time',
  'ack_time',
  'first_fill_time',
  'final_fill_time',
  'cancel_request_time',
  'cancel_ack_time',
  'terminal_time',
  'filled_quantity',
  'remaining_quantity',
  'average_fill_price',
  'estimated_fee_usdt',
  'actual_fee_usdt',
  'estimated_slippage_pct',
  'actual_slippage_pct',
  'rejection_reason',
  'timeout_reason',
  'cancel_reject_reason',
] as const;

function orderToRow(order: PaperOrder): unknown[] {
  return [
    order.order_id,
    order.client_order_id,
    order.trade_id,
    order.leg_id,
    order.purpose,
    order.exchange,
    order.symbol,
    order.order_type,
    order.side,
    order.position_side,
    boolToRow(order.reduce_only),
    order.requested_quantity,
    order.requested_notional_usdt,
    optionalToRow(order.requested_price),
    order.reference_price,
    order.order_state,
    order.created_at,
    order.updated_at,
    optionalToRow(order.submit_time),
    optionalToRow(order.ack_time),
    optionalToRow(order.first_fill_time),
    optionalToRow(order.final_fill_time),
    optionalToRow(order.cancel_request_time),
    optionalToRow(order.cancel_ack_time),
    optionalToRow(order.terminal_time),
    order.filled_quantity,
    order.remaining_quantity,
    optionalToRow(order.average_fill_price),
    order.estimated_fee_usdt,
    optionalToRow(order.actual_fee_usdt),
    order.estimated_slippage_pct,
    optionalToRow(order.actual_slippage_pct),
    optionalToRow(order.rejection_reason),
    optionalToRow(order.timeout_reason),
    optionalToRow(order.cancel_reject_reason),
  ];
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

// ---------------------------------------------------------------------------
// fills
// ---------------------------------------------------------------------------

const FILL_COLUMNS = [
  'fill_id',
  'order_id',
  'trade_id',
  'leg_id',
  'exchange',
  'timestamp',
  'recorded_at',
  'created_at',
  'updated_at',
  'quantity',
  'price',
  'notional_usdt',
  'fee_usdt',
  'fee_asset',
  'liquidity',
  'slippage_from_reference_pct',
] as const;

function fillToRow(fill: Fill): unknown[] {
  return [
    fill.fill_id,
    fill.order_id,
    fill.trade_id,
    fill.leg_id,
    fill.exchange,
    fill.timestamp,
    fill.recorded_at,
    fill.created_at,
    fill.updated_at,
    fill.quantity,
    fill.price,
    fill.notional_usdt,
    fill.fee_usdt,
    fill.fee_asset,
    fill.liquidity,
    fill.slippage_from_reference_pct,
  ];
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

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

const POSITION_COLUMNS = [
  'position_id',
  'trade_id',
  'leg_id',
  'exchange',
  'symbol',
  'position_side',
  'quantity',
  'average_entry_price',
  'status',
  'opened_at',
  'closed_at',
  'created_at',
  'updated_at',
  // position-funding-pnl additive fields (migration 002):
  'base_quantity',
  'entry_filled_quantity',
  'exit_filled_quantity',
  'entry_notional_usdt',
  'average_exit_price',
  'realized_price_pnl_usdt',
  'fees_usdt',
  'slippage_attribution_usdt',
  'applied_fill_ids',
] as const;

function positionToRow(position: PaperPosition): unknown[] {
  return [
    position.position_id,
    position.trade_id,
    position.leg_id,
    position.exchange,
    position.symbol,
    position.position_side,
    position.quantity,
    position.average_entry_price,
    position.status,
    position.opened_at,
    optionalToRow(position.closed_at),
    position.created_at,
    position.updated_at,
    position.base_quantity,
    position.entry_filled_quantity,
    position.exit_filled_quantity,
    position.entry_notional_usdt,
    optionalToRow(position.average_exit_price),
    position.realized_price_pnl_usdt,
    position.fees_usdt,
    position.slippage_attribution_usdt,
    JSON.stringify(position.applied_fill_ids),
  ];
}

interface PositionRow {
  position_id: string;
  trade_id: string;
  leg_id: string;
  exchange: ExchangeId;
  symbol: string;
  position_side: PaperPosition['position_side'];
  quantity: number;
  average_entry_price: number;
  status: PaperPosition['status'];
  opened_at: number;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
  base_quantity: number;
  entry_filled_quantity: number;
  exit_filled_quantity: number;
  entry_notional_usdt: number;
  average_exit_price: number | null;
  realized_price_pnl_usdt: number;
  fees_usdt: number;
  slippage_attribution_usdt: number;
  applied_fill_ids: string;
}

function rowToPosition(row: PositionRow): PaperPosition {
  return {
    position_id: row.position_id,
    trade_id: row.trade_id,
    leg_id: row.leg_id,
    exchange: row.exchange,
    symbol: row.symbol,
    position_side: row.position_side,
    quantity: row.quantity,
    average_entry_price: row.average_entry_price,
    status: row.status,
    opened_at: row.opened_at,
    closed_at: optionalFromRow(row.closed_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    base_quantity: row.base_quantity,
    entry_filled_quantity: row.entry_filled_quantity,
    exit_filled_quantity: row.exit_filled_quantity,
    entry_notional_usdt: row.entry_notional_usdt,
    average_exit_price: optionalFromRow(row.average_exit_price),
    realized_price_pnl_usdt: row.realized_price_pnl_usdt,
    fees_usdt: row.fees_usdt,
    slippage_attribution_usdt: row.slippage_attribution_usdt,
    applied_fill_ids: JSON.parse(row.applied_fill_ids) as string[],
  };
}

// ---------------------------------------------------------------------------
// funding_settlements
// ---------------------------------------------------------------------------

const FUNDING_SETTLEMENT_COLUMNS = [
  'funding_id',
  'trade_id',
  'leg_id',
  'exchange',
  'symbol',
  'funding_time',
  'position_notional',
  'funding_rate',
  'settled_funding_rate',
  'position_side',
  'expected_cashflow_usdt',
  'actual_cashflow_usdt',
  'settlement_status',
  'created_at',
  'updated_at',
  'settlement_timestamp',
  'mark_price_source',
  'settled_rate_published_at',
  'publication_delay_ms',
] as const;

function fundingSettlementToRow(fs: FundingSettlement): unknown[] {
  return [
    fs.funding_id,
    fs.trade_id,
    fs.leg_id,
    fs.exchange,
    fs.symbol,
    fs.funding_time,
    fs.position_notional,
    fs.funding_rate,
    optionalToRow(fs.settled_funding_rate),
    fs.position_side,
    fs.expected_cashflow_usdt,
    optionalToRow(fs.actual_cashflow_usdt),
    fs.settlement_status,
    fs.created_at,
    fs.updated_at,
    optionalToRow(fs.settlement_timestamp),
    optionalToRow(fs.mark_price_source),
    optionalToRow(fs.settled_rate_published_at),
    optionalToRow(fs.publication_delay_ms),
  ];
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

// ---------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------

export interface OrderRepository {
  saveOrder(order: PaperOrder): void;
  getOrder(id: string): PaperOrder | undefined;
  saveFill(fill: Fill): void;
  listFillsForOrder(orderId: string): Fill[];
  savePosition(position: PaperPosition): void;
  getPosition(id: string): PaperPosition | undefined;
  saveFundingSettlement(fs: FundingSettlement): void;
  listFundingSettlementsForLeg(legId: string): FundingSettlement[];
}

/** No method here deletes rows (spec: orders/fills must never be deleted). */
export function createOrderRepository(db: SqliteDriver): OrderRepository {
  const upsertOrder = db.prepare(
    `INSERT INTO orders (${ORDER_COLUMNS.join(', ')}) VALUES (${placeholders(ORDER_COLUMNS.length)})
     ON CONFLICT(order_id) DO UPDATE SET ${ORDER_COLUMNS.filter((c) => c !== 'order_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectOrder = db.prepare(`SELECT * FROM orders WHERE order_id = ?`);

  const upsertFill = db.prepare(
    `INSERT INTO fills (${FILL_COLUMNS.join(', ')}) VALUES (${placeholders(FILL_COLUMNS.length)})
     ON CONFLICT(fill_id) DO UPDATE SET ${FILL_COLUMNS.filter((c) => c !== 'fill_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectFillsForOrder = db.prepare(`SELECT * FROM fills WHERE order_id = ? ORDER BY fill_id`);

  const upsertPosition = db.prepare(
    `INSERT INTO positions (${POSITION_COLUMNS.join(', ')}) VALUES (${placeholders(POSITION_COLUMNS.length)})
     ON CONFLICT(position_id) DO UPDATE SET ${POSITION_COLUMNS.filter((c) => c !== 'position_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectPosition = db.prepare(`SELECT * FROM positions WHERE position_id = ?`);

  const upsertFundingSettlement = db.prepare(
    `INSERT INTO funding_settlements (${FUNDING_SETTLEMENT_COLUMNS.join(', ')}) VALUES (${placeholders(FUNDING_SETTLEMENT_COLUMNS.length)})
     ON CONFLICT(funding_id) DO UPDATE SET ${FUNDING_SETTLEMENT_COLUMNS.filter((c) => c !== 'funding_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectFundingSettlementsForLeg = db.prepare(`SELECT * FROM funding_settlements WHERE leg_id = ? ORDER BY funding_id`);

  return {
    saveOrder(order) {
      upsertOrder.run(...orderToRow(order));
    },
    getOrder(id) {
      const row = selectOrder.get(id) as OrderRow | undefined;
      return row ? rowToOrder(row) : undefined;
    },
    saveFill(fill) {
      upsertFill.run(...fillToRow(fill));
    },
    listFillsForOrder(orderId) {
      const rows = selectFillsForOrder.all(orderId) as FillRow[];
      return rows.map(rowToFill);
    },
    savePosition(position) {
      upsertPosition.run(...positionToRow(position));
    },
    getPosition(id) {
      const row = selectPosition.get(id) as PositionRow | undefined;
      return row ? rowToPosition(row) : undefined;
    },
    saveFundingSettlement(fs) {
      upsertFundingSettlement.run(...fundingSettlementToRow(fs));
    },
    listFundingSettlementsForLeg(legId) {
      const rows = selectFundingSettlementsForLeg.all(legId) as FundingSettlementRow[];
      return rows.map(rowToFundingSettlement);
    },
  };
}
