/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Dry-Run Console (Spec Sections 11 - 15)
 * Linked Multi-Exchange Execution Simulator
 * Features:
 * - Prominent "LOCKED ACTIVE TARGET BANNER" displaying symbol, long/short combination, rates, spread & profit
 * - 30-second automatic rate refresher with countdown timer and manual refresh button
 * - Zone A: Pre-Funding Analysis (Top list recommendation, only calculates for active locked target)
 * - Zone B: 60s Millisecond Execution Timeline with dynamic exchange legs
 * - Zone C: Itemized Cost / Profit Table (Long Leg vs Short Leg vs Total)
 * - Zone D: 9-Factor Pre-Flight & In-Flight Risk Checklist
 */

import React, { useState, useEffect } from 'react';
import { FunnelCandidate } from '../types/systemSpec';
import { executeDryRunSimulation, DryRunExecutionResult } from '../engine/dryRunEngine';
import { fetchLiveMarketScan } from '../services/liveMarketService';
import {
  Clock,
  Play,
  RotateCcw,
  AlertOctagon,
  CheckCircle2,
  AlertTriangle,
  Layers,
  Activity,
  ArrowRight,
  ShieldCheck,
  ShieldAlert,
  Server,
  RefreshCw,
  Zap,
  Target,
  ArrowRightLeft
} from 'lucide-react';

interface DryRunConsoleProps {
  top3Candidates: FunnelCandidate[];
  selectedCandidate: FunnelCandidate;
  onSelectCandidate: (candidate: FunnelCandidate) => void;
}

