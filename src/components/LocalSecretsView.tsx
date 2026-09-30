/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Local Secrets Vault (Spec Sections 16 - 18)
 * 4-Exchange Ready: Pionex × Binance × Bybit × Bitget
 * 
 * STRICT ARCHITECTURAL INVARIANTS:
 * - Clear explanation of the purpose and exact usage of each API Key.
 * - Credentials NEVER mix into Common Schema or research exports.
 * - Credentials reside strictly inside local browser memory / localStorage.
 * - Withdrawal permissions are strictly forbidden.
 * - IP Whitelist safety checklist enforced.
 */

import React, { useState } from 'react';
import { LocalSecretsConfig } from '../types/systemSpec';
import {
  ShieldCheck,
  Lock,
  AlertTriangle,
  Key,
  Save,
  Trash2,
  CheckCircle2,
  Eye,
  EyeOff,
  HelpCircle,
  Activity,
  ArrowRight,
  Database
} from 'lucide-react';

const DEFAULT_SECRETS: LocalSecretsConfig = {
  pionex_api_key: '',
  pionex_api_secret: '',
  binance_api_key: '',
  binance_api_secret: '',
  bybit_api_key: '',
  bybit_api_secret: '',
  bitget_api_key: '',
  bitget_api_secret: '',
  okx_api_key: '',
  okx_api_secret: '',
  okx_passphrase: '',
  coinglass_api_key: '',
  trading_capital_usdt: 5000,
  max_position_usdt: 1000,
  max_slippage_pct: 0.08,
  min_funding_spread_pct: 0.20,
  ip_whitelist_confirmed: false,
  withdrawal_disabled_confirmed: false,
};

