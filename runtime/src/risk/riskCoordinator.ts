/**
 * runtime/src/risk/riskCoordinator.ts
 *
 * The thin orchestration layer (design.md Decision 1 `riskCoordinator.ts`):
 * wires the pure evaluators (`preTradeRisk.ts`, `executionRisk.ts`,
 * `positionRisk.ts`) to the injected ports (`riskReport.ts` outputs +
 * `CapitalLedgerPort` / an execution command port) at the three call points
 * spec.md defines — ARM, PRE_FLIGHT, and the ENTRY/POSITION continuous
 * checks. It does not own Opportunity/Trade state transitions itself
 * (`opportunity-lifecycle` / `paper-execution` do, per design.md Decision
 * 8) — it returns an outcome the caller applies.
 *
 * `MAX_POSITIONS` / `BELOW_MIN_NET_PNL` / `STALE_MARKET_DATA` /
 * `CLOCK_UNRELIABLE` are judged exclusively by `preTradeRisk.ts`'s
 * `evaluatePreTrade` (via this coordinator) — `paper-trading-event-loop`'s
 * `armDecision.ts` / `positionLimiter.ts` compute the *same* conditions for
 * its own pre-ARM shortlist filtering, but the Pre-Trade Risk gate at ARM
 * itself has exactly one implementation: this module (spec.md "確認
 * event-loop 的 … 只有這一份實作").
 */
import type { RiskCheck, RiskStatusReport, TradingEvent } from '../types';
import { evaluateEntry } from './executionRisk';
import { evaluatePosition } from './positionRisk';
import { evaluatePreFlight, evaluatePreTrade } from './preTradeRisk';
import {
  changedItems,
  riskCheckResultEvent,
  riskCheckStartedEvent,
  toRiskCheckRows,
  toRiskStatusReport,
  type RiskEventClockInfo,
} from './riskReport';
import type {
  CapitalLedgerPort,
  EntryContext,
  PositionContext,
  PreTradeContext,
  RiskCheckResult,
  RiskCheckSink,
  RiskConfig,
  RiskEventSink,
} from './types';

export interface RiskCoordinatorDeps {
  capital: CapitalLedgerPort;
  eventSink: RiskEventSink;
  checkSink: RiskCheckSink;
  idGenerator?: () => string;
}

/** `paper-execution`'s command interface (design.md Decision 8) — Risk Engine only requests, never mutates Trade/Order state itself. */
export interface ExecutionCommandPort {
  cancelEntryOrders(tradeId: string, reason: string): void;
  rejectFurtherEntry(tradeId: string, reason: string): void;
  startEmergencyExit(tradeId: string, reason: string): void;
}

// ---------------------------------------------------------------------------
// ARM — full 15-item Pre-Trade Risk
// ---------------------------------------------------------------------------

export interface ArmRiskInput {
  opportunity_id: string;
  session_id?: string;
  ctx: PreTradeContext;
  cfg: RiskConfig;
  /** Capital to reserve on ALLOW — usually ctx.required_capital_usdt, passed explicitly for clarity. */
  required_capital_usdt: number;
  trade_id: string;
}

export type ArmRiskOutcome =
  | { outcome: 'SELECTED'; trade_id: string; risk_status: RiskStatusReport }
  | { outcome: 'REJECTED'; rejection_reason: string; risk_status: RiskStatusReport };

/**
 * ARM Pre-Trade gate (spec "ARM 與 PRE_FLIGHT 呼叫 Pre-Trade Risk"): runs
 * all 15 checks, writes one `risk_checks` row per item, emits
 * `RISK_CHECK_STARTED` + `RISK_CHECK_PASSED`/`FAILED`. On ALLOW, reserves
 * capital via the injected `CapitalLedgerPort` and returns `SELECTED`; on
 * BLOCK, reserves nothing and returns `REJECTED` with `rejection_reason` =
 * the first `failed_reasons` entry (registry order).
 */
