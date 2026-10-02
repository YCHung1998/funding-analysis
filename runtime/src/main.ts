/**
 * runtime/src/main.ts
 *
 * Runtime process entrypoint (design.md Decision 4, tasks.md 4.1). Implements
 * the 12-step startup flow:
 *
 *   1 Load Config -> 2 Backup + Migrate -> 3 Credentials -> 4 Connect + Clock
 *   calibrate -> 5 Validate Market Data -> 6 Load Account Snapshot -> 7
 *   Recover from Event Store -> 8 Reconcile -> 9 Start Market Data -> 10
 *   Start Scanner -> 11 Start Risk -> 12 ARM Paper Execution
 *
 * Every step emits `RUNTIME_STARTUP_STEP` (trade_id null); the final outcome
 * emits `RUNTIME_ARMED` or `RUNTIME_DISARMED`. Three failure tiers
 * (design.md Decision 4):
 *
 *  - FATAL (steps 1-3, including a withdraw-permission credential): returns
 *    `exitCode: 1` immediately — steps 4-12 never run.
 *  - DEGRADED (step 5 market-data timeout, step 8 reconciliation mismatch):
 *    every remaining step still runs, but step 12 disarms instead of arming.
 *  - ADVISORY (missing credentials, "公開資料模式"): same as DEGRADED —
 *    everything runs, Paper Execution stays DISARMED, only public market
 *    data flows.
 *
 * `runStartup` is the pure, fully-injectable core (every side effect —
 * `Clock`, SQLite, the not-yet-implemented `market-data-stream` /
 * `risk-engine` / credentials ports — arrives via `StartupDeps`), exercised
 * directly by `main.test.ts` with `VirtualClock` + an in-memory DB + fakes
 * (design.md Decision 4 "各服務以 Startable 介面接入，本 change 以 fake 服務測試").
 * `main()` is the thin production bootstrap that wires `RealClock` + a real
 * `NodeSqliteDriver` + the placeholder ports from `startup/types.ts` for
 * every capability this change's Non-Goals exclude (market data, scanner,
 * risk engine, credentials) and calls `process.exit` on a FATAL result — the
 * ONLY place in this file that touches the system clock or process exit
 * directly (everything else routes through the injected `Clock`,
 * `runtime/test/architecture.test.ts`'s system-time guard only allowlists
 * `clock/realClock.ts` for `Date.now`/`setTimeout`/`setInterval`, which this
 * file never calls — `RealClock` itself does).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from './clock/types';
import { RealClock } from './clock/realClock';
import type { CredentialStatus, ExchangeHealth, ScannerStatus } from './health/healthModel';
import { deriveHealth } from './health/healthModel';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from './health/types';
import { HealthPublisher } from './health/healthPublisher';
import { recoverFromEventStore, type RecoveryResult } from './health/recovery';
import type { EntryHaltPort } from './reconciliation/entryHalt';
import { EntryHaltLatch } from './reconciliation/entryHalt';
import { Reconciler, type ReconciliationRunRecord } from './reconciliation/reconciler';
import { DEFAULT_RECONCILIATION_CONFIG } from './reconciliation/types';
import type { AccountRepository } from './storage/accountRepository';
import { createAccountRepository } from './storage/accountRepository';
import { backupBeforeStartup, createNodeBackupDeps, type BackupDeps } from './storage/backup';
import { NodeSqliteDriver, type SqliteDriver } from './storage/driver';
import { EventStore } from './storage/eventStore';
import { Ledger } from './storage/ledger';
import type { Migration } from './storage/migrate';
import { migrate } from './storage/migrate';
import { migration001 } from './storage/migrations/001_initial';
import { migration002 } from './storage/migrations/002_position_accounting_fields';
import { migration003 } from './storage/migrations/003_runtime_health';
import type { OrderRepository } from './storage/orderRepository';
import { createOrderRepository } from './storage/orderRepository';
import type { TradeRepository } from './storage/tradeRepository';
import { createTradeRepository } from './storage/tradeRepository';
import {
  AlwaysFreshMarketDataValidationPort,
  NoCredentialsPort,
  NoopExchangeConnectPort,
  NoopSettlementRecoveryHandoff,
  NoopStartable,
  SimpleArmLatch,
  type CredentialsPort,
  type ExchangeConnectPort,
  type MarketDataValidationPort,
  type PaperExecutionArmPort,
  type SettlementRecoveryHandoffPort,
  type Startable,
} from './startup/types';

/** `PAPER_DB_PATH` convention already established by `server.ts`'s task 3.2 routes — reused here verbatim (design.md Implementation Notes "task 3.2 PAPER_DB_PATH"). */
export function resolvePaperDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPER_DB_PATH ?? new URL('../../data/paper.sqlite', import.meta.url).pathname;
}

