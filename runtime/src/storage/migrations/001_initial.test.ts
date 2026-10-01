/**
 * runtime/src/storage/migrations/001_initial.test.ts
 *
 * Task 2.1 — tech spec §29 tables, §30 foreign keys, indexes, and the
 * `trading_events` append-only trigger (spec "Tables and relationships",
 * "Append-only event store").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, rollback } from '../migrate';
import { NodeSqliteDriver } from '../driver';
import { tmpDriver } from '../test-helpers';
import { migration001 } from './001_initial';

describe('001_initial', () => {
  let db: NodeSqliteDriver;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001]);
  });

  afterEach(() => {
    db.close();
  });

  it('creates every table from tech spec §29', () => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const expected of [
      'market_events',
      'funding_rates',
      'opportunities',
      'trades',
      'trade_legs',
      'orders',
      'fills',
      'positions',
      'funding_settlements',
      'risk_checks',
      'trading_events',
      'account_snapshots',
      'pnl_snapshots',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('down removes every object created by up (round trip)', () => {
    rollback(db, [migration001], 0);
    const objects = db
      .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`)
      .all();
    expect(objects).toEqual([]);
  });

  function insertOpportunity(id = 'opp1') {
    db.prepare(
      `INSERT INTO opportunities (
        opportunity_id, symbol, created_at, detected_at, expires_at, updated_at,
        long_exchange, short_exchange, long_funding_rate, short_funding_rate, funding_spread,
        long_funding_time, short_funding_time, long_funding_interval_hours, short_funding_interval_hours,
        funding_time_diff_ms, funding_aligned, long_price, short_price, price_difference_pct,
        estimated_fee_pct, estimated_slippage_pct, estimated_funding_pnl, estimated_net_pnl,
        liquidity_score, strategy_version, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      'BTCUSDT',
      1,
      1,
      2,
      1,
      'Binance',
      'Bybit',
      0.0001,
      0.0002,
      0.0001,
      1,
      1,
      8,
      8,
      0,
      1,
      100,
      100,
      0,
      0.0005,
      0.0005,
      1,
      1,
      1,
      'v1',
      'DETECTED',
    );
  }

  function insertTrade(id = 'trade1', opportunityId = 'opp1') {
    db.prepare(
      `INSERT INTO trades (
        trade_id, opportunity_id, strategy_id, strategy_version, config_version, symbol, mode,
        created_at, updated_at, status, target_notional_per_leg_usdt, leverage,
        allocated_margin_usdt, allocated_capital_usdt, expected_pnl_usdt, risk_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, opportunityId, 's1', 'v1', 'c1', 'BTCUSDT', 'PAPER', 1, 1, 'CREATED', 1000, 1, 100, 1000, 0, '{}');
  }

  function insertLeg(id = 'leg1', tradeId = 'trade1') {
    db.prepare(
      `INSERT INTO trade_legs (
        leg_id, trade_id, exchange, symbol, direction, order_side, leverage,
        target_notional_usdt, target_quantity, margin_allocated_usdt, target_entry_price,
        entry_order_ids, exit_order_ids, status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, tradeId, 'Binance', 'BTCUSDT', 'LONG', 'BUY', 1, 1000, 0.1, 100, 10000, '[]', '[]', 'PENDING', 1, 1);
  }

  function insertOrder(id = 'order1', tradeId = 'trade1', legId = 'leg1') {
    db.prepare(
      `INSERT INTO orders (
        order_id, client_order_id, trade_id, leg_id, purpose, exchange, symbol, order_type, side,
        position_side, reduce_only, requested_quantity, requested_notional_usdt, reference_price,
        order_state, created_at, updated_at, filled_quantity, remaining_quantity,
        estimated_fee_usdt, estimated_slippage_pct
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      `c-${id}`,
      tradeId,
      legId,
      'ENTRY',
      'Binance',
      'BTCUSDT',
      'MARKET',
      'BUY',
      'LONG',
      0,
      0.1,
      1000,
      10000,
      'CREATED',
      1,
      1,
      0,
      0.1,
      1,
      0,
    );
  }

  it('fill referencing a non-existent order_id is rejected by a foreign key error', () => {
    insertOpportunity();
    insertTrade();
    insertLeg();
    insertOrder();
    expect(() =>
      db
        .prepare(
          `INSERT INTO fills (fill_id, order_id, trade_id, leg_id, exchange, timestamp, recorded_at, created_at, updated_at,
            quantity, price, notional_usdt, fee_usdt, fee_asset, liquidity, slippage_from_reference_pct)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('fill1', 'does-not-exist', 'trade1', 'leg1', 'Binance', 1, 1, 1, 1, 0.1, 10000, 1000, 0, 'USDT', 'TAKER', 0),
    ).toThrow();
  });

  it('an OPPORTUNITY_REJECTED event with trade_id = NULL is accepted (trading_events has no foreign keys)', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO trading_events (event_id, event_type, timestamp, trade_id, payload, recorded_at)
          VALUES (?,?,?,?,?,?)`,
        )
        .run('evt1', 'OPPORTUNITY_REJECTED', 1, null, '{}', 1),
    ).not.toThrow();
  });

  it('a trade_legs row inserted without updated_at fails with a NOT NULL constraint error', () => {
    insertOpportunity();
    insertTrade();
    expect(() =>
      db
        .prepare(
          `INSERT INTO trade_legs (
            leg_id, trade_id, exchange, symbol, direction, order_side, leverage,
            target_notional_usdt, target_quantity, margin_allocated_usdt, target_entry_price,
            entry_order_ids, exit_order_ids, status, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('leg1', 'trade1', 'Binance', 'BTCUSDT', 'LONG', 'BUY', 1, 1000, 0.1, 100, 10000, '[]', '[]', 'PENDING', 1),
    ).toThrow(/NOT NULL/i);
  });

  it('trading_events rejects UPDATE', () => {
    db.prepare(`INSERT INTO trading_events (event_id, event_type, timestamp, trade_id, payload, recorded_at) VALUES (?,?,?,?,?,?)`).run(
      'evt1',
      'OPPORTUNITY_DETECTED',
      1,
      null,
      '{}',
      1,
    );
    expect(() => db.exec(`UPDATE trading_events SET event_type = 'X' WHERE event_id = 'evt1'`)).toThrow(/append-only/);
  });

  it('trading_events rejects DELETE', () => {
    db.prepare(`INSERT INTO trading_events (event_id, event_type, timestamp, trade_id, payload, recorded_at) VALUES (?,?,?,?,?,?)`).run(
      'evt1',
      'OPPORTUNITY_DETECTED',
      1,
      null,
      '{}',
      1,
    );
    expect(() => db.exec(`DELETE FROM trading_events WHERE event_id = 'evt1'`)).toThrow(/append-only/);
  });
});
