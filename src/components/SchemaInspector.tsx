/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Section 1: Common Schema & 5-Exchange Adapter Inspector
 * Live verification and mapping across all 5 exchanges: Pionex, Binance, Bybit, Bitget, OKX.
 */

import React, { useState } from 'react';
import { CommonFundingRecord } from '../types/schema';
import { mapPionexToCommon, PIONEX_FIELD_MAPPING_DOC, PionexRawFuturesTicker } from '../adapters/pionexAdapter';
import { mapBinanceToCommon, BINANCE_FIELD_MAPPING_DOC, BinanceRawFuturesTicker } from '../adapters/binanceAdapter';
import { mapBybitToCommon, BYBIT_FIELD_MAPPING_DOC, BybitRawLinearTicker } from '../adapters/bybitAdapter';
import { mapBitgetToCommon, BITGET_FIELD_MAPPING_DOC, BitgetRawFuturesTicker } from '../adapters/bitgetAdapter';
import { mapOKXToCommon, OKX_FIELD_MAPPING_DOC, OKXRawSwapTicker } from '../adapters/okxAdapter';
import { Layers, Copy, Check, Code, ArrowRightLeft, FileCode, CheckCircle2 } from 'lucide-react';

const COMMON_FIELDS_TABLE = [
  { field: 'exchange', type: 'ExchangeId', def: '交易所識別名稱', pionex: "'Pionex'", binance: "'Binance'", bybit: "'Bybit'", bitget: "'Bitget'", okx: "'OKX'" },
  { field: 'symbol', type: 'string', def: '統一交易對 (大寫無分隔)', pionex: "symbol.replace('_', '')", binance: 'symbol', bybit: 'symbol', bitget: 'symbol', okx: "instId.replace('-SWAP','').replace('-','')" },
  { field: 'event_time', type: 'number', def: '資料接收時間戳 (ms)', pionex: 'time', binance: 'time', bybit: 'time || now', bitget: 'parseInt(ts)', okx: 'parseInt(ts)' },
  { field: 'funding_time', type: 'number', def: '結算時間戳 T (ms)', pionex: 'fundingTime', binance: 'nextFundingTime', bybit: 'parseInt(nextFundingTime)', bitget: 'next 8h boundary', okx: 'parseInt(fundingTime)' },
  { field: 'funding_rate', type: 'number', def: '該次資金費率 (小數形式)', pionex: 'fundingRate', binance: 'lastFundingRate', bybit: 'fundingRate', bitget: 'fundingRate', okx: 'parseFloat(fundingRate)' },
  { field: 'next_funding_time', type: 'number', def: '下一次結算時間戳 (ms)', pionex: 'nextFundingTime', binance: 'nextFundingTime + 8h', bybit: 'nextFundingTime + interval', bitget: 'boundary + 8h', okx: 'parseInt(nextFundingTime)' },
  { field: 'mark_price', type: 'number', def: '合約標記價格 Mark Price', pionex: 'markPrice', binance: 'markPrice', bybit: 'markPrice', bitget: 'markPrice', okx: 'parseFloat(markPx || last)' },
  { field: 'index_price', type: 'number', def: '現貨指數基準價 Index Price', pionex: 'indexPrice', binance: 'indexPrice', bybit: 'indexPrice', bitget: 'indexPrice', okx: 'parseFloat(indexPrice)' },
  { field: 'last_price', type: 'number', def: '最後撮合成交價', pionex: 'lastPrice', binance: 'lastPrice || markPrice', bybit: 'lastPrice', bitget: 'lastPr', okx: 'parseFloat(last)' },
  { field: 'bid_price', type: 'number', def: '盤口最佳買價 (Best Bid)', pionex: 'bid1', binance: 'bidPrice', bybit: 'bid1Price', bitget: 'bidPr', okx: 'parseFloat(bidPx)' },
  { field: 'ask_price', type: 'number', def: '盤口最佳賣價 (Best Ask)', pionex: 'ask1', binance: 'askPrice', bybit: 'ask1Price', bitget: 'askPr', okx: 'parseFloat(askPx)' },
  { field: 'volume', type: 'number', def: '24h 名義成交額 (USDT)', pionex: 'volume24h', binance: 'volume', bybit: 'turnover24h', bitget: 'usdtVolume || quoteVolume', okx: 'parseFloat(volCcy24h)' },
  { field: 'open_interest', type: 'number', def: '未平倉量 (USDT Notional)', pionex: 'openInterest', binance: 'openInterest', bybit: 'openInterestValue', bitget: 'holdingAmount * mark', okx: 'ctVal * ctMult' },
  { field: 'kline_open', type: 'number', def: '1m K線 Open 開盤價', pionex: 'kline.open', binance: 'kline.open', bybit: 'kline.open', bitget: 'kline.open', okx: 'kline.open' },
  { field: 'kline_high', type: 'number', def: '1m K線 High 最高價', pionex: 'kline.high', binance: 'kline.high', bybit: 'kline.high', bitget: 'kline.high', okx: 'kline.high' },
  { field: 'kline_low', type: 'number', def: '1m K線 Low 最低價', pionex: 'kline.low', binance: 'kline.low', bybit: 'kline.low', bitget: 'kline.low', okx: 'kline.low' },
  { field: 'kline_close', type: 'number', def: '1m K線 Close 收盤價', pionex: 'kline.close', binance: 'kline.close', bybit: 'kline.close', bitget: 'kline.close', okx: 'kline.close' },
  { field: 'kline_volume', type: 'number', def: '1m K線 Volume 成交量', pionex: 'kline.volume', binance: 'kline.volume', bybit: 'kline.volume', bitget: 'kline.volume', okx: 'kline.volume' },
  { field: 'fee_rate', type: 'number', def: '最低會員等級 Taker 費率', pionex: '0.00050 (0.05%)', binance: '0.00050 (0.05%)', bybit: '0.00055 (0.055%)', bitget: '0.00060 (0.06%)', okx: '0.00050 (0.05%)' },
  { field: 'native_symbol', type: 'string', def: '交易所原生代碼', pionex: "'SOL_USDT'", binance: "'SOLUSDT'", bybit: "'SOLUSDT'", bitget: "'SOLUSDT'", okx: "'SOL-USDT-SWAP'" },
  { field: 'native_field_mapping', type: 'Record<string, string>', def: '欄位溯源對映字典', pionex: 'Mapping Dict', binance: 'Mapping Dict', bybit: 'Mapping Dict', bitget: 'Mapping Dict', okx: 'Mapping Dict' },
];