export function runArmPreTradeRisk(input: ArmRiskInput, deps: RiskCoordinatorDeps): ArmRiskOutcome {
  const clockInfo: RiskEventClockInfo = { timestamp: input.ctx.now };
  const ids = { opportunity_id: input.opportunity_id, trade_id: null, session_id: input.session_id };
  deps.eventSink.emit(riskCheckStartedEvent('PRE_TRADE', ids, clockInfo, deps.idGenerator));

  const evaluation = evaluatePreTrade(input.ctx, input.cfg);
  const rows = toRiskCheckRows(evaluation, 'TRADE_CREATION', { opportunity_id: input.opportunity_id }, deps.idGenerator);
  deps.checkSink.record(rows);
  deps.eventSink.emit(riskCheckResultEvent(evaluation, ids, clockInfo, deps.idGenerator));

  const risk_status = toRiskStatusReport(evaluation);
  if (evaluation.action === 'ALLOW') {
    deps.capital.reserve(input.trade_id, input.required_capital_usdt);
    return { outcome: 'SELECTED', trade_id: input.trade_id, risk_status };
  }
  return { outcome: 'REJECTED', rejection_reason: evaluation.failed_reasons[0], risk_status };
}

// ---------------------------------------------------------------------------
// PRE_FLIGHT — 6-item rerun before Order Submission
// ---------------------------------------------------------------------------

export interface PreFlightRiskInput {
  opportunity_id: string;
  trade_id: string;
  ctx: PreTradeContext;
  cfg: RiskConfig;
}

export type PreFlightRiskOutcome =
  | { outcome: 'CONTINUE'; risk_status: RiskStatusReport }
  | { outcome: 'ABORTED'; reason: string; risk_status: RiskStatusReport };

/**
 * PRE_FLIGHT gate (spec "Trade 進入 PRE_FLIGHT…再以最新輸入重跑…六項"): any
 * FAIL -> releases the trade's reserved capital and returns `ABORTED`, no
 * order is submitted.
 */
export function runPreFlightRisk(input: PreFlightRiskInput, deps: RiskCoordinatorDeps): PreFlightRiskOutcome {
  const clockInfo: RiskEventClockInfo = { timestamp: input.ctx.now };
  const ids = { opportunity_id: input.opportunity_id, trade_id: input.trade_id };
  deps.eventSink.emit(riskCheckStartedEvent('PRE_TRADE', ids, clockInfo, deps.idGenerator));

  const evaluation = evaluatePreFlight(input.ctx, input.cfg);
  const rows = toRiskCheckRows(
    evaluation,
    'ORDER_SUBMISSION',
    { opportunity_id: input.opportunity_id, trade_id: input.trade_id },
    deps.idGenerator,
  );
  deps.checkSink.record(rows);
  deps.eventSink.emit(riskCheckResultEvent(evaluation, ids, clockInfo, deps.idGenerator));

  const risk_status = toRiskStatusReport(evaluation);
  if (evaluation.action === 'BLOCK') {
    deps.capital.release(input.trade_id, evaluation.failed_reasons[0]);
    return { outcome: 'ABORTED', reason: evaluation.failed_reasons[0], risk_status };
  }
  return { outcome: 'CONTINUE', risk_status };
}

// ---------------------------------------------------------------------------
// ENTRY / POSITION continuous monitors (write-on-start/change/end)
// ---------------------------------------------------------------------------

type MonitorPhase = 'ENTRY' | 'POSITION';

abstract class ContinuousRiskMonitor<Ctx extends { now: number }> {
  private previousItems: RiskCheckResult[] | null = null;

  protected constructor(
    private readonly phase: MonitorPhase,
    private readonly opportunityId: string | undefined,
    private readonly tradeId: string,
    private readonly deps: RiskCoordinatorDeps,
    private readonly execution: ExecutionCommandPort,
  ) {}

  protected abstract run(ctx: Ctx, cfg: RiskConfig): ReturnType<typeof evaluateEntry>;

  private ids() {
    return { opportunity_id: this.opportunityId, trade_id: this.tradeId };
  }