export const LocalSecretsView: React.FC = () => {
  const [config, setConfig] = useState<LocalSecretsConfig>(() => {
    try {
      const saved = localStorage.getItem('px_bn_local_secrets_vault');
      return saved ? { ...DEFAULT_SECRETS, ...JSON.parse(saved) } : DEFAULT_SECRETS;
    } catch {
      return DEFAULT_SECRETS;
    }
  });

  const [showSecrets, setShowSecrets] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      localStorage.setItem('px_bn_local_secrets_vault', JSON.stringify(config));
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2500);
    } catch (err) {
      console.error('Failed to save to localStorage', err);
    }
  };

  const handleClearAll = () => {
    if (confirm('確定清除本地保存的所有 API 金鑰與機密配置嗎？此操作不可逆。')) {
      localStorage.removeItem('px_bn_local_secrets_vault');
      setConfig(DEFAULT_SECRETS);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner: Local-Only Privacy Guarantee */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <span>Spec Sections 16 - 18 Security Invariant</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="text-emerald-400 font-bold">CLIENT-SIDE LOCAL VAULT</span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 mt-1">
              Local Machine Secret Manager &amp; API Permissions (5 Exchanges)
            </h2>
            <p className="text-xs text-slate-400 mt-1 max-w-3xl leading-relaxed">
              <strong>Common Schema ≠ Credentials：</strong> API Key 與 Secret 永遠獨立保存在本機端 (Local Machine)，絕不進入 Common Data，絕不隨 Parquet / CSV / 回測數據或 Telemetry 上傳雲端。
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              onClick={() => setShowSecrets(!showSecrets)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              {showSecrets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{showSecrets ? 'Hide Secrets' : 'Reveal Secrets'}</span>
            </button>
          </div>
        </div>

        {/* Security Invariants Checklist (Prompt Section 18) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-4 mt-4 border-t border-slate-800 text-xs font-sans">
          <div className="p-3 bg-rose-950/20 border border-rose-800/40 rounded-lg space-y-1">
            <div className="flex items-center gap-2 text-rose-300 font-bold font-mono">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <span>嚴格禁止開啟提現權限 (No Withdrawal)</span>
            </div>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              Pionex、Binance、Bybit、Bitget API 金鑰僅開啟 <strong>「讀取 (Read)」</strong> 與 <strong>「合約交易 (Futures Trading)」</strong> 權限。絕不可開啟 <strong>「提現 (Withdrawal)」</strong>！
            </p>
          </div>

          <div className="p-3 bg-cyan-950/20 border border-cyan-800/40 rounded-lg space-y-1">
            <div className="flex items-center gap-2 text-cyan-300 font-bold font-mono">
              <ShieldCheck className="w-4 h-4 text-cyan-400" />
              <span>IP 白名單綁定 (IP Restriction)</span>
            </div>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              建議在交易所 API 設置中綁定交易主機固定 IP，即便 Key 洩漏亦無法在其他網路環境發起下單請求。
            </p>
          </div>
        </div>
      </div>

      {/* Detailed Transparent API Key Purpose Breakdown Box */}
      <div className="bg-slate-900 border border-cyan-800/60 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2 text-cyan-300 font-mono font-bold text-sm">
          <Key className="w-4 h-4 text-cyan-400" />
          <span>四大交易所 API Key 在系統中的具體作用與職責分解</span>
        </div>

        <p className="text-xs text-slate-300 font-sans leading-relaxed">
          為了讓您對資金安全 100% 透明掌控，以下詳細說明每個 API Key 在套利架構中扮演的角色。
          <strong>重要原則：全市場公開行情掃描完全不需要任何 Key；只有在操作您個人帳戶的私有資訊時才會調用 Key。</strong>
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-sans">
          {/* Pionex API Key Purpose */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-cyan-400 font-mono flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                PIONEX_API_KEY &amp; SECRET 的具體作用
              </span>
              <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                Truth Layer
              </span>
            </div>
            <ul className="space-y-1.5 text-[11px] text-slate-300 list-disc list-inside">
              <li>
                <strong>查詢個人可用保證金 (Margin Balance)</strong>：在 T-30s 前向 <code>GET /api/v1/futures/account</code> 確認合約帳戶有足夠的 USDT 可開立部位。
              </li>
              <li>
                <strong>T-30s 實盤主動開倉 (Market Order Entry)</strong>：向 <code>POST /api/v1/futures/order</code> 發送市價 IOC 反向合約單。
              </li>
              <li>
                <strong>T+30s 實盤同時平倉 (Position Close)</strong>：資金費結算完畢後，立即發送市價反向平倉單，落袋淨利。
              </li>
              <li>
                <strong>單腿失衡急停平倉 (Leg Imbalance Emergency Close)</strong>：若對沖邊下單失敗，立即平倉 Pionex 部位。
              </li>
            </ul>
            <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 font-mono">
              必要權限：<strong>Read (讀取) + Futures Trading (合約下單)</strong> · 嚴禁 Withdrawal
            </div>
          </div>

          {/* Binance API Key Purpose */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-amber-400 font-mono flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                BINANCE_API_KEY &amp; SECRET 的具體作用
              </span>
              <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                Truth Layer
              </span>
            </div>
            <ul className="space-y-1.5 text-[11px] text-slate-300 list-disc list-inside">
              <li>
                <strong>查詢帳戶風險率與保證金 (Risk Ratio Query)</strong>：向 <code>GET /fapi/v2/account</code> 取得維持保證金率與未實現損益。
              </li>
              <li>
                <strong>WebSocket 即時成交回報 (User Data Stream)</strong>：生成 <code>listenKey</code> 監聽訂單是否完全成交 (FILLED)。
              </li>
              <li>
                <strong>T-30s 實盤對沖發單 &amp; T+30s 平倉</strong>：向 <code>POST /fapi/v1/order</code> 發送反向合約單。
              </li>
            </ul>
            <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 font-mono">
              必要權限：<strong>Read (讀取) + USDⓈ-M Futures Trading</strong> · 嚴禁 Withdrawal
            </div>
          </div>

          {/* Bybit API Key Purpose */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-purple-400 font-mono flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-purple-400" />
                BYBIT_API_KEY &amp; SECRET 的具體作用
              </span>
              <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                Truth Layer
              </span>
            </div>
            <ul className="space-y-1.5 text-[11px] text-slate-300 list-disc list-inside">
              <li>
                <strong>查詢統一保證金帳戶餘額 (UTA Wallet Balance)</strong>：向 <code>GET /v5/account/wallet-balance</code> 檢查 USDT 可用餘額。
              </li>
              <li>
                <strong>T-30s V5 Linear 開倉與平倉</strong>：向 <code>POST /v5/order/create</code> 發送市價 IOC 正向或反向對沖訂單。
              </li>
              <li>
                <strong>WebSocket 私有執行回報</strong>：連線 <code>wss://stream.bybit.com/v5/private</code> 監聽 <code>execution</code> 主題。
              </li>
            </ul>
            <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 font-mono">
              必要權限：<strong>Read (讀取) + Contract Orders (合約交易)</strong> · 嚴禁 Transfer/Withdrawal
            </div>
          </div>

          {/* Bitget API Key Purpose */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-emerald-400 font-mono flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                BITGET_API_KEY &amp; SECRET 的具體作用
              </span>
              <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                Truth Layer
              </span>
            </div>
            <ul className="space-y-1.5 text-[11px] text-slate-300 list-disc list-inside">
              <li>
                <strong>查詢 U 本位合約帳戶餘額</strong>：向 <code>GET /api/v2/mix/account/accounts</code> 確認可用 USDT。
              </li>
              <li>
                <strong>T-30s 實盤下單與 T+30s 平倉</strong>：向 <code>POST /api/v2/mix/order/place-order</code> 發送市價合約委託。
              </li>
              <li>
                <strong>Passphrase 密碼口令防護</strong>：遵循 Bitget V2 API 三重安全認證架構。
              </li>
            </ul>
            <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 font-mono">
              必要權限：<strong>Read (讀取) + Futures Trading (合約下單)</strong> · 嚴禁 Withdrawal
            </div>
          </div>

          {/* OKX API Key Purpose */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-blue-400 font-mono flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-400" />
                OKX_API_KEY, SECRET &amp; PASSPHRASE 的具體作用
              </span>
              <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                Truth Layer
              </span>
            </div>
            <ul className="space-y-1.5 text-[11px] text-slate-300 list-disc list-inside">
              <li>
                <strong>查詢交易帳戶餘額 (Trading Account Balance)</strong>：向 <code>GET /api/v5/account/balance</code> 檢查 USDT 可用保證金。
              </li>
              <li>
                <strong>T-30s SWAP 實盤市價 IOC 對沖下單</strong>：向 <code>POST /api/v5/trade/order</code> 發送永續合約買賣委託。
              </li>
              <li>
                <strong>三要素認證 (API Key + Secret + Passphrase)</strong>：符合 OKX 官方 V5 安全規範與 IP 白名單防護。
              </li>
            </ul>
            <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 font-mono">
              必要權限：<strong>Read (讀取) + Trade (交易)</strong> · 嚴禁 Withdraw (提幣)
            </div>
          </div>
        </div>
      </div>

      {/* Main Credentials Form */}
      <form onSubmit={handleSave} className="space-y-6">
        {/* Section 1: Truth Layer Credentials across 5 Exchanges */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
          <div className="flex items-center gap-2 font-mono text-sm font-semibold text-slate-100 border-b border-slate-800 pb-3">
            <Key className="w-4 h-4 text-cyan-400" />
            <span>Execution / Exchange Truth Layer Credentials (5 Exchanges)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs font-mono">
            {/* Pionex */}
            <div className="space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-bold text-cyan-400 font-sans">Pionex API Credentials</span>
                <span className="text-[10px] text-slate-500">Read + Futures Only</span>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">PIONEX_API_KEY</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Pionex API Key..."
                  value={config.pionex_api_key}
                  onChange={e => setConfig({ ...config, pionex_api_key: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">PIONEX_API_SECRET</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Pionex API Secret..."
                  value={config.pionex_api_secret}
                  onChange={e => setConfig({ ...config, pionex_api_secret: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>

            {/* Binance */}
            <div className="space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-bold text-amber-400 font-sans">Binance API Credentials</span>
                <span className="text-[10px] text-slate-500">Read + USDⓈ-M Futures Only</span>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">BINANCE_API_KEY</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Binance API Key..."
                  value={config.binance_api_key}
                  onChange={e => setConfig({ ...config, binance_api_key: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">BINANCE_API_SECRET</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Binance API Secret..."
                  value={config.binance_api_secret}
                  onChange={e => setConfig({ ...config, binance_api_secret: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>

            {/* Bybit */}
            <div className="space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-bold text-purple-400 font-sans">Bybit API Credentials</span>
                <span className="text-[10px] text-slate-500">Read + Linear Contract Only</span>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">BYBIT_API_KEY</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Bybit API Key..."
                  value={config.bybit_api_key || ''}
                  onChange={e => setConfig({ ...config, bybit_api_key: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">BYBIT_API_SECRET</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Bybit API Secret..."
                  value={config.bybit_api_secret || ''}
                  onChange={e => setConfig({ ...config, bybit_api_secret: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>

            {/* Bitget */}
            <div className="space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-bold text-emerald-400 font-sans">Bitget API Credentials</span>
                <span className="text-[10px] text-slate-500">Read + USDT-Futures Only</span>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">BITGET_API_KEY</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Bitget API Key..."
                  value={config.bitget_api_key || ''}
                  onChange={e => setConfig({ ...config, bitget_api_key: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">BITGET_API_SECRET</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 Bitget API Secret..."
                  value={config.bitget_api_secret || ''}
                  onChange={e => setConfig({ ...config, bitget_api_secret: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>

            {/* OKX */}
            <div className="space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-bold text-blue-400 font-sans">OKX API Credentials</span>
                <span className="text-[10px] text-slate-500">Read + Trade (SWAP)</span>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">OKX_API_KEY</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 OKX API Key..."
                  value={config.okx_api_key || ''}
                  onChange={e => setConfig({ ...config, okx_api_key: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">OKX_API_SECRET</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 OKX API Secret..."
                  value={config.okx_api_secret || ''}
                  onChange={e => setConfig({ ...config, okx_api_secret: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">OKX_PASSPHRASE</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="輸入 OKX Passphrase 口令..."
                  value={config.okx_passphrase || ''}
                  onChange={e => setConfig({ ...config, okx_passphrase: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Capital & Risk Limits */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
          <div className="font-mono text-sm font-semibold text-slate-100 border-b border-slate-800 pb-3 flex items-center justify-between">
            <span>Trading Capital &amp; Risk Guard Thresholds</span>
            <span className="text-xs text-slate-500 font-sans">Enforced by M6 Risk Engine</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1 font-sans">總資本配額 (USDT)</label>
              <input
                type="number"
                value={config.trading_capital_usdt}
                onChange={e => setConfig({ ...config, trading_capital_usdt: parseFloat(e.target.value) || 0 })}
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1 font-sans">單次最大名義部位 (USDT)</label>
              <input
                type="number"
                value={config.max_position_usdt}
                onChange={e => setConfig({ ...config, max_position_usdt: parseFloat(e.target.value) || 0 })}
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1 font-sans">最大滑價容忍度 (%)</label>
              <input
                type="number"
                step="0.01"
                value={config.max_slippage_pct}
                onChange={e => setConfig({ ...config, max_slippage_pct: parseFloat(e.target.value) || 0 })}
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1 font-sans">最低費率差門檻 (%)</label>
              <input
                type="number"
                step="0.01"
                value={config.min_funding_spread_pct}
                onChange={e => setConfig({ ...config, min_funding_spread_pct: parseFloat(e.target.value) || 0 })}
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Safety Confirmations */}
          <div className="pt-3 border-t border-slate-800 space-y-2 text-xs font-sans">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={config.withdrawal_disabled_confirmed}
                onChange={e => setConfig({ ...config, withdrawal_disabled_confirmed: e.target.checked })}
                className="rounded border-slate-700 text-cyan-500 focus:ring-0 bg-slate-950"
              />
              <span className="text-slate-300">我已確認所有交易所 API 金鑰皆<strong>未勾選提現 (Withdraw) 權限</strong>。</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={config.ip_whitelist_confirmed}
                onChange={e => setConfig({ ...config, ip_whitelist_confirmed: e.target.checked })}
                className="rounded border-slate-700 text-cyan-500 focus:ring-0 bg-slate-950"
              />
              <span className="text-slate-300">我已在交易所控制台設定<strong>IP 白名單限制</strong>。</span>
            </label>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleClearAll}
            className="px-3 py-2 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/60 rounded text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Purge Local Secrets</span>
          </button>

          <button
            type="submit"
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-medium flex items-center gap-2 shadow-lg transition-colors font-mono"
          >
            {savedSuccess ? <CheckCircle2 className="w-4 h-4 text-emerald-200" /> : <Save className="w-4 h-4" />}
            <span>{savedSuccess ? 'Saved to Local Vault!' : 'Save Local Configuration'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
