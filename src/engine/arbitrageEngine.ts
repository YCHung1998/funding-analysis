/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Arbitrage & Research Engine for Spec v0.1
 * Core mathematical execution model for Pionex × Binance Funding Arbitrage
 */

import {
  CommonFundingRecord,
  SettlementWindowBar,
  SettlementEventWindow,
  ArbitrageTradeResult,
  TradeLegResult,
  ExecutionExperimentConfig,
} from '../types/schema';

export const DEFAULT_CONFIG: ExecutionExperimentConfig = {
  notional_usdt: 1000,
  entry_offset_sec: -30,
  exit_offset_sec: 30,
  fee_tier: 'lowest_vip0',
  pionex_taker_fee: 0.0005, // 0.05%
  binance_taker_fee: 0.0005, // 0.05%
  research_threshold_spread: 0.0020, // 0.20%
};

/**
 * Derives analytical metrics from a 1m Kline bar
 */
export function enrichKlineBar(bar: Omit<SettlementWindowBar, 'price_change' | 'high_low_range' | 'return_pct' | 'volatility'>, baselineVol?: number): SettlementWindowBar {
  const price_change = bar.close - bar.open;
  const high_low_range = bar.high - bar.low;
  const return_pct = bar.open > 0 ? (price_change / bar.open) * 100 : 0;
  const volatility = bar.open > 0 ? (high_low_range / bar.open) * 100 : 0;
  const volume_shock_ratio = baselineVol && baselineVol > 0 ? bar.volume / baselineVol : 1.0;

  return {
    ...bar,
    price_change,
    high_low_range,
    return_pct,
    volatility,
    volume_shock_ratio,
  };
}

/**
 * Calculates estimated execution slippage based on volume shock, volatility, and bid-ask spread
 */
export function estimateSlippageRate(
  volatilityPct: number,
  volumeShockRatio: number,
  bidPrice: number,
  askPrice: number,
  midPrice: number
): number {
  const baseSpreadPct = midPrice > 0 ? ((askPrice - bidPrice) / midPrice) * 100 : 0.01;
  // Conservative quantitative model:
  // Base half-spread + volatility expansion + shock multiplier
  const dynamicSlip = (baseSpreadPct * 0.5) + (volatilityPct * 0.12 * Math.min(Math.max(volumeShockRatio * 0.5, 0.8), 2.5));
  // Convert from percentage to decimal (e.g. 0.02% -> 0.0002)
  return Math.max(dynamicSlip / 100, 0.0001); // Minimum 1 bp
}

/**
 * Simulates the Standard Execution Experiment:
 * Entry at T - 30s (1000 USDT notional each side)
 * Funding event settlement at T
 * Exit at T + 30s (close both sides)
 */
