/**
 * runtime/src/risk/preTradeRisk.ts
 *
 * `evaluatePreTrade` — the 15-item Pre-Trade Risk evaluator (design.md
 * Decision 1/3, spec.md Pre-Trade requirements). Pure function: all inputs
 * come from the injected `PreTradeContext` + `RiskConfig`, nothing is read
 * from the network, a clock, or a database (design.md "為什麼純函式").
 *
 * `evaluatePreFlight` reruns only the 6 ★ checks (design.md §14 table /
 * `PRE_FLIGHT_RERUN_CODES`) for the Order Submission re-check.
 */
import { LEGS, PRE_FLIGHT_RERUN_CODES } from './types';
import type {
  CheckDefinition,
  Leg,
  PreTradeContext,
  RiskCheckResult,
  RiskConfig,
  RiskEvaluation,
} from './types';
import { failResult, inputMissing, passResult, warnResult } from './types';
import { PRE_TRADE_CHECKS, findCheck } from './checks/registry';

function legLabel(leg: Leg): string {
  return leg;
}

function capital(def: CheckDefinition, ctx: PreTradeContext): RiskCheckResult {
  const { required_capital_usdt, available_capital_usdt } = ctx;
  if (required_capital_usdt === undefined || available_capital_usdt === undefined) return inputMissing(def);
  const value = `${required_capital_usdt} / ${available_capital_usdt}`;
  if (required_capital_usdt > available_capital_usdt) {
    return failResult(def, value, 'required <= available', 'INSUFFICIENT_CAPITAL');
  }
  return passResult(def, value, 'required <= available');
}

function maxPositions(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { non_terminal_trade_count, non_terminal_trade_count_in_session } = ctx;
  if (non_terminal_trade_count === undefined) return inputMissing(def);
  if (non_terminal_trade_count >= cfg.max_positions) {
    return failResult(def, String(non_terminal_trade_count), `< ${cfg.max_positions}`, 'MAX_POSITIONS');
  }
  if (
    cfg.max_positions_per_session !== undefined &&
    non_terminal_trade_count_in_session !== undefined &&
    non_terminal_trade_count_in_session >= cfg.max_positions_per_session
  ) {
    return failResult(
      def,
      String(non_terminal_trade_count_in_session),
      `< ${cfg.max_positions_per_session}`,
      'MAX_POSITIONS',
    );
  }
  return passResult(def, String(non_terminal_trade_count), `< ${cfg.max_positions}`);
}

function maxNotionalPerLeg(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { target_notional_per_leg_usdt } = ctx;
  if (target_notional_per_leg_usdt === undefined) return inputMissing(def);
  if (target_notional_per_leg_usdt > cfg.max_notional_per_leg_usdt) {
    return failResult(
      def,
      String(target_notional_per_leg_usdt),
      `<= ${cfg.max_notional_per_leg_usdt}`,
      'MAX_NOTIONAL_EXCEEDED',
    );
  }
  return passResult(def, String(target_notional_per_leg_usdt), `<= ${cfg.max_notional_per_leg_usdt}`);
}

function maxLeverage(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { leverage, leg_max_leverage } = ctx;
  if (leverage === undefined) return inputMissing(def);
  if (leverage > cfg.max_leverage) {
    return failResult(def, String(leverage), `<= ${cfg.max_leverage}`, 'MAX_LEVERAGE_EXCEEDED');
  }
  for (const leg of LEGS) {
    const legMax = leg_max_leverage?.[leg];
    if (legMax !== undefined && leverage > legMax) {
      return failResult(def, `${legLabel(leg)}: ${leverage}`, `<= ${legMax}`, 'MAX_LEVERAGE_EXCEEDED');
    }
  }
  return passResult(def, String(leverage), `<= ${cfg.max_leverage}`);
}

