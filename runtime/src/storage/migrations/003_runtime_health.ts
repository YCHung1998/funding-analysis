/**
 * runtime/src/storage/migrations/003_runtime_health.ts
 *
 * `runtime-health-reconciliation` tasks.md 1.1. Adds `runtime_health` (single
 * overwritten row, design.md Decision 3 — Health is a state cache, not a
 * TradingEvent) and `reconciliation_runs` (one row per reconciliation pass,
 * design.md Decision 1/2 — `reconciliation_runs` records every pass whether
 * or not it found a mismatch, so the UI / ops can see the last-run time even
 * when everything is consistent). Reversible: both tables are new, so `down`
 * is a plain `DROP TABLE` (no rebuild needed, unlike `002`'s column-add).
 *
 * Note on numbering: `002_position_accounting_fields.ts` already exists
 * (position-funding-pnl task 1.1), so this migration is `003` / `version: 3`
 * — the filename prefix and the `Migration.version` field are independent
 * (`migrate.ts` sorts/filters purely by `.version`), but `003` keeps the two
 * in sync for readability.
 */
import type { Migration } from '../migrate';

const UP_SQL = `
CREATE TABLE runtime_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  components TEXT NOT NULL,
  entry_allowed INTEGER NOT NULL,
  entry_block_reasons TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  checks_run INTEGER NOT NULL,
  mismatch_count INTEGER NOT NULL,
  mismatches TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reconciliation_runs_started_at ON reconciliation_runs(started_at);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS idx_reconciliation_runs_started_at;
DROP TABLE IF EXISTS reconciliation_runs;
DROP TABLE IF EXISTS runtime_health;
`;

export const migration003: Migration = {
  version: 3,
  name: 'runtime_health',
  up(db) {
    db.exec(UP_SQL);
  },
  down(db) {
    db.exec(DOWN_SQL);
  },
};
