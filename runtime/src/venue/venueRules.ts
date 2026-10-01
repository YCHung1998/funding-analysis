import type { ExchangeId, PairGuard, VenueRule } from './types';

/**
 * Default rule table (design.md §4 "交易所結算規則表"). In production these values come from
 * each exchange's adapter; this table is the shape + initial data until adapters wire it in
 * (funding-settlement-rules spec "Venue settlement rules provided by adapters").
 * Pionex / Bitget are not yet specified upstream — callers MUST check for `undefined`.
 */
export const DEFAULT_VENUE_RULES: Partial<Record<ExchangeId, VenueRule>> = {
  Binance: {
    exchange: 'Binance',
    guardBeforeMs: 15_000,
    guardAfterMs: 15_000,
    settledRateSource: 'GET /fapi/v1/fundingRate',
    fundingIntervalSource: 'GET /fapi/v1/fundingInfo',
  },
  Bybit: {
    exchange: 'Bybit',
    guardBeforeMs: 5_000,
    guardAfterMs: 5_000,
    settledRateSource: 'GET /v5/market/funding/history',
    fundingIntervalSource: 'instruments-info fundingInterval / tickers',
  },
  OKX: {
    exchange: 'OKX',
    guardBeforeMs: 0,
    guardAfterMs: 60_000,
    settledRateSource: 'settFundingRate / funding-rate-history',
    fundingIntervalSource: 'nextFundingTime - fundingTime',
  },
};

/** The wider of the two legs' guard windows (funding-settlement-rules spec "Pair guard uses the wider venue"). */
export function pairGuard(a: VenueRule, b: VenueRule): PairGuard {
  return {
    guardBeforeMs: Math.max(a.guardBeforeMs, b.guardBeforeMs),
    guardAfterMs: Math.max(a.guardAfterMs, b.guardAfterMs),
  };
}

export function requireVenueRule(
  table: Partial<Record<ExchangeId, VenueRule>>,
  exchange: ExchangeId,
): VenueRule {
  const rule = table[exchange];
  if (!rule) throw new Error(`No venue rule configured for exchange "${exchange}"`);
  return rule;
}