function minFundingSpread(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { long_funding_rate, short_funding_rate } = ctx;
  if (long_funding_rate === undefined || short_funding_rate === undefined) return inputMissing(def);
  const spread = short_funding_rate - long_funding_rate;
  if (spread < cfg.minimum_funding_spread_pct) {
    return failResult(def, String(spread), `>= ${cfg.minimum_funding_spread_pct}`, 'BELOW_MIN_SPREAD');
  }
  return passResult(def, String(spread), `>= ${cfg.minimum_funding_spread_pct}`);
}

function expectedNetPnl(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { estimated_net_pnl_usdt } = ctx;
  if (estimated_net_pnl_usdt === undefined) return inputMissing(def);
  if (estimated_net_pnl_usdt < cfg.minimum_expected_net_pnl_usdt) {
    return failResult(
      def,
      String(estimated_net_pnl_usdt),
      `>= ${cfg.minimum_expected_net_pnl_usdt}`,
      'BELOW_MIN_NET_PNL',
    );
  }
  return passResult(def, String(estimated_net_pnl_usdt), `>= ${cfg.minimum_expected_net_pnl_usdt}`);
}

function maxSlippage(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { leg_estimated_slippage_pct } = ctx;
  for (const leg of LEGS) {
    const v = leg_estimated_slippage_pct?.[leg];
    if (v === undefined) return inputMissing(def);
  }
  for (const leg of LEGS) {
    const v = leg_estimated_slippage_pct![leg]!;
    if (v > cfg.max_slippage_pct) {
      return failResult(def, `${legLabel(leg)}: ${v}`, `<= ${cfg.max_slippage_pct}`, 'MAX_SLIPPAGE_EXCEEDED');
    }
  }
  return passResult(def, JSON.stringify(leg_estimated_slippage_pct), `<= ${cfg.max_slippage_pct}`);
}

function orderbookDepth(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { leg_depth_usdt, target_notional_per_leg_usdt } = ctx;
  if (target_notional_per_leg_usdt === undefined) return inputMissing(def);
  const required = target_notional_per_leg_usdt * cfg.depth_coverage_ratio;
  for (const leg of LEGS) {
    const v = leg_depth_usdt?.[leg];
    if (v === undefined) return inputMissing(def);
  }
  for (const leg of LEGS) {
    const v = leg_depth_usdt![leg]!;
    if (v < required) {
      return failResult(def, `${legLabel(leg)}: ${v}`, `>= ${required}`, 'INSUFFICIENT_DEPTH');
    }
  }
  return passResult(def, JSON.stringify(leg_depth_usdt), `>= ${required}`);
}

function exchangeConnectivity(def: CheckDefinition, ctx: PreTradeContext): RiskCheckResult {
  const { leg_connectivity, leg_instrument_status } = ctx;
  for (const leg of LEGS) {
    const conn = leg_connectivity?.[leg];
    if (conn === undefined) return inputMissing(def);
    if (conn !== 'CONNECTED') {
      return failResult(def, `${legLabel(leg)}: ${conn}`, 'CONNECTED', 'EXCHANGE_DISCONNECTED');
    }
  }
  for (const leg of LEGS) {
    const status = leg_instrument_status?.[leg];
    if (status === undefined) return inputMissing(def);
    if (status !== 'TRADING') {
      return failResult(def, `${legLabel(leg)}: ${status}`, 'TRADING', 'INSTRUMENT_NOT_TRADING');
    }
  }
  return passResult(def, 'CONNECTED/TRADING', 'CONNECTED/TRADING');
}

function apiLatency(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { leg_api_latency_samples_ms } = ctx;
  const medians: PartialRecord = {};
  for (const leg of LEGS) {
    const samples = leg_api_latency_samples_ms?.[leg];
    if (!samples || samples.length === 0) return inputMissing(def);
    medians[leg] = median(samples);
  }
  for (const leg of LEGS) {
    const m = medians[leg]!;
    if (m > cfg.max_api_latency_ms) {
      return failResult(def, `${legLabel(leg)}: ${m}ms`, `<= ${cfg.max_api_latency_ms}ms`, 'API_LATENCY_HIGH');
    }
  }
  for (const leg of LEGS) {
    const m = medians[leg]!;
    if (m > cfg.warn_api_latency_ms) {
      return warnResult(def, `${legLabel(leg)}: ${m}ms`, `<= ${cfg.warn_api_latency_ms}ms`, 'API_LATENCY_HIGH');
    }
  }
  return passResult(def, JSON.stringify(medians), `<= ${cfg.max_api_latency_ms}ms`);
}

