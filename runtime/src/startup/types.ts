/**
 * runtime/src/startup/types.ts
 *
 * Shared ports for `main.ts`'s 12-step startup flow (design.md Decision 4).
 * `market-data-stream`, `risk-engine`, and credentials validation are not
 * yet implemented by any merged change — per design.md Decision 4 ("各服務
 * 以 Startable 介面接入，本 change 以 fake 服務測試") they are wired through
 * these small ports and exercised with fakes; main.ts's own production
 * bootstrap substitutes a documented no-op placeholder until those
 * capabilities land (same "fake until implemented" precedent as
 * `reconciler.ts` treating `position-accounting` as a fake before
 * `paper-execution-engine` existed).
 */
import type { CredentialStatus } from '../health/healthModel';
import type { Trade } from '../types/trade';

/** A long-running service the Runtime starts once at step 9/10/11 and queries for Health (design.md Decision 4). */
export interface Startable {
  start(): Promise<void>;
  /** Free-form status string surfaced into `HealthInputs` by main.ts's wiring (not itself part of `HealthInputs`'s typed enums). */
  status(): string;
}

/** Step 3 (tech spec §52): never returns the credential value itself (Invariant #2) — only its status and the one safety-relevant fact. */
export interface CredentialsPort {
  validate(): Promise<{ status: CredentialStatus; withdrawPermissionGranted: boolean }>;
}

/** Step 4: exchange connectivity + `Clock` calibration (folded into one step per design.md Decision 4). */
export interface ExchangeConnectPort {
  connectAndCalibrate(): Promise<void>;
}

/** Step 5: market-data freshness check with a timeout (design.md Decision 4 "5 逾時" is a degraded-tier failure). */
export interface MarketDataValidationPort {
  validate(timeoutMs: number): Promise<{ ok: boolean }>;
}

/**
 * Step 12: ARM/DISARM is tracked by the startup orchestrator itself, not by
 * `PaperExecutionAdapter` (which has no such method — a resolved design
 * ambiguity, see design.md Implementation Notes "task 4.1 ARM/DISARM").
 */
export interface PaperExecutionArmPort {
  arm(): void;
  disarm(): void;
  isArmed(): boolean;
}

/** `Startable` that always starts immediately and reports a fixed status — placeholder for a not-yet-implemented port. */
export class NoopStartable implements Startable {
  constructor(private readonly statusValue: string = 'RUNNING') {}
  async start(): Promise<void> {
    // no-op
  }
  status(): string {
    return this.statusValue;
  }
}

/** Placeholder `PaperExecutionArmPort` — tracks ARM/DISARM in memory only. */
export class SimpleArmLatch implements PaperExecutionArmPort {
  private armed = false;
  arm(): void {
    this.armed = true;
  }
  disarm(): void {
    this.armed = false;
  }
  isArmed(): boolean {
    return this.armed;
  }
}

/** Placeholder `CredentialsPort` — always reports `MISSING` (advisory tier / public-data-only mode) with no withdraw permission. */
export class NoCredentialsPort implements CredentialsPort {
  async validate(): Promise<{ status: CredentialStatus; withdrawPermissionGranted: boolean }> {
    return { status: 'MISSING', withdrawPermissionGranted: false };
  }
}

/** Placeholder `ExchangeConnectPort` — resolves immediately (no real exchange to connect to yet). */
export class NoopExchangeConnectPort implements ExchangeConnectPort {
  async connectAndCalibrate(): Promise<void> {
    // no-op
  }
}

/** Placeholder `MarketDataValidationPort` — always reports fresh. */
export class AlwaysFreshMarketDataValidationPort implements MarketDataValidationPort {
  async validate(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

/** `settlement-session`'s not-yet-existing registration port (design.md Open Question 6) — re-exported here for main.ts's convenience; see `health/recovery.ts` for the full doc comment. */
export interface SettlementRecoveryHandoffPort {
  registerRecoveredTrade(trade: Trade): void;
}

/** Placeholder `SettlementRecoveryHandoffPort` — records what it was handed, does nothing else. */
export class NoopSettlementRecoveryHandoff implements SettlementRecoveryHandoffPort {
  readonly registered: Trade[] = [];
  registerRecoveredTrade(trade: Trade): void {
    this.registered.push(trade);
  }
}
