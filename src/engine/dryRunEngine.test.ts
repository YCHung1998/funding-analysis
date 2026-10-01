import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDryRunSimulation } from './dryRunEngine';
import type { FunnelCandidate } from '../types/systemSpec';

const NOW = Date.UTC(2026, 0, 1, 7, 30, 0); // 1767252600000

const candidate: FunnelCandidate = {
  rank: 1,
  symbol: 'DOGEUSDT',
  pionex_rate: 0.0001,
  binance_rate: 0.0021,
  spread: 0.002,
  interval_hours: 8,
  settlement_time: Date.UTC(2026, 0, 1, 8),
  time_to_settlement_sec: 1800,
  volume_24h: 410_000_000,
  orderbook_depth_usd: 4_200_000,
  est_slippage_pct: 0.0008,
  fee_drag_pct: 0.002,
  expected_net_pnl_pct: -0.0008,
  expected_net_pnl_usdt: -0.8,
  meets_threshold: true,
  funnel_stage: 'Level3_Selected',
  long_exchange: 'Binance',
  short_exchange: 'Bybit',
  long_rate: 0.0001,
  short_rate: 0.0021,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeDryRunSimulation：正常情境', () => {
  it('平衡對沖，成本表逐腿鎖住', () => {
    const r = executeDryRunSimulation(candidate, 1000, false);
    expect(r.position_state).toBe('BALANCED_HEDGED');
    expect(r.long_exchange).toBe('Binance');
    expect(r.short_exchange).toBe('Bybit');

    const t = r.cost_table;
    expect(t.position).toEqual({ leg_long: 1000, leg_short: 1000, total: 2000 });
    expect(t.entry_fee).toEqual({ leg_long: 0.5, leg_short: 0.5, total: 1 });
    expect(t.exit_fee).toEqual({ leg_long: 0.5, leg_short: 0.5, total: 1 });
    // 單腿滑價 = est_slippage_pct × 0.25 × notional = 0.2
    expect(t.entry_slippage.leg_long).toBeCloseTo(0.2, 9);
    expect(t.entry_slippage.total).toBeCloseTo(0.4, 9);
    expect(t.exit_slippage.total).toBeCloseTo(0.4, 9);
    expect(t.price_pnl.leg_long).toBeCloseTo(0.08, 9);
    expect(t.price_pnl.leg_short).toBeCloseTo(-0.09, 9);
    expect(t.funding_pnl.leg_long).toBeCloseTo(-0.1, 9);
    expect(t.funding_pnl.leg_short).toBeCloseTo(2.1, 9);
    expect(t.net_pnl.leg_long).toBeCloseTo(-1.42, 9);
    expect(t.net_pnl.leg_short).toBeCloseTo(0.61, 9);
    expect(t.net_pnl.total).toBeCloseTo(-0.81, 9);
  });

  it('[Q-08][P7] 現況：延遲依交易所名稱寫死', () => {
    // 修正後預期：延遲來自實測（Runtime Health / 下單回報），而非交易所名稱對照常數
    const r = executeDryRunSimulation(candidate, 1000, false);
    expect(r.telemetry).toEqual({
      long_api_latency_ms: 22,
      short_api_latency_ms: 34,
      long_fill_latency_ms: 55,
      short_fill_latency_ms: 50,
      total_execution_drift_ms: 3,
    });
  });

  it('風控報告全數通過', () => {
    const r = executeDryRunSimulation(candidate, 1000, false);
    expect(r.risk_report.overall_status).toBe('PASS');
    expect(r.risk_report.action_recommendation).toBe('PROCEED_TRADE');
    expect(r.risk_report.leg_imbalance_detected).toBe(false);
    expect(r.risk_report.failed_reasons).toEqual([]);
    expect(r.risk_report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'r1:PASS', 'r2:PASS', 'r3:PASS', 'r4:PASS', 'r5:PASS', 'r6:PASS', 'r7:PASS', 'r8:PASS', 'r9:PASS',
    ]);
  });

  it('timeline 步驟與狀態', () => {
    const r = executeDryRunSimulation(candidate, 1000, false);
    expect(r.timeline.map((s) => [s.id, s.title, s.status])).toEqual([
      ['step_1', 'PRE_FLIGHT_CHECK', 'SUCCESS'],
      ['step_2', 'ORDER_SUBMIT', 'INFO'],
      ['step_3', 'ORDER_ACK', 'SUCCESS'],
      ['step_4', 'ORDER_FILL', 'SUCCESS'],
      ['step_5', 'FUNDING_SETTLEMENT', 'SUCCESS'],
      ['step_6', 'POSITION_CLOSE', 'SUCCESS'],
    ]);
  });

  it('訂單編號使用固定系統時間', () => {
    const r = executeDryRunSimulation(candidate, 1000, false);
    expect(r.long_order.client_order_id).toBe('DRY_LONG_1767252600000');
    expect(r.short_order.client_order_id).toBe('DRY_SHORT_1767252600000');
    expect(r.short_order.order_state).toBe('FILLED');
  });
});

