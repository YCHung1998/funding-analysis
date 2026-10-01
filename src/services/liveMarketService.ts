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
  // websocket-data-layer 新增欄位（選用，向下相容）：每所行情來源狀態與最近成功更新時間
  // （market-data-snapshot spec「Research live-scan served from in-memory market state」）。
  sources?: Record<
    ExchangeName,
    {
      state: 'INITIALIZING' | 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'RATE_LIMITED';
      last_success_at: number | null;
      data_age_ms: number | null;
      instrument_count: number;
      consecutive_failures: number;
    } | undefined
  >;
  data_as_of?: Record<ExchangeName, number | null>;
  cache_age_ms?: number;
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
