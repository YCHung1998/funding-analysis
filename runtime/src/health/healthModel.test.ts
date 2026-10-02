/**
 * runtime/src/health/healthModel.test.ts
 *
 * Task 3.1 — `deriveHealth`: component status model + derivation rules for
 * `entry_allowed` / `entry_block_reasons` (design.md tasks.md 3.1: stale
 * market data and an entry halt DO block entry; a disconnected/stale
 * SCAN-ONLY exchange does NOT). Pure function — no DB, no Clock, no I/O.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeId } from '../types/ids';
import { deriveHealth, type HealthInputs } from './healthModel';

function baseInputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    engine: 'RUNNING',
    exchanges: [
      { exchange: 'Binance' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
      { exchange: 'Bybit' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
      { exchange: 'OKX' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: true },
    ],
    scanner: 'RUNNING',
    risk: 'ARMED',
    paperExecution: 'ARMED',
    database: 'HEALTHY',
    clock: 'RELIABLE',
    credentials: 'PRESENT',
    entryHalted: false,
    haltReasons: [],
    lastEventAt: 1000,
    ...overrides,
  };
}

describe('deriveHealth (design.md tasks.md 3.1)', () => {
  it('entry_allowed = true and no block reasons when every component is healthy', () => {
    const h = deriveHealth(baseInputs());
    expect(h.entry_allowed).toBe(true);
    expect(h.entry_block_reasons).toEqual([]);
    expect(h.marketData).toBe('HEALTHY');
  });

  it('an entry halt blocks entry (reason reflects the halt)', () => {
    const h = deriveHealth(baseInputs({ entryHalted: true, haltReasons: ['RECONCILIATION'] }));
    expect(h.entry_allowed).toBe(false);
    expect(h.entry_block_reasons).toContain('ENTRY_HALT');
  });

  it('stale market data on a TRADING exchange blocks entry and marks marketData STALE', () => {
    const h = deriveHealth(
      baseInputs({
        exchanges: [
          { exchange: 'Binance' as ExchangeId, status: 'CONNECTED', stale: true, scanOnly: false },
          { exchange: 'Bybit' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
        ],
      }),
    );
    expect(h.entry_allowed).toBe(false);
    expect(h.marketData).toBe('STALE');
    expect(h.entry_block_reasons.some((r) => r.startsWith('STALE_MARKET_DATA'))).toBe(true);
  });

  it('a disconnected TRADING exchange blocks entry', () => {
    const h = deriveHealth(
      baseInputs({
        exchanges: [
          { exchange: 'Binance' as ExchangeId, status: 'DISCONNECTED', stale: false, scanOnly: false },
          { exchange: 'Bybit' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
        ],
      }),
    );
    expect(h.entry_allowed).toBe(false);
    expect(h.entry_block_reasons).toContain('EXCHANGE_DISCONNECTED:Binance');
  });

  it('a disconnected AND stale SCAN-ONLY exchange does NOT block entry and does not mark marketData STALE', () => {
    const h = deriveHealth(
      baseInputs({
        exchanges: [
          { exchange: 'Binance' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
          { exchange: 'Bybit' as ExchangeId, status: 'CONNECTED', stale: false, scanOnly: false },
          { exchange: 'OKX' as ExchangeId, status: 'DISCONNECTED', stale: true, scanOnly: true },
        ],
      }),
    );
    expect(h.entry_allowed).toBe(true);
    expect(h.entry_block_reasons).toEqual([]);
    expect(h.marketData).toBe('HEALTHY');
  });

  it('RISK or PAPER_EXECUTION not ARMED blocks entry', () => {
    const h1 = deriveHealth(baseInputs({ risk: 'DISARMED' }));
    expect(h1.entry_allowed).toBe(false);
    expect(h1.entry_block_reasons).toContain('RISK_DISARMED');

    const h2 = deriveHealth(baseInputs({ paperExecution: 'DISARMED' }));
    expect(h2.entry_allowed).toBe(false);
    expect(h2.entry_block_reasons).toContain('PAPER_EXECUTION_DISARMED');
  });

  it('missing or invalid credentials block entry', () => {
    const h1 = deriveHealth(baseInputs({ credentials: 'MISSING' }));
    expect(h1.entry_allowed).toBe(false);
    expect(h1.entry_block_reasons).toContain('CREDENTIALS_MISSING');

    const h2 = deriveHealth(baseInputs({ credentials: 'INVALID' }));
    expect(h2.entry_allowed).toBe(false);
    expect(h2.entry_block_reasons).toContain('CREDENTIALS_INVALID');
  });

  it('a degraded database (e.g. event queue overflow) blocks entry', () => {
    const h = deriveHealth(baseInputs({ database: 'DEGRADED' }));
    expect(h.entry_allowed).toBe(false);
    expect(h.entry_block_reasons).toContain('DATABASE_DEGRADED');
  });

  it('multiple simultaneous blockers all appear in entry_block_reasons', () => {
    const h = deriveHealth(baseInputs({ entryHalted: true, risk: 'DISARMED', credentials: 'MISSING' }));
    expect(h.entry_allowed).toBe(false);
    expect(h.entry_block_reasons).toEqual(
      expect.arrayContaining(['ENTRY_HALT', 'RISK_DISARMED', 'CREDENTIALS_MISSING']),
    );
  });

  it('passes through engine/scanner/clock/exchanges/last_event_at unchanged', () => {
    const h = deriveHealth(baseInputs({ lastEventAt: null }));
    expect(h.engine).toBe('RUNNING');
    expect(h.scanner).toBe('RUNNING');
    expect(h.clock).toBe('RELIABLE');
    expect(h.exchanges).toHaveLength(3);
    expect(h.last_event_at).toBeNull();
  });
});
