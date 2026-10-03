/**
 * runtime/src/storage/migrations/004_trade_results.ts
 *
 * `paper-trading-read-api` task 1.1 implementation note: `runtime/src/types/result.ts`'s
 * `TradeResult` (spec §21) has never had a persisted table — `accounting/tradeResultAssembler.ts`
 * only builds the value in memory, and `assets/HANDOFF.md`'s `position-funding-pnl` entry
 * explicitly defers "何時提交 TradeResult 到資料庫" to the not-yet-built Runtime main loop /
 * Trade Manager. `paper-trading-read-api/design.md`'s Migration Plan assumed "no schema
 * migration (reads existing tables as-is)" — that assumption was stale: the completed-trades
 * (A-6) and trade-detail (A-7) routes both require a `trade_results` row per finalized Trade,
 * and no such table exists in 001-003. This migration adds it (additive, reversible, same
 * conventions as 001/002/003) so this change's read routes have something to read; the Runtime
 * write-path that inserts into it is explicitly out of scope here (see design.md Implementation
 * Notes for the full resolution writeup).
 *
 * Column layout mirrors `TradeResult` 1:1 (spec §21 field names verbatim, `INTEGER` epoch-ms
 * timestamps, `REAL` amounts/ratios, `INTEGER 0/1` for `funding_confirmed`). `trade_id` is the
 * primary key — one result per trade, upserted as it is re-assembled from provisional to final
 * (`tradeResultAssembler.ts`'s own doc comment: "re-built... on every settlement update").
 */
import type { Migration } from '../migrate';

const UP_SQL = `
CREATE TABLE trade_results (
  trade_id TEXT PRIMARY KEY REFERENCES trades(trade_id),
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  long_exchange TEXT NOT NULL,
  short_exchange TEXT NOT NULL,
  target_notional_per_leg_usdt REAL NOT NULL,
  actual_long_notional_usdt REAL NOT NULL,
  actual_short_notional_usdt REAL NOT NULL,
  leverage REAL NOT NULL,
  entry_duration_ms INTEGER NOT NULL,
  exit_duration_ms INTEGER NOT NULL,
  total_trade_duration_ms INTEGER NOT NULL,
  funding_pnl_usdt REAL NOT NULL,
  price_pnl_usdt REAL NOT NULL,
  fee_usdt REAL NOT NULL,
  slippage_attribution_usdt REAL NOT NULL,
  net_pnl_usdt REAL NOT NULL,
  roi_on_capital_pct REAL NOT NULL,
  roi_on_notional_pct REAL NOT NULL,
  max_leg_imbalance_usdt REAL NOT NULL,
  max_leg_imbalance_duration_ms INTEGER NOT NULL,
  final_status TEXT NOT NULL,
  result_reason TEXT NOT NULL,
  finalized_at INTEGER,
  funding_confirmed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_trade_results_final_status ON trade_results(final_status);
CREATE INDEX idx_trade_results_finalized_updated ON trade_results(finalized_at, updated_at);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS idx_trade_results_finalized_updated;
DROP INDEX IF EXISTS idx_trade_results_final_status;
DROP TABLE IF EXISTS trade_results;
`;

export const migration004: Migration = {
  version: 4,
  name: 'trade_results',
  up(db) {
    db.exec(UP_SQL);
  },
  down(db) {
    db.exec(DOWN_SQL);
  },
};
