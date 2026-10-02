/**
 * runtime/src/health/healthModel.ts
 *
 * Runtime Health component-status model + derivation rules (tech spec §32,
 * §52; design.md Open Question 5). Pure function — no DB, no Clock, no I/O —
 * so `healthPublisher.ts` can call it with whatever it reads from the
 * injected state ports (`market-data-stream` / `risk-engine` /
 * `position-accounting` are still fakes at this point, design.md Decision 9
 * "上游狀態介面尚未實作").
 *
 * `entry_allowed` / `entry_block_reasons` (tasks.md 3.1): an entry halt and
 * stale/disconnected data on a TRADING exchange both block entry; a
 * disconnected or stale SCAN-ONLY exchange does NOT (tasks.md 3.1 "stale、
 * halt、scan-only 所斷線不影響" — only the "scan-only disconnect" case is the
 * one that doesn't affect `entry_allowed`). RISK/PAPER_EXECUTION not ARMED,
 * missing/invalid credentials, and a degraded database (e.g. event-queue
 * overflow) are additional blockers not spelled out verbatim in tasks.md's
 * parenthetical but required by spec §32/§52's own intent (a Runtime that
 * isn't armed, or has no usable credentials, cannot actually accept a new
 * entry) — recorded as a resolved ambiguity, see design.md Implementation
 * Notes (Task Group 1-3).
 */
import type { ExchangeId } from '../types/ids';

export type EngineStatus = 'RUNNING';
export type ExchangeConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
export type MarketDataStatus = 'HEALTHY' | 'STALE';
export type ScannerStatus = 'RUNNING' | 'STOPPED';
export type ArmStatus = 'ARMED' | 'DISARMED';
export type DatabaseStatus = 'HEALTHY' | 'DEGRADED';
export type ClockStatus = 'RELIABLE' | 'UNRELIABLE';
/** `credentials` MUST only ever be this enum — never the credential value itself (Invariant #2). */
export type CredentialStatus = 'PRESENT' | 'MISSING' | 'INVALID';

export interface ExchangeHealth {
  exchange: ExchangeId;
  status: ExchangeConnectionStatus;
  /** This exchange's market-data feed is older than its staleness threshold. */
  stale: boolean;
  /** True for an exchange server.ts only scans (not in `TRADING_EXCHANGES`) — its disconnects/staleness never block entry. */
  scanOnly: boolean;
}

/** Everything `deriveHealth` needs, read fresh by `healthPublisher.ts` on every publish tick. */
export interface HealthInputs {
  engine: EngineStatus;
  exchanges: ExchangeHealth[];
  scanner: ScannerStatus;
  risk: ArmStatus;
  paperExecution: ArmStatus;
  database: DatabaseStatus;
  clock: ClockStatus;
  credentials: CredentialStatus;
  entryHalted: boolean;
  haltReasons: string[];
  lastEventAt: number | null;
}

export interface RuntimeHealthModel {
  engine: EngineStatus;
  exchanges: ExchangeHealth[];
  marketData: MarketDataStatus;
  scanner: ScannerStatus;
  risk: ArmStatus;
  paperExecution: ArmStatus;
  database: DatabaseStatus;
  clock: ClockStatus;
  credentials: CredentialStatus;
  entry_allowed: boolean;
  entry_block_reasons: string[];
  last_event_at: number | null;
}

export function deriveHealth(inputs: HealthInputs): RuntimeHealthModel {
  const tradingExchanges = inputs.exchanges.filter((e) => !e.scanOnly);
  const staleTrading = tradingExchanges.filter((e) => e.stale);
  const disconnectedTrading = tradingExchanges.filter((e) => e.status !== 'CONNECTED');

  const reasons: string[] = [];
  if (inputs.entryHalted) reasons.push('ENTRY_HALT');
  for (const e of staleTrading) reasons.push(`STALE_MARKET_DATA:${e.exchange}`);
  for (const e of disconnectedTrading) reasons.push(`EXCHANGE_DISCONNECTED:${e.exchange}`);
  if (inputs.risk !== 'ARMED') reasons.push('RISK_DISARMED');
  if (inputs.paperExecution !== 'ARMED') reasons.push('PAPER_EXECUTION_DISARMED');
  if (inputs.credentials !== 'PRESENT') reasons.push(`CREDENTIALS_${inputs.credentials}`);
  if (inputs.database === 'DEGRADED') reasons.push('DATABASE_DEGRADED');

  return {
    engine: inputs.engine,
    exchanges: inputs.exchanges,
    marketData: staleTrading.length > 0 ? 'STALE' : 'HEALTHY',
    scanner: inputs.scanner,
    risk: inputs.risk,
    paperExecution: inputs.paperExecution,
    database: inputs.database,
    clock: inputs.clock,
    credentials: inputs.credentials,
    entry_allowed: reasons.length === 0,
    entry_block_reasons: reasons,
    last_event_at: inputs.lastEventAt,
  };
}
