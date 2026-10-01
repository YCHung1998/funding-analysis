/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 5, 6, 7: Standard Execution Experiment Simulator
 * Models T-30s (Entry) -> T (Funding Settlement) -> T+30s (Exit)
 * Computes exact Realized Net PnL with 4 Taker Fees + Slippage Loss.
 */

import React, { useState } from 'react';
import { MarketEventDataset } from '../data/mockMarketData';
import { resolveLegFeeRates, simulateExecutionExperiment } from '../engine/arbitrageEngine';
import { feeRate } from '../../runtime/src/accounting/feeEngine';
import type { ExchangeId } from '../../runtime/src/types/ids';
import { Clock, ArrowRight, DollarSign, ShieldAlert, Check, RefreshCw, SlidersHorizontal } from 'lucide-react';

interface ExecutionSimulatorProps {
  currentDataset: MarketEventDataset;
  allDatasets: MarketEventDataset[];
  onSelectSymbol: (symbol: string) => void;
}

export const ExecutionSimulator: React.FC<ExecutionSimulatorProps> = ({
  currentDataset,
  allDatasets,
  onSelectSymbol,
}) => {
  const [notional, setNotional] = useState(1000);
  const [customSlippageBps, setCustomSlippageBps] = useState<number | null>(null); // in bps (e.g. 3 = 0.03%)
  const [activeStep, setActiveStep] = useState<number>(4); // 1 = T-30s, 2 = T, 3 = T+30s, 4 = Final

  const [longEx, setLongEx] = useState<'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX'>('Pionex');
  const [shortEx, setShortEx] = useState<'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX'>('Binance');
  const [rateCountdown, setRateCountdown] = useState<number>(10);

  // 10-Second Rate Refresh Countdown
  React.useEffect(() => {
    const timer = setInterval(() => {
      setRateCountdown(prev => (prev <= 1 ? 10 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Q-06: routed through the shared Fee Engine's default table (no second hardcoded fee source).
  const getTakerFee = (ex: string) => feeRate(ex as ExchangeId, 'TAKER');

  const longFee = getTakerFee(longEx);
  const shortFee = getTakerFee(shortEx);
  const totalFeeRate = 2 * (longFee + shortFee);

  const slippageDecimal = customSlippageBps !== null ? customSlippageBps / 10000 : undefined;

  // Q-06 fix: fee rates must track which exchange actually plays the SHORT/LONG leg (decided by
  // funding-rate comparison inside simulateExecutionExperiment), not a fixed
  // longFee -> pionex_taker_fee assignment (design.md Decision 9).
  const pionexIsShort = currentDataset.pionex_common.funding_rate >= currentDataset.binance_common.funding_rate;
  const { pionexFeeRate, binanceFeeRate } = resolveLegFeeRates({ pionexIsShort, longFeeRate: longFee, shortFeeRate: shortFee });

  const tradeResult = simulateExecutionExperiment(
    currentDataset.pionex_common,
    currentDataset.binance_common,
    currentDataset.pionex_klines,
    currentDataset.binance_klines,
    {
      notional_usdt: notional,
      entry_offset_sec: -30,
      exit_offset_sec: 30,
      fee_tier: 'lowest_vip0',
      pionex_taker_fee: pionexFeeRate,
      binance_taker_fee: binanceFeeRate,
      research_threshold_spread: 0.0020,
      custom_entry_slippage: slippageDecimal,
      custom_exit_slippage: slippageDecimal,
    }
  );

  const pionexRate = currentDataset.pionex_common.funding_rate;
  const binanceRate = currentDataset.binance_common.funding_rate;
  const higherExchange = pionexRate >= binanceRate ? 'Pionex' : 'Binance';

  const isProfitable = tradeResult.net_pnl > 0;

  return (
    <div className="space-y-6">
      {/* Top Banner & Execution Rules */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <span>Standard Execution Experiment (Spec v0.1)</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>Fixed 60-Second Holding Period</span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 mt-0.5">
              {currentDataset.symbol} Arbitrage Execution Simulation
            </h2>
            <div className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-3">
              <span>Settlement Event (T): <strong className="text-slate-200 font-mono">{currentDataset.funding_time_str}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Spread: <strong className="text-cyan-400 font-mono">{(tradeResult.spread * 100).toFixed(3)}%</strong></span>
              <span aria-hidden="true">·</span>
              <span>Research Hurdle: <strong className="text-emerald-400 font-mono">≥ 0.20%</strong></span>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1 font-mono text-cyan-300 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                <Clock className="w-3 h-3 text-cyan-400" />
                <span>費率更新倒數:</span>
                <strong className="text-cyan-400">{rateCountdown}s</strong>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 self-start lg:self-auto">
            <span className="text-xs text-slate-400 font-sans">Active Symbol:</span>
            <select
              value={currentDataset.symbol}
              onChange={(e) => onSelectSymbol(e.target.value)}
              className="bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
            >
              {allDatasets.map(d => (
                <option key={d.symbol} value={d.symbol}>
                  {d.symbol} (Spread: {(d.event_window.spread * 100).toFixed(2)}%)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Interactive Controls Bar: Notional & Slippage Override */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-4 mt-4 border-t border-slate-800">
          <div>
            <label className="block text-[11px] text-slate-400 font-mono mb-1">
              Position Notional (Per Exchange):
            </label>
            <div className="flex items-center gap-1.5">
              {[500, 1000, 2000, 5000].map(val => (
                <button
                  key={val}
                  onClick={() => setNotional(val)}
                  className={`px-2.5 py-1 text-xs font-mono rounded ${
                    notional === val
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                      : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {val}U
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 font-mono mb-1">
              對沖交易所 (多頭 ⟷ 空頭):
            </label>
            <div className="flex items-center gap-1 text-xs font-mono">
              <select
                value={longEx}
                onChange={e => setLongEx(e.target.value as any)}
                className="bg-slate-950 border border-slate-700 text-cyan-300 text-xs rounded px-2 py-1 focus:outline-none"
              >
                {(['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'] as const).map(ex => (
                  <option key={ex} value={ex}>Long {ex}</option>
                ))}
              </select>
              <span className="text-slate-600">⟷</span>
              <select
                value={shortEx}
                onChange={e => setShortEx(e.target.value as any)}
                className="bg-slate-950 border border-slate-700 text-amber-300 text-xs rounded px-2 py-1 focus:outline-none"
              >
                {(['Pionex', 'Binance', 'Bybit', 'Bitget', 'OKX'] as const).map(ex => (
                  <option key={ex} value={ex}>Short {ex}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 font-mono mb-1">
              Slippage Override (per leg):
            </label>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCustomSlippageBps(null)}
                className={`px-2 py-1 text-xs font-mono rounded ${
                  customSlippageBps === null
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                    : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                }`}
              >
                Auto
              </button>
              {[1, 2, 4, 8].map(bps => (
                <button
                  key={bps}
                  onClick={() => setCustomSlippageBps(bps)}
                  className={`px-2 py-1 text-xs font-mono rounded ${
                    customSlippageBps === bps
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                      : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {(bps / 100).toFixed(2)}%
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col justify-end">
            <div className="text-[11px] text-slate-400 font-mono">雙邊 4 筆 Taker 剛性手續費:</div>
            <div className="text-sm font-mono font-semibold text-rose-400">
              -${(notional * totalFeeRate).toFixed(2)} <span className="text-xs text-slate-500 font-normal">(-{(totalFeeRate * 100).toFixed(2)}%)</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3-Step Execution Timeline (ASCII diagram brought to life) */}
      <div className="bg-slate-950 border border-slate-800 rounded-lg p-5">
        <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-4 flex items-center justify-between">
          <span>Execution Lifecycle Architecture (T-30s ───► T ───► T+30s)</span>
          <span className="text-cyan-400 font-sans normal-case">Hold Duration: 60 Seconds</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
          {/* Step 1: Entry T-30s */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3 relative">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-cyan-400 bg-cyan-950/60 border border-cyan-800/60 px-2 py-0.5 rounded">
                T - 30s · ENTRY
              </span>
              <span className="text-xs text-slate-400 font-mono">11:59:30</span>
            </div>
            
            <div className="space-y-2 text-xs font-mono">
              <div className="p-2 bg-slate-950 rounded border border-slate-800/80">
                <div className="text-slate-400 text-[11px]">Pionex Position:</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className={`font-bold ${tradeResult.pionex_leg.side === 'SHORT' ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {tradeResult.pionex_leg.side} {notional} USDT
                  </span>
                  <span className="text-slate-400">@{tradeResult.pionex_leg.entry_price.toFixed(4)}</span>
                </div>
              </div>

              <div className="p-2 bg-slate-950 rounded border border-slate-800/80">
                <div className="text-slate-400 text-[11px]">Binance Position:</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className={`font-bold ${tradeResult.binance_leg.side === 'SHORT' ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {tradeResult.binance_leg.side} {notional} USDT
                  </span>
                  <span className="text-slate-400">@{tradeResult.binance_leg.entry_price.toFixed(4)}</span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800/80 text-[11px] font-mono space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Entry Taker Fees (2 trades):</span>
                <span className="text-rose-400">-${tradeResult.total_entry_fee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Entry Slippage Loss:</span>
                <span className="text-amber-400">-${tradeResult.total_entry_slippage.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Step 2: Funding Event T */}
          <div className="bg-slate-900 border border-cyan-800/60 rounded-lg p-4 space-y-3 relative shadow-lg shadow-cyan-950/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded">
                T · FUNDING EVENT
              </span>
              <span className="text-xs text-slate-400 font-mono">12:00:00</span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="p-2 bg-slate-950 rounded border border-slate-800/80">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">Pionex ({tradeResult.pionex_leg.side}):</span>
                  <span className={pionexRate >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {(pionexRate * 100).toFixed(3)}%
                  </span>
                </div>
                <div className="flex justify-between font-bold mt-1">
                  <span className="text-slate-300">Cashflow:</span>
                  <span className={tradeResult.pionex_leg.funding_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {tradeResult.pionex_leg.funding_pnl >= 0 ? '+' : ''}${tradeResult.pionex_leg.funding_pnl.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="p-2 bg-slate-950 rounded border border-slate-800/80">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">Binance ({tradeResult.binance_leg.side}):</span>
                  <span className={binanceRate >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {(binanceRate * 100).toFixed(3)}%
                  </span>
                </div>
                <div className="flex justify-between font-bold mt-1">
                  <span className="text-slate-300">Cashflow:</span>
                  <span className={tradeResult.binance_leg.funding_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {tradeResult.binance_leg.funding_pnl >= 0 ? '+' : ''}${tradeResult.binance_leg.funding_pnl.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800/80 text-[11px] font-mono space-y-1">
              <div className="flex justify-between text-slate-300 font-semibold">
                <span>Net Funding Captured:</span>
                <span className="text-emerald-400">+${tradeResult.funding_pnl.toFixed(2)}</span>
              </div>
              <div className="text-[10px] text-slate-500 font-sans">
                = Notional ({notional}U) × Spread ({(tradeResult.spread * 100).toFixed(3)}%)
              </div>
            </div>
          </div>

          {/* Step 3: Exit T+30s */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3 relative">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-amber-400 bg-amber-950/60 border border-amber-800/60 px-2 py-0.5 rounded">
                T + 30s · EXIT
              </span>
              <span className="text-xs text-slate-400 font-mono">12:00:30</span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="p-2 bg-slate-950 rounded border border-slate-800/80">
                <div className="text-slate-400 text-[11px]">Pionex Close:</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-slate-300">Exit @{tradeResult.pionex_leg.exit_price.toFixed(4)}</span>
                  <span className={`font-semibold ${tradeResult.pionex_leg.price_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    Price PnL: {tradeResult.pionex_leg.price_pnl >= 0 ? '+' : ''}${tradeResult.pionex_leg.price_pnl.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="p-2 bg-slate-950 rounded border border-slate-800/80">
                <div className="text-slate-400 text-[11px]">Binance Close:</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-slate-300">Exit @{tradeResult.binance_leg.exit_price.toFixed(4)}</span>
                  <span className={`font-semibold ${tradeResult.binance_leg.price_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    Price PnL: {tradeResult.binance_leg.price_pnl >= 0 ? '+' : ''}${tradeResult.binance_leg.price_pnl.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800/80 text-[11px] font-mono space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Exit Taker Fees (2 trades):</span>
                <span className="text-rose-400">-${tradeResult.total_exit_fee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Exit Slippage Loss:</span>
                <span className="text-amber-400">-${tradeResult.total_exit_slippage.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Realized Net PnL Waterfall (Matching Spec Section 6 Formula) */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <h3 className="font-semibold text-slate-100 text-sm">
              Realized Net PnL Waterfall Breakdown
            </h3>
          </div>
          <div className="text-xs font-mono text-slate-400">
            Formula: Net = Gross - Fees (✅ C-13; slippage already in Price PnL, not subtracted again)
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 font-mono text-xs">
          {/* Funding Gain */}
          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400 text-[11px]">+ Funding Gain</div>
            <div className="text-base font-bold text-emerald-400">
              +${tradeResult.funding_pnl.toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-500 font-sans">
              Notional × {(tradeResult.spread * 100).toFixed(3)}% spread
            </div>
          </div>

          {/* Price Drift PnL */}
          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400 text-[11px]">± Price PnL (60s drift)</div>
            <div className={`text-base font-bold ${tradeResult.price_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {tradeResult.price_pnl >= 0 ? '+' : ''}${tradeResult.price_pnl.toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-500 font-sans">
              Basis drift between exchanges
            </div>
          </div>

          {/* Deterministic Taker Fees */}
          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400 text-[11px]">- Taker Fees (4 orders)</div>
            <div className="text-base font-bold text-rose-400">
              -${tradeResult.total_fee.toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-500 font-sans">
              Per-exchange taker fee on {notional}U (Q-06 fix: not a fixed 0.20%)
            </div>
          </div>

          {/* Slippage attribution only (§20.1): already included in Price PnL above, not a
              separate Net PnL deduction (✅ C-13 / Q-05 fix). */}
          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400 text-[11px]">Slippage Attribution (4 orders)</div>
            <div className="text-base font-bold text-amber-400">
              -${tradeResult.total_slippage.toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-500 font-sans">
              已含在 Price PnL 中，不另外扣除（entry + exit orderbook penetration）
            </div>
          </div>

          {/* Final Realized Net PnL */}
          <div className={`p-3 rounded border space-y-1 ${
            isProfitable ? 'bg-emerald-950/30 border-emerald-800/80' : 'bg-rose-950/30 border-rose-800/80'
          }`}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
              = Realized Net PnL
            </div>
            <div className={`text-xl font-bold ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
              {tradeResult.net_pnl >= 0 ? '+' : ''}${tradeResult.net_pnl.toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-300 font-sans">
              ROI: <strong className={isProfitable ? 'text-emerald-300' : 'text-rose-300'}>
                {tradeResult.roi_on_notional_pct >= 0 ? '+' : ''}{tradeResult.roi_on_notional_pct.toFixed(2)}%
              </strong>
            </div>
          </div>
        </div>

        {/* Verdict Callout */}
        <div className={`p-3 rounded text-xs flex items-start gap-2.5 font-sans ${
          isProfitable
            ? 'bg-emerald-950/20 text-emerald-300 border border-emerald-800/50'
            : 'bg-rose-950/20 text-rose-300 border border-rose-800/50'
        }`}>
          {isProfitable ? (
            <>
              <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <strong>Profitable Execution:</strong> The funding spread of {(tradeResult.spread * 100).toFixed(3)}% successfully surmounted the per-exchange taker fee hurdle (-${tradeResult.total_fee.toFixed(2)}) even with slippage attribution of -${tradeResult.total_slippage.toFixed(2)} already baked into Price PnL, yielding a real net profit of <strong>${tradeResult.net_pnl.toFixed(2)}</strong>.
              </div>
            </>
          ) : (
            <>
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <strong>Negative Realized Yield:</strong> The funding spread of {(tradeResult.spread * 100).toFixed(3)}% was insufficient to absorb the per-exchange taker fee drag (-${tradeResult.total_fee.toFixed(2)}), with slippage attribution of -${tradeResult.total_slippage.toFixed(2)} already baked into Price PnL, resulting in a net loss of <strong>-${Math.abs(tradeResult.net_pnl).toFixed(2)}</strong>.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
