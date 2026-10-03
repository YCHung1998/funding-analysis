import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, rollback } from '../migrate';
import type { NodeSqliteDriver } from '../driver';
import { tmpDriver } from '../test-helpers';
import { migration001 } from './001_initial';
import { migration002 } from './002_position_accounting_fields';
import { migration003 } from './003_runtime_health';
import { migration004 } from './004_trade_results';

const ALL = [migration001, migration002, migration003, migration004];

describe('004_trade_results', () => {
  let db: NodeSqliteDriver;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, ALL);
  });

  afterEach(() => {
    db.close();
  });

  it('creates trade_results', () => {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toContain('trade_results');
  });

  it('accepts one row per trade_id (round trip of every TradeResult field)', () => {
    db.prepare(
      `INSERT INTO opportunities (opportunity_id, symbol, created_at, detected_at, expires_at, updated_at, long_exchange, short_exchange, long_funding_rate, short_funding_rate, funding_spread, long_funding_time, short_funding_time, long_funding_interval_hours, short_funding_interval_hours, funding_time_diff_ms, funding_aligned, long_price, short_price, price_difference_pct, estimated_fee_pct, estimated_slippage_pct, estimated_funding_pnl, estimated_net_pnl, liquidity_score, strategy_version, status)
       VALUES ('o1','BTCUSDT',0,0,1000000,0,'Binance','Bybit',0.0001,0.0002,0.0001,1,1,8,8,0,1,100,100.1,0.001,0.0005,0.0005,1,0.5,0.9,'v1','SELECTED')`,
    ).run();
    db.prepare(`INSERT INTO trades (trade_id, opportunity_id, strategy_id, strategy_version, config_version, symbol, mode, created_at, updated_at, status, target_notional_per_leg_usdt, leverage, allocated_margin_usdt, allocated_capital_usdt, expected_pnl_usdt, risk_status) VALUES ('t1','o1','s1','v1','c1','BTCUSDT','PAPER',0,0,'CLOSED',1000,1,500,2000,1,'{}')`).run();

    db.prepare(
      `INSERT INTO trade_results (
        trade_id, symbol, mode, long_exchange, short_exchange, target_notional_per_leg_usdt,
        actual_long_notional_usdt, actual_short_notional_usdt, leverage, entry_duration_ms,
        exit_duration_ms, total_trade_duration_ms, funding_pnl_usdt, price_pnl_usdt, fee_usdt,
        slippage_attribution_usdt, net_pnl_usdt, roi_on_capital_pct, roi_on_notional_pct,
        max_leg_imbalance_usdt, max_leg_imbalance_duration_ms, final_status, result_reason,
        finalized_at, funding_confirmed, created_at, updated_at
      ) VALUES (
        't1','BTCUSDT','PAPER','Binance','Bybit',1000,
        1000,1000,1,5000,
        3000,8000,1.5,2.5,0.3,
        -0.1,3.6,0.18,0.18,
        5,200,'PROFIT','PROFIT',
        9000,1,0,9000
      )`,
    ).run();

    const row = db.prepare(`SELECT * FROM trade_results WHERE trade_id = ?`).get('t1') as Record<string, unknown>;
    expect(row.trade_id).toBe('t1');
    expect(row.final_status).toBe('PROFIT');
    expect(row.funding_confirmed).toBe(1);
    expect(row.finalized_at).toBe(9000);
    expect(row.net_pnl_usdt).toBeCloseTo(3.6, 9);
  });

  it('down removes exactly what up created (round trip, leaves 001/002/003 intact)', () => {
    const before = (db.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`).all() as {
      name: string;
    }[])
      .map((r) => r.name)
      .sort();

    rollback(db, ALL, 3);
    const afterDown = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(afterDown).not.toContain('trade_results');
    expect(afterDown).toContain('runtime_health');
    expect(afterDown).toContain('trades');

    migrate(db, ALL);
    const after = (db.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`).all() as {
      name: string;
    }[])
      .map((r) => r.name)
      .sort();
    expect(after).toEqual(before);
  });

  it('full rollback to 0 removes every object', () => {
    rollback(db, ALL, 0);
    const objects = db
      .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`)
      .all() as { name: string }[];
    expect(objects).toEqual([]);
  });
});
