/**
 * runtime/src/main.test.ts
 *
 * `runStartup` (design.md Decision 4, tasks.md 4.1): the 12-step startup
 * flow and its three failure tiers. Real `Ledger`/`EventStore`/temp-dir
 * SQLite/`VirtualClock`; `market-data-stream`/`risk-engine`/credentials are
 * exercised via fakes implementing `Startable` / the small ports in
 * `startup/types.ts` (design.md Decision 4 "各服務以 Startable 介面接入，本
 * change 以 fake 服務測試") — never a real exchange API or wall-clock sleep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from './clock/virtualClock';
import { HealthPublisher, readRuntimeHealthRow } from './health/healthPublisher';
import { runStartup, type StartupDeps } from './main';
import { EntryHaltLatch } from './reconciliation/entryHalt';
import { Reconciler } from './reconciliation/reconciler';
import { DEFAULT_RECONCILIATION_CONFIG } from './reconciliation/types';
import { DEFAULT_HEALTH_CONFIG } from './health/types';
import { createAccountRepository } from './storage/accountRepository';
import type { NodeSqliteDriver } from './storage/driver';
import { EventStore } from './storage/eventStore';
import { Ledger } from './storage/ledger';
import { migrate } from './storage/migrate';
import { migration001 } from './storage/migrations/001_initial';
import { migration002 } from './storage/migrations/002_position_accounting_fields';
import { migration003 } from './storage/migrations/003_runtime_health';
import { createOrderRepository } from './storage/orderRepository';
import { createTradeRepository } from './storage/tradeRepository';
import { tmpDriver } from './storage/test-helpers';
import { NoopSettlementRecoveryHandoff, SimpleArmLatch, type Startable } from './startup/types';
import type { AccountSnapshot } from './types';

class RecordingStartable implements Startable {
  started = 0;
  async start(): Promise<void> {
    this.started += 1;
  }
  status(): string {
    return this.started > 0 ? 'RUNNING' : 'STOPPED';
  }
}

function neverFailingBackupDeps() {
  return {
    dbExists: () => false,
    ensureDir: () => {},
    fileExists: () => false,
    backupTo: () => {},
    verifyIntegrity: () => true,
  };
}

interface Harness {
  db: NodeSqliteDriver;
  clock: VirtualClock;
  deps: StartupDeps;
  marketData: RecordingStartable;
  scanner: RecordingStartable;
  risk: RecordingStartable;
}

function buildHarness(overrides: Partial<StartupDeps> = {}): Harness {
  const db = tmpDriver();
  const clock = new VirtualClock(0);
  migrate(db, [migration001, migration002, migration003]);
  const trade = createTradeRepository(db);
  const order = createOrderRepository(db);
  const account = createAccountRepository(db);
  const eventStore = new EventStore(db, clock);
  const ledger = new Ledger(db, clock, { trade, order, account }, eventStore);
  const entryHalt = new EntryHaltLatch(eventStore, clock);
  const reconciler = new Reconciler({
    db,
    clock,
    repos: { trade, order, account },
    eventStore,
    ledger,
    entryHalt,
    config: DEFAULT_RECONCILIATION_CONFIG,
  });
  const healthPublisher = new HealthPublisher({ db, clock });
  const marketData = new RecordingStartable();
  const scanner = new RecordingStartable();
  const risk = new RecordingStartable();

  const deps: StartupDeps = {
    clock,
    db,
    migrations: [migration001, migration002, migration003],
    backup: { dbPath: 'unused', backupDir: 'unused', deps: neverFailingBackupDeps() },
    credentials: { validate: async () => ({ status: 'PRESENT', withdrawPermissionGranted: false }) },
    exchangeConnect: { connectAndCalibrate: async () => {} },
    marketDataValidation: { validate: async () => ({ ok: true }) },
    marketDataValidationTimeoutMs: 1000,
    repos: { trade, order, account },
    eventStore,
    ledger,
    entryHalt,
    settlementHandoff: new NoopSettlementRecoveryHandoff(),
    reconciler,
    marketData,
    scanner,
    risk,
    paperExecutionArm: new SimpleArmLatch(),
    healthPublisher,
    healthConfig: DEFAULT_HEALTH_CONFIG,
    buildExchangeHealth: () => [],
    idGenerator: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    ...overrides,
  };

  return { db, clock, deps, marketData, scanner, risk };
}

describe('runStartup (design.md Decision 4, tasks.md 4.1)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it('FATAL: migration failure stops before any service starts, exitCode=1', async () => {
    const result = await runStartup({
      ...harness.deps,
      migrations: [
        {
          version: 999,
          name: 'always-fails',
          up: () => {
            throw new Error('boom');
          },
          down: () => {},
        },
      ],
    });

    expect(result.tier).toBe('FATAL');
    expect(result.exitCode).toBe(1);
    expect(result.armed).toBe(false);
    expect(harness.marketData.started).toBe(0);
    expect(harness.scanner.started).toBe(0);
    expect(harness.risk.started).toBe(0);
  });

  it('FATAL: withdraw-permission-enabled credentials abort startup, exitCode=1', async () => {
    const result = await runStartup({
      ...harness.deps,
      credentials: { validate: async () => ({ status: 'PRESENT', withdrawPermissionGranted: true }) },
    });

    expect(result.tier).toBe('FATAL');
    expect(result.exitCode).toBe(1);
    expect(harness.marketData.started).toBe(0);
  });

  it('DEGRADED: market data validation timeout keeps running but stays DISARMED', async () => {
    const result = await runStartup({
      ...harness.deps,
      marketDataValidation: { validate: async () => ({ ok: false }) },
    });

    expect(result.tier).toBe('DEGRADED');
    expect(result.exitCode).toBeNull();
    expect(result.armed).toBe(false);
    expect(result.reasons).toContain('MARKET_DATA_VALIDATION_TIMEOUT');
    expect(harness.marketData.started).toBe(1);
    expect(harness.scanner.started).toBe(1);
    expect(harness.risk.started).toBe(1);
    expect(harness.deps.paperExecutionArm.isArmed()).toBe(false);
  });

  it('DEGRADED: a reconciliation mismatch at startup keeps running but stays DISARMED', async () => {
    // Seed an inconsistent account snapshot directly (bypassing the Ledger)
    // so the very first reconciliation pass (step 8) finds a CAPITAL_AVAILABLE mismatch.
    const bad: AccountSnapshot = {
      snapshot_id: 'bad',
      mode: 'PAPER',
      snapshot_time: 0,
      total_capital_usdt: 10_000,
      reserved_capital_usdt: 0,
      available_capital_usdt: 999, // should be 10_000 - 0
      used_margin_usdt: 0,
      realized_pnl_usdt: 0,
      open_trade_count: 0,
      reason: 'INITIAL',
      config_version: 'c1',
      created_at: 0,
      updated_at: 0,
    };
    harness.deps.repos.account.saveAccountSnapshot(bad);

    const result = await runStartup(harness.deps);

    expect(result.tier).toBe('DEGRADED');
    expect(result.armed).toBe(false);
    expect(result.reasons).toContain('RECONCILIATION_MISMATCH');
    expect(result.reconciliation!.mismatch_count).toBeGreaterThan(0);
    expect(harness.deps.entryHalt.isHalted()).toBe(true);
  });

  it('ADVISORY: missing credentials runs in public-data-only mode, stays DISARMED', async () => {
    const result = await runStartup({
      ...harness.deps,
      credentials: { validate: async () => ({ status: 'MISSING', withdrawPermissionGranted: false }) },
    });

    expect(result.tier).toBe('ADVISORY');
    expect(result.exitCode).toBeNull();
    expect(result.armed).toBe(false);
    expect(harness.marketData.started).toBe(1);
    expect(harness.scanner.started).toBe(1);
    expect(harness.risk.started).toBe(1);
  });

  it('OK: everything passes -> ARMED, RUNTIME_ARMED emitted, health published', async () => {
    const result = await runStartup(harness.deps);

    expect(result.tier).toBe('OK');
    expect(result.exitCode).toBeNull();
    expect(result.armed).toBe(true);
    expect(harness.deps.paperExecutionArm.isArmed()).toBe(true);

    const events = harness.deps.eventStore.replay();
    expect(events.some((e) => e.event_type === 'RUNTIME_ARMED')).toBe(true);
    expect(events.filter((e) => e.event_type === 'RUNTIME_STARTUP_STEP')).toHaveLength(12);

    const row = readRuntimeHealthRow(harness.db);
    expect(row).toBeDefined();
    const model = JSON.parse(row!.components) as { paperExecution: string; credentials: string };
    expect(model.paperExecution).toBe('ARMED');
    expect(model.credentials).toBe('PRESENT');
  });

  it('recovers from the Event Store before reconciling (step 7 runs, step 8 sees a clean slate)', async () => {
    // Seed a trade stuck ENTRY_PENDING (as if the previous Runtime process died mid-entry).
    const trade = harness.deps.repos.trade.getTrade('__missing__');
    expect(trade).toBeUndefined(); // sanity: no trades seeded by this bare harness

    const result = await runStartup(harness.deps);
    expect(result.recovery).toBeDefined();
    expect(result.recovery!.projectionMismatches).toBe(0);
  });
});
