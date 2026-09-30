/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Common Schema for Pionex × Binance Funding Arbitrage Spec v0.1
 * Strategy & Backtest engines interact strictly with this unified schema.
 */

export type ExchangeId = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

export interface FeeTierConfig {
  exchange: ExchangeId;
  tier_name: string; // e.g. "VIP 0 (Regular / Lowest)"
  maker_fee: number; // e.g. 0.0002 (0.02%)
  taker_fee: number; // e.g. 0.0005 (0.05%)
  effective_from?: string;
  effective_to?: string;
  is_default_lowest: boolean;
}

/**
 * 1. Common Schema: Unified representation of a perpetual contract snapshot
 */
export interface CommonFundingRecord {
  exchange: ExchangeId;
  symbol: string;             // Unified format e.g. "BTCUSDT"
  event_time: number;         // Milliseconds epoch timestamp
  funding_time: number;       // Settlement timestamp (T)
  funding_rate: number;       // Rate as a decimal e.g. 0.0025 for +0.25%
  next_funding_time: number;  // Next scheduled settlement (T + 8h or 4h)
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
  fee_rate: number;           // Standard taker fee rate for lowest tier (e.g. 0.0005)
  
  // Traceability metadata
  native_symbol: string;      // e.g. "BTC_USDT" on Pionex, "BTCUSDT" on Binance
  native_field_mapping: Record<string, string>; // Maps CommonField -> Native API Key
}

/**
 * 2 & 3. Settlement Window 1m Kline & Volume Record (±2 min = 5 bars)
 * T-2m, T-1m, T (Funding Settlement), T+1m, T+2m
 */
export type WindowOffset = 'T-2m' | 'T-1m' | 'T' | 'T+1m' | 'T+2m';

export interface SettlementWindowBar {
  exchange: ExchangeId;
  symbol: string;
  funding_time: number;       // The reference T settlement time
  kline_time: number;         // Timestamp of this 1m bar
  offset_label: WindowOffset;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;             // USDT volume within this 1m window
  
  // Derived analytical metrics for volatility & slippage evaluation
  price_change: number;       // close - open
  high_low_range: number;     // high - low
  return_pct: number;         // (close - open) / open * 100
  volatility: number;         // (high - low) / open * 100
  volume_shock_ratio?: number;// volume / avg(T-2, T-1) volume
}

/**
 * Combined settlement window data for a single funding event across both exchanges
 */
export interface SettlementEventWindow {
  id: string;
  symbol: string;
  funding_time: number;
  funding_time_str: string;
  pionex_rate: number;
  binance_rate: number;
  spread: number;             // abs(pionex_rate - binance_rate)
  higher_exchange: ExchangeId;
  pionex_bars: SettlementWindowBar[];
  binance_bars: SettlementWindowBar[];
  avg_volatility_pct: number;
  volume_spike_ratio: number;
  estimated_slippage_pct: number;
}

/**
 * 5, 6, 7. Standard Execution Experiment (T-30s -> T -> T+30s)
 */
export interface ExecutionExperimentConfig {
  notional_usdt: number;      // Fixed 1000 USDT per side
  entry_offset_sec: number;   // -30 (T - 30s)
  exit_offset_sec: number;    // +30 (T + 30s)
  fee_tier: 'lowest_vip0';
  pionex_taker_fee: number;   // 0.0005 (0.05%)
  binance_taker_fee: number;  // 0.0005 (0.05%)
  research_threshold_spread: number; // 0.0020 (0.20%)
  custom_entry_slippage?: number;
  custom_exit_slippage?: number;
}

export interface TradeLegResult {
  exchange: ExchangeId;
  side: 'LONG' | 'SHORT';
  notional: number;
  entry_price: number;
  exit_price: number;
  price_pnl: number;
  funding_rate: number;
  funding_pnl: number;
  entry_fee: number;
  exit_fee: number;
  entry_slippage: number;
  exit_slippage: number;
  total_cost: number;
  net_pnl: number;
}

export interface ArbitrageTradeResult {
  id: string;
  symbol: string;
  funding_time: number;
  funding_time_str: string;
  spread: number;             // Funding rate difference
  meets_research_threshold: boolean; // spread >= 0.20%
  pionex_rate: number;
  binance_rate: number;
  pionex_leg: TradeLegResult;
  binance_leg: TradeLegResult;
  
  // Aggregate Metrics (Matching Spec Section 7 & 8)
  funding_pnl: number;        // Gross funding collected - funding paid
  price_pnl: number;          // Combined price drift PnL
  gross_pnl: number;          // funding_pnl + price_pnl
  total_entry_fee: number;    // Pionex entry + Binance entry
  total_exit_fee: number;     // Pionex exit + Binance exit
  total_fee: number;          // All 4 taker fees combined (deterministic cost)
  total_entry_slippage: number;
  total_exit_slippage: number;
  total_slippage: number;
  net_pnl: number;            // Realized Net PnL = Gross - Fees - Slippage
  roi_on_notional_pct: number;// Net PnL / (2 * notional) * 100
  
  // Market Behavior around event
  volume_shock_ratio: number;
  max_high_low_spread_pct: number;
}
