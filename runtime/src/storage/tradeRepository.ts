/**
 * runtime/src/storage/tradeRepository.ts
 *
 * `opportunities`, `trades` + nested `trade_legs`, and `risk_checks`
 * (design.md §7). No method deletes rows (spec "Lossless repository round
 * trip": unfinished trades, including `ABORTED` with zero fills, must never
 * be deleted).
 */
import type { ExchangeId } from '../types/ids';
import type { Opportunity } from '../types/opportunity';
import type { RiskCheck } from '../types/risk';
import type { Trade, TradeLeg } from '../types/trade';
import type { SqliteDriver } from './driver';
import { boolFromRow, boolToRow, jsonFromRow, jsonToRow, optionalFromRow, optionalToRow } from './rowMapping';

const OPPORTUNITY_COLUMNS = [
  'opportunity_id',
  'symbol',
  'created_at',
  'detected_at',
  'expires_at',
  'updated_at',
  'long_exchange',
  'short_exchange',
  'long_funding_rate',
  'short_funding_rate',
  'funding_spread',
  'long_funding_time',
  'short_funding_time',
  'long_funding_interval_hours',
  'short_funding_interval_hours',
  'funding_time_diff_ms',
  'funding_aligned',
  'long_price',
  'short_price',
  'price_difference_pct',
  'estimated_fee_pct',
  'estimated_slippage_pct',
  'estimated_funding_pnl',
  'estimated_net_pnl',
  'liquidity_score',
  'strategy_version',
  'status',
  'rejection_reason',
] as const;