export function simulateExecutionExperiment(
  pionex: CommonFundingRecord,
  binance: CommonFundingRecord,
  pionexBars: SettlementWindowBar[],
  binanceBars: SettlementWindowBar[],
  config: ExecutionExperimentConfig = DEFAULT_CONFIG
): ArbitrageTradeResult {
  const notional = config.notional_usdt;
  const spread = Math.abs(pionex.funding_rate - binance.funding_rate);
  const meetsThreshold = spread >= config.research_threshold_spread;

  // Direction rule:
  // If Pionex Funding > Binance Funding: Pionex SHORT, Binance LONG
  // If Binance Funding > Pionex Funding: Binance SHORT, Pionex LONG
  const pionexShort = pionex.funding_rate >= binance.funding_rate;
  const pionexSide = pionexShort ? 'SHORT' : 'LONG';
  const binanceSide = pionexShort ? 'LONG' : 'SHORT';

  // Find T bar for volatility metrics
  const pionexTBar = pionexBars.find(b => b.offset_label === 'T') || pionexBars[2];
  const binanceTBar = binanceBars.find(b => b.offset_label === 'T') || binanceBars[2];

  const pionexBaselineVol = (pionexBars[0]?.volume + pionexBars[1]?.volume) / 2 || pionexTBar?.volume;
  const binanceBaselineVol = (binanceBars[0]?.volume + binanceBars[1]?.volume) / 2 || binanceTBar?.volume;

  const pionexShock = pionexTBar ? pionexTBar.volume / (pionexBaselineVol || 1) : 1.5;
  const binanceShock = binanceTBar ? binanceTBar.volume / (binanceBaselineVol || 1) : 1.5;
  const avgShock = (pionexShock + binanceShock) / 2;

  // Calculate slippages
  const pionexSlipRate = config.custom_entry_slippage ?? estimateSlippageRate(
    pionexTBar?.volatility || 0.1,
    pionexShock,
    pionex.bid_price,
    pionex.ask_price,
    pionex.mark_price
  );

  const binanceSlipRate = config.custom_entry_slippage ?? estimateSlippageRate(
    binanceTBar?.volatility || 0.08,
    binanceShock,
    binance.bid_price,
    binance.ask_price,
    binance.mark_price
  );

  // Prices:
  // Entry at T-30s
  // For SHORT: sells at bid or mark - slippage
  // For LONG: buys at ask or mark + slippage
  const pionexEntryPrice = pionexSide === 'SHORT'
    ? pionex.mark_price * (1 - pionexSlipRate)
    : pionex.mark_price * (1 + pionexSlipRate);

  const binanceEntryPrice = binanceSide === 'LONG'
    ? binance.mark_price * (1 + binanceSlipRate)
    : binance.mark_price * (1 - binanceSlipRate);

  // 60-second price drift during the window:
  // T+30s price movement modeled from T bar / T+1m bar progression
  const pionexTPriceChangePct = (pionexTBar?.return_pct || 0) * 0.5; // ~30s drift fraction
  const binanceTPriceChangePct = (binanceTBar?.return_pct || 0) * 0.5;

  const pionexExitMark = pionex.mark_price * (1 + pionexTPriceChangePct / 100);
  const binanceExitMark = binance.mark_price * (1 + binanceTPriceChangePct / 100);

  // Exit at T+30s:
  // Closing SHORT = Buy back at ask + exit slippage
  // Closing LONG = Sell at bid - exit slippage
  const pionexExitPrice = pionexSide === 'SHORT'
    ? pionexExitMark * (1 + pionexSlipRate)
    : pionexExitMark * (1 - pionexSlipRate);

  const binanceExitPrice = binanceSide === 'LONG'
    ? binanceExitMark * (1 - binanceSlipRate)
    : binanceExitMark * (1 + binanceSlipRate);

  // Price PnL:
  // SHORT PnL = (EntryPrice - ExitPrice) / EntryPrice * Notional
  // LONG PnL  = (ExitPrice - EntryPrice) / EntryPrice * Notional
  const pionexPricePnL = pionexSide === 'SHORT'
    ? ((pionexEntryPrice - pionexExitPrice) / pionexEntryPrice) * notional
    : ((pionexExitPrice - pionexEntryPrice) / pionexEntryPrice) * notional;

  const binancePricePnL = binanceSide === 'LONG'
    ? ((binanceExitPrice - binanceEntryPrice) / binanceEntryPrice) * notional
    : ((binanceEntryPrice - binanceExitPrice) / binanceEntryPrice) * notional;

  const totalPricePnL = pionexPricePnL + binancePricePnL;

  // Funding PnL at T:
  // SHORT position collects positive funding (pays negative)
  // LONG position pays positive funding (collects negative)
  // Funding PnL = Notional * (Rate if SHORT ? +rate : -rate)
  const pionexFundingPnL = pionexSide === 'SHORT'
    ? notional * pionex.funding_rate
    : -notional * pionex.funding_rate;

  const binanceFundingPnL = binanceSide === 'SHORT'
    ? notional * binance.funding_rate
    : -notional * binance.funding_rate;

  const totalFundingPnL = pionexFundingPnL + binanceFundingPnL;

  // Fees: 4 Taker trades of 1000 USDT notional
  const pionexEntryFee = notional * config.pionex_taker_fee;
  const pionexExitFee = notional * config.pionex_taker_fee;
  const binanceEntryFee = notional * config.binance_taker_fee;
  const binanceExitFee = notional * config.binance_taker_fee;

  const totalEntryFee = pionexEntryFee + binanceEntryFee;
  const totalExitFee = pionexExitFee + binanceExitFee;
  const totalFee = totalEntryFee + totalExitFee; // Deterministic 2.00 USDT per 1000U

  // Slippages:
  const pionexEntrySlip = notional * pionexSlipRate;
  const pionexExitSlip = notional * pionexSlipRate;
  const binanceEntrySlip = notional * binanceSlipRate;
  const binanceExitSlip = notional * binanceSlipRate;

  const totalEntrySlippage = pionexEntrySlip + binanceEntrySlip;
  const totalExitSlippage = pionexExitSlip + binanceExitSlip;
  const totalSlippage = totalEntrySlippage + totalExitSlippage;

  // Gross PnL = Price PnL + Funding PnL
  const grossPnL = totalPricePnL + totalFundingPnL;

  // Realized Net PnL = Gross PnL - Fees - Slippage
  const netPnL = grossPnL - totalFee - totalSlippage;
  const roiPct = (netPnL / (2 * notional)) * 100;

  const pionexLeg: TradeLegResult = {
    exchange: 'Pionex',
    side: pionexSide,
    notional,
    entry_price: pionexEntryPrice,
    exit_price: pionexExitPrice,
    price_pnl: pionexPricePnL,
    funding_rate: pionex.funding_rate,
    funding_pnl: pionexFundingPnL,
    entry_fee: pionexEntryFee,
    exit_fee: pionexExitFee,
    entry_slippage: pionexEntrySlip,
    exit_slippage: pionexExitSlip,
    total_cost: pionexEntryFee + pionexExitFee + pionexEntrySlip + pionexExitSlip,
    net_pnl: pionexPricePnL + pionexFundingPnL - (pionexEntryFee + pionexExitFee + pionexEntrySlip + pionexExitSlip),
  };

  const binanceLeg: TradeLegResult = {
    exchange: 'Binance',
    side: binanceSide,
    notional,
    entry_price: binanceEntryPrice,
    exit_price: binanceExitPrice,
    price_pnl: binancePricePnL,
    funding_rate: binance.funding_rate,
    funding_pnl: binanceFundingPnL,
    entry_fee: binanceEntryFee,
    exit_fee: binanceExitFee,
    entry_slippage: binanceEntrySlip,
    exit_slippage: binanceExitSlip,
    total_cost: binanceEntryFee + binanceExitFee + binanceEntrySlip + binanceExitSlip,
    net_pnl: binancePricePnL + binanceFundingPnL - (binanceEntryFee + binanceExitFee + binanceEntrySlip + binanceExitSlip),
  };

  const maxRangePct = Math.max(
    pionexTBar?.volatility || 0,
    binanceTBar?.volatility || 0
  );

  const fundingDateStr = new Date(pionex.funding_time).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return {
    id: `${pionex.symbol}-${pionex.funding_time}`,
    symbol: pionex.symbol,
    funding_time: pionex.funding_time,
    funding_time_str: fundingDateStr,
    spread,
    meets_research_threshold: meetsThreshold,
    pionex_rate: pionex.funding_rate,
    binance_rate: binance.funding_rate,
    pionex_leg: pionexLeg,
    binance_leg: binanceLeg,
    funding_pnl: totalFundingPnL,
    price_pnl: totalPricePnL,
    gross_pnl: grossPnL,
    total_entry_fee: totalEntryFee,
    total_exit_fee: totalExitFee,
    total_fee: totalFee,
    total_entry_slippage: totalEntrySlippage,
    total_exit_slippage: totalExitSlippage,
    total_slippage: totalSlippage,
    net_pnl: netPnL,
    roi_on_notional_pct: roiPct,
    volume_shock_ratio: avgShock,
    max_high_low_spread_pct: maxRangePct,
  };
}