  private writeRows(items: RiskCheckResult[], configVersion: string, evaluatedAt: number): void {
    if (items.length === 0) return;
    const rows: RiskCheck[] = toRiskCheckRows(
      { stage: this.phase, evaluated_at: evaluatedAt, config_version: configVersion, items, action: 'CONTINUE', failed_reasons: [], leg_imbalance_detected: false },
      this.phase,
      { opportunity_id: this.opportunityId ?? '', trade_id: this.tradeId },
      this.deps.idGenerator,
    );
    this.deps.checkSink.record(rows);
  }

  private dispatchAction(action: string, failed_reasons: string[]): void {
    const reason = failed_reasons[0] ?? action;
    if (action === 'HALT_ENTRY') {
      this.execution.cancelEntryOrders(this.tradeId, reason);
      this.execution.rejectFurtherEntry(this.tradeId, 'RISK_HALT_ENTRY');
    } else if (action === 'EMERGENCY_EXIT') {
      this.execution.startEmergencyExit(this.tradeId, reason);
    }
  }

  /** First evaluation of the stage: writes every item, emits STARTED + result event. */
  start(ctx: Ctx, cfg: RiskConfig): ReturnType<typeof evaluateEntry> {
    const clockInfo: RiskEventClockInfo = { timestamp: ctx.now };
    this.deps.eventSink.emit(riskCheckStartedEvent(this.phase, this.ids(), clockInfo, this.deps.idGenerator));
    const evaluation = this.run(ctx, cfg);
    this.writeRows(evaluation.items, cfg.config_version, ctx.now);
    this.deps.eventSink.emit(riskCheckResultEvent(evaluation, this.ids(), clockInfo, this.deps.idGenerator));
    this.previousItems = evaluation.items;
    this.dispatchAction(evaluation.action, evaluation.failed_reasons);
    return evaluation;
  }

  /** A periodic/event-triggered re-evaluation: writes + emits only if some item's status changed. */
  continue(ctx: Ctx, cfg: RiskConfig): ReturnType<typeof evaluateEntry> {
    const evaluation = this.run(ctx, cfg);
    const diff = this.previousItems ? changedItems(this.previousItems, evaluation.items) : evaluation.items;
    if (diff.length > 0) {
      this.writeRows(diff, cfg.config_version, ctx.now);
      const clockInfo: RiskEventClockInfo = { timestamp: ctx.now };
      this.deps.eventSink.emit(riskCheckResultEvent(evaluation, this.ids(), clockInfo, this.deps.idGenerator));
    }
    this.previousItems = evaluation.items;
    this.dispatchAction(evaluation.action, evaluation.failed_reasons);
    return evaluation;
  }

  /** Stage end: writes every item one final time. */
  end(ctx: Ctx, cfg: RiskConfig): ReturnType<typeof evaluateEntry> {
    const evaluation = this.run(ctx, cfg);
    this.writeRows(evaluation.items, cfg.config_version, ctx.now);
    const clockInfo: RiskEventClockInfo = { timestamp: ctx.now };
    this.deps.eventSink.emit(riskCheckResultEvent(evaluation, this.ids(), clockInfo, this.deps.idGenerator));
    this.previousItems = evaluation.items;
    return evaluation;
  }
}

/** Entry Risk continuous monitor for `ENTRY_PENDING` / `PARTIALLY_HEDGED` (spec 3.2 / S10). */
export class EntryRiskMonitor extends ContinuousRiskMonitor<EntryContext> {
  constructor(opportunityId: string | undefined, tradeId: string, deps: RiskCoordinatorDeps, execution: ExecutionCommandPort) {
    super('ENTRY', opportunityId, tradeId, deps, execution);
  }
  protected run(ctx: EntryContext, cfg: RiskConfig) {
    return evaluateEntry(ctx, cfg);
  }
}

/** Position Risk continuous monitor for `HEDGED` / `EXIT_PENDING` (spec 3.3). */
export class PositionRiskMonitor extends ContinuousRiskMonitor<PositionContext> {
  constructor(opportunityId: string | undefined, tradeId: string, deps: RiskCoordinatorDeps, execution: ExecutionCommandPort) {
    super('POSITION', opportunityId, tradeId, deps, execution);
  }
  protected run(ctx: PositionContext, cfg: RiskConfig) {
    return evaluatePosition(ctx, cfg);
  }
}
