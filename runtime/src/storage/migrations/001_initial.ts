/**
 * runtime/src/storage/migrations/001_initial.ts
 *
 * Creates every table from tech spec §29, foreign keys from §30, indexes,
 * and the `trading_events` append-only triggers (design.md Decision 2).
 * Column types: timestamps `INTEGER` (epoch ms), rates/amounts/quantities
 * `REAL` (decimals, Invariant #5), booleans `INTEGER 0/1`, nested
 * objects/arrays `TEXT` (JSON). Every entity table has `created_at` /
 * `updated_at NOT NULL`. `trading_events` has no foreign keys (spec: "the
 * log must never be rejected").
 */
import type { Migration } from '../migrate';

const UP_SQL = `
CREATE TABLE opportunities (
  opportunity_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  long_exchange TEXT NOT NULL,
  short_exchange TEXT NOT NULL,
  long_funding_rate REAL NOT NULL,
  short_funding_rate REAL NOT NULL,
  funding_spread REAL NOT NULL,
  long_funding_time INTEGER NOT NULL,
  short_funding_time INTEGER NOT NULL,
  long_funding_interval_hours REAL NOT NULL,
  short_funding_interval_hours REAL NOT NULL,
  funding_time_diff_ms INTEGER NOT NULL,
  funding_aligned INTEGER NOT NULL,
  long_price REAL NOT NULL,
  short_price REAL NOT NULL,
  price_difference_pct REAL NOT NULL,
  estimated_fee_pct REAL NOT NULL,
  estimated_slippage_pct REAL NOT NULL,
  estimated_funding_pnl REAL NOT NULL,
  estimated_net_pnl REAL NOT NULL,
  liquidity_score REAL NOT NULL,
  strategy_version TEXT NOT NULL,
  status TEXT NOT NULL,
  rejection_reason TEXT
);

CREATE TABLE trades (
  trade_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(opportunity_id),
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  entry_started_at INTEGER,
  entry_completed_at INTEGER,
  exit_started_at INTEGER,
  exit_completed_at INTEGER,
  status TEXT NOT NULL,
  close_reason TEXT,
  target_notional_per_leg_usdt REAL NOT NULL,
  leverage REAL NOT NULL,
  allocated_margin_usdt REAL NOT NULL,
  allocated_capital_usdt REAL NOT NULL,
  expected_pnl_usdt REAL NOT NULL,
  realized_pnl_usdt REAL,
  risk_status TEXT NOT NULL
);
CREATE INDEX idx_trades_opportunity_id ON trades(opportunity_id);

CREATE TABLE trade_legs (
  leg_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(trade_id),
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  order_side TEXT NOT NULL,
  leverage REAL NOT NULL,
  target_notional_usdt REAL NOT NULL,
  target_quantity REAL NOT NULL,
  actual_notional_usdt REAL,
  actual_quantity REAL,
  margin_allocated_usdt REAL NOT NULL,
  target_entry_price REAL NOT NULL,
  average_entry_price REAL,
  average_exit_price REAL,
  entry_order_ids TEXT NOT NULL,
  exit_order_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  entry_started_at INTEGER,
  entry_completed_at INTEGER,
  exit_started_at INTEGER,
  exit_completed_at INTEGER
);
CREATE INDEX idx_trade_legs_trade_id ON trade_legs(trade_id);

CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  trade_id TEXT NOT NULL REFERENCES trades(trade_id),
  leg_id TEXT NOT NULL REFERENCES trade_legs(leg_id),
  purpose TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  order_type TEXT NOT NULL,
  side TEXT NOT NULL,
  position_side TEXT NOT NULL,
  reduce_only INTEGER NOT NULL,
  requested_quantity REAL NOT NULL,
  requested_notional_usdt REAL NOT NULL,
  requested_price REAL,
  reference_price REAL NOT NULL,
  order_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submit_time INTEGER,
  ack_time INTEGER,
  first_fill_time INTEGER,
  final_fill_time INTEGER,
  cancel_request_time INTEGER,
  cancel_ack_time INTEGER,
  terminal_time INTEGER,
  filled_quantity REAL NOT NULL,
  remaining_quantity REAL NOT NULL,
  average_fill_price REAL,
  estimated_fee_usdt REAL NOT NULL,
  actual_fee_usdt REAL,
  estimated_slippage_pct REAL NOT NULL,
  actual_slippage_pct REAL,
  rejection_reason TEXT,
  timeout_reason TEXT,
  cancel_reject_reason TEXT
);
CREATE INDEX idx_orders_trade_id ON orders(trade_id);
CREATE INDEX idx_orders_leg_id ON orders(leg_id);

CREATE TABLE fills (
  fill_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  trade_id TEXT NOT NULL,
  leg_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  notional_usdt REAL NOT NULL,
  fee_usdt REAL NOT NULL,
  fee_asset TEXT NOT NULL,
  liquidity TEXT NOT NULL,
  slippage_from_reference_pct REAL NOT NULL
);
CREATE INDEX idx_fills_order_id ON fills(order_id);

CREATE TABLE positions (
  position_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  leg_id TEXT NOT NULL REFERENCES trade_legs(leg_id),
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL,
  quantity REAL NOT NULL,
  average_entry_price REAL NOT NULL,
  status TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_positions_leg_id ON positions(leg_id);

CREATE TABLE funding_settlements (
  funding_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  leg_id TEXT NOT NULL REFERENCES trade_legs(leg_id),
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  funding_time INTEGER NOT NULL,
  position_notional REAL NOT NULL,
  funding_rate REAL NOT NULL,
  settled_funding_rate REAL,
  position_side TEXT NOT NULL,
  expected_cashflow_usdt REAL NOT NULL,
  actual_cashflow_usdt REAL,
  settlement_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settlement_timestamp INTEGER,
  mark_price_source TEXT,
  settled_rate_published_at INTEGER,
  publication_delay_ms INTEGER
);
CREATE INDEX idx_funding_settlements_leg_id ON funding_settlements(leg_id);

CREATE TABLE risk_checks (
  risk_check_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  trade_id TEXT REFERENCES trades(trade_id),
  stage TEXT NOT NULL,
  check_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  critical INTEGER NOT NULL,
  value TEXT NOT NULL,
  threshold TEXT NOT NULL,
  reason TEXT,
  config_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_risk_checks_trade_id ON risk_checks(trade_id);

CREATE TABLE trading_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  trade_id TEXT,
  leg_id TEXT,
  order_id TEXT,
  position_id TEXT,
  opportunity_id TEXT,
  session_id TEXT,
  exchange TEXT,
  symbol TEXT,
  payload TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  clock_offset_ms REAL,
  clock_reference TEXT
);
CREATE INDEX idx_trading_events_trade_seq ON trading_events(trade_id, seq);
CREATE INDEX idx_trading_events_type_timestamp ON trading_events(event_type, timestamp);
CREATE INDEX idx_trading_events_order_id ON trading_events(order_id);

CREATE TRIGGER trading_events_no_update
BEFORE UPDATE ON trading_events
BEGIN
  SELECT RAISE(ABORT, 'trading_events is append-only');
END;

CREATE TRIGGER trading_events_no_delete
BEFORE DELETE ON trading_events
BEGIN
  SELECT RAISE(ABORT, 'trading_events is append-only');
END;

CREATE TABLE account_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  snapshot_time INTEGER NOT NULL,
  total_capital_usdt REAL NOT NULL,
  reserved_capital_usdt REAL NOT NULL,
  available_capital_usdt REAL NOT NULL,
  used_margin_usdt REAL NOT NULL,
  realized_pnl_usdt REAL NOT NULL,
  open_trade_count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  trade_id TEXT,
  config_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_account_snapshots_snapshot_time ON account_snapshots(snapshot_time);

CREATE TABLE pnl_snapshots (
  pnl_snapshot_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  snapshot_time INTEGER NOT NULL,
  funding_pnl_usdt REAL NOT NULL,
  price_pnl_usdt REAL NOT NULL,
  fee_usdt REAL NOT NULL,
  unrealized_pnl_usdt REAL NOT NULL,
  net_pnl_usdt REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_pnl_snapshots_trade_id ON pnl_snapshots(trade_id);

CREATE TABLE market_events (
  market_event_id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  event_type TEXT NOT NULL,
  exchange_timestamp INTEGER,
  local_received_timestamp INTEGER NOT NULL,
  sequence INTEGER,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_market_events_exchange_symbol ON market_events(exchange, symbol);

CREATE TABLE funding_rates (
  funding_rate_id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  funding_rate REAL NOT NULL,
  funding_time INTEGER NOT NULL,
  interval_hours REAL,
  recorded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_funding_rates_exchange_symbol ON funding_rates(exchange, symbol);
`;

const DOWN_SQL = `
DROP TABLE IF EXISTS funding_rates;
DROP TABLE IF EXISTS market_events;
DROP TABLE IF EXISTS pnl_snapshots;
DROP TABLE IF EXISTS account_snapshots;
DROP TRIGGER IF EXISTS trading_events_no_delete;
DROP TRIGGER IF EXISTS trading_events_no_update;
DROP TABLE IF EXISTS trading_events;
DROP TABLE IF EXISTS risk_checks;
DROP TABLE IF EXISTS funding_settlements;
DROP TABLE IF EXISTS positions;
DROP TABLE IF EXISTS fills;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS trade_legs;
DROP TABLE IF EXISTS trades;
DROP TABLE IF EXISTS opportunities;
`;

export const migration001: Migration = {
  version: 1,
  name: '001_initial',
  up(db) {
    db.exec(UP_SQL);
  },
  down(db) {
    db.exec(DOWN_SQL);
  },
};