export type StartupTier = 'FATAL' | 'DEGRADED' | 'ADVISORY' | 'OK';

export interface StartupResult {
  tier: StartupTier;
  armed: boolean;
  /** `process.exit` code `main()` should use, or `null` to keep running. */
  exitCode: number | null;
  reasons: string[];
  recovery?: RecoveryResult;
  reconciliation?: ReconciliationRunRecord;
}

export interface StartupRepos {
  trade: TradeRepository;
  order: OrderRepository;
  account: AccountRepository;
}

export interface StartupDeps {
  clock: Clock;
  db: SqliteDriver;
  migrations: Migration[];
  backup: { dbPath: string; backupDir: string; deps: BackupDeps };
  credentials: CredentialsPort;
  exchangeConnect: ExchangeConnectPort;
  marketDataValidation: MarketDataValidationPort;
  marketDataValidationTimeoutMs: number;
  repos: StartupRepos;
  eventStore: EventStore;
  ledger: Ledger;
  entryHalt: EntryHaltPort;
  settlementHandoff: SettlementRecoveryHandoffPort;
  reconciler: Reconciler;
  marketData: Startable;
  scanner: Startable;
  risk: Startable;
  paperExecutionArm: PaperExecutionArmPort;
  healthPublisher: HealthPublisher;
  healthConfig: HealthConfig;
  /** Read fresh at the moment Health is derived — exchange connection/staleness state (design.md Non-Goals: not implemented by this change). */
  buildExchangeHealth: () => ExchangeHealth[];
  idGenerator?: () => string;
}

function emitStep(
  deps: Pick<StartupDeps, 'ledger' | 'clock'>,
  genId: () => string,
  step: number,
  name: string,
  status: 'OK' | 'DEGRADED' | 'FAILED' | 'ADVISORY',
  details?: Record<string, unknown>,
): void {
  deps.ledger.appendEvent({
    event_id: genId(),
    event_type: 'RUNTIME_STARTUP_STEP',
    timestamp: deps.clock.now(),
    trade_id: null,
    payload: { step, name, status, ...details },
  });
}

/**
 * Runs the 12-step startup flow once. Pure with respect to the outside
 * world — every effect goes through `deps` — so tests exercise it directly
 * with `VirtualClock` + an in-memory DB + fakes, never real timers/sockets.
 */
