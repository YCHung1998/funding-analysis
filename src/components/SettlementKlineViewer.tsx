/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 2 & 3: Funding Settlement ±2 min 1m Kline & Volume Analysis
 * Evaluates price volatility and volume shocks around T (T-2m, T-1m, T, T+1m, T+2m)
 * to quantify execution slippage drivers.
 */

import React, { useState } from 'react';
import { MarketEventDataset } from '../data/mockMarketData';
import { SettlementWindowBar, ExchangeId } from '../types/schema';
import { fetchLiveKlines } from '../services/liveMarketService';
import { BarChart2, TrendingUp, AlertCircle, ArrowRight, Zap, Eye, Globe, RefreshCw } from 'lucide-react';

interface SettlementKlineViewerProps {
  currentDataset: MarketEventDataset;
  allDatasets: MarketEventDataset[];
  onSelectSymbol: (symbol: string) => void;
}

export const SettlementKlineViewer: React.FC<SettlementKlineViewerProps> = ({
  currentDataset,
  allDatasets,
  onSelectSymbol,
}) => {
  const [selectedExchange, setSelectedExchange] = useState<'both' | 'Pionex' | 'Binance'>('both');
  const [isLiveLoading, setIsLiveLoading] = useState(false);
  const [liveKlines, setLiveKlines] = useState<{
    pionex: SettlementWindowBar[];
    binance: SettlementWindowBar[];
  } | null>(null);

  const handleLoadLiveKlines = async () => {
    setIsLiveLoading(true);
    try {
      const res = await fetchLiveKlines(currentDataset.symbol);
      if (res.success && res.binance_bars.length > 0 && res.pionex_bars.length > 0) {
        const offsets: SettlementWindowBar['offset_label'][] = ['T-2m', 'T-1m', 'T', 'T+1m', 'T+2m'];
        const pMapped: SettlementWindowBar[] = res.pionex_bars.slice(0, 5).map((b, i) => ({
          exchange: 'Pionex',
          symbol: currentDataset.symbol,
          funding_time: currentDataset.funding_time,
          kline_time: b.time,
          offset_label: offsets[i] || 'T',
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          price_change: b.close - b.open,
          high_low_range: b.high - b.low,
          return_pct: ((b.close - b.open) / b.open) * 100,
          volatility: ((b.high - b.low) / b.open) * 100,
        }));

        const bMapped: SettlementWindowBar[] = res.binance_bars.slice(0, 5).map((b, i) => ({
          exchange: 'Binance',
          symbol: currentDataset.symbol,
          funding_time: currentDataset.funding_time,
          kline_time: b.time,
          offset_label: offsets[i] || 'T',
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          price_change: b.close - b.open,
          high_low_range: b.high - b.low,
          return_pct: ((b.close - b.open) / b.open) * 100,
          volatility: ((b.high - b.low) / b.open) * 100,
        }));

        setLiveKlines({ pionex: pMapped, binance: bMapped });
      }
    } catch (err) {
      console.warn('Failed to fetch live klines, using dataset:', err);
    } finally {
      setIsLiveLoading(false);
    }
  };

  const pBars = liveKlines?.pionex || currentDataset.pionex_klines;
  const bBars = liveKlines?.binance || currentDataset.binance_klines;

  // Find T bar metrics
  const pTBar = pBars.find(b => b.offset_label === 'T') || pBars[2];
  const bTBar = bBars.find(b => b.offset_label === 'T') || bBars[2];

  const pBaseVol = (pBars[0].volume + pBars[1].volume) / 2;
  const bBaseVol = (bBars[0].volume + bBars[1].volume) / 2;

  const pShock = pTBar.volume / (pBaseVol || 1);
  const bShock = bTBar.volume / (bBaseVol || 1);

  // Render a clean SVG Candlestick & Volume Chart
  const renderExchangeCandlesticks = (bars: SettlementWindowBar[], exchange: ExchangeId, accentColor: string) => {
    if (!bars || bars.length === 0) return null;

    // Determine scale for candlesticks
    const minPrice = Math.min(...bars.map(b => b.low));
    const maxPrice = Math.max(...bars.map(b => b.high));
    const pricePadding = (maxPrice - minPrice) * 0.15 || maxPrice * 0.001;
    const chartMin = minPrice - pricePadding;
    const chartMax = maxPrice + pricePadding;
    const priceRange = chartMax - chartMin || 1;

    // Determine scale for volume
    const maxVol = Math.max(...bars.map(b => b.volume));

    const svgWidth = 560;
    const svgHeight = 220;
    const candleAreaHeight = 150;
    const volAreaHeight = 55;
    const volAreaTop = 165;

    const barWidth = 44;
    const colSpacing = svgWidth / bars.length;

    const getY = (val: number) => {
      return candleAreaHeight - ((val - chartMin) / priceRange) * (candleAreaHeight - 20) - 10;
    };

    const getVolHeight = (vol: number) => {
      return (vol / (maxVol || 1)) * (volAreaHeight - 10);
    };

    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${exchange === 'Pionex' ? 'bg-cyan-400' : 'bg-amber-400'}`} />
            <span className="font-semibold text-sm text-slate-100">{exchange} 1m Klines (±2m Window)</span>
          </div>
          <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
            <span>High: <strong className="text-slate-200">{maxPrice.toFixed(4)}</strong></span>
            <span>Low: <strong className="text-slate-200">{minPrice.toFixed(4)}</strong></span>
            <span>Range: <strong className="text-cyan-400">{(((maxPrice - minPrice) / minPrice) * 100).toFixed(3)}%</strong></span>
          </div>
        </div>

        {/* SVG Canvas */}
        <div className="relative overflow-x-auto">
          <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-52 select-none font-mono text-[10px]">
            {/* Grid Lines */}
            <line x1="0" y1="20" x2={svgWidth} y2="20" stroke="#1e293b" strokeDasharray="3,3" />
            <line x1="0" y1={candleAreaHeight / 2} x2={svgWidth} y2={candleAreaHeight / 2} stroke="#1e293b" strokeDasharray="3,3" />
            <line x1="0" y1={candleAreaHeight} x2={svgWidth} y2={candleAreaHeight} stroke="#334155" />
            <line x1="0" y1={svgHeight - 1} x2={svgWidth} y2={svgHeight - 1} stroke="#1e293b" />

            {/* Vertical T marker highlight */}
            <rect
              x={2 * colSpacing + (colSpacing - barWidth) / 2 - 8}
              y="0"
              width={barWidth + 16}
              height={svgHeight}
              fill="#06b6d4"
              fillOpacity="0.06"
              rx="4"
            />
            <line
              x1={2 * colSpacing + colSpacing / 2}
              y1="0"
              x2={2 * colSpacing + colSpacing / 2}
              y2={svgHeight}
              stroke="#06b6d4"
              strokeDasharray="4,4"
              strokeWidth="1.5"
            />

            {/* Text badge for T */}
            <text
              x={2 * colSpacing + colSpacing / 2}
              y="14"
              textAnchor="middle"
              fill="#06b6d4"
              fontWeight="bold"
              fontSize="10"
            >
              T (Settlement)
            </text>

            {/* Candlesticks and Volume Bars */}
            {bars.map((bar, idx) => {
              const xCenter = idx * colSpacing + colSpacing / 2;
              const isGreen = bar.close >= bar.open;
              const candleColor = isGreen ? '#10b981' : '#f43f5e';

              const yOpen = getY(bar.open);
              const yClose = getY(bar.close);
              const yHigh = getY(bar.high);
              const yLow = getY(bar.low);

              const bodyY = Math.min(yOpen, yClose);
              const bodyHeight = Math.max(Math.abs(yClose - yOpen), 2);

              const vHeight = getVolHeight(bar.volume);
              const vY = svgHeight - vHeight;

              const isTBar = bar.offset_label === 'T';

              return (
                <g key={bar.offset_label}>
                  {/* High - Low Wick */}
                  <line
                    x1={xCenter}
                    y1={yHigh}
                    x2={xCenter}
                    y2={yLow}
                    stroke={candleColor}
                    strokeWidth="1.5"
                  />

                  {/* Open - Close Body */}
                  <rect
                    x={xCenter - barWidth / 2}
                    y={bodyY}
                    width={barWidth}
                    height={bodyHeight}
                    fill={candleColor}
                    rx="1"
                    stroke={candleColor}
                    strokeWidth="0.5"
                  />

                  {/* Volume Bar */}
                  <rect
                    x={xCenter - barWidth / 2}
                    y={vY}
                    width={barWidth}
                    height={vHeight}
                    fill={isTBar ? '#06b6d4' : candleColor}
                    fillOpacity={isTBar ? 0.85 : 0.45}
                    rx="1"
                  />

                  {/* Label on X axis */}
                  <text
                    x={xCenter}
                    y={volAreaTop - 4}
                    textAnchor="middle"
                    fill={isTBar ? '#06b6d4' : '#94a3b8'}
                    fontWeight={isTBar ? 'bold' : 'normal'}
                    fontSize="10"
                  >
                    {bar.offset_label}
                  </text>

                  {/* Shock ratio label above T volume */}
                  {isTBar && bar.volume_shock_ratio && (
                    <text
                      x={xCenter}
                      y={vY - 4}
                      textAnchor="middle"
                      fill="#06b6d4"
                      fontSize="9"
                      fontWeight="bold"
                    >
                      {bar.volume_shock_ratio.toFixed(1)}x Vol
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Legend */}
        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-emerald-500 rounded-sm" /> Bullish 1m Bar
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-rose-500 rounded-sm" /> Bearish 1m Bar
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-cyan-500 rounded-sm" /> T-Settlement Shock
            </span>
          </div>
          <div className="font-mono text-slate-400">
            Volume Surge at T: <strong className="text-cyan-400 font-semibold">{exchange === 'Pionex' ? pShock.toFixed(1) : bShock.toFixed(1)}x</strong>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Selector & Context Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <span>Spec v0.1 Section 2 & 3 Window</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>1-Minute Kline Sampling (5 Bars)</span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 mt-0.5">
              {currentDataset.symbol} ±2min Settlement Volatility & Volume Shock
            </h2>
            <div className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-3">
              <span>Funding Time: <strong className="text-slate-200 font-mono">{currentDataset.funding_time_str}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Pionex Rate: <strong className="text-emerald-400 font-mono">{(currentDataset.event_window.pionex_rate * 100).toFixed(3)}%</strong></span>
              <span aria-hidden="true">·</span>
              <span>Binance Rate: <strong className="text-emerald-400 font-mono">{(currentDataset.event_window.binance_rate * 100).toFixed(3)}%</strong></span>
              <span aria-hidden="true">·</span>
              <span>Spread: <strong className="text-cyan-400 font-mono font-bold">{(currentDataset.event_window.spread * 100).toFixed(3)}%</strong></span>
            </div>
          </div>

          {/* Quick Symbol Switcher & Live Fetch */}
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <button
              onClick={handleLoadLiveKlines}
              disabled={isLiveLoading}
              className="px-2.5 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 rounded text-xs font-mono flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isLiveLoading ? 'animate-spin' : ''}`} />
              <span>{isLiveLoading ? 'Fetching...' : 'Fetch Live 1m Klines'}</span>
            </button>

            <span className="text-xs text-slate-400 font-sans">Symbol:</span>
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

        {/* View mode toggle */}
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-slate-800 text-xs font-mono">
          <span className="text-slate-400 font-sans">交易所展示:</span>
          <button
            onClick={() => setSelectedExchange('both')}
            className={`px-2.5 py-1 rounded font-medium transition-colors ${
              selectedExchange === 'both' ? 'bg-slate-800 text-cyan-300 border border-slate-700' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            全所並排 (All Exchanges)
          </button>
          <button
            onClick={() => setSelectedExchange('Pionex')}
            className={`px-2.5 py-1 rounded font-medium transition-colors ${
              selectedExchange === 'Pionex' ? 'bg-cyan-950 text-cyan-300 border border-cyan-700' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Pionex
          </button>
          <button
            onClick={() => setSelectedExchange('Binance')}
            className={`px-2.5 py-1 rounded font-medium transition-colors ${
              selectedExchange === 'Binance' ? 'bg-amber-950 text-amber-300 border border-amber-700' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Binance
          </button>
          <span className="text-xs text-slate-500 font-sans pl-2 border-l border-slate-800">
            支援跨所衝擊對比：Pionex · Binance · Bybit · Bitget
          </span>
        </div>
      </div>

      {/* Candlestick & Volume Shock Visualizers */}
      <div className={`grid gap-6 ${selectedExchange === 'both' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
        {(selectedExchange === 'both' || selectedExchange === 'Pionex') &&
          renderExchangeCandlesticks(pBars, 'Pionex', '#06b6d4')}
        {(selectedExchange === 'both' || selectedExchange === 'Binance') &&
          renderExchangeCandlesticks(bBars, 'Binance', '#f59e0b')}
      </div>

      {/* Quantitative Correlation: Volume Shock -> Price Volatility -> Slippage */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-cyan-400" />
          <h3 className="font-semibold text-slate-100 text-sm">
            Research Chain: Funding Event → Volume Shock → Volatility → Execution Slippage
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs font-mono">
          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400">Pionex Volume Shock (T)</div>
            <div className="text-lg font-bold text-cyan-400">{pShock.toFixed(1)}x</div>
            <div className="text-[11px] text-slate-500 font-sans">
              Vol: ${pTBar.volume.toLocaleString()} vs Base ${(pBaseVol).toLocaleString()}
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400">Binance Volume Shock (T)</div>
            <div className="text-lg font-bold text-amber-400">{bShock.toFixed(1)}x</div>
            <div className="text-[11px] text-slate-500 font-sans">
              Vol: ${bTBar.volume.toLocaleString()} vs Base ${(bBaseVol).toLocaleString()}
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400">Max Excursion Range (T)</div>
            <div className="text-lg font-bold text-rose-400">
              {Math.max(pTBar.volatility, bTBar.volatility).toFixed(3)}%
            </div>
            <div className="text-[11px] text-slate-500 font-sans">
              High-Low spread peak around settlement
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1">
            <div className="text-slate-400">Estimated Total Slippage</div>
            <div className="text-lg font-bold text-amber-300">
              ${((currentDataset.event_window.avg_volatility_pct * 0.15 * 2) * 10).toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 font-sans">
              Entry + Exit across both legs (1000U each)
            </div>
          </div>
        </div>

        {/* Detailed Bar-by-Bar Inspection Table */}
        <div className="pt-2">
          <div className="text-xs font-semibold text-slate-300 mb-2 font-mono flex items-center justify-between">
            <span>5-Bar Synchronized Metric Audit (T-2m ~ T+2m)</span>
            <span className="text-[11px] text-slate-500 font-normal">All values recorded in Common Schema format</span>
          </div>

          <div className="border border-slate-800 rounded overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-950 text-slate-400 text-[11px] border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">Offset</th>
                  <th className="py-2.5 px-3">Exchange</th>
                  <th className="py-2.5 px-3">Open</th>
                  <th className="py-2.5 px-3">High</th>
                  <th className="py-2.5 px-3">Low</th>
                  <th className="py-2.5 px-3">Close</th>
                  <th className="py-2.5 px-3 text-right">Volume (USDT)</th>
                  <th className="py-2.5 px-3 text-right">High-Low Range</th>
                  <th className="py-2.5 px-3 text-right">Return %</th>
                  <th className="py-2.5 px-3 text-right">Vol Shock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {/* Interleaved Pionex and Binance bars */}
                {['T-2m', 'T-1m', 'T', 'T+1m', 'T+2m'].flatMap((offset) => {
                  const pBar = pBars.find(b => b.offset_label === offset)!;
                  const bBar = bBars.find(b => b.offset_label === offset)!;
                  const isT = offset === 'T';

                  return [
                    <tr key={`p-${offset}`} className={isT ? 'bg-cyan-950/20' : 'hover:bg-slate-900/30'}>
                      <td className="py-2 px-3 font-bold text-slate-200">
                        {offset} {isT && <span className="text-[10px] text-cyan-400 font-normal">(Settlement)</span>}
                      </td>
                      <td className="py-2 px-3 text-cyan-400 font-semibold">Pionex</td>
                      <td className="py-2 px-3 text-slate-300">{pBar.open.toFixed(4)}</td>
                      <td className="py-2 px-3 text-emerald-400">{pBar.high.toFixed(4)}</td>
                      <td className="py-2 px-3 text-rose-400">{pBar.low.toFixed(4)}</td>
                      <td className="py-2 px-3 text-slate-300">{pBar.close.toFixed(4)}</td>
                      <td className="py-2 px-3 text-right text-slate-200">${pBar.volume.toLocaleString()}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{pBar.volatility.toFixed(3)}%</td>
                      <td className={`py-2 px-3 text-right ${pBar.return_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {pBar.return_pct >= 0 ? '+' : ''}{pBar.return_pct.toFixed(3)}%
                      </td>
                      <td className="py-2 px-3 text-right text-cyan-400 font-bold">
                        {pBar.volume_shock_ratio ? `${pBar.volume_shock_ratio.toFixed(1)}x` : '-'}
                      </td>
                    </tr>,
                    <tr key={`b-${offset}`} className={isT ? 'bg-amber-950/20' : 'hover:bg-slate-900/30'}>
                      <td className="py-2 px-3 text-slate-500">{offset}</td>
                      <td className="py-2 px-3 text-amber-400 font-semibold">Binance</td>
                      <td className="py-2 px-3 text-slate-300">{bBar.open.toFixed(4)}</td>
                      <td className="py-2 px-3 text-emerald-400">{bBar.high.toFixed(4)}</td>
                      <td className="py-2 px-3 text-rose-400">{bBar.low.toFixed(4)}</td>
                      <td className="py-2 px-3 text-slate-300">{bBar.close.toFixed(4)}</td>
                      <td className="py-2 px-3 text-right text-slate-200">${bBar.volume.toLocaleString()}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{bBar.volatility.toFixed(3)}%</td>
                      <td className={`py-2 px-3 text-right ${bBar.return_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {bBar.return_pct >= 0 ? '+' : ''}{bBar.return_pct.toFixed(3)}%
                      </td>
                      <td className="py-2 px-3 text-right text-amber-400 font-bold">
                        {bBar.volume_shock_ratio ? `${bBar.volume_shock_ratio.toFixed(1)}x` : '-'}
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