function opportunityToRow(opp: Opportunity): unknown[] {
  return [
    opp.opportunity_id,
    opp.symbol,
    opp.created_at,
    opp.detected_at,
    opp.expires_at,
    opp.updated_at,
    opp.long_exchange,
    opp.short_exchange,
    opp.long_funding_rate,
    opp.short_funding_rate,
    opp.funding_spread,
    opp.long_funding_time,
    opp.short_funding_time,
    opp.long_funding_interval_hours,
    opp.short_funding_interval_hours,
    opp.funding_time_diff_ms,
    boolToRow(opp.funding_aligned),
    opp.long_price,
    opp.short_price,
    opp.price_difference_pct,
    opp.estimated_fee_pct,
    opp.estimated_slippage_pct,
    opp.estimated_funding_pnl,
    opp.estimated_net_pnl,
    opp.liquidity_score,
    opp.strategy_version,
    opp.status,
    optionalToRow(opp.rejection_reason),
  ];
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

const TRADE_LEG_COLUMNS = [
  'leg_id',
  'trade_id',
  'exchange',
  'symbol',
  'direction',
  'order_side',
  'leverage',
  'target_notional_usdt',
  'target_quantity',
  'actual_notional_usdt',
  'actual_quantity',
  'margin_allocated_usdt',
  'target_entry_price',
  'average_entry_price',
  'average_exit_price',
  'entry_order_ids',
  'exit_order_ids',
  'status',
  'created_at',
  'updated_at',
  'entry_started_at',
  'entry_completed_at',
  'exit_started_at',
  'exit_completed_at',
] as const;

function legToRow(leg: TradeLeg): unknown[] {
  return [
    leg.leg_id,
    leg.trade_id,
    leg.exchange,
    leg.symbol,
    leg.direction,
    leg.order_side,
    leg.leverage,
    leg.target_notional_usdt,
    leg.target_quantity,
    optionalToRow(leg.actual_notional_usdt),
    optionalToRow(leg.actual_quantity),
    leg.margin_allocated_usdt,
    leg.target_entry_price,
    optionalToRow(leg.average_entry_price),
    optionalToRow(leg.average_exit_price),
    jsonToRow(leg.entry_order_ids),
    jsonToRow(leg.exit_order_ids),
    leg.status,
    leg.created_at,
    leg.updated_at,
    optionalToRow(leg.entry_started_at),
    optionalToRow(leg.entry_completed_at),
    optionalToRow(leg.exit_started_at),
    optionalToRow(leg.exit_completed_at),
  ];
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

const TRADE_COLUMNS = [
  'trade_id',
  'opportunity_id',
  'strategy_id',
  'strategy_version',
  'config_version',
  'symbol',
  'mode',
  'created_at',
  'updated_at',
  'entry_started_at',
  'entry_completed_at',
  'exit_started_at',
  'exit_completed_at',
  'status',
  'close_reason',
  'target_notional_per_leg_usdt',
  'leverage',
  'allocated_margin_usdt',
  'allocated_capital_usdt',
  'expected_pnl_usdt',
  'realized_pnl_usdt',
  'risk_status',
] as const;

function tradeToRow(trade: Trade): unknown[] {
  return [
    trade.trade_id,
    trade.opportunity_id,
    trade.strategy_id,
    trade.strategy_version,
    trade.config_version,
    trade.symbol,
    trade.mode,
    trade.created_at,
    trade.updated_at,
    optionalToRow(trade.entry_started_at),
    optionalToRow(trade.entry_completed_at),
    optionalToRow(trade.exit_started_at),
    optionalToRow(trade.exit_completed_at),
    trade.status,
    optionalToRow(trade.close_reason),
    trade.target_notional_per_leg_usdt,
    trade.leverage,
    trade.allocated_margin_usdt,
    trade.allocated_capital_usdt,
    trade.expected_pnl_usdt,
    optionalToRow(trade.realized_pnl_usdt),
    jsonToRow(trade.risk_status),
  ];
}

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
  status: Trade['status'];
  close_reason: Trade['close_reason'] | null;
  target_notional_per_leg_usdt: number;
  leverage: number;
  allocated_margin_usdt: number;
  allocated_capital_usdt: number;
  expected_pnl_usdt: number;
  realized_pnl_usdt: number | null;
  risk_status: string;
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

const RISK_CHECK_COLUMNS = [
  'risk_check_id',
  'opportunity_id',
  'trade_id',
  'stage',
  'check_id',
  'name',
  'status',
  'critical',
  'value',
  'threshold',
  'reason',
  'config_version',
  'created_at',
  'updated_at',
] as const;

function riskCheckToRow(rc: RiskCheck): unknown[] {
  return [
    rc.risk_check_id,
    rc.opportunity_id,
    optionalToRow(rc.trade_id),
    rc.stage,
    rc.check_id,
    rc.name,
    rc.status,
    boolToRow(rc.critical),
    rc.value,
    rc.threshold,
    optionalToRow(rc.reason),
    rc.config_version,
    rc.created_at,
    rc.updated_at,
  ];
}

interface RiskCheckRow {
  risk_check_id: string;
  opportunity_id: string;
  trade_id: string | null;
  stage: RiskCheck['stage'];
  check_id: string;
  name: string;
  status: RiskCheck['status'];
  critical: number;
  value: string;
  threshold: string;
  reason: string | null;
  config_version: string;
  created_at: number;
  updated_at: number;
}

function rowToRiskCheck(row: RiskCheckRow): RiskCheck {
  return {
    risk_check_id: row.risk_check_id,
    opportunity_id: row.opportunity_id,
    trade_id: optionalFromRow(row.trade_id),
    stage: row.stage,
    check_id: row.check_id,
    name: row.name,
    status: row.status,
    critical: boolFromRow(row.critical),
    value: row.value,
    threshold: row.threshold,
    reason: optionalFromRow(row.reason),
    config_version: row.config_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface TradeRepository {
  saveOpportunity(opp: Opportunity): void;
  getOpportunity(id: string): Opportunity | undefined;
  saveTrade(trade: Trade): void;
  saveTradeLeg(leg: TradeLeg): void;
  getTrade(id: string): Trade | undefined;
  saveRiskCheck(rc: RiskCheck): void;
  listRiskChecksForTrade(tradeId: string): RiskCheck[];
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** No method here deletes rows (spec: unfinished / ABORTED trades must never be deleted). */
export function createTradeRepository(db: SqliteDriver): TradeRepository {
  const upsertOpportunity = db.prepare(
    `INSERT INTO opportunities (${OPPORTUNITY_COLUMNS.join(', ')}) VALUES (${placeholders(OPPORTUNITY_COLUMNS.length)})
     ON CONFLICT(opportunity_id) DO UPDATE SET ${OPPORTUNITY_COLUMNS.filter((c) => c !== 'opportunity_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectOpportunity = db.prepare(`SELECT * FROM opportunities WHERE opportunity_id = ?`);

  const upsertTrade = db.prepare(
    `INSERT INTO trades (${TRADE_COLUMNS.join(', ')}) VALUES (${placeholders(TRADE_COLUMNS.length)})
     ON CONFLICT(trade_id) DO UPDATE SET ${TRADE_COLUMNS.filter((c) => c !== 'trade_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectTrade = db.prepare(`SELECT * FROM trades WHERE trade_id = ?`);

  const upsertLeg = db.prepare(
    `INSERT INTO trade_legs (${TRADE_LEG_COLUMNS.join(', ')}) VALUES (${placeholders(TRADE_LEG_COLUMNS.length)})
     ON CONFLICT(leg_id) DO UPDATE SET ${TRADE_LEG_COLUMNS.filter((c) => c !== 'leg_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectLegsForTrade = db.prepare(`SELECT * FROM trade_legs WHERE trade_id = ? ORDER BY leg_id`);

  const upsertRiskCheck = db.prepare(
    `INSERT INTO risk_checks (${RISK_CHECK_COLUMNS.join(', ')}) VALUES (${placeholders(RISK_CHECK_COLUMNS.length)})
     ON CONFLICT(risk_check_id) DO UPDATE SET ${RISK_CHECK_COLUMNS.filter((c) => c !== 'risk_check_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectRiskChecksForTrade = db.prepare(`SELECT * FROM risk_checks WHERE trade_id = ? ORDER BY risk_check_id`);

  return {
    saveOpportunity(opp) {
      upsertOpportunity.run(...opportunityToRow(opp));
    },
    getOpportunity(id) {
      const row = selectOpportunity.get(id) as OpportunityRow | undefined;
      return row ? rowToOpportunity(row) : undefined;
    },
    saveTrade(trade) {
      db.transaction(() => {
        upsertTrade.run(...tradeToRow(trade));
        for (const leg of trade.legs) {
          upsertLeg.run(...legToRow(leg));
        }
      });
    },
    saveTradeLeg(leg) {
      upsertLeg.run(...legToRow(leg));
    },
    getTrade(id) {
      const row = selectTrade.get(id) as TradeRow | undefined;
      if (!row) return undefined;
      const legRows = selectLegsForTrade.all(id) as TradeLegRow[];
      return rowToTrade(row, legRows.map(rowToLeg));
    },
    saveRiskCheck(rc) {
      upsertRiskCheck.run(...riskCheckToRow(rc));
    },
    listRiskChecksForTrade(tradeId) {
      const rows = selectRiskChecksForTrade.all(tradeId) as RiskCheckRow[];
      return rows.map(rowToRiskCheck);
    },
  };
}