describe('executeDryRunSimulation：forceLegImbalance', () => {
  it('[Q-08] 現況：單腿失敗仍計多腿資金費', () => {
    // 修正後預期：對沖未成立時不應計入任何資金費收益假設（見 issue/Q-08）
    const r = executeDryRunSimulation(candidate, 1000, true);
    expect(r.position_state).toBe('LEG_IMBALANCE');
    expect(r.cost_table.funding_pnl.leg_short).toBe(0);
    expect(r.cost_table.funding_pnl.leg_long).toBeCloseTo(-1000 * 0.0001, 9);
    expect(r.cost_table.position).toEqual({ leg_long: 1000, leg_short: 0, total: 2000 });
    expect(r.cost_table.entry_fee).toEqual({ leg_long: 0.5, leg_short: 0, total: 0.5 });
    expect(r.cost_table.net_pnl.leg_short).toBe(0);
    expect(r.cost_table.net_pnl.total).toBeCloseTo(-1.42, 9);
  });

  it('telemetry 與空腿訂單', () => {
    const r = executeDryRunSimulation(candidate, 1000, true);
    expect(r.telemetry).toEqual({
      long_api_latency_ms: 22,
      short_api_latency_ms: 34,
      long_fill_latency_ms: 55,
      short_fill_latency_ms: 0,
      total_execution_drift_ms: 30027,
    });
    expect(r.short_order.order_state).toBe('REJECTED');
    expect(r.short_order.latency.cancel_latency_ms).toBe(32);
  });

  it('風控報告進入緊急出場', () => {
    const r = executeDryRunSimulation(candidate, 1000, true);
    expect(r.risk_report.overall_status).toBe('EMERGENCY_EXIT');
    expect(r.risk_report.action_recommendation).toBe('EMERGENCY_CLOSE_FILLED_LEG');
    expect(r.risk_report.leg_imbalance_detected).toBe(true);
    expect(r.risk_report.failed_reasons).toEqual([
      'Bybit API rejected order',
      'CRITICAL: Unhedged directional risk detected!',
    ]);
  });

  it('timeline 步驟與狀態', () => {
    const r = executeDryRunSimulation(candidate, 1000, true);
    expect(r.timeline.map((s) => [s.id, s.title, s.status])).toEqual([
      ['step_1', 'PRE_FLIGHT_CHECK', 'SUCCESS'],
      ['step_2', 'ORDER_SUBMIT', 'INFO'],
      ['step_3', 'ORDER_ACK', 'ERROR'],
      ['step_4', 'EMERGENCY_ACTION', 'ERROR'],
      ['step_5', 'FUNDING_SETTLEMENT', 'SUCCESS'],
      ['step_6', 'POSITION_CLOSE', 'SUCCESS'],
    ]);
  });
});