export async function runStartup(deps: StartupDeps): Promise<StartupResult> {
  const genId = deps.idGenerator ?? (() => crypto.randomUUID());
  const fatal = (reason: string): StartupResult => {
    emitStep(deps, genId, 0, 'STARTUP_ABORTED', 'FAILED', { reason });
    return { tier: 'FATAL', armed: false, exitCode: 1, reasons: [reason] };
  };

  // Step 1: Load Config — configuration is already loaded into `deps` by the
  // caller (production `main()` / the test); this step only records that
  // startup began.
  emitStep(deps, genId, 1, 'LOAD_CONFIG', 'OK');

  // Step 2: Backup + Migrate (tech spec §51.3: must happen before any write).
  try {
    backupBeforeStartup({ dbPath: deps.backup.dbPath, backupDir: deps.backup.backupDir, clock: deps.clock, deps: deps.backup.deps });
    migrate(deps.db, deps.migrations, Infinity, deps.clock);
    emitStep(deps, genId, 2, 'BACKUP_AND_MIGRATE', 'OK');
  } catch (err) {
    return fatal(`BACKUP_OR_MIGRATE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Credentials (tech spec §52). A withdraw-permission-enabled key is
  // a fatal safety violation regardless of credential status; missing
  // credentials is advisory (public-data-only), never fatal.
  const credentials = await deps.credentials.validate();
  if (credentials.status === 'PRESENT' && credentials.withdrawPermissionGranted) {
    return fatal('WITHDRAW_PERMISSION_GRANTED');
  }
  emitStep(deps, genId, 3, 'CREDENTIALS', credentials.status === 'PRESENT' ? 'OK' : 'ADVISORY', { status: credentials.status });

  // Step 4: Connect + Clock calibrate. No failure tier is specified for this
  // step in design.md Decision 4 (only 5/8 are DEGRADED, only 1-3 are
  // FATAL) — treated conservatively as FATAL here (a Runtime that cannot
  // establish a reliable Clock reference cannot safely time anything
  // downstream); recorded as a resolved ambiguity in design.md
  // Implementation Notes.
  try {
    await deps.exchangeConnect.connectAndCalibrate();
    emitStep(deps, genId, 4, 'CONNECT_AND_CALIBRATE', 'OK');
  } catch (err) {
    return fatal(`CONNECT_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 5: Validate Market Data (degraded on timeout).
  const degradedReasons: string[] = [];
  const marketDataResult = await deps.marketDataValidation.validate(deps.marketDataValidationTimeoutMs);
  if (!marketDataResult.ok) {
    degradedReasons.push('MARKET_DATA_VALIDATION_TIMEOUT');
    emitStep(deps, genId, 5, 'VALIDATE_MARKET_DATA', 'DEGRADED');
  } else {
    emitStep(deps, genId, 5, 'VALIDATE_MARKET_DATA', 'OK');
  }

  // Step 6: Load Account Snapshot.
  const accountSnapshot = deps.repos.account.getLatestAccountSnapshot('PAPER');
  emitStep(deps, genId, 6, 'LOAD_ACCOUNT_SNAPSHOT', accountSnapshot ? 'OK' : 'ADVISORY', {
    found: Boolean(accountSnapshot),
  });

  // Step 7: Recover from Event Store (health/recovery.ts, tasks.md 4.2).
  const recovery = recoverFromEventStore({
    db: deps.db,
    clock: deps.clock,
    eventStore: deps.eventStore,
    ledger: deps.ledger,
    repos: { trade: deps.repos.trade, order: deps.repos.order },
    entryHalt: deps.entryHalt,
    settlementHandoff: deps.settlementHandoff,
    idGenerator: deps.idGenerator,
  });
  emitStep(deps, genId, 7, 'RECOVER_FROM_EVENT_STORE', 'OK', {
    closedOrders: recovery.closedOrders.length,
    failedTrades: recovery.failedTrades.length,
    handedToSettlement: recovery.handedToSettlement.length,
    projectionMismatches: recovery.projectionMismatches,
  });

  // Step 8: Reconcile — must pass before ARM (design.md Decision 4 "8 對帳通過才 ARM").
  const reconciliation = deps.reconciler.runOnce();
  if (reconciliation.mismatch_count > 0) {
    degradedReasons.push('RECONCILIATION_MISMATCH');
    emitStep(deps, genId, 8, 'RECONCILE', 'DEGRADED', { mismatch_count: reconciliation.mismatch_count });
  } else {
    emitStep(deps, genId, 8, 'RECONCILE', 'OK');
  }

  // Step 9: Start Market Data.
  await deps.marketData.start();
  emitStep(deps, genId, 9, 'START_MARKET_DATA', 'OK', { status: deps.marketData.status() });

  // Step 10: Start Scanner.
  await deps.scanner.start();
  emitStep(deps, genId, 10, 'START_SCANNER', 'OK', { status: deps.scanner.status() });

  // Step 11: Start Risk.
  await deps.risk.start();
  emitStep(deps, genId, 11, 'START_RISK', 'OK', { status: deps.risk.status() });

  // Step 12: ARM Paper Execution — only when nothing advisory or degraded is outstanding.
  const credentialReasons = credentials.status === 'PRESENT' ? [] : [`CREDENTIALS_${credentials.status}`];
  const allReasons = [...degradedReasons, ...credentialReasons];
  const armed = allReasons.length === 0;
  if (armed) {
    deps.paperExecutionArm.arm();
    emitStep(deps, genId, 12, 'ARM_PAPER_EXECUTION', 'OK');
    deps.ledger.appendEvent({ event_id: genId(), event_type: 'RUNTIME_ARMED', timestamp: deps.clock.now(), trade_id: null, payload: {} });
  } else {
    deps.paperExecutionArm.disarm();
    emitStep(deps, genId, 12, 'ARM_PAPER_EXECUTION', 'DEGRADED', { reasons: allReasons });
    deps.ledger.appendEvent({
      event_id: genId(),
      event_type: 'RUNTIME_DISARMED',
      timestamp: deps.clock.now(),
      trade_id: null,
      payload: { reasons: allReasons },
    });
  }

  const tier: StartupTier = armed ? 'OK' : degradedReasons.length > 0 ? 'DEGRADED' : 'ADVISORY';

  // Publish Health once, reflecting the outcome of this startup pass.
  const credentialStatus: CredentialStatus = credentials.status;
  deps.healthPublisher.publish(
    deriveHealth({
      engine: 'RUNNING',
      exchanges: deps.buildExchangeHealth(),
      scanner: 'RUNNING',
      risk: 'ARMED',
      paperExecution: armed ? 'ARMED' : 'DISARMED',
      database: 'HEALTHY',
      clock: 'RELIABLE',
      credentials: credentialStatus,
      entryHalted: deps.entryHalt.isHalted(),
      haltReasons: deps.entryHalt.reasons().map((r) => r.reason),
      lastEventAt: deps.clock.now(),
    }),
  );

  return { tier, armed, exitCode: null, reasons: allReasons, recovery, reconciliation };
}

/**
 * Schedules `HealthPublisher.publish` every `healthConfig.publishIntervalMs`
 * via the injected `Clock` (never `setInterval` directly — see this file's
 * header comment). Returns a `stop()` to cancel, mirroring
 * `Reconciler.start()/stop()`.
 */
export function startPeriodicHealthPublish(deps: StartupDeps): { stop(): void } {
  let handle: ReturnType<Clock['after']> | null = null;
  const tick = (): void => {
    deps.healthPublisher.publish(
      deriveHealth({
        engine: 'RUNNING',
        exchanges: deps.buildExchangeHealth(),
        scanner: (deps.scanner.status() === 'STOPPED' ? 'STOPPED' : 'RUNNING') satisfies ScannerStatus,
        risk: 'ARMED',
        paperExecution: deps.paperExecutionArm.isArmed() ? 'ARMED' : 'DISARMED',
        database: 'HEALTHY',
        clock: 'RELIABLE',
        credentials: 'PRESENT',
        entryHalted: deps.entryHalt.isHalted(),
        haltReasons: deps.entryHalt.reasons().map((r) => r.reason),
        lastEventAt: deps.clock.now(),
      }),
    );
    handle = deps.clock.after(deps.healthConfig.publishIntervalMs, tick);
  };
  handle = deps.clock.after(deps.healthConfig.publishIntervalMs, tick);
  return {
    stop: () => {
      if (handle) deps.clock.cancel(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// Production bootstrap. The only part of this file that constructs real
// side-effecting dependencies (RealClock, a real SQLite file, process.exit).
// market-data-stream / risk-engine / credentials validation are Non-Goals of
// this change (proposal.md "Non-goals") — the placeholder ports from
// `startup/types.ts` stand in until those capabilities exist; replacing them
// is an adapter swap at this call site only.
// ---------------------------------------------------------------------------

function buildProductionDeps(dbPath: string): StartupDeps {
  const clock = new RealClock();
  const migrations = [migration001, migration002, migration003];
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new NodeSqliteDriver(dbPath);
  // Every repository constructor (`createTradeRepository` etc.) prepares its
  // SQL statements eagerly, so the schema must already exist before any
  // repository is built — but `runStartup`'s own step 2 (backup+migrate)
  // only runs once `runStartup` is called with these repos already in hand.
  // Applying `migrate` once here, before constructing repositories, resolves
  // that ordering without changing step 2's own behavior: on a fresh
  // install (no file yet) there is nothing to back up either way; on an
  // up-to-date DB this is a no-op (no pending migrations, no DDL executed);
  // only a DB with migrations pending from a version applied by some other
  // process would see those applied here before step 2's backup runs — a
  // narrow, documented gap (no prior Runtime process has ever written this
  // DB, since `main.ts` is this change's first production entrypoint).
  migrate(db, migrations);
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

  return {
    clock,
    db,
    migrations,
    backup: {
      dbPath,
      backupDir: new URL('../../data/backup', import.meta.url).pathname,
      deps: createNodeBackupDeps(dbPath),
    },
    credentials: new NoCredentialsPort(),
    exchangeConnect: new NoopExchangeConnectPort(),
    marketDataValidation: new AlwaysFreshMarketDataValidationPort(),
    marketDataValidationTimeoutMs: 5_000,
    repos: { trade, order, account },
    eventStore,
    ledger,
    entryHalt,
    settlementHandoff: new NoopSettlementRecoveryHandoff(),
    reconciler,
    marketData: new NoopStartable('RUNNING'),
    scanner: new NoopStartable('RUNNING'),
    risk: new NoopStartable('ARMED'),
    paperExecutionArm: new SimpleArmLatch(),
    healthPublisher,
    healthConfig: DEFAULT_HEALTH_CONFIG,
    buildExchangeHealth: () => [],
  };
}

export async function main(): Promise<void> {
  const dbPath = resolvePaperDbPath();
  const deps = buildProductionDeps(dbPath);
  const result = await runStartup(deps);

  if (result.exitCode !== null) {
    console.error(`[runtime] startup failed (${result.tier}): ${result.reasons.join(', ')}`);
    deps.db.close();
    process.exit(result.exitCode);
    return;
  }

  console.log(`[runtime] startup complete, tier=${result.tier} armed=${result.armed}`);
  deps.reconciler.start();
  startPeriodicHealthPublish(deps);
}

// ESM entrypoint check — only runs `main()` when this file is executed directly (`tsx runtime/src/main.ts`), not when imported by tests.
const isDirectRun = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  void main();
}