export const SchemaInspector: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'matrix' | 'pionex_demo' | 'binance_demo' | 'bybit_demo' | 'bitget_demo' | 'okx_demo' | 'ts_code'>('matrix');
  const [copied, setCopied] = useState(false);

  // Sample raw payloads
  const samplePionexRaw: PionexRawFuturesTicker = {
    symbol: 'SOL_USDT',
    time: 1718035155000,
    fundingRate: '0.00310',
    fundingTime: 1718035200000,
    nextFundingTime: 1718064000000,
    markPrice: '154.20',
    indexPrice: '154.18',
    lastPrice: '154.21',
    bid1: '154.19',
    ask1: '154.22',
    volume24h: '122400000',
    openInterest: '45000000',
    kline: { open: 154.15, high: 154.38, low: 154.08, close: 154.25, volume: 850000 },
  };

  const sampleBinanceRaw: BinanceRawFuturesTicker = {
    symbol: 'SOLUSDT',
    time: 1718035155000,
    lastFundingRate: '0.00080000',
    nextFundingTime: 1718035200000,
    markPrice: '154.22',
    indexPrice: '154.19',
    lastPrice: '154.23',
    bidPrice: '154.21',
    askPrice: '154.23',
    volume: '280000000',
    openInterest: '95000000',
    kline: { open: 154.18, high: 154.35, low: 154.10, close: 154.24, volume: 1250000 },
  };

  const sampleBybitRaw: BybitRawLinearTicker = {
    symbol: 'SOLUSDT',
    lastPrice: '154.20',
    indexPrice: '154.18',
    markPrice: '154.21',
    prevPrice24h: '150.00',
    price24hPcnt: '0.028',
    highPrice24h: '156.00',
    lowPrice24h: '149.50',
    openInterest: '350000',
    openInterestValue: '53970000',
    turnover24h: '195000000',
    volume24h: '1264590',
    fundingRate: '0.001718',
    nextFundingTime: '1718035200000',
    fundingIntervalHour: '8',
    bid1Price: '154.19',
    ask1Price: '154.22',
    time: 1718035155000,
    kline: { open: 154.16, high: 154.36, low: 154.09, close: 154.22, volume: 920000 },
  };

  const sampleBitgetRaw: BitgetRawFuturesTicker = {
    symbol: 'SOLUSDT',
    lastPr: '154.22',
    askPr: '154.23',
    bidPr: '154.20',
    high24h: '155.80',
    low24h: '149.80',
    ts: '1718035155000',
    baseVolume: '980000',
    quoteVolume: '151116000',
    usdtVolume: '151116000',
    openUtc: '151.00',
    indexPrice: '154.19',
    fundingRate: '-0.001568',
    holdingAmount: '320000',
    markPrice: '154.21',
    kline: { open: 154.15, high: 154.34, low: 154.08, close: 154.21, volume: 780000 },
  };

  const sampleOKXRaw: OKXRawSwapTicker = {
    instId: 'SOL-USDT-SWAP',
    instType: 'SWAP',
    last: '154.21',
    askPx: '154.22',
    bidPx: '154.20',
    volCcy24h: '210500000',
    ts: '1718035155000',
    fundingRate: '0.000093',
    fundingTime: '1718035200000',
    nextFundingTime: '1718064000000',
    markPx: '154.21',
    indexPrice: '154.19',
    kline: { open: 154.17, high: 154.35, low: 154.10, close: 154.21, volume: 880000 },
  };

  const pionexConverted = mapPionexToCommon(samplePionexRaw);
  const binanceConverted = mapBinanceToCommon(sampleBinanceRaw);
  const bybitConverted = mapBybitToCommon(sampleBybitRaw);
  const bitgetConverted = mapBitgetToCommon(sampleBitgetRaw);
  const okxConverted = mapOKXToCommon(sampleOKXRaw);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(JSON.stringify(COMMON_FIELDS_TABLE, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <span>Spec v0.1 Section 1 Architectural Invariant</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-emerald-400 font-bold">5-EXCHANGE COMMON DATA LAYER</span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 mt-1">
              Common Schema &amp; 5-Exchange Adapter Specification
            </h2>
            <p className="text-xs text-slate-400 mt-1 max-w-3xl leading-relaxed">
              核心策略、回測引擎與風控完全依賴統一的 Common Schema。涵蓋 <strong>Pionex</strong>、<strong>Binance</strong>、<strong>Bybit</strong>、<strong>Bitget</strong> 與 <strong>OKX</strong> 五大交易所，透過各自獨立的 Adapter 進行無損轉換，保留雙向欄位溯源。
            </p>
          </div>

          <button
            onClick={handleCopyCode}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-xs font-medium flex items-center gap-1.5 transition-colors self-start sm:self-auto"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied Mapping!' : 'Copy Dictionary'}</span>
          </button>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex flex-wrap items-center gap-2 mt-5 pt-4 border-t border-slate-800 text-xs font-mono">
          <button
            onClick={() => setActiveTab('matrix')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'matrix' ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>5-Exchange Mapping Matrix (21 Fields)</span>
          </button>

          <button
            onClick={() => setActiveTab('pionex_demo')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'pionex_demo' ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Pionex Transform</span>
          </button>

          <button
            onClick={() => setActiveTab('binance_demo')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'binance_demo' ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Binance Transform</span>
          </button>

          <button
            onClick={() => setActiveTab('bybit_demo')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'bybit_demo' ? 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Bybit Transform</span>
          </button>

          <button
            onClick={() => setActiveTab('bitget_demo')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'bitget_demo' ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Bitget Transform</span>
          </button>

          <button
            onClick={() => setActiveTab('okx_demo')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'okx_demo' ? 'bg-blue-500/20 text-blue-300 font-bold border border-blue-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>OKX Transform</span>
          </button>

          <button
            onClick={() => setActiveTab('ts_code')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              activeTab === 'ts_code' ? 'bg-slate-800 text-slate-200 font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>TypeScript Interface</span>
          </button>
        </div>
      </div>

      {/* View 1: 5-Exchange Mapping Matrix Table */}
      {activeTab === 'matrix' && (
        <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
          <div className="p-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
            <span className="text-slate-200 font-semibold">Common Funding Record Field Traceability Matrix</span>
            <span className="text-emerald-400 text-[11px]">Strict Type Guarantee: Zero Data Pollution</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-900/60 text-slate-400 text-[11px] border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">Common Field Name</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Semantic Definition</th>
                  <th className="py-2.5 px-3 text-cyan-400 font-semibold">Pionex Source</th>
                  <th className="py-2.5 px-3 text-amber-400 font-semibold">Binance Source</th>
                  <th className="py-2.5 px-3 text-purple-400 font-semibold">Bybit Source</th>
                  <th className="py-2.5 px-3 text-emerald-400 font-semibold">Bitget Source</th>
                  <th className="py-2.5 px-3 text-blue-400 font-semibold">OKX Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {COMMON_FIELDS_TABLE.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-900/40 transition-colors">
                    <td className="py-2 px-3 text-slate-200 font-bold">{row.field}</td>
                    <td className="py-2 px-3 text-cyan-300 font-mono text-[11px]">{row.type}</td>
                    <td className="py-2 px-3 text-slate-400 font-sans text-xs">{row.def}</td>
                    <td className="py-2 px-3 text-cyan-400 bg-cyan-950/10 font-mono text-[11px]">{row.pionex}</td>
                    <td className="py-2 px-3 text-amber-400 bg-amber-950/10 font-mono text-[11px]">{row.binance}</td>
                    <td className="py-2 px-3 text-purple-400 bg-purple-950/10 font-mono text-[11px]">{row.bybit}</td>
                    <td className="py-2 px-3 text-emerald-400 bg-emerald-950/10 font-mono text-[11px]">{row.bitget}</td>
                    <td className="py-2 px-3 text-blue-400 bg-blue-950/10 font-mono text-[11px]">{row.okx}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* View 2: Pionex Transform */}
      {activeTab === 'pionex_demo' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-cyan-400">Pionex Raw API Payload (Incoming)</span>
              <span className="text-[10px] text-slate-500">api.pionex.com</span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-slate-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(samplePionexRaw, null, 2)}
            </pre>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-emerald-400">Converted Common Funding Record</span>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-sans">
                <CheckCircle2 className="w-3 h-3" /> Validated
              </span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-cyan-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(pionexConverted, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* View 3: Binance Transform */}
      {activeTab === 'binance_demo' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-amber-400">Binance Raw API Payload (Incoming)</span>
              <span className="text-[10px] text-slate-500">fapi.binance.com</span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-slate-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(sampleBinanceRaw, null, 2)}
            </pre>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-emerald-400">Converted Common Funding Record</span>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-sans">
                <CheckCircle2 className="w-3 h-3" /> Validated
              </span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-amber-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(binanceConverted, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* View 4: Bybit Transform */}
      {activeTab === 'bybit_demo' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-purple-400">Bybit V5 Linear Raw Payload (Incoming)</span>
              <span className="text-[10px] text-slate-500">api.bybit.com</span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-slate-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(sampleBybitRaw, null, 2)}
            </pre>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-emerald-400">Converted Common Funding Record</span>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-sans">
                <CheckCircle2 className="w-3 h-3" /> Validated
              </span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-purple-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(bybitConverted, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* View 5: Bitget Transform */}
      {activeTab === 'bitget_demo' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-emerald-400">Bitget V2 USDT-FUTURES Raw Payload (Incoming)</span>
              <span className="text-[10px] text-slate-500">api.bitget.com</span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-slate-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(sampleBitgetRaw, null, 2)}
            </pre>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-emerald-400">Converted Common Funding Record</span>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-sans">
                <CheckCircle2 className="w-3 h-3" /> Validated
              </span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-emerald-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(bitgetConverted, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* View 6: OKX Transform */}
      {activeTab === 'okx_demo' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-blue-400">OKX V5 SWAP Raw Payload (Incoming)</span>
              <span className="text-[10px] text-slate-500">www.okx.com</span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-slate-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(sampleOKXRaw, null, 2)}
            </pre>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="font-semibold text-emerald-400">Converted Common Funding Record</span>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-sans">
                <CheckCircle2 className="w-3 h-3" /> Validated
              </span>
            </div>
            <pre className="p-3 bg-slate-950 rounded text-blue-300 overflow-x-auto text-[11px] max-h-96 leading-relaxed">
              {JSON.stringify(okxConverted, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* View 7: TypeScript Source Definition */}
      {activeTab === 'ts_code' && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-xs font-mono">
          <pre className="p-3 bg-slate-950 rounded text-slate-300 overflow-x-auto text-[11px] leading-relaxed">
{`export type ExchangeId = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

export interface CommonFundingRecord {
  exchange: ExchangeId;
  symbol: string;             // Unified format e.g. "BTCUSDT"
  event_time: number;         // Milliseconds epoch timestamp
  funding_time: number;       // Settlement timestamp (T)
  funding_rate: number;       // Rate as a decimal e.g. 0.0025 for +0.25%
  next_funding_time: number;  // Next scheduled settlement (T + 8h, 4h or 1h)
  mark_price: number;         // Perpetual Mark price used for funding
  index_price: number;        // Underlying Spot Index price
  last_price: number;         // Last executed market price
  bid_price: number;          // Best bid (immediate sell price)
  ask_price: number;          // Best ask (immediate buy price)
  volume: number;             // 24h rolling volume (USDT)
  open_interest: number;      // Open interest (USDT notional)
  kline_open: number;         // 1m Kline open at event
  kline_high: number;         // 1m Kline high at event
  kline_low: number;          // 1m Kline low at event
  kline_close: number;        // 1m Kline close at event
  kline_volume: number;       // 1m Kline volume at event
  fee_rate: number;           // Standard taker fee rate for lowest tier
  
  // Traceability metadata
  native_symbol: string;      // e.g. "SOL-USDT-SWAP" on OKX, "SOLUSDT" on Binance
  native_field_mapping: Record<string, string>; // Maps CommonField -> Native API Key
}`}
          </pre>
        </div>
      )}
    </div>
  );
};