type PartialRecord = Partial<Record<Leg, number>>;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fundingTimeAlignment(def: CheckDefinition, ctx: PreTradeContext): RiskCheckResult {
  const { funding_time_eligible, now, entry_deadline } = ctx;
  if (funding_time_eligible === undefined) return inputMissing(def);
  if (!funding_time_eligible) {
    return failResult(
      def,
      'INELIGIBLE',
      'ELIGIBLE',
      ctx.funding_time_fail_reason ?? 'FUNDING_NOT_ALIGNED',
    );
  }
  if (entry_deadline === undefined) return inputMissing(def);
  if (now >= entry_deadline) {
    return failResult(def, `now=${now}`, `< entry_deadline(${entry_deadline})`, 'ENTRY_WINDOW_CLOSED');
  }
  return passResult(def, 'ELIGIBLE', 'ELIGIBLE, now < entry_deadline');
}

function existingExposure(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { same_symbol_existing_exposure, leg_exchange_existing_notional_usdt, target_notional_per_leg_usdt } = ctx;
  if (same_symbol_existing_exposure === undefined) return inputMissing(def);
  if (same_symbol_existing_exposure) {
    return failResult(def, 'true', 'false', 'EXISTING_EXPOSURE');
  }
  if (target_notional_per_leg_usdt === undefined) return inputMissing(def);
  for (const leg of LEGS) {
    const existing = leg_exchange_existing_notional_usdt?.[leg];
    if (existing === undefined) return inputMissing(def);
    const total = existing + target_notional_per_leg_usdt;
    if (total > cfg.max_exchange_notional_usdt) {
      return failResult(
        def,
        `${legLabel(leg)}: ${total}`,
        `<= ${cfg.max_exchange_notional_usdt}`,
        'EXCHANGE_EXPOSURE_LIMIT',
      );
    }
  }
  return passResult(def, 'no existing exposure', 'no existing exposure');
}

function dataFreshness(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { data_age_samples } = ctx;
  if (!data_age_samples || data_age_samples.length === 0) return inputMissing(def);
  for (const sample of data_age_samples) {
    if (sample.ageMs > cfg.data_stale_threshold_ms) {
      return failResult(
        def,
        `${sample.name}: ${sample.ageMs}ms`,
        `<= ${cfg.data_stale_threshold_ms}ms`,
        'STALE_MARKET_DATA',
      );
    }
  }
  return passResult(def, 'fresh', `<= ${cfg.data_stale_threshold_ms}ms`);
}

function clockReliability(def: CheckDefinition, ctx: PreTradeContext, cfg: RiskConfig): RiskCheckResult {
  const { leg_clock_offset, now } = ctx;
  for (const leg of LEGS) {
    const offset = leg_clock_offset?.[leg];
    if (offset === undefined) return inputMissing(def);
    if (offset.errorMs > cfg.clock_max_error_ms) {
      return failResult(
        def,
        `${legLabel(leg)} errorMs=${offset.errorMs}`,
        `<= ${cfg.clock_max_error_ms}`,
        'CLOCK_UNRELIABLE',
      );
    }
    if (now - offset.calibratedAt > cfg.clock_calibration_max_age_ms) {
      return failResult(
        def,
        `${legLabel(leg)} age=${now - offset.calibratedAt}`,
        `<= ${cfg.clock_calibration_max_age_ms}`,
        'CLOCK_UNRELIABLE',
      );
    }
  }
  return passResult(def, 'reliable', 'reliable');
}

