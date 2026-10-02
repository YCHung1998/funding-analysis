/**
 * runtime/src/risk/riskReport.ts
 *
 * `RiskEvaluation` -> `RiskStatusReport` (old v0.1 shape, spec §6 "沿用"),
 * -> `risk_checks` rows (`trading-schema`'s `RiskCheck`), -> `TradingEvent`s
 * (`RISK_CHECK_STARTED` / `RISK_CHECK_PASSED` / `RISK_CHECK_FAILED`).
 * design.md Decision 2 / Decision 4; spec.md "評估結果彙總為
 * RiskStatusReport" and "檢查結果寫入 risk_checks 並產生 TradingEvent".
 */
import type { RiskCheck, RiskCheckItem, RiskStatusReport, TradingEvent, TradingEventType } from '../types';
import type { RiskCheckResult, RiskEvaluation, StageAction } from './types';

/** `RiskCheck.stage` — the Order Submission / continuous-check phase this evaluation belongs to. */
export type RiskCheckPhase = 'TRADE_CREATION' | 'ORDER_SUBMISSION' | 'ENTRY' | 'POSITION';

// ---------------------------------------------------------------------------
// RiskEvaluation -> RiskStatusReport (design.md Decision 2 old-type mapping)
// ---------------------------------------------------------------------------

function mapAction(stage: RiskEvaluation['stage'], action: StageAction): {
  overall_status: RiskStatusReport['overall_status'];
  action_recommendation: RiskStatusReport['action_recommendation'];
} {
  if (stage === 'PRE_TRADE') {
    return action === 'BLOCK'
      ? { overall_status: 'ABORT', action_recommendation: 'ABORT_PRE_FLIGHT' }
      : { overall_status: 'PASS', action_recommendation: 'PROCEED_TRADE' };
  }
  if (action === 'EMERGENCY_EXIT') {
    return { overall_status: 'EMERGENCY_EXIT', action_recommendation: 'EMERGENCY_CLOSE_FILLED_LEG' };
  }
  if (action === 'HALT_ENTRY') {
    return { overall_status: 'ABORT', action_recommendation: 'ABORT_PRE_FLIGHT' };
  }
  return { overall_status: 'PASS', action_recommendation: 'PROCEED_TRADE' };
}

function toCheckItem(item: RiskCheckResult): RiskCheckItem {
  return {
    id: item.check_code,
    name: item.name,
    category: item.category,
    status: item.status,
    value: item.value,
    threshold: item.threshold,
    details: item.reason_code ?? '',
  };
}

/** Maps a `RiskEvaluation` to the v0.1 `RiskStatusReport` shape (spec §6 "沿用"). */
export function toRiskStatusReport(evaluation: RiskEvaluation): RiskStatusReport {
  const { overall_status, action_recommendation } = mapAction(evaluation.stage, evaluation.action);
  return {
    overall_status,
    checks: evaluation.items.map(toCheckItem),
    failed_reasons: evaluation.failed_reasons,
    leg_imbalance_detected: evaluation.leg_imbalance_detected,
    action_recommendation,
  };
}

// ---------------------------------------------------------------------------
// RiskEvaluation -> risk_checks rows (RiskCheck, trading-schema shape)
// ---------------------------------------------------------------------------

export interface RiskCheckRowIds {
  opportunity_id: string;
  trade_id?: string;
}

/**
 * Builds one `RiskCheck` row per item (design.md Decision 4 / spec
 * "PRE_TRADE 的每一項 MUST 各寫入一筆"). `created_at` = `updated_at` =
 * `evaluation.evaluated_at` (Clock time, spec §25 #4).
 */
export function toRiskCheckRows(
  evaluation: RiskEvaluation,
  phase: RiskCheckPhase,
  ids: RiskCheckRowIds,
  idGenerator: () => string = () => crypto.randomUUID(),
): RiskCheck[] {
  return evaluation.items.map((item) => ({
    risk_check_id: idGenerator(),
    opportunity_id: ids.opportunity_id,
    trade_id: ids.trade_id,
    stage: phase,
    check_id: item.check_code,
    name: item.name,
    status: item.status,
    critical: item.critical,
    value: item.value,
    threshold: item.threshold,
    reason: item.reason_code,
    config_version: evaluation.config_version,
    created_at: evaluation.evaluated_at,
    updated_at: evaluation.evaluated_at,
  }));
}

// ---------------------------------------------------------------------------
// Continuous-check diffing (Entry/Position: write-on-start, write-on-change,
// write-on-end — spec "只在某一項狀態改變時寫入該項").
// ---------------------------------------------------------------------------

/** Items whose `status` differs from `previous` (by `check_code`), for mid-stage writes. */
export function changedItems(previous: RiskCheckResult[], current: RiskCheckResult[]): RiskCheckResult[] {
  const prevByCode = new Map(previous.map((i) => [i.check_code, i]));
  return current.filter((item) => prevByCode.get(item.check_code)?.status !== item.status);
}

// ---------------------------------------------------------------------------
// TradingEvents (RISK_CHECK_STARTED / PASSED / FAILED)
// ---------------------------------------------------------------------------

export interface RiskEventIds {
  opportunity_id?: string;
  trade_id: string | null;
  session_id?: string;
}

export interface RiskEventClockInfo {
  timestamp: number;
  clock_offset_ms?: number;
}

function baseEvent(
  event_type: TradingEventType,
  ids: RiskEventIds,
  clock: RiskEventClockInfo,
  payload: Record<string, unknown>,
  idGenerator: () => string,
): TradingEvent {
  return {
    event_id: idGenerator(),
    event_type,
    timestamp: clock.timestamp,
    trade_id: ids.trade_id,
    opportunity_id: ids.opportunity_id,
    session_id: ids.session_id,
    payload,
    recorded_at: clock.timestamp,
    clock_offset_ms: clock.clock_offset_ms,
  };
}

/** `RISK_CHECK_STARTED` — emitted before evaluation begins. */
export function riskCheckStartedEvent(
  stage: RiskEvaluation['stage'],
  ids: RiskEventIds,
  clock: RiskEventClockInfo,
  idGenerator: () => string = () => crypto.randomUUID(),
): TradingEvent {
  return baseEvent('RISK_CHECK_STARTED', ids, clock, { stage }, idGenerator);
}

/**
 * `RISK_CHECK_PASSED` (no FAIL) or `RISK_CHECK_FAILED` (payload carries
 * `stage`, `failed_reasons`, `action`, and FAIL items' input snapshots —
 * spec "FAIL 項目的輸入快照放在 RISK_CHECK_FAILED 事件 payload").
 */
export function riskCheckResultEvent(
  evaluation: RiskEvaluation,
  ids: RiskEventIds,
  clock: RiskEventClockInfo,
  idGenerator: () => string = () => crypto.randomUUID(),
): TradingEvent {
  const hasFail = evaluation.failed_reasons.length > 0;
  const payload: Record<string, unknown> = {
    stage: evaluation.stage,
    action: evaluation.action,
    failed_reasons: evaluation.failed_reasons,
  };
  if (hasFail) {
    payload.failed_items = evaluation.items
      .filter((i) => i.status === 'FAIL')
      .map((i) => ({ check_code: i.check_code, reason_code: i.reason_code, value: i.value, inputs: i.inputs }));
  }
  return baseEvent(hasFail ? 'RISK_CHECK_FAILED' : 'RISK_CHECK_PASSED', ids, clock, payload, idGenerator);
}
