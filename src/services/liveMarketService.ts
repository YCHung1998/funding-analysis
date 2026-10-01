/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Live Market Service (Pionex × Binance × Bybit × Bitget × OKX)
 */

export type ExchangeName = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

export interface LiveMarketCandidate {
  rank: number;
  symbol: string;
  base: string;
  available_exchanges: ExchangeName[];
  // Rates for all 5 exchanges
  pionex_rate: number | null;
  binance_rate: number | null;
  bybit_rate: number | null;
  bitget_rate: number | null;
  okx_rate: number | null;
  // Marks
  pionex_mark: number | null;
  binance_mark: number | null;
  bybit_mark: number | null;
  bitget_mark: number | null;
  okx_mark: number | null;
  // Best arbitrage spread
  spread: number;
  best_pair: {
    long_exchange: ExchangeName;
    short_exchange: ExchangeName;
    pair_label: string;
    spread: number;
  };
  pair_spreads: Record<string, number>;
  next_funding_time: number;
  time_to_settlement_sec: number;
  interval_hours: number;
  volume_24h: number;
  est_slippage_pct: number;
  fee_drag_pct: number;
  expected_net_pnl_pct: number;
  expected_net_pnl_usdt: number;
  meets_threshold: boolean;
  // instrument-registry 新增欄位（向下相容，選用）
  instrument_key?: string;
  long_funding_time?: number;
  short_funding_time?: number;
  long_funding_interval_hours?: number | null;
  short_funding_interval_hours?: number | null;
  funding_aligned?: boolean;
  long_volume_24h?: number;
  short_volume_24h?: number;
  // net-cost-model 新增欄位（向下相容，選用）：best_pair / 排序 / meets_threshold 已改為淨值口徑
  // （`spread` 保留為毛 spread，`expected_net_pnl_pct`/`expected_net_pnl_usdt` 等 @deprecated
  // 欄位語意不變但數值已是淨值）。
  net_spread_pct?: number;
  pair_net_spreads?: Record<string, number>;
  entry_basis_pct?: number;
  slippage_model?: { long: string; short: string };
  fee_config_version?: string;
  // [Integrator review fix] single-leg notional that est_slippage_pct / fee_drag_pct /
  // expected_net_pnl_pct are all consistently denominated by (spec §5 mapping).
  target_notional_per_leg_usdt?: number;
}

export interface LiveScanResponse {
  success: boolean;
  cached: boolean;
  server_time: number;
  fetch_latency_ms: number;
  total_matched_pairs: number;
  threshold_qualified_count: number;
  exchange_counts: {
    Pionex: number;
    Binance: number;
    Bybit: number;
    Bitget: number;
    OKX: number;
  };
  candidates: LiveMarketCandidate[];
  // instrument-registry 新增欄位：每所註冊表來源狀態（選用）
  registry_sources?: Record<string, { status: 'OK' | 'FAILED'; error_kind?: string; http_status?: number }>;
}

export async function fetchLiveMarketScan(): Promise<LiveScanResponse> {
  const res = await fetch('/api/market/live-scan');
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchLiveKlines(symbol: string): Promise<{
  success: boolean;
  symbol: string;
  binance_bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  pionex_bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}> {
  const res = await fetch(`/api/market/live-klines?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch live klines for ${symbol}`);
  }
  return res.json();
}

export async function fetchLiveLatency(): Promise<{
  pings: Record<string, number>;
  server_time: number;
}> {
  const res = await fetch('/api/latency/ping');
  if (!res.ok) {
    throw new Error('Failed to ping exchanges');
  }
  return res.json();
}
