/**
 * runtime/src/storage/accountRepository.ts
 *
 * `account_snapshots` + `pnl_snapshots` (design.md §7). `PnlSnapshot` is the
 * minimal shape from design.md Decision 2 (`position-funding-pnl` owns
 * semantics; this capability only owns the storage row).
 */
import type { AccountSnapshot } from '../types/account';
import type { SqliteDriver } from './driver';
import { optionalFromRow, optionalToRow } from './rowMapping';

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export interface PnlSnapshot {
  pnl_snapshot_id: string;
  trade_id: string;
  snapshot_time: number;
  funding_pnl_usdt: number;
  price_pnl_usdt: number;
  fee_usdt: number;
  unrealized_pnl_usdt: number;
  net_pnl_usdt: number;
  created_at: number;
  updated_at: number;
}

const ACCOUNT_SNAPSHOT_COLUMNS = [
  'snapshot_id',
  'mode',
  'snapshot_time',
  'total_capital_usdt',
  'reserved_capital_usdt',
  'available_capital_usdt',
  'used_margin_usdt',
  'realized_pnl_usdt',
  'open_trade_count',
  'reason',
  'trade_id',
  'config_version',
  'created_at',
  'updated_at',
] as const;

function accountSnapshotToRow(s: AccountSnapshot): unknown[] {
  return [
    s.snapshot_id,
    s.mode,
    s.snapshot_time,
    s.total_capital_usdt,
    s.reserved_capital_usdt,
    s.available_capital_usdt,
    s.used_margin_usdt,
    s.realized_pnl_usdt,
    s.open_trade_count,
    s.reason,
    optionalToRow(s.trade_id),
    s.config_version,
    s.created_at,
    s.updated_at,
  ];
}

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

const PNL_SNAPSHOT_COLUMNS = [
  'pnl_snapshot_id',
  'trade_id',
  'snapshot_time',
  'funding_pnl_usdt',
  'price_pnl_usdt',
  'fee_usdt',
  'unrealized_pnl_usdt',
  'net_pnl_usdt',
  'created_at',
  'updated_at',
] as const;

function pnlSnapshotToRow(p: PnlSnapshot): unknown[] {
  return [
    p.pnl_snapshot_id,
    p.trade_id,
    p.snapshot_time,
    p.funding_pnl_usdt,
    p.price_pnl_usdt,
    p.fee_usdt,
    p.unrealized_pnl_usdt,
    p.net_pnl_usdt,
    p.created_at,
    p.updated_at,
  ];
}

function rowToPnlSnapshot(row: PnlSnapshot): PnlSnapshot {
  return { ...row };
}

export interface AccountRepository {
  saveAccountSnapshot(snapshot: AccountSnapshot): void;
  getAccountSnapshot(id: string): AccountSnapshot | undefined;
  getLatestAccountSnapshot(mode: AccountSnapshot['mode']): AccountSnapshot | undefined;
  savePnlSnapshot(pnl: PnlSnapshot): void;
  listPnlSnapshotsForTrade(tradeId: string): PnlSnapshot[];
}

/** No method here deletes rows. */
export function createAccountRepository(db: SqliteDriver): AccountRepository {
  const upsertSnapshot = db.prepare(
    `INSERT INTO account_snapshots (${ACCOUNT_SNAPSHOT_COLUMNS.join(', ')}) VALUES (${placeholders(ACCOUNT_SNAPSHOT_COLUMNS.length)})
     ON CONFLICT(snapshot_id) DO UPDATE SET ${ACCOUNT_SNAPSHOT_COLUMNS.filter((c) => c !== 'snapshot_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectSnapshot = db.prepare(`SELECT * FROM account_snapshots WHERE snapshot_id = ?`);
  const selectLatestSnapshot = db.prepare(
    `SELECT * FROM account_snapshots WHERE mode = ? ORDER BY snapshot_time DESC, snapshot_id DESC LIMIT 1`,
  );

  const upsertPnl = db.prepare(
    `INSERT INTO pnl_snapshots (${PNL_SNAPSHOT_COLUMNS.join(', ')}) VALUES (${placeholders(PNL_SNAPSHOT_COLUMNS.length)})
     ON CONFLICT(pnl_snapshot_id) DO UPDATE SET ${PNL_SNAPSHOT_COLUMNS.filter((c) => c !== 'pnl_snapshot_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectPnlForTrade = db.prepare(`SELECT * FROM pnl_snapshots WHERE trade_id = ? ORDER BY snapshot_time ASC`);

  return {
    saveAccountSnapshot(snapshot) {
      upsertSnapshot.run(...accountSnapshotToRow(snapshot));
    },
    getAccountSnapshot(id) {
      const row = selectSnapshot.get(id) as AccountSnapshotRow | undefined;
      return row ? rowToAccountSnapshot(row) : undefined;
    },
    getLatestAccountSnapshot(mode) {
      const row = selectLatestSnapshot.get(mode) as AccountSnapshotRow | undefined;
      return row ? rowToAccountSnapshot(row) : undefined;
    },
    savePnlSnapshot(pnl) {
      upsertPnl.run(...pnlSnapshotToRow(pnl));
    },
    listPnlSnapshotsForTrade(tradeId) {
      const rows = selectPnlForTrade.all(tradeId) as PnlSnapshot[];
      return rows.map(rowToPnlSnapshot);
    },
  };
}
