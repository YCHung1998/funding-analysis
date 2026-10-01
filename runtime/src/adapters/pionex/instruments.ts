/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pionex instrument adapter（design.md Decision 4）。僅掃描用，settle_asset 未經官方查證，
 * 以 quoteCurrency 為準。
 */

import { buildInstrumentKey, resolveMultiplier } from '../../market/instruments/canonical';
import type { InstrumentSnapshotInput, InstrumentStatus, MultiplierOverride } from '../../market/instruments/types';

export interface PionexSymbol {
  symbol: string; // e.g. 'BTC_USDT_PERP'、'USDT_BTC_PERP'
  baseCurrency: string;
  quoteCurrency: string;
  status: string;
  quoteStep: string;
  baseStep: string;
  minSizeLimit: string;
  minNotional: string;
}

export interface PionexIndex {
  symbol: string;
  nextFundingTime: number;
}

const STATUS_MAP: Record<string, InstrumentStatus> = {
  TRADING: 'TRADING',
};

export interface NormalizePionexInstrumentsParams {
  symbols: PionexSymbol[];
  indexes: PionexIndex[];
  now: number;
  overrides?: Record<string, MultiplierOverride>;
  onUnknown?: (field: string, nativeValue: string, nativeSymbol: string) => void;
}

export function normalizePionexInstruments(params: NormalizePionexInstrumentsParams): InstrumentSnapshotInput[] {
  const indexMap = new Map(params.indexes.map((i) => [i.symbol, i.nextFundingTime]));

  return params.symbols.map((sym) => {
    const status = STATUS_MAP[sym.status] ?? 'UNKNOWN';
    if (status === 'UNKNOWN') params.onUnknown?.('status', sym.status, sym.symbol);

    const isInverse = sym.quoteCurrency !== 'USDT';

    const override = params.overrides?.[`Pionex:${sym.symbol}`];
    const multiplier = resolveMultiplier(sym.baseCurrency, override);

    const rawNextFunding = indexMap.get(sym.symbol);
    const nextFundingTime = rawNextFunding && rawNextFunding > 0 ? rawNextFunding : null;

    return {
      instrument_id: `Pionex:${sym.symbol}`,
      exchange: 'Pionex',
      native_symbol: sym.symbol,
      instrument_key: buildInstrumentKey(multiplier.base_asset, sym.quoteCurrency, sym.quoteCurrency),
      base_asset: multiplier.base_asset,
      quote_asset: sym.quoteCurrency,
      settle_asset: sym.quoteCurrency,
      listed_base_asset: sym.baseCurrency,
      price_multiplier: multiplier.price_multiplier,
      qty_unit_in_base: multiplier.qty_unit_in_base,
      multiplier_source: multiplier.multiplier_source,
      contract_type: isInverse ? 'INVERSE_PERPETUAL' : 'LINEAR_PERPETUAL',
      native_contract_type: 'PERP',
      status,
      native_status: sym.status,
      tick_size: Number(sym.quoteStep),
      qty_step: Number(sym.baseStep),
      min_qty: Number(sym.minSizeLimit),
      min_notional: sym.minNotional != null ? Number(sym.minNotional) : null,
      funding: {
        next_funding_time: nextFundingTime,
        funding_interval_hours: null,
        interval_source: 'UNKNOWN',
        schedule_status: nextFundingTime === null ? 'MISSING' : nextFundingTime <= params.now ? 'STALE' : 'VALID',
        exchange_timestamp: nextFundingTime,
        local_received_timestamp: params.now,
        updated_at: params.now,
      },
    };
  });
}
