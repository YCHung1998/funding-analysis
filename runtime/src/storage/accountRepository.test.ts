/**
 * runtime/src/storage/accountRepository.test.ts
 *
 * Task 2.2 — lossless round trip for AccountSnapshot and the minimal
 * PnL snapshot (design.md §4 Decision 2 field list).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSnapshot } from '../types';
import { NodeSqliteDriver } from './driver';
import { migrate } from './migrate';
import { migration001 } from './migrations/001_initial';
import { createAccountRepository, type AccountRepository, type PnlSnapshot } from './accountRepository';
import { tmpDriver } from './test-helpers';

describe('accountRepository', () => {
  let db: NodeSqliteDriver;
  let repo: AccountRepository;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001]);
    repo = createAccountRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('AccountSnapshot round trips losslessly', () => {
    const snapshot: AccountSnapshot = {
      snapshot_id: 's1',
      mode: 'PAPER',
      snapshot_time: 1,
      total_capital_usdt: 10000,
      reserved_capital_usdt: 1000,
      available_capital_usdt: 9000,
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 1,
      reason: 'CAPITAL_RESERVED',
      trade_id: 'trade1',
      config_version: 'c1',
      created_at: 1,
      updated_at: 1,
    };
    repo.saveAccountSnapshot(snapshot);
    expect(repo.getAccountSnapshot('s1')).toEqual(snapshot);
  });

  it('getLatestAccountSnapshot returns the most recent snapshot for a mode', () => {
    const base = {
      mode: 'PAPER' as const,
      total_capital_usdt: 10000,
      reserved_capital_usdt: 0,
      available_capital_usdt: 10000,
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 0,
      config_version: 'c1',
    };
    repo.saveAccountSnapshot({ ...base, snapshot_id: 's1', snapshot_time: 1, reason: 'INITIAL', created_at: 1, updated_at: 1 });
    repo.saveAccountSnapshot({
      ...base,
      snapshot_id: 's2',
      snapshot_time: 2,
      reserved_capital_usdt: 500,
      available_capital_usdt: 9500,
      reason: 'CAPITAL_RESERVED',
      created_at: 2,
      updated_at: 2,
    });
    const latest = repo.getLatestAccountSnapshot('PAPER');
    expect(latest?.snapshot_id).toBe('s2');
    expect(latest?.available_capital_usdt).toBe(9500);
  });

  it('PnlSnapshot round trips losslessly', () => {
    const pnl: PnlSnapshot = {
      pnl_snapshot_id: 'p1',
      trade_id: 'trade1',
      snapshot_time: 5,
      funding_pnl_usdt: 1,
      price_pnl_usdt: 2,
      fee_usdt: 0.5,
      unrealized_pnl_usdt: 0,
      net_pnl_usdt: 2.5,
      created_at: 5,
      updated_at: 5,
    };
    repo.savePnlSnapshot(pnl);
    expect(repo.listPnlSnapshotsForTrade('trade1')).toEqual([pnl]);
  });

  it('exposes no delete method', () => {
    const methodNames = Object.keys(repo);
    expect(methodNames.some((name) => /delete/i.test(name))).toBe(false);
  });
});
