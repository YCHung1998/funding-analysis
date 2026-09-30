/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { MarketEventDataset } from '../data/mockMarketData';
import { ArbitrageTradeResult } from '../types/schema';
import { Filter, ArrowUpRight, TrendingUp, AlertTriangle, CheckCircle2, ChevronRight, Info } from 'lucide-react';

interface ArbitrageScannerProps {
  datasets: MarketEventDataset[];
  results: ArbitrageTradeResult[];
  selectedSymbol: string;
  onSelectEvent: (symbol: string, fundingTime: number) => void;
  onNavigateTab: (tab: 'klines' | 'simulator' | 'sensitivity') => void;
}

export const ArbitrageScanner: React.FC<ArbitrageScannerProps> = ({
  datasets,
  results,
  selectedSymbol,
  onSelectEvent,
  onNavigateTab,
}) => {
  const [filterMode, setFilterMode] = useState<'all' | 'threshold' | 'profitable'>('threshold');
  const [searchQuery, setSearchQuery] = useState('');

  // Combine datasets and backtest results
  const pairedData = datasets.map(d => {
    const result = results.find(r => r.id === `${d.symbol}-${d.funding_time}`) || results[0];
    return { dataset: d, result };
  });

  const filteredData = pairedData.filter(({ dataset, result }) => {
    if (searchQuery && !dataset.symbol.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (filterMode === 'threshold') {
      return result.meets_research_threshold;
    }
    if (filterMode === 'profitable') {
      return result.net_pnl > 0;
    }
    return true;
  });

  // Aggregate stats
  const totalEvents = results.length;
  const thresholdMeets = results.filter(r => r.meets_research_threshold).length;
  const profitableTrades = results.filter(r => r.net_pnl > 0).length;
  const winRate = totalEvents > 0 ? (profitableTrades / totalEvents) * 100 : 0;
  const avgNetPnl = results.reduce((acc, r) => acc + r.net_pnl, 0) / (totalEvents || 1);
  const avgSpread = results.reduce((acc, r) => acc + r.spread, 0) / (totalEvents || 1);

  return (
    <div className="space-y-6">
      {/* Top Banner: Spec v0.1 Core Concept Callout */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4 sm:p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-cyan-400 font-mono text-xs uppercase tracking-wider font-semibold">
                Spec v0.1 Standard Execution Experiment
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-slate-400 text-xs">Research Threshold = 0.20%</span>
            </div>
            <h2 className="text-base sm:text-lg font-semibold text-slate-100">
              Pionex × Binance Funding Spread Scanner
            </h2>
            <p className="text-xs text-slate-400 max-w-3xl">
              策略在結算前 30 秒 (T-30s) 同時在兩交易所開立 1000 USDT 反向合約，在結算後 30 秒 (T+30s) 同步平倉。
              固定扣除 4 筆 Taker 手續費 (2.00 USDT = 0.20%) 與雙邊進出場滑價，計算出真實到手 Realized Net PnL。
            </p>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto shrink-0">
            <button
              onClick={() => onNavigateTab('simulator')}
              className="px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 rounded text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              <span>View 60s Execution Breakdown</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Quantitative Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 mt-4 border-t border-slate-800/80">
          <div className="space-y-0.5">
            <div className="text-[11px] text-slate-400">Total Monitored Events</div>
            <div className="text-lg font-mono font-semibold text-slate-200">
              {totalEvents} <span className="text-xs text-slate-500 font-normal">settlements</span>
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] text-slate-400">≥ 0.20% Research Qualified</div>
            <div className="text-lg font-mono font-semibold text-emerald-400">
              {thresholdMeets} <span className="text-xs text-slate-500 font-normal">({((thresholdMeets / totalEvents) * 100).toFixed(0)}%)</span>
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] text-slate-400">Fixed Fee Drag per Event</div>
            <div className="text-lg font-mono font-semibold text-rose-400">
              -2.00 USDT <span className="text-xs text-slate-500 font-normal">(-0.20%)</span>
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] text-slate-400">Realized Profitable Rate</div>
            <div className="text-lg font-mono font-semibold text-cyan-400">
              {winRate.toFixed(0)}% <span className="text-xs text-slate-500 font-normal">win rate</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Search Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-1 rounded-md text-xs">
          <button
            onClick={() => setFilterMode('threshold')}
            className={`px-3 py-1.5 rounded transition-colors font-medium ${
              filterMode === 'threshold'
                ? 'bg-slate-800 text-emerald-300 shadow-sm border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Research Threshold (≥ 0.20%)
          </button>
          <button
            onClick={() => setFilterMode('profitable')}
            className={`px-3 py-1.5 rounded transition-colors font-medium ${
              filterMode === 'profitable'
                ? 'bg-slate-800 text-cyan-300 shadow-sm border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Realized Net Profit &gt; 0
          </button>
          <button
            onClick={() => setFilterMode('all')}
            className={`px-3 py-1.5 rounded transition-colors font-medium ${
              filterMode === 'all'
                ? 'bg-slate-800 text-slate-200 shadow-sm border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All Events ({results.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Filter symbol (e.g. SOL, PEPE, BTC)..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500/50 w-full sm:w-64"
          />
        </div>
      </div>

      {/* Main Events Table */}
      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/60">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/90 text-slate-400 font-mono text-[11px] border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Symbol / Event</th>
                <th className="py-3 px-3">Pionex Rate</th>
                <th className="py-3 px-3">Binance Rate</th>
                <th className="py-3 px-3">Spread (Threshold)</th>
                <th className="py-3 px-3">Execution Direction (1000U)</th>
                <th className="py-3 px-3 text-right">Funding Gain</th>
                <th className="py-3 px-3 text-right">Total Taker Fee</th>
                <th className="py-3 px-3 text-right">Est. Slippage</th>
                <th className="py-3 px-3 text-right">Realized Net PnL</th>
                <th className="py-3 px-4 text-center">±2m Klines</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredData.map(({ dataset, result }) => {
                const isSelected = selectedSymbol === dataset.symbol;
                const isProfitable = result.net_pnl > 0;
                const meetsThreshold = result.meets_research_threshold;
                const spreadPct = (result.spread * 100).toFixed(3) + '%';
                const pionexRatePct = (dataset.pionex_common.funding_rate * 100).toFixed(3) + '%';
                const binanceRatePct = (dataset.binance_common.funding_rate * 100).toFixed(3) + '%';

                return (
                  <tr
                    key={result.id}
                    onClick={() => onSelectEvent(dataset.symbol, dataset.funding_time)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-slate-800/80 border-l-2 border-l-cyan-400'
                        : 'hover:bg-slate-900/50'
                    }`}
                  >
                    {/* Symbol & Time */}
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200 text-sm">{dataset.symbol}</span>
                        {meetsThreshold ? (
                          <span className="text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-1 py-0.2 rounded font-sans">
                            ≥0.20%
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500 bg-slate-900 px-1 py-0.2 rounded font-sans">
                            Sub-0.20%
                          </span>
                        )}
                        <span className="text-[9px] text-cyan-400 bg-cyan-950/60 border border-cyan-800/60 px-1 rounded font-mono">
                          4/4 通用型
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 font-sans mt-0.5 flex items-center gap-1.5">
                        <span>{dataset.funding_time_str}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-400 font-mono text-[10px]">PX ⟷ BN</span>
                      </div>
                    </td>

                    {/* Pionex Rate */}
                    <td className="py-3 px-3">
                      <span className={dataset.pionex_common.funding_rate >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {dataset.pionex_common.funding_rate >= 0 ? '+' : ''}{pionexRatePct}
                      </span>
                    </td>

                    {/* Binance Rate */}
                    <td className="py-3 px-3">
                      <span className={dataset.binance_common.funding_rate >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {dataset.binance_common.funding_rate >= 0 ? '+' : ''}{binanceRatePct}
                      </span>
                    </td>

                    {/* Spread */}
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`font-semibold ${meetsThreshold ? 'text-emerald-300' : 'text-amber-400/80'}`}>
                          {spreadPct}
                        </span>
                        {meetsThreshold && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                      </div>
                      <div className="text-[10px] text-slate-500 font-sans">
                        {meetsThreshold ? 'Above hurdle' : 'Below fee drag'}
                      </div>
                    </td>

                    {/* Direction */}
                    <td className="py-3 px-3 text-[11px] font-sans">
                      <div className="space-y-0.5">
                        <div>
                          <span className="text-slate-400">Pionex:</span>{' '}
                          <strong className={result.pionex_leg.side === 'SHORT' ? 'text-rose-400' : 'text-emerald-400'}>
                            {result.pionex_leg.side}
                          </strong>
                        </div>
                        <div>
                          <span className="text-slate-400">Binance:</span>{' '}
                          <strong className={result.binance_leg.side === 'SHORT' ? 'text-rose-400' : 'text-emerald-400'}>
                            {result.binance_leg.side}
                          </strong>
                        </div>
                      </div>
                    </td>

                    {/* Funding Gain */}
                    <td className="py-3 px-3 text-right">
                      <span className="text-emerald-400 font-medium">
                        +${result.funding_pnl.toFixed(2)}
                      </span>
                    </td>

                    {/* Taker Fee */}
                    <td className="py-3 px-3 text-right text-rose-400">
                      -${result.total_fee.toFixed(2)}
                    </td>

                    {/* Slippage */}
                    <td className="py-3 px-3 text-right text-amber-400/90">
                      -${result.total_slippage.toFixed(2)}
                      <div className="text-[10px] text-slate-500">
                        {result.volume_shock_ratio.toFixed(1)}x Vol Shock
                      </div>
                    </td>

                    {/* Realized Net PnL */}
                    <td className="py-3 px-3 text-right">
                      <div className={`font-bold text-sm ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {result.net_pnl >= 0 ? '+' : ''}${result.net_pnl.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        ROI: {result.roi_on_notional_pct >= 0 ? '+' : ''}{result.roi_on_notional_pct.toFixed(2)}%
                      </div>
                    </td>

                    {/* Action */}
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectEvent(dataset.symbol, dataset.funding_time);
                          onNavigateTab('klines');
                        }}
                        className="text-[11px] text-cyan-400 hover:text-cyan-300 font-sans underline underline-offset-2 flex items-center justify-center gap-1 mx-auto"
                      >
                        <span>View ±2m</span>
                        <ArrowUpRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Research Question Mapping Box */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 text-xs space-y-3">
        <div className="flex items-center gap-2 text-cyan-400 font-semibold font-mono">
          <Info className="w-4 h-4" />
          <span>Spec v0.1 Research Principle: Why 0.20% is NOT a Guarantee of Profit</span>
        </div>
        <p className="text-slate-300 leading-relaxed font-sans">
          在 Spec v0.1 裡，我們將 <strong>0.20% 定義為 Research Threshold</strong> 而非自動獲利點。
          原因在於雙邊 4 筆 Taker 交易手續費（Pionex Taker 0.05% + Binance Taker 0.05% 開平倉各一次）必然扣除恰好 <strong>0.20% (2.00 USDT)</strong>。
          如果結算前後因大量套利者平倉湧入導致盤口被吃穿，產生 0.03% ~ 0.05% 的進出場滑價，則總摩擦成本會達到 <strong>0.26% ~ 0.30%</strong>。
          因此，只有同時記錄 <strong>結算前後 ±2m 的 1m Kline 與 Volume 成交量暴衝</strong>，才能精準量化滑價因子！
        </p>
      </div>
    </div>
  );
};
