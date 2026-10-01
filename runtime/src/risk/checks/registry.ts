/**
 * runtime/src/risk/checks/registry.ts
 *
 * The 28-check definition table (design.md Decision 1 `checks/registry.ts`;
 * spec.md Pre-Trade/Entry/Position tables). Order within each stage is the
 * spec's table order — `failed_reasons` MUST follow this order (spec
 * "Requirement: 評估結果彙總為 RiskStatusReport").
 */
import type { CheckDefinition } from '../types';

export const PRE_TRADE_CHECKS: readonly CheckDefinition[] = [
  { check_code: 'CAPITAL', name: 'Capital', stage: 'PRE_TRADE', critical: true, category: 'Capital' },
  { check_code: 'MAX_POSITIONS', name: 'Max Positions', stage: 'PRE_TRADE', critical: true, category: 'Capital' },
  {
    check_code: 'MAX_NOTIONAL_PER_LEG',
    name: 'Max Notional Per Leg',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Capital',
  },
  { check_code: 'MAX_LEVERAGE', name: 'Max Leverage', stage: 'PRE_TRADE', critical: true, category: 'Capital' },
  {
    check_code: 'MIN_FUNDING_SPREAD',
    name: 'Min Funding Spread',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Market',
  },
  {
    check_code: 'EXPECTED_NET_PNL',
    name: 'Expected Net PnL',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Market',
  },
  { check_code: 'MAX_SLIPPAGE', name: 'Max Slippage', stage: 'PRE_TRADE', critical: true, category: 'Execution' },
  {
    check_code: 'ORDERBOOK_DEPTH',
    name: 'Orderbook Depth',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Execution',
  },
  {
    check_code: 'EXCHANGE_CONNECTIVITY',
    name: 'Exchange Connectivity',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Connection',
  },
  { check_code: 'API_LATENCY', name: 'API Latency', stage: 'PRE_TRADE', critical: true, category: 'Connection' },
  {
    check_code: 'FUNDING_TIME_ALIGNMENT',
    name: 'Funding Time Alignment',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Market',
  },
  {
    check_code: 'EXISTING_EXPOSURE',
    name: 'Existing Exposure',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Capital',
  },
  {
    check_code: 'DATA_FRESHNESS',
    name: 'Data Freshness',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Connection',
  },
  {
    check_code: 'CLOCK_RELIABILITY',
    name: 'Clock Reliability',
    stage: 'PRE_TRADE',
    critical: true,
    category: 'Connection',
  },
  { check_code: 'ENTRY_GATE', name: 'Entry Gate', stage: 'PRE_TRADE', critical: true, category: 'Execution' },
] as const;

export const ENTRY_CHECKS: readonly CheckDefinition[] = [
  {
    check_code: 'PRICE_DEVIATION',
    name: 'Price Deviation',
    stage: 'ENTRY',
    critical: true,
    category: 'Market',
    failAction: 'HALT_ENTRY',
  },
  {
    check_code: 'FUNDING_RATE_CHANGE',
    name: 'Funding Rate Change',
    stage: 'ENTRY',
    critical: true,
    category: 'Market',
    failAction: 'HALT_ENTRY',
  },
  {
    check_code: 'ORDER_TIMEOUT',
    name: 'Order Timeout',
    stage: 'ENTRY',
    critical: true,
    category: 'Execution',
    failAction: 'HALT_ENTRY',
  },
  {
    check_code: 'PARTIAL_FILL',
    name: 'Partial Fill',
    stage: 'ENTRY',
    critical: true,
    category: 'Execution',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'LEG_IMBALANCE',
    name: 'Leg Imbalance',
    stage: 'ENTRY',
    critical: true,
    category: 'Execution',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'EXCHANGE_CONNECTION',
    name: 'Exchange Connection',
    stage: 'ENTRY',
    critical: true,
    category: 'Connection',
    failAction: 'HALT_ENTRY',
  },
  {
    check_code: 'MARKET_VOLATILITY',
    name: 'Market Volatility',
    stage: 'ENTRY',
    critical: true,
    category: 'Market',
    failAction: 'HALT_ENTRY',
  },
] as const;

export const POSITION_CHECKS: readonly CheckDefinition[] = [
  {
    check_code: 'POSITION_IMBALANCE',
    name: 'Position Imbalance',
    stage: 'POSITION',
    critical: true,
    category: 'Execution',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'MARK_PRICE_MOVEMENT',
    name: 'Mark Price Movement',
    stage: 'POSITION',
    critical: true,
    category: 'Market',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'BASIS_DIVERGENCE',
    name: 'Basis Divergence',
    stage: 'POSITION',
    critical: true,
    category: 'Market',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'FUNDING_CHANGE',
    name: 'Funding Change',
    stage: 'POSITION',
    critical: true,
    category: 'Market',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'HOLDING_TIME',
    name: 'Holding Time',
    stage: 'POSITION',
    critical: true,
    category: 'Execution',
    failAction: 'EMERGENCY_EXIT',
  },
  {
    check_code: 'EXIT_CONDITION',
    name: 'Exit Condition',
    stage: 'POSITION',
    critical: true,
    category: 'Execution',
    failAction: 'EMERGENCY_EXIT',
  },
] as const;

export const ALL_CHECKS: readonly CheckDefinition[] = [...PRE_TRADE_CHECKS, ...ENTRY_CHECKS, ...POSITION_CHECKS];

export function findCheck(check_code: string): CheckDefinition {
  const def = ALL_CHECKS.find((c) => c.check_code === check_code);
  if (!def) throw new Error(`Unknown check_code: ${check_code}`);
  return def;
}
