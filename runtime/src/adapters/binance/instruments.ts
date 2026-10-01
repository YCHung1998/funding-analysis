/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Binance USD-M Futures instrument adapter（design.md Decision 4）。
 * 交易所差異（端點、欄位對應、狀態對照、週期來源）只存在於此檔。
 */

import { buildInstrumentKey, resolveMultiplier } from '../../market/instruments/canonical';
import type {
  ContractType,
  InstrumentSnapshotInput,
  InstrumentStatus,
  IntervalSource,
  MultiplierOverride,
} from '../../market/instruments/types';

export interface BinanceExchangeInfoFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  notional?: string;
}

export interface BinanceExchangeInfoSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
  filters: BinanceExchangeInfoFilter[];
}

export interface BinanceExchangeInfoResponse {
  symbols: BinanceExchangeInfoSymbol[];
}

export interface BinanceFundingInfoItem {
  symbol: string;
  fundingIntervalHours: number;
}

export interface BinancePremiumIndexItem {
  symbol: string;
  nextFundingTime: number;
}

const STATUS_MAP: Record<string, InstrumentStatus> = {
  TRADING: 'TRADING',
  PENDING_TRADING: 'PRE_TRADING',
  SETTLING: 'DELISTING',
};

const CONTRACT_TYPE_MAP: Record<string, ContractType> = {
  PERPETUAL: 'LINEAR_PERPETUAL',
  TRADIFI_PERPETUAL: 'TRADFI_PERPETUAL',
  CURRENT_QUARTER: 'DATED_FUTURE',
  NEXT_QUARTER: 'DATED_FUTURE',
  CURRENT_QUARTER_DELIVERING: 'DATED_FUTURE',
};

export interface NormalizeBinanceInstrumentsParams {
  exchangeInfo: BinanceExchangeInfoResponse;
  fundingInfo: BinanceFundingInfoItem[];
  premiumIndex: BinancePremiumIndexItem[];
  now: number;
  overrides?: Record<string, MultiplierOverride>;
  onUnknown?: (field: string, nativeValue: string, nativeSymbol: string) => void;
}

export function normalizeBinanceInstruments(params: NormalizeBinanceInstrumentsParams): InstrumentSnapshotInput[] {
  const fundingIntervalMap = new Map(params.fundingInfo.map((f) => [f.symbol, f.fundingIntervalHours]));
  const premiumMap = new Map(params.premiumIndex.map((p) => [p.symbol, p.nextFundingTime]));

  return params.exchangeInfo.symbols.map((sym) => {
    const status = STATUS_MAP[sym.status] ?? 'UNKNOWN';
    if (status === 'UNKNOWN') params.onUnknown?.('status', sym.status, sym.symbol);

    const contractType = CONTRACT_TYPE_MAP[sym.contractType] ?? 'UNKNOWN';
    if (contractType === 'UNKNOWN') params.onUnknown?.('contractType', sym.contractType, sym.symbol);

    const override = params.overrides?.[`Binance:${sym.symbol}`];
    const multiplier = resolveMultiplier(sym.baseAsset, override);

    const tickFilter = sym.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const lotFilter = sym.filters.find((f) => f.filterType === 'LOT_SIZE');
    const notionalFilter = sym.filters.find((f) => f.filterType === 'MIN_NOTIONAL');

    const listedInterval = fundingIntervalMap.get(sym.symbol);
    const fundingIntervalHours = listedInterval ?? 8;
    const intervalSource: IntervalSource = listedInterval !== undefined ? 'EXCHANGE_FIELD' : 'EXCHANGE_DOC_DEFAULT';

    const rawNextFunding = premiumMap.get(sym.symbol);
    const nextFundingTime = rawNextFunding && rawNextFunding > 0 ? rawNextFunding : null;

    return {
      instrument_id: `Binance:${sym.symbol}`,
      exchange: 'Binance',
      native_symbol: sym.symbol,
      instrument_key: buildInstrumentKey(multiplier.base_asset, sym.quoteAsset, sym.quoteAsset),
      base_asset: multiplier.base_asset,
      quote_asset: sym.quoteAsset,
      settle_asset: sym.quoteAsset,
      listed_base_asset: sym.baseAsset,
      price_multiplier: multiplier.price_multiplier,
      qty_unit_in_base: multiplier.qty_unit_in_base,
      multiplier_source: multiplier.multiplier_source,
      contract_type: contractType,
      native_contract_type: sym.contractType,
      status,
      native_status: sym.status,
      tick_size: Number(tickFilter?.tickSize ?? '0'),
      qty_step: Number(lotFilter?.stepSize ?? '0'),
      min_qty: Number(lotFilter?.minQty ?? '0'),
      min_notional: notionalFilter?.notional != null ? Number(notionalFilter.notional) : null,
      funding: {
        next_funding_time: nextFundingTime,
        funding_interval_hours: fundingIntervalHours,
        interval_source: intervalSource,
        schedule_status: nextFundingTime === null ? 'MISSING' : nextFundingTime <= params.now ? 'STALE' : 'VALID',
        exchange_timestamp: nextFundingTime,
        local_received_timestamp: params.now,
        updated_at: params.now,
      },
    };
  });
}