export const DryRunConsole: React.FC<DryRunConsoleProps> = ({
  top3Candidates,
  selectedCandidate,
  onSelectCandidate,
}) => {
  const [notional, setNotional] = useState(1000);
  const [forceLegImbalance, setForceLegImbalance] = useState(false);
  const [activeZone, setActiveZone] = useState<'all' | 'timeline' | 'cost' | 'risk'>('all');

  // 10-Second Live Rate Update State (Requirement 2)
  const [countdown, setCountdown] = useState(10);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedTime, setLastUpdatedTime] = useState<Date>(new Date());
  const [lockedCandidateState, setLockedCandidateState] = useState<FunnelCandidate>(selectedCandidate);

  // Sync when prop selectedCandidate changes
  useEffect(() => {
    setLockedCandidateState(selectedCandidate);
    setCountdown(10);
  }, [selectedCandidate]);

  // 10-Second Countdown & Auto-Refresh Hook
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          refreshRatesForLockedTarget();
          return 10;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [lockedCandidateState.symbol]);

  // Live polling for the locked symbol
  const refreshRatesForLockedTarget = async () => {
    setIsRefreshing(true);
    try {
      const scanRes = await fetchLiveMarketScan();
      if (scanRes.success && scanRes.candidates) {
        const found = scanRes.candidates.find(
          c => c.symbol === lockedCandidateState.symbol || c.base === lockedCandidateState.symbol.replace('USDT', '')
        );

        if (found) {
          const updated: FunnelCandidate = {
            ...lockedCandidateState,
            pionex_rate: found.pionex_rate ?? lockedCandidateState.pionex_rate,
            binance_rate: found.binance_rate ?? lockedCandidateState.binance_rate,
            bybit_rate: found.bybit_rate,
            bitget_rate: found.bitget_rate,
            okx_rate: found.okx_rate,
            okx_mark: found.okx_mark,
            spread: found.spread,
            long_exchange: found.best_pair.long_exchange,
            short_exchange: found.best_pair.short_exchange,
            long_rate: (found as any)[`${found.best_pair.long_exchange.toLowerCase()}_rate`],
            short_rate: (found as any)[`${found.best_pair.short_exchange.toLowerCase()}_rate`],
            pair_label: found.best_pair.pair_label,
            expected_net_pnl_pct: found.expected_net_pnl_pct,
            expected_net_pnl_usdt: notional * found.expected_net_pnl_pct,
            coverage_count: found.available_exchanges?.length || 5,
          };
          setLockedCandidateState(updated);
        }
      }
      setLastUpdatedTime(new Date());
    } catch (err) {
      console.warn('Failed to refresh rate for locked symbol:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const simulation: DryRunExecutionResult = executeDryRunSimulation(
    lockedCandidateState,
    notional,
    forceLegImbalance
  );

  const cost = simulation.cost_table;
  const isProfitable = cost.net_pnl.total > 0;

  return (
    <div className="space-y-6">
      {/* REQUIREMENT 1 & 2: PROMINENT LOCKED ACTIVE TARGET BANNER */}
      <div className="bg-slate-900 border-2 border-cyan-500/80 rounded-xl p-5 shadow-2xl relative overflow-hidden">
        {/* Subtle background glow */}
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 bg-cyan-950 border border-cyan-500/60 text-cyan-300 text-xs font-mono font-bold px-2.5 py-1 rounded">
                <Target className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                <span>當前鎖定模擬目標 (LOCKED ACTIVE TARGET)</span>
              </span>

              <span className="text-xs text-slate-400 font-mono">
                {lockedCandidateState.coverage_count ? `[${lockedCandidateState.coverage_count}/5 家交易所支援]` : '[五所跨市套利]'}
              </span>

              <span className="text-slate-600 font-mono">·</span>

              {/* 10-Second Refresh Countdown Badge */}
              <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 px-2 py-0.5 rounded">
                <Clock className="w-3 h-3 text-cyan-400" />
                <span>費率更新倒數:</span>
                <span className="text-cyan-400 font-bold">{countdown}s</span>
              </div>
            </div>

            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-2xl font-black font-mono text-slate-100 tracking-tight">
                {lockedCandidateState.symbol}
              </h2>

              <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1 rounded text-xs font-mono">
                <span className="text-slate-400">操作方向:</span>
                <span className="text-cyan-300 font-bold">
                  Long {simulation.long_exchange}
                </span>
                <span className="text-slate-600 font-normal">
                  ({(simulation.long_rate * 100).toFixed(4)}%)
                </span>
                <ArrowRightLeft className="w-3 h-3 text-slate-500" />
                <span className="text-amber-300 font-bold">
                  Short {simulation.short_exchange}
                </span>
                <span className="text-slate-600 font-normal">
                  ({(simulation.short_rate * 100).toFixed(4)}%)
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
              下方 <strong>Zone A ~ Zone D 所有時間軸、分拆成本表與 9 大風控檢查</strong>，均嚴格以此目標【{lockedCandidateState.symbol}】（{simulation.long_exchange} ⟷ {simulation.short_exchange}）之即時數據為唯一運算依據。
            </p>
          </div>

          {/* Action / Refresh & Position Notional Controls */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 self-start lg:self-auto">
            {/* Manual Rate Refresh Button */}
            <button
              onClick={() => {
                refreshRatesForLockedTarget();
                setCountdown(10);
              }}
              disabled={isRefreshing}
              className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 rounded text-xs font-mono font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
              title="立即向交易所拉取此幣種最新即時資費"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
              <span>{isRefreshing ? '更新中...' : '立即刷新費率'}</span>
            </button>

            {/* Stress Test: Leg Imbalance Trigger */}
            <button
              onClick={() => setForceLegImbalance(!forceLegImbalance)}
              className={`px-3 py-1.5 rounded text-xs font-mono font-medium flex items-center gap-1.5 transition-colors border ${
                forceLegImbalance
                  ? 'bg-rose-950/80 text-rose-300 border-rose-500 animate-pulse font-bold'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <AlertOctagon className="w-3.5 h-3.5" />
              <span>{forceLegImbalance ? '單腿失衡觸發中 (ACTIVE)' : '模擬單腿失衡 (Inject)'}</span>
            </button>

            {/* Position Size */}
            <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded p-1 text-xs font-mono">
              {[500, 1000, 2000].map(val => (
                <button
                  key={val}
                  onClick={() => setNotional(val)}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    notional === val
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {val}U
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Real-time Target Metrics Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 mt-4 border-t border-slate-800 font-mono text-xs">
          <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800/80">
            <span className="text-slate-400 block text-[10px]">即時費率差 (Spread):</span>
            <span className="text-cyan-300 font-bold text-sm">
              {(lockedCandidateState.spread * 100).toFixed(4)}%
            </span>
            <span className="text-[10px] text-slate-500 block">
              {simulation.short_exchange} - {simulation.long_exchange}
            </span>
          </div>

          <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800/80">
            <span className="text-slate-400 block text-[10px]">預期單次純利 ({notional}U):</span>
            <span className={`font-bold text-sm ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
              {cost.net_pnl.total > 0 ? '+' : ''}${cost.net_pnl.total.toFixed(2)} USDT
            </span>
            <span className="text-[10px] text-slate-500 block">
              淨利率: {(lockedCandidateState.expected_net_pnl_pct * 100).toFixed(3)}%
            </span>
          </div>

          <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800/80">
            <span className="text-slate-400 block text-[10px]">雙邊 API 延遲與成交差:</span>
            <span className="text-slate-200 font-bold text-sm">
              {simulation.telemetry.total_execution_drift_ms} ms
            </span>
            <span className="text-[10px] text-slate-500 block">
              {simulation.long_exchange}: {simulation.telemetry.long_api_latency_ms}ms · {simulation.short_exchange}: {simulation.telemetry.short_api_latency_ms}ms
            </span>
          </div>

          <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800/80">
            <span className="text-slate-400 block text-[10px]">對沖倉位狀態 (Position):</span>
            <span className={`font-bold text-sm ${
              simulation.position_state === 'BALANCED_HEDGED' ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {simulation.position_state}
            </span>
            <span className="text-[10px] text-slate-500 block">
              {simulation.position_state === 'BALANCED_HEDGED' ? 'Delta-Neutral 100%' : 'Emergency Abort Active'}
            </span>
          </div>
        </div>
      </div>

      {/* ZONE A: Pre-Market / Pre-Funding Analysis (Requirement 3: Clear Target Indicator) */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
            <h3 className="font-semibold text-slate-100 text-sm font-mono">
              ZONE A. Pre-Funding Analysis &amp; Target Switcher
            </h3>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            目前全流程專注模擬：<strong className="text-cyan-400">{lockedCandidateState.symbol}</strong>
          </span>
        </div>

        <div className="p-2.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-300 font-sans flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-cyan-400 shrink-0" />
            <span>
              推薦清單僅供參考比對，<strong>唯有點選「鎖定中標的」或切換後，系統才會在 Zone B~D 計算該幣種</strong>。
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            上次刷新: {lastUpdatedTime.toLocaleTimeString()}
          </span>
        </div>

        <div className="border border-slate-800 rounded overflow-x-auto bg-slate-950">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-900 text-slate-400 text-[11px] border-b border-slate-800">
              <tr>
                <th className="py-2.5 px-3">狀態</th>
                <th className="py-2.5 px-3">Symbol</th>
                <th className="py-2.5 px-3">最佳雙邊對沖</th>
                <th className="py-2.5 px-3 text-right">Spread</th>
                <th className="py-2.5 px-3 text-right">Est. Slip</th>
                <th className="py-2.5 px-3 text-right">Fee (VIP 0)</th>
                <th className="py-2.5 px-3 text-right text-emerald-400 font-bold">Expected Net</th>
                <th className="py-2.5 px-3 text-center">切換目標</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {/* Active Locked Candidate Row */}
              <tr className="bg-cyan-950/30 font-semibold border-l-4 border-l-cyan-400">
                <td className="py-2.5 px-3">
                  <span className="px-2 py-0.5 rounded text-[10px] bg-cyan-900/80 text-cyan-300 border border-cyan-700">
                    ★ 鎖定運算中
                  </span>
                </td>
                <td className="py-2.5 px-3 font-bold text-slate-100">
                  {lockedCandidateState.symbol}
                </td>
                <td className="py-2.5 px-3 text-slate-300">
                  {simulation.long_exchange} ⟷ {simulation.short_exchange}
                </td>
                <td className="py-2.5 px-3 text-right font-bold text-cyan-300">
                  {(lockedCandidateState.spread * 100).toFixed(4)}%
                </td>
                <td className="py-2.5 px-3 text-right text-slate-400">
                  -{(lockedCandidateState.est_slippage_pct * 100).toFixed(3)}%
                </td>
                <td className="py-2.5 px-3 text-right text-slate-400">
                  -0.200%
                </td>
                <td className="py-2.5 px-3 text-right text-emerald-400 font-bold">
                  {(lockedCandidateState.expected_net_pnl_pct * 100).toFixed(3)}%
                  <span className="block text-[10px] text-slate-400 font-normal">
                    ${(notional * lockedCandidateState.expected_net_pnl_pct).toFixed(2)}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-center">
                  <span className="text-cyan-400 text-xs font-sans">
                    ✓ 當前目標
                  </span>
                </td>
              </tr>

              {/* Recommended Top Candidates (if different from locked candidate) */}
              {top3Candidates
                .filter(c => c.symbol !== lockedCandidateState.symbol)
                .map(cand => (
                  <tr key={cand.symbol} className="hover:bg-slate-900/40 transition-colors">
                    <td className="py-2.5 px-3 text-slate-500">
                      推薦候選
                    </td>
                    <td className="py-2.5 px-3 text-slate-300 font-bold">
                      {cand.symbol}
                    </td>
                    <td className="py-2.5 px-3 text-slate-400">
                      {cand.long_exchange || 'Pionex'} ⟷ {cand.short_exchange || 'Binance'}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300">
                      {(cand.spread * 100).toFixed(4)}%
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-500">
                      -{(cand.est_slippage_pct * 100).toFixed(3)}%
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-500">
                      -0.200%
                    </td>
                    <td className="py-2.5 px-3 text-right text-emerald-400/80">
                      {(cand.expected_net_pnl_pct * 100).toFixed(3)}%
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <button
                        onClick={() => {
                          onSelectCandidate(cand);
                          setLockedCandidateState(cand);
                          setCountdown(10);
                        }}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-sans transition-colors"
                      >
                        切換並計算此幣
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ZONE B: Execution Timeline (T-30m down to T+30s) */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
            <h3 className="font-semibold text-slate-100 text-sm font-mono">
              ZONE B. 60-Second Millisecond Execution Timeline: {lockedCandidateState.symbol}
            </h3>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            {simulation.long_exchange} (Long) ⟷ {simulation.short_exchange} (Short)
          </span>
        </div>

        <div className="space-y-3">
          {simulation.timeline.map((step, idx) => {
            const isSettlement = step.timestamp_offset_str.includes('T+00');
            const isImbalance = step.title === 'EMERGENCY_ACTION';

            return (
              <div
                key={step.id || idx}
                className={`p-3.5 rounded-lg border text-xs font-mono transition-all ${
                  isImbalance
                    ? 'bg-rose-950/30 border-rose-600 text-rose-200'
                    : isSettlement
                    ? 'bg-cyan-950/30 border-cyan-500 text-cyan-200 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-300'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <div className="flex items-center gap-2 font-bold">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${
                      isSettlement ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'
                    }`}>
                      {step.timestamp_offset_str}
                    </span>
                    <span className="text-slate-100">{step.title}</span>
                    <span className="text-slate-500 font-normal">({step.offset_ms} ms)</span>
                  </div>

                  <div className="flex items-center gap-3 text-[11px]">
                    <span>
                      {simulation.long_exchange}: <strong className="text-slate-200">{step.long_status || 'PASS'}</strong>
                    </span>
                    <span>
                      {simulation.short_exchange}: <strong className={step.short_status === 'REJECTED' || step.short_status === 'ORDER_REJECTED' ? 'text-rose-400' : 'text-slate-200'}>
                        {step.short_status || 'PASS'}
                      </strong>
                    </span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 mt-1 font-sans">
                  {step.description}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ZONE C: Itemized Cost / Profit Decomposition Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
            <h3 className="font-semibold text-slate-100 text-sm font-mono">
              ZONE C. Cost &amp; Net PnL Decomposition Table: {lockedCandidateState.symbol}
            </h3>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            名義部位: {notional} USDT 雙邊對沖
          </span>
        </div>

        <div className="border border-slate-800 rounded overflow-x-auto bg-slate-950">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-900 text-slate-400 text-[11px] border-b border-slate-800">
              <tr>
                <th className="py-2.5 px-3">損益 / 成本拆解項目</th>
                <th className="py-2.5 px-3 text-right">
                  多頭腿: {cost.long_exchange_name} ({(simulation.long_rate * 100).toFixed(4)}%)
                </th>
                <th className="py-2.5 px-3 text-right">
                  空頭腿: {cost.short_exchange_name} ({(simulation.short_rate * 100).toFixed(4)}%)
                </th>
                <th className="py-2.5 px-3 text-right font-bold text-slate-200">
                  套利投組合計 (Delta-Neutral)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              <tr>
                <td className="py-2.5 px-3 text-slate-300">名義持倉價值 (Notional Position)</td>
                <td className="py-2.5 px-3 text-right text-slate-400">${cost.position.leg_long.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right text-slate-400">${cost.position.leg_short.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right font-bold text-slate-200">${cost.position.total.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 text-slate-300">開倉手續費 (Entry Fee · 0.05% Taker)</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.entry_fee.leg_long.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.entry_fee.leg_short.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right font-bold text-rose-400">-${cost.entry_fee.total.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 text-slate-300">平倉手續費 (Exit Fee · 0.05% Taker)</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.exit_fee.leg_long.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.exit_fee.leg_short.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right font-bold text-rose-400">-${cost.exit_fee.total.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 text-slate-300">開倉預估滑價 (Entry Slippage)</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.entry_slippage.leg_long.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.entry_slippage.leg_short.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right font-bold text-rose-400">-${cost.entry_slippage.total.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 text-slate-300">平倉預估滑價 (Exit Slippage)</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.exit_slippage.leg_long.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right text-rose-400">-${cost.exit_slippage.leg_short.toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right font-bold text-rose-400">-${cost.exit_slippage.total.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 text-slate-300">60秒基差微幅偏離 (Price Drift PnL)</td>
                <td className="py-2.5 px-3 text-right text-slate-400">
                  {cost.price_pnl.leg_long >= 0 ? '+' : ''}${cost.price_pnl.leg_long.toFixed(2)}
                </td>
                <td className="py-2.5 px-3 text-right text-slate-400">
                  {cost.price_pnl.leg_short >= 0 ? '+' : ''}${cost.price_pnl.leg_short.toFixed(2)}
                </td>
                <td className="py-2.5 px-3 text-right font-bold text-slate-400">
                  {cost.price_pnl.total >= 0 ? '+' : ''}${cost.price_pnl.total.toFixed(2)}
                </td>
              </tr>
              <tr className="bg-slate-900/60 font-semibold">
                <td className="py-2.5 px-3 text-cyan-300">T時刻資金費率收入 (Funding PnL)</td>
                <td className={`py-2.5 px-3 text-right ${cost.funding_pnl.leg_long >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {cost.funding_pnl.leg_long >= 0 ? '+' : ''}${cost.funding_pnl.leg_long.toFixed(2)}
                </td>
                <td className={`py-2.5 px-3 text-right ${cost.funding_pnl.leg_short >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {cost.funding_pnl.leg_short >= 0 ? '+' : ''}${cost.funding_pnl.leg_short.toFixed(2)}
                </td>
                <td className="py-2.5 px-3 text-right font-bold text-emerald-400">
                  +${cost.funding_pnl.total.toFixed(2)}
                </td>
              </tr>
              <tr className="bg-slate-900 border-t-2 border-slate-700 text-sm font-bold">
                <td className="py-3 px-3 text-slate-100">最終實現淨利潤 (Realized Net PnL)</td>
                <td className={`py-3 px-3 text-right ${cost.net_pnl.leg_long >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {cost.net_pnl.leg_long >= 0 ? '+' : ''}${cost.net_pnl.leg_long.toFixed(2)}
                </td>
                <td className={`py-3 px-3 text-right ${cost.net_pnl.leg_short >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {cost.net_pnl.leg_short >= 0 ? '+' : ''}${cost.net_pnl.leg_short.toFixed(2)}
                </td>
                <td className={`py-3 px-3 text-right text-base ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {cost.net_pnl.total >= 0 ? '+' : ''}${cost.net_pnl.total.toFixed(2)} USDT
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ZONE D: 9-Factor Pre-Flight Risk Checklist */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
            <h3 className="font-semibold text-slate-100 text-sm font-mono">
              ZONE D. 9-Factor Pre-Flight &amp; In-Flight Risk Checklist: {lockedCandidateState.symbol}
            </h3>
          </div>
          <div className="flex items-center gap-2 font-mono text-xs">
            <span>Overall Decision:</span>
            <span className={`px-2 py-0.5 rounded font-bold ${
              simulation.risk_report.overall_status === 'PASS'
                ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                : 'bg-rose-950 text-rose-300 border border-rose-700'
            }`}>
              {simulation.risk_report.overall_status}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {simulation.risk_report.checks.map(check => (
            <div
              key={check.id}
              className={`p-3 rounded-lg border text-xs font-mono space-y-1.5 ${
                check.status === 'PASS'
                  ? 'bg-slate-950 border-slate-800'
                  : check.status === 'WARN'
                  ? 'bg-amber-950/20 border-amber-800/60'
                  : 'bg-rose-950/30 border-rose-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-200">{check.name}</span>
                <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                  check.status === 'PASS'
                    ? 'text-emerald-400'
                    : check.status === 'WARN'
                    ? 'text-amber-400'
                    : 'text-rose-400 animate-pulse'
                }`}>
                  {check.status}
                </span>
              </div>

              <div className="text-[11px] text-cyan-400">
                {check.value}
              </div>

              <div className="text-[10px] text-slate-500 font-sans leading-tight">
                {check.details}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
