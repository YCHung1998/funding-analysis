/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Module 5 & 6 (M5 Execution + M6 Risk Engine): Multi-Exchange Dry-Run Engine
 * 
 * Dynamic support for:
 * - Arbitrary pairs across Pionex, Binance, Bybit, Bitget
 * - Clear identification of Long Leg vs Short Leg
 * - Millisecond Execution Timeline with real Latency Telemetry
 * - Explicit State Machine: Cancel Pending Order vs Close Filled Position
 * - Leg Imbalance Emergency Handling
 * - 9-Factor Pre-Flight & In-Flight Risk Checker
 * - Itemized Cost / Profit Decomposition Table (Leg A vs Leg B vs Total)
 */

import {
  FunnelCandidate,
  TimelineMilestone,
  RiskStatusReport,
  RiskCheckItem,
  SimulatedOrderLeg,
  OrderLatencyMetrics,
  OrderState,
  PositionState
} from '../types/systemSpec';
import { feeRate } from '../../runtime/src/accounting/feeEngine';
import type { ExchangeId } from '../../runtime/src/types/ids';

export interface DryRunExecutionResult {
  candidate: FunnelCandidate;
  notional: number;
  position_state: PositionState;
  timeline: TimelineMilestone[];
  risk_report: RiskStatusReport;
  
  // Dynamic Leg Names
  long_exchange: string;
  short_exchange: string;
  long_rate: number;
  short_rate: number;
  
  long_order: SimulatedOrderLeg;
  short_order: SimulatedOrderLeg;
  
  // Cost & Profit Breakdown
  cost_table: {
    long_exchange_name: string;
    short_exchange_name: string;
    position: { leg_long: number; leg_short: number; total: number };
    entry_fee: { leg_long: number; leg_short: number; total: number };
    exit_fee: { leg_long: number; leg_short: number; total: number };
    entry_slippage: { leg_long: number; leg_short: number; total: number };
    exit_slippage: { leg_long: number; leg_short: number; total: number };
    price_pnl: { leg_long: number; leg_short: number; total: number };
    funding_pnl: { leg_long: number; leg_short: number; total: number };
    net_pnl: { leg_long: number; leg_short: number; total: number };
  };

  telemetry: {
    long_api_latency_ms: number;
    short_api_latency_ms: number;
    long_fill_latency_ms: number;
    short_fill_latency_ms: number;
    total_execution_drift_ms: number;
  };
}

/**
 * Runs a complete dry-run simulation of the 60-second lifecycle for the specific locked candidate
 */
