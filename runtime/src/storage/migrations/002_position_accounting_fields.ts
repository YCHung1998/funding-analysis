/**
 * runtime/src/storage/migrations/002_position_accounting_fields.ts
 *
 * Adds the `position-accounting` additive columns to `positions`
 * (position-funding-pnl design.md Decision 2 / tasks.md 1.1). Reversible:
 * `down` drops the columns by rebuilding the table (SQLite has no
 * `DROP COLUMN` before 3.35; rebuilding keeps this migration portable).
 */
import type { Migration } from '../migrate';

const UP_SQL = `
ALTER TABLE positions ADD COLUMN base_quantity REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN entry_filled_quantity REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN exit_filled_quantity REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN entry_notional_usdt REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN average_exit_price REAL;
ALTER TABLE positions ADD COLUMN realized_price_pnl_usdt REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN fees_usdt REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN slippage_attribution_usdt REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN applied_fill_ids TEXT NOT NULL DEFAULT '[]';
`;

const DOWN_SQL = `
CREATE TABLE positions_pre_002 (
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
INSERT INTO positions_pre_002 (position_id, trade_id, leg_id, exchange, symbol, position_side, quantity, average_entry_price, status, opened_at, closed_at, created_at, updated_at)
  SELECT position_id, trade_id, leg_id, exchange, symbol, position_side, quantity, average_entry_price, status, opened_at, closed_at, created_at, updated_at FROM positions;
DROP TABLE positions;
ALTER TABLE positions_pre_002 RENAME TO positions;
CREATE INDEX idx_positions_leg_id ON positions(leg_id);
`;

export const migration002: Migration = {
  version: 2,
  name: 'position_accounting_fields',
  up(db) {
    db.exec(UP_SQL);
  },
  down(db) {
    db.exec(DOWN_SQL);
  },
};
