/**
 * server/paperReadLayer.test.ts — task 1.1.
 *
 * Covers: `openPaperDb` read-only contract (an INSERT through the opened
 * handle fails — proves the connection truly cannot write, spec.md "Server
 * cannot write"), `getAccountSnapshot()` (latest-by-created_at, spec.md
 * "Latest snapshot returned" / "No snapshot yet" / DB-missing -> 503 via
 * `PaperReadLayerUnavailableError`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createPaperDbFixture, type PaperDbFixture } from './test/paperDbFixture';
import { getAccountSnapshot, openPaperDb, PaperReadLayerUnavailableError } from './paperReadLayer';
import type { AccountSnapshot } from '../runtime/src/types';

describe('paperReadLayer — task 1.1', () => {
  let fixture: PaperDbFixture | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  describe('openPaperDb', () => {
    it('returns undefined when the database file does not exist', () => {
      const reader = openPaperDb(join('/tmp', `does-not-exist-${Date.now()}.sqlite`));
      expect(reader).toBeUndefined();
    });

    it('opens a connection that cannot write (read-only contract)', () => {
      fixture = createPaperDbFixture();
      const reader = openPaperDb(fixture.path);
      expect(reader).toBeDefined();
      expect(() => reader!.prepare(`INSERT INTO account_snapshots (snapshot_id) VALUES ('x')`).run()).toThrow();
      reader!.close();
    });
  });

  describe('getAccountSnapshot', () => {
    function snapshot(overrides: Partial<AccountSnapshot>): AccountSnapshot {
      return {
        snapshot_id: 's1',
        mode: 'PAPER',
        snapshot_time: 1000,
        total_capital_usdt: 100_000,
        reserved_capital_usdt: 0,
        available_capital_usdt: 100_000,
        used_margin_usdt: 0,
        realized_pnl_usdt: 0,
        open_trade_count: 0,
        reason: 'INITIAL',
        config_version: 'c1',
        created_at: 1000,
        updated_at: 1000,
        ...overrides,
      };
    }

    it('returns the row with the latest created_at', () => {
      fixture = createPaperDbFixture();
      fixture.accountRepo.saveAccountSnapshot(snapshot({ snapshot_id: 's1', created_at: 1000, updated_at: 1000 }));
      fixture.accountRepo.saveAccountSnapshot(snapshot({ snapshot_id: 's2', created_at: 3000, updated_at: 3000 }));
      fixture.accountRepo.saveAccountSnapshot(snapshot({ snapshot_id: 's3', created_at: 2000, updated_at: 2000 }));

      const reader = openPaperDb(fixture.path)!;
      try {
        const result = getAccountSnapshot(reader);
        expect(result.snapshot_id).toBe('s2');
      } finally {
        reader.close();
      }
    });

    it('throws PaperReadLayerUnavailableError when no snapshot has been written yet', () => {
      fixture = createPaperDbFixture();
      const reader = openPaperDb(fixture.path)!;
      try {
        expect(() => getAccountSnapshot(reader)).toThrow(PaperReadLayerUnavailableError);
      } finally {
        reader.close();
      }
    });

    it('throws PaperReadLayerUnavailableError when the database does not exist', () => {
      const reader = openPaperDb(join('/tmp', `does-not-exist-${Date.now()}.sqlite`));
      expect(() => getAccountSnapshot(reader)).toThrow(PaperReadLayerUnavailableError);
    });
  });
});
