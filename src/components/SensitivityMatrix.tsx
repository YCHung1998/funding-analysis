/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 8: Sensitivity Matrix & Research Frontier
 * Maps Funding Spread vs Execution Slippage vs Fee Drag to locate
 * the mathematical breakeven boundary.
 */

import React, { useState } from 'react';
import { Sliders, Target, HelpCircle, ArrowRight, Zap } from 'lucide-react';

export const SensitivityMatrix: React.FC = () => {
  const [notional, setNotional] = useState<number>(1000);
  const [pionexFee, setPionexFee] = useState<number>(0.0005); // 0.05%
  const [binanceFee, setBinanceFee] = useState<number>(0.0005); // 0.05%

  // Total fee drag = (Pionex Entry + Pionex Exit + Binance Entry + Binance Exit) = 2 * (pionexFee + binanceFee)
  const totalFeeRate = 2 * (pionexFee + binanceFee);
  const totalFeeUsdt = notional * totalFeeRate;

  // Spread levels from 0.10% to 0.50%
  const spreads = [0.0010, 0.0015, 0.0018, 0.0020, 0.0025, 0.0030, 0.0035, 0.0040, 0.0050];
  // Slippage per leg from 0.01% to 0.08% (total slippage = 4 * slipPerLeg: Entry Px, Entry Bn, Exit Px, Exit Bn)
  const slippagesPerLeg = [0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0008];

  return (
    <div className="space-y-6">
      {/* Intro Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <span>Spec v0.1 Section 8 Quantitative Frontier</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>Breakeven Threshold Matrix</span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 mt-0.5">
              Funding Spread vs Slippage Sensitivity Model
            </h2>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              探索在不同資金費差 (Spread) 與盤口滑價 (Slippage) 組合下，扣除雙邊手續費後的真實結算純益 (Net PnL)。
            </p>
          </div>

          {/* Quick Multi-Exchange Fee Scenario Toggles */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
            <span className="text-slate-400 font-sans mr-1">跨所手續費模型:</span>
            <button
              onClick={() => {
                setPionexFee(0.0005);
                setBinanceFee(0.0005);
              }}
              className={`px-2 py-1 rounded transition-colors ${
                pionexFee === 0.0005 && binanceFee === 0.0005
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-600 font-bold'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-850'
              }`}
            >
              PX×BN (0.20%)
            </button>
            <button
              onClick={() => {
                setPionexFee(0.0005);
                setBinanceFee(0.00055);
              }}
              className={`px-2 py-1 rounded transition-colors ${
                binanceFee === 0.00055
                  ? 'bg-purple-950 text-purple-300 border border-purple-600 font-bold'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-850'
              }`}
            >
              BN×BY (0.21%)
            </button>
            <button
              onClick={() => {
                setPionexFee(0.00055);
                setBinanceFee(0.00060);
              }}
              className={`px-2 py-1 rounded transition-colors ${
                pionexFee === 0.00055 && binanceFee === 0.00060
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-600 font-bold'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-850'
              }`}
            >
              BY×BG (0.23%)
            </button>
            <button
              onClick={() => {
                setPionexFee(0.0005);
                setBinanceFee(0.0006);
              }}
              className={`px-2 py-1 rounded transition-colors ${
                pionexFee === 0.0005 && binanceFee === 0.0006
                  ? 'bg-amber-950 text-amber-300 border border-amber-600 font-bold'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-850'
              }`}
            >
              PX×BG (0.22%)
            </button>
            <button
              onClick={() => {
                setPionexFee(0.0004);
                setBinanceFee(0.0004);
              }}
              className={`px-2 py-1 rounded transition-colors ${
                pionexFee === 0.0004 && binanceFee === 0.0004
                  ? 'bg-slate-800 text-slate-100 border border-slate-600 font-bold'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-850'
              }`}
            >
              VIP 1 (0.16%)
            </button>
          </div>
        </div>

        {/* Current Cost Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 mt-4 border-t border-slate-800 font-mono text-xs">
          <div>
            <span className="text-slate-400 block text-[11px]">Position Notional:</span>
            <span className="text-slate-200 font-bold text-sm">${notional} USDT</span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">Deterministic Fee Drag:</span>
            <span className="text-rose-400 font-bold text-sm">
              -{(totalFeeRate * 100).toFixed(2)}% (-${totalFeeUsdt.toFixed(2)})
            </span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">Zero-Slippage Breakeven:</span>
            <span className="text-cyan-400 font-bold text-sm">
              ≥ {(totalFeeRate * 100).toFixed(2)}% Spread
            </span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">Practical Target (w/ Slip):</span>
            <span className="text-emerald-400 font-bold text-sm">
              ≥ {( (totalFeeRate + 0.0012) * 100 ).toFixed(2)}% Spread
            </span>
          </div>
        </div>
      </div>

      {/* Sensitivity Heatmap Table */}
      <div className="bg-slate-950 border border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-cyan-400" />
            <span>Net Realized PnL Matrix (USDT) on {notional}U Notional</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-slate-400 font-mono">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-emerald-500/20 border border-emerald-500/60 rounded-sm" /> Net Profit &gt; 0
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-rose-500/20 border border-rose-500/60 rounded-sm" /> Net Loss &lt; 0
            </span>
          </div>
        </div>

        <div className="overflow-x-auto border border-slate-800 rounded">
          <table className="w-full text-center text-xs font-mono">
            <thead className="bg-slate-900 text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-3 px-3 text-left bg-slate-950">
                  <div className="text-[10px] text-slate-500">Spread \ Slippage</div>
                  <div className="text-slate-200 font-bold">Funding Spread</div>
                </th>
                {slippagesPerLeg.map(slip => (
                  <th key={slip} className="py-3 px-3">
                    <div className="text-slate-200">{(slip * 100).toFixed(2)}% Slip</div>
                    <div className="text-[10px] text-slate-500">4× leg = {(slip * 4 * 100).toFixed(2)}%</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {spreads.map(spread => {
                const isHurdle = spread === 0.0020;
                return (
                  <tr key={spread} className={isHurdle ? 'bg-cyan-950/20 font-semibold' : 'hover:bg-slate-900/30'}>
                    {/* Spread Header Cell */}
                    <td className="py-2.5 px-3 text-left bg-slate-950/80 font-bold">
                      <div className="flex items-center gap-1.5">
                        <span className={spread >= 0.0020 ? 'text-emerald-400' : 'text-slate-400'}>
                          {(spread * 100).toFixed(2)}%
                        </span>
                        {isHurdle && (
                          <span className="text-[9px] bg-cyan-950 border border-cyan-700/60 text-cyan-300 px-1 py-0.2 rounded font-sans">
                            Spec Threshold
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Cells */}
                    {slippagesPerLeg.map(slip => {
                      const fundingGain = notional * spread;
                      const totalSlip = notional * (slip * 4); // 4 trades
                      const netPnl = fundingGain - totalFeeUsdt - totalSlip;
                      const isProfit = netPnl > 0;

                      return (
                        <td
                          key={slip}
                          className={`py-2.5 px-3 transition-colors ${
                            isProfit
                              ? 'bg-emerald-950/25 text-emerald-300 font-semibold border-b border-emerald-900/20'
                              : 'bg-rose-950/20 text-rose-400/90 border-b border-rose-900/20'
                          }`}
                        >
                          <span>{netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Strategic Research Answers */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2 text-cyan-400 text-sm font-semibold">
          <Target className="w-4 h-4" />
          <span>Research Question Matrix: Quant Findings from Spec v0.1</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-sans">
          <div className="bg-slate-950 border border-slate-800/80 p-3.5 rounded space-y-1.5">
            <div className="font-semibold text-slate-200 flex items-center gap-1.5 font-mono">
              <span className="w-2 h-2 rounded-full bg-cyan-400" />
              <span>Q1. 為什麼 0.20% 是必虧與可能盈利的剛性分水嶺？</span>
            </div>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              因為 Pionex 與 Binance 的 VIP 0 合約 Taker 手續費皆為 0.05%。在 60 秒的實驗中，進場開倉 (Pionex + Binance 各一筆) 加上出場平倉 (各一筆) 共有 4 筆 Taker 交易。手續費總成本固定為 <strong>4 × 0.05% = 0.20%</strong>。若 Spread 低於 0.20%，即使滑價為 0，利潤也被手續費全數吞噬。
            </p>
          </div>

          <div className="bg-slate-950 border border-slate-800/80 p-3.5 rounded space-y-1.5">
            <div className="font-semibold text-slate-200 flex items-center gap-1.5 font-mono">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>Q2. 結算前後 ±2m 的 Volume Spike 扮演什麼角色？</span>
            </div>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              資金費率結算時，市場上大量費率套利者同時執行進出場，造成 T 時刻成交量暴增 3x ~ 5x。盤口買一賣一厚度被瞬間打穿，導致原本只有 0.01% 的常態價差擴大到 0.03% ~ 0.06% 的滑價。因此只有將 ±2m 1m Kline 與 Volume 一併納入，才能還原真實成本！
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
