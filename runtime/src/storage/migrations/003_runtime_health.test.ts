import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, rollback } from '../migrate';
import type { NodeSqliteDriver } from '../driver';
import { tmpDriver } from '../test-helpers';
import { migration001 } from './001_initial';
import { migration002 } from './002_position_accounting_fields';
import { migration003 } from './003_runtime_health';

describe('003_runtime_health', () => {
  let db: NodeSqliteDriver;

  beforeEach(() => {
    db = tmpDriver();
    migrate(db, [migration001, migration002, migration003]);
  });

  afterEach(() => {
    db.close();
  });

  it('creates runtime_health and reconciliation_runs', () => {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toContain('runtime_health');
    expect(names).toContain('reconciliation_runs');
  });

  it('runtime_health accepts a single upserted row (id=1)', () => {
    db.prepare(
      `INSERT INTO runtime_health (id, components, entry_allowed, entry_block_reasons, updated_at)
       VALUES (1, '{}', 1, '[]', 1000)
       ON CONFLICT(id) DO UPDATE SET components = excluded.components, entry_allowed = excluded.entry_allowed,
         entry_block_reasons = excluded.entry_block_reasons, updated_at = excluded.updated_at`,
    ).run();
    db.prepare(
      `INSERT INTO runtime_health (id, components, entry_allowed, entry_block_reasons, updated_at)
       VALUES (1, '{"a":1}', 0, '["HALT"]', 2000)
       ON CONFLICT(id) DO UPDATE SET components = excluded.components, entry_allowed = excluded.entry_allowed,
         entry_block_reasons = excluded.entry_block_reasons, updated_at = excluded.updated_at`,
    ).run();
    const rows = db.prepare(`SELECT * FROM runtime_health`).all() as Array<{ id: number; updated_at: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBe(2000);
  });

  it('runtime_health rejects a second distinct id (single-row invariant)', () => {
    db.prepare(
      `INSERT INTO runtime_health (id, components, entry_allowed, entry_block_reasons, updated_at) VALUES (1, '{}', 1, '[]', 1000)`,
    ).run();
    expect(() =>
      db
        .prepare(`INSERT INTO runtime_health (id, components, entry_allowed, entry_block_reasons, updated_at) VALUES (2, '{}', 1, '[]', 1000)`)
        .run(),
    ).toThrow();
  });

  it('reconciliation_runs stores one row per pass', () => {
    db.prepare(
      `INSERT INTO reconciliation_runs (run_id, started_at, completed_at, checks_run, mismatch_count, mismatches, created_at, updated_at)
       VALUES ('r1', 1000, 1005, 10, 0, '[]', 1005, 1005)`,
    ).run();
    db.prepare(
      `INSERT INTO reconciliation_runs (run_id, started_at, completed_at, checks_run, mismatch_count, mismatches, created_at, updated_at)
       VALUES ('r2', 2000, 2005, 10, 2, '[{"check_id":"ORDER_FILL_SUM"}]', 2005, 2005)`,
    ).run();
    const rows = db.prepare(`SELECT run_id FROM reconciliation_runs ORDER BY started_at`).all() as Array<{ run_id: string }>;
    expect(rows.map((r) => r.run_id)).toEqual(['r1', 'r2']);
  });

  it('down removes exactly what up created (round trip, leaves 001/002 intact)', () => {
    const before = (db.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`).all() as {
      name: string;
    }[])
      .map((r) => r.name)
      .sort();

    rollback(db, [migration001, migration002, migration003], 2);
    const afterDown = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(afterDown).not.toContain('runtime_health');
    expect(afterDown).not.toContain('reconciliation_runs');
    expect(afterDown).toContain('positions');
    expect(afterDown).toContain('trades');

    migrate(db, [migration001, migration002, migration003]);
    const after = (db.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`).all() as {
      name: string;
    }[])
      .map((r) => r.name)
      .sort();
    expect(after).toEqual(before);
  });

  it('full rollback to 0 removes every object', () => {
    rollback(db, [migration001, migration002, migration003], 0);
    const objects = db
      .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`)
      .all() as { name: string }[];
    expect(objects).toEqual([]);
  });
});