export function executeDryRunSimulation(
  candidate: FunnelCandidate,
  notional: number = 1000,
  forceLegImbalance: boolean = false
): DryRunExecutionResult {
  // Determine Long and Short exchange dynamically
  let longEx = candidate.long_exchange || 'Bybit';
  let shortEx = candidate.short_exchange || 'Bitget';
  let longRate = candidate.long_rate !== undefined ? candidate.long_rate : Math.min(candidate.pionex_rate, candidate.binance_rate);
  let shortRate = candidate.short_rate !== undefined ? candidate.short_rate : Math.max(candidate.pionex_rate, candidate.binance_rate);

  // If long and short are identical or default, calibrate from rates
  if (longEx === shortEx) {
    if (candidate.pionex_rate < candidate.binance_rate) {
      longEx = 'Pionex';
      shortEx = 'Binance';
      longRate = candidate.pionex_rate;
      shortRate = candidate.binance_rate;
    } else {
      longEx = 'Binance';
      shortEx = 'Pionex';
      longRate = candidate.binance_rate;
      shortRate = candidate.pionex_rate;
    }
  }

  // Realistic Latency Measurements (ms) for the two chosen exchanges
  const latencyA = longEx === 'Binance' ? 22 : longEx === 'Bybit' ? 32 : longEx === 'Bitget' ? 45 : 68;
  const latencyB = shortEx === 'Binance' ? 24 : shortEx === 'Bybit' ? 34 : shortEx === 'Bitget' ? 48 : 72;

  const submitTimeA = 30000 - 50; // T-29.950s
  const ackTimeA = submitTimeA + latencyA;
  const fillTimeA = ackTimeA + 55;

  const submitTimeB = 30000 - 60; // T-29.940s
  const ackTimeB = submitTimeB + latencyB;
  const fillTimeB = forceLegImbalance ? 0 : ackTimeB + 50;

  const latencyMetricsLong: OrderLatencyMetrics = {
    order_submit_time: submitTimeA,
    order_ack_time: ackTimeA,
    order_fill_time: fillTimeA,
    api_latency_ms: ackTimeA - submitTimeA,
    fill_latency_ms: fillTimeA - ackTimeA,
  };

  const latencyMetricsShort: OrderLatencyMetrics = {
    order_submit_time: submitTimeB,
    order_ack_time: ackTimeB,
    order_fill_time: fillTimeB,
    api_latency_ms: ackTimeB - submitTimeB,
    fill_latency_ms: forceLegImbalance ? 0 : fillTimeB - ackTimeB,
    cancel_latency_ms: forceLegImbalance ? 32 : undefined,
  };

  // P9 fix (frozen module C-04: only the fee *source* changes, no new behavior): fee rate read
  // from the shared Fee Engine's default table per leg's actual exchange, instead of a hardcoded
  // 0.05% applied to both legs regardless of identity.
  const longFeeRate = feeRate(longEx as ExchangeId, 'TAKER');
  const shortFeeRate = feeRate(shortEx as ExchangeId, 'TAKER');
  const entryFeeLong = notional * longFeeRate;
  const exitFeeLong = notional * longFeeRate;
  const entryFeeShort = forceLegImbalance ? 0 : notional * shortFeeRate;
  const exitFeeShort = forceLegImbalance ? 0 : notional * shortFeeRate;

  // Slippages
  const slipPct = candidate.est_slippage_pct > 0 ? candidate.est_slippage_pct * 0.25 : 0.00025;
  const entrySlipLong = notional * slipPct;
  const exitSlipLong = notional * slipPct;
  const entrySlipShort = forceLegImbalance ? 0 : notional * slipPct;
  const exitSlipShort = forceLegImbalance ? 0 : notional * slipPct;

  // Price Drift PnL (60s slight basis drift)
  const pricePnLLong = notional * 0.00008;
  const pricePnLShort = forceLegImbalance ? 0 : -notional * 0.00009;

  // Funding PnL at T:
  // Short leg receives funding if shortRate > 0; Long leg pays if longRate > 0 (or receives if longRate < 0)
  // Formula: Long Funding PnL = - notional * longRate; Short Funding PnL = notional * shortRate
  // [Q-08 fix, position-funding-pnl task 3.3] When the other leg failed to fill
  // (forceLegImbalance), this leg is emergency-closed (reduce-only) before the
  // funding settlement time — it never earns/pays the scheduled funding cashflow
  // either, so it must NOT be counted as if it held through settlement.
  const fundingPnLLong = forceLegImbalance ? 0 : -notional * longRate;
  const fundingPnLShort = forceLegImbalance ? 0 : notional * shortRate;

  // Net PnLs
  const netLong = fundingPnLLong + pricePnLLong - entryFeeLong - exitFeeLong - entrySlipLong - exitSlipLong;
  const netShort = fundingPnLShort + pricePnLShort - entryFeeShort - exitFeeShort - entrySlipShort - exitSlipShort;
  const totalNet = netLong + netShort;

  const positionState: PositionState = forceLegImbalance ? 'LEG_IMBALANCE' : 'BALANCED_HEDGED';

  // 9-Factor Pre-Flight Risk Checklist
  const checks: RiskCheckItem[] = [
    {
      id: 'r1',
      name: 'Dual Exchange API Health',
      category: 'Connection',
      status: latencyMetricsLong.api_latency_ms < 120 && latencyMetricsShort.api_latency_ms < 120 ? 'PASS' : 'WARN',
      value: `${longEx}: ${latencyMetricsLong.api_latency_ms}ms · ${shortEx}: ${latencyMetricsShort.api_latency_ms}ms`,
      threshold: '< 120ms roundtrip',
      details: 'WebSocket ping & REST status validated',
    },
    {
      id: 'r2',
      name: `${longEx} Order Routing (Long Leg)`,
      category: 'Execution',
      status: 'PASS',
      value: `ACK ${latencyMetricsLong.api_latency_ms}ms`,
      threshold: '< 80ms ACK',
      details: `${longEx} perpetual market order gateway active`,
    },
    {
      id: 'r3',
      name: `${shortEx} Order Routing (Short Leg)`,
      category: 'Execution',
      status: forceLegImbalance ? 'FAIL' : 'PASS',
      value: forceLegImbalance ? 'REJECTED: 429 Rate Limit' : `ACK ${latencyMetricsShort.api_latency_ms}ms`,
      threshold: '< 50ms ACK',
      details: forceLegImbalance ? `${shortEx} API rejected order` : `${shortEx} order router responsive`,
    },
    {
      id: 'r4',
      name: 'Position Balance (Delta-Neutral)',
      category: 'Execution',
      status: forceLegImbalance ? 'FAIL' : 'PASS',
      value: forceLegImbalance ? `${longEx} 1000U / ${shortEx} 0U` : `${notional}U : ${notional}U (1:1 Balanced)`,
      threshold: 'Delta-Neutral 100%',
      details: forceLegImbalance ? 'CRITICAL: Unhedged directional risk detected!' : 'Zero naked delta exposure',
    },
    {
      id: 'r5',
      name: 'Price Basis Divergence (60s)',
      category: 'Market',
      status: 'PASS',
      value: '0.018%',
      threshold: '< 0.150% max drift',
      details: `${candidate.symbol} tracking tight basis corridor between ${longEx} & ${shortEx}`,
    },
    {
      id: 'r6',
      name: 'Orderbook Depth ($800k Gate)',
      category: 'Market',
      status: candidate.volume_24h > 15000000 ? 'PASS' : 'WARN',
      value: `$${(candidate.volume_24h * 0.02 / 1000).toFixed(0)}k`,
      threshold: '> $800k within ±0.1%',
      details: 'Deep liquidity absorbs 1000U with minimal market impact',
    },
    {
      id: 'r7',
      name: 'Available Margin Quota',
      category: 'Capital',
      status: 'PASS',
      value: `$5,000 / $1,000 allocated`,
      threshold: 'Margin Ratio > 200%',
      details: 'Sufficient collateral for 1x hedged position',
    },
    {
      id: 'r8',
      name: 'Funding Rate Inversion Guard',
      category: 'Market',
      status: candidate.spread >= 0.0020 ? 'PASS' : 'WARN',
      value: `${(candidate.spread * 100).toFixed(3)}% spread`,
      threshold: '≥ 0.20% Taker hurdle',
      details: 'Net profit buffer exceeds fixed fee drag (0.20%)',
    },
    {
      id: 'r9',
      name: 'Exchange Listing Validation',
      category: 'Execution',
      status: 'PASS',
      value: `${candidate.symbol} Verified on ${longEx} & ${shortEx}`,
      threshold: 'Dual Active Listing',
      details: 'Strict enforcement: contract verified active on both venues',
    },
  ];

  const failedReasons = checks.filter(c => c.status === 'FAIL').map(c => c.details);
  const overallStatus = failedReasons.length > 0 ? (forceLegImbalance ? 'EMERGENCY_EXIT' : 'ABORT') : 'PASS';
  const recommendation = forceLegImbalance
    ? 'EMERGENCY_CLOSE_FILLED_LEG'
    : failedReasons.length > 0
    ? 'ABORT_PRE_FLIGHT'
    : 'PROCEED_TRADE';

  const riskReport: RiskStatusReport = {
    overall_status: overallStatus,
    checks,
    failed_reasons: failedReasons,
    leg_imbalance_detected: forceLegImbalance,
    action_recommendation: recommendation,
  };

  // 60-Second Timeline Milestones
  const timeline: TimelineMilestone[] = [
    {
      id: 'step_1',
      timestamp_offset_str: 'T-30.000s',
      offset_ms: -30000,
      title: 'PRE_FLIGHT_CHECK',
      description: `Run 9-Factor Risk Checklist on ${candidate.symbol} (${longEx} vs ${shortEx}). Verify margin quota & API pings.`,
      type: 'CHECK',
      status: 'SUCCESS',
      long_status: 'PASS',
      short_status: 'PASS',
    },
    {
      id: 'step_2',
      timestamp_offset_str: 'T-29.950s',
      offset_ms: -29950,
      title: 'ORDER_SUBMIT',
      description: `Concurrent REST Market IOC Orders: Buy $${notional} on ${longEx} | Sell $${notional} on ${shortEx}.`,
      type: 'POST',
      status: 'INFO',
      long_status: 'ORDER_NEW',
      short_status: 'ORDER_NEW',
    },
    {
      id: 'step_3',
      timestamp_offset_str: 'T-29.900s',
      offset_ms: -29900,
      title: 'ORDER_ACK',
      description: `WebSocket ACK received: ${longEx} (${latencyMetricsLong.api_latency_ms}ms) | ${shortEx} (${latencyMetricsShort.api_latency_ms}ms).`,
      type: 'ACK',
      status: forceLegImbalance ? 'ERROR' : 'SUCCESS',
      long_status: 'ACK_CONFIRMED',
      short_status: forceLegImbalance ? 'ORDER_REJECTED' : 'ACK_CONFIRMED',
    },
    {
      id: 'step_4',
      timestamp_offset_str: 'T-29.840s',
      offset_ms: -29840,
      title: forceLegImbalance ? 'EMERGENCY_ACTION' : 'ORDER_FILL',
      description: forceLegImbalance
        ? `EMERGENCY ALERT: ${shortEx} rejected order! Immediately CLOSE ${longEx} position via Market Close IOC!`
        : `Both legs completely FILLED. Balanced hedged position locked (Delta-Neutral 100%).`,
      type: forceLegImbalance ? 'RISK_ALERT' : 'FILL',
      status: forceLegImbalance ? 'ERROR' : 'SUCCESS',
      long_status: forceLegImbalance ? 'POSITION_CLOSED' : 'POSITION_FILLED',
      short_status: forceLegImbalance ? 'REJECTED' : 'POSITION_FILLED',
    },
    {
      id: 'step_5',
      timestamp_offset_str: 'T+00.000s',
      offset_ms: 0,
      title: 'FUNDING_SETTLEMENT',
      description: `Funding Settlement Snapshot. Long leg receives/pays ${longRate >= 0 ? '-' : '+'}${(Math.abs(longRate) * 100).toFixed(4)}%; Short leg receives/pays ${shortRate >= 0 ? '+' : '-'}${(Math.abs(shortRate) * 100).toFixed(4)}%.`,
      type: 'FUNDING',
      status: 'SUCCESS',
      long_status: 'FEE_TRANSFERRED',
      short_status: forceLegImbalance ? 'SKIPPED' : 'FEE_TRANSFERRED',
    },
    {
      id: 'step_6',
      timestamp_offset_str: 'T+30.000s',
      offset_ms: 30000,
      title: 'POSITION_CLOSE',
      description: `Scheduled Exit: Submit simultaneous Market Close orders on both legs. Realize net funding arbitrage PnL.`,
      type: 'EXIT',
      status: 'SUCCESS',
      long_status: 'POSITION_FLAT',
      short_status: 'POSITION_FLAT',
    },
  ];

  const longOrder: SimulatedOrderLeg = {
    exchange: longEx as any,
    client_order_id: `DRY_LONG_${Date.now()}`,
    symbol: candidate.symbol,
    side: 'BUY',
    contract_side: 'LONG',
    notional,
    quantity: notional / 100,
    order_state: 'FILLED',
    submit_time: submitTimeA,
    ack_time: ackTimeA,
    fill_time: fillTimeA,
    latency: latencyMetricsLong,
    target_price: 100,
    executed_price: 100 * (1 + slipPct),
    slippage_pct: slipPct,
    fee_usdt: entryFeeLong,
  };

  const shortOrder: SimulatedOrderLeg = {
    exchange: shortEx as any,
    client_order_id: `DRY_SHORT_${Date.now()}`,
    symbol: candidate.symbol,
    side: 'SELL',
    contract_side: 'SHORT',
    notional,
    quantity: notional / 100,
    order_state: forceLegImbalance ? 'REJECTED' : 'FILLED',
    submit_time: submitTimeB,
    ack_time: ackTimeB,
    fill_time: fillTimeB,
    latency: latencyMetricsShort,
    target_price: 100,
    executed_price: 100 * (1 - slipPct),
    slippage_pct: forceLegImbalance ? 0 : slipPct,
    fee_usdt: entryFeeShort,
  };

  return {
    candidate,
    notional,
    position_state: positionState,
    timeline,
    risk_report: riskReport,
    long_exchange: longEx,
    short_exchange: shortEx,
    long_rate: longRate,
    short_rate: shortRate,
    long_order: longOrder,
    short_order: shortOrder,
    cost_table: {
      long_exchange_name: longEx,
      short_exchange_name: shortEx,
      position: { leg_long: notional, leg_short: forceLegImbalance ? 0 : notional, total: notional * 2 },
      entry_fee: { leg_long: entryFeeLong, leg_short: entryFeeShort, total: entryFeeLong + entryFeeShort },
      exit_fee: { leg_long: exitFeeLong, leg_short: exitFeeShort, total: exitFeeLong + exitFeeShort },
      entry_slippage: { leg_long: entrySlipLong, leg_short: entrySlipShort, total: entrySlipLong + entrySlipShort },
      exit_slippage: { leg_long: exitSlipLong, leg_short: exitSlipShort, total: exitSlipLong + exitSlipShort },
      price_pnl: { leg_long: pricePnLLong, leg_short: pricePnLShort, total: pricePnLLong + pricePnLShort },
      funding_pnl: { leg_long: fundingPnLLong, leg_short: fundingPnLShort, total: fundingPnLLong + fundingPnLShort },
      net_pnl: { leg_long: netLong, leg_short: netShort, total: totalNet },
    },
    telemetry: {
      long_api_latency_ms: latencyMetricsLong.api_latency_ms,
      short_api_latency_ms: latencyMetricsShort.api_latency_ms,
      long_fill_latency_ms: latencyMetricsLong.fill_latency_ms,
      short_fill_latency_ms: latencyMetricsShort.fill_latency_ms,
      total_execution_drift_ms: Math.abs(fillTimeA - fillTimeB),
    },
  };
}
