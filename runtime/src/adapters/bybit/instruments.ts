/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bybit linear perpetual instrument adapter（design.md Decision 4）。
 */

import { buildInstrumentKey, resolveMultiplier } from '../../market/instruments/canonical';
import type {
  ContractType,
  InstrumentSnapshotInput,
  InstrumentStatus,
  MultiplierOverride,
} from '../../market/instruments/types';

export interface BybitInstrumentInfo {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  contractType: string;
  status: string;
  symbolType?: string;
  fundingInterval: number; // 分鐘
  priceFilter: { tickSize: string };
  lotSizeFilter: { qtyStep: string; minOrderQty: string; minNotionalValue?: string };
}

export interface BybitTicker {
  symbol: string;
  nextFundingTime: string;
}

const STATUS_MAP: Record<string, InstrumentStatus> = {
  Trading: 'TRADING',
  PreLaunch: 'PRE_TRADING',
  PendingOpen: 'PRE_TRADING',
  Delivering: 'DELISTING',
};

export interface NormalizeBybitInstrumentsParams {
  instrumentsInfo: BybitInstrumentInfo[];
  tickers: BybitTicker[];
  now: number;
  overrides?: Record<string, MultiplierOverride>;
  onUnknown?: (field: string, nativeValue: string, nativeSymbol: string) => void;
}

export function normalizeBybitInstruments(params: NormalizeBybitInstrumentsParams): InstrumentSnapshotInput[] {
  const fundingTimeMap = new Map(params.tickers.map((t) => [t.symbol, Number(t.nextFundingTime)]));

  return params.instrumentsInfo.map((sym) => {
    const status = STATUS_MAP[sym.status] ?? 'UNKNOWN';
    if (status === 'UNKNOWN') params.onUnknown?.('status', sym.status, sym.symbol);

    const contractType: ContractType = sym.symbolType === 'stock' ? 'TRADFI_PERPETUAL' : 'LINEAR_PERPETUAL';

    const override = params.overrides?.[`Bybit:${sym.symbol}`];
    const multiplier = resolveMultiplier(sym.baseCoin, override);

    const fundingIntervalHours = sym.fundingInterval / 60;
    const rawNextFunding = fundingTimeMap.get(sym.symbol);
    const nextFundingTime = rawNextFunding && rawNextFunding > 0 ? rawNextFunding : null;

    return {
      instrument_id: `Bybit:${sym.symbol}`,
      exchange: 'Bybit',
      native_symbol: sym.symbol,
      instrument_key: buildInstrumentKey(multiplier.base_asset, sym.quoteCoin, sym.settleCoin),
      base_asset: multiplier.base_asset,
      quote_asset: sym.quoteCoin,
      settle_asset: sym.settleCoin,
      listed_base_asset: sym.baseCoin,
      price_multiplier: multiplier.price_multiplier,
      qty_unit_in_base: multiplier.qty_unit_in_base,
      multiplier_source: multiplier.multiplier_source,
      contract_type: contractType,
      native_contract_type: sym.contractType,
      status,
      native_status: sym.status,
      tick_size: Number(sym.priceFilter.tickSize),
      qty_step: Number(sym.lotSizeFilter.qtyStep),
      min_qty: Number(sym.lotSizeFilter.minOrderQty),
      min_notional: sym.lotSizeFilter.minNotionalValue != null ? Number(sym.lotSizeFilter.minNotionalValue) : null,
      funding: {
        next_funding_time: nextFundingTime,
        funding_interval_hours: fundingIntervalHours,
        interval_source: 'EXCHANGE_FIELD',
        schedule_status: nextFundingTime === null ? 'MISSING' : nextFundingTime <= params.now ? 'STALE' : 'VALID',
        exchange_timestamp: nextFundingTime,
        local_received_timestamp: params.now,
        updated_at: params.now,
      },
    };
  });
}