function entryGate(def: CheckDefinition, ctx: PreTradeContext): RiskCheckResult {
  const sources = ctx.entry_gate_sources ?? {};
  for (const [, source] of Object.entries(sources)) {
    if (source.open) {
      return failResult(def, 'GATE_CLOSED', 'GATE_OPEN', source.reason_code);
    }
  }
  return passResult(def, 'GATE_OPEN', 'GATE_OPEN');
}

const CHECK_FNS: Record<string, (ctx: PreTradeContext, cfg: RiskConfig) => RiskCheckResult> = {
  CAPITAL: (ctx) => capital(findCheck('CAPITAL'), ctx),
  MAX_POSITIONS: (ctx, cfg) => maxPositions(findCheck('MAX_POSITIONS'), ctx, cfg),
  MAX_NOTIONAL_PER_LEG: (ctx, cfg) => maxNotionalPerLeg(findCheck('MAX_NOTIONAL_PER_LEG'), ctx, cfg),
  MAX_LEVERAGE: (ctx, cfg) => maxLeverage(findCheck('MAX_LEVERAGE'), ctx, cfg),
  MIN_FUNDING_SPREAD: (ctx, cfg) => minFundingSpread(findCheck('MIN_FUNDING_SPREAD'), ctx, cfg),
  EXPECTED_NET_PNL: (ctx, cfg) => expectedNetPnl(findCheck('EXPECTED_NET_PNL'), ctx, cfg),
  MAX_SLIPPAGE: (ctx, cfg) => maxSlippage(findCheck('MAX_SLIPPAGE'), ctx, cfg),
  ORDERBOOK_DEPTH: (ctx, cfg) => orderbookDepth(findCheck('ORDERBOOK_DEPTH'), ctx, cfg),
  EXCHANGE_CONNECTIVITY: (ctx) => exchangeConnectivity(findCheck('EXCHANGE_CONNECTIVITY'), ctx),
  API_LATENCY: (ctx, cfg) => apiLatency(findCheck('API_LATENCY'), ctx, cfg),
  FUNDING_TIME_ALIGNMENT: (ctx) => fundingTimeAlignment(findCheck('FUNDING_TIME_ALIGNMENT'), ctx),
  EXISTING_EXPOSURE: (ctx, cfg) => existingExposure(findCheck('EXISTING_EXPOSURE'), ctx, cfg),
  DATA_FRESHNESS: (ctx, cfg) => dataFreshness(findCheck('DATA_FRESHNESS'), ctx, cfg),
  CLOCK_RELIABILITY: (ctx, cfg) => clockReliability(findCheck('CLOCK_RELIABILITY'), ctx, cfg),
  ENTRY_GATE: (ctx) => entryGate(findCheck('ENTRY_GATE'), ctx),
};

function aggregate(stage: 'PRE_TRADE', items: RiskCheckResult[], now: number, cfg: RiskConfig): RiskEvaluation {
  const failed = items.filter((i) => i.status === 'FAIL');
  const action = failed.length > 0 ? 'BLOCK' : 'ALLOW';
  return {
    stage,
    evaluated_at: now,
    config_version: cfg.config_version,
    items,
    action,
    failed_reasons: failed.map((i) => i.reason_code!).filter((r): r is string => r !== undefined),
    leg_imbalance_detected: false,
  };
}

/** Runs all 15 Pre-Trade checks, in registry order. */
export function evaluatePreTrade(ctx: PreTradeContext, cfg: RiskConfig): RiskEvaluation {
  const items = PRE_TRADE_CHECKS.map((def) => CHECK_FNS[def.check_code](ctx, cfg));
  return aggregate('PRE_TRADE', items, ctx.now, cfg);
}

/** Reruns only the 6 ★ checks for the `PRE_FLIGHT` (Order Submission) gate. */
export function evaluatePreFlight(ctx: PreTradeContext, cfg: RiskConfig): RiskEvaluation {
  const items = PRE_TRADE_CHECKS.filter((def) =>
    (PRE_FLIGHT_RERUN_CODES as readonly string[]).includes(def.check_code),
  ).map((def) => CHECK_FNS[def.check_code](ctx, cfg));
  return aggregate('PRE_TRADE', items, ctx.now, cfg);
}
