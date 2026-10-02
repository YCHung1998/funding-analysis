/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bitget USDT-FUTURES instrument adapter（design.md Decision 4）。僅掃描用。
 */

import { buildInstrumentKey, resolveMultiplier } from '../../market/instruments/canonical';
import type { InstrumentSnapshotInput, InstrumentStatus, MultiplierOverride } from '../../market/instruments/types';

export interface BitgetContract {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  symbolType: string;
  symbolStatus: string;
  priceEndStep: string;
  pricePlace: string;
  sizeMultiplier: string;
  minTradeNum: string;
  minTradeUSDT: string;
  fundInterval: string;
}

export interface BitgetFundingRateSchedule {
  symbol: string;
  nextUpdate: string;
  fundingRateInterval: string;
}

const STATUS_MAP: Record<string, InstrumentStatus> = {
  normal: 'TRADING',
};

export interface NormalizeBitgetInstrumentsParams {
  contracts: BitgetContract[];
  fundingRateSchedule: BitgetFundingRateSchedule[];
  now: number;
  overrides?: Record<string, MultiplierOverride>;
  onUnknown?: (field: string, nativeValue: string, nativeSymbol: string) => void;
}

export function normalizeBitgetInstruments(params: NormalizeBitgetInstrumentsParams): InstrumentSnapshotInput[] {
  const fundingMap = new Map(params.fundingRateSchedule.map((f) => [f.symbol, f]));

  return params.contracts.map((c) => {
    const status = STATUS_MAP[c.symbolStatus] ?? 'UNKNOWN';
    if (status === 'UNKNOWN') params.onUnknown?.('symbolStatus', c.symbolStatus, c.symbol);

    const override = params.overrides?.[`Bitget:${c.symbol}`];
    const multiplier = resolveMultiplier(c.baseCoin, override);

    const tickSize = Number(c.priceEndStep) * 10 ** -Number(c.pricePlace);
    const funding = fundingMap.get(c.symbol);
    const nextFundingTime = funding ? Number(funding.nextUpdate) : null;
    const fundingIntervalHours = funding ? Number(funding.fundingRateInterval) : null;

    return {
      instrument_id: `Bitget:${c.symbol}`,
      exchange: 'Bitget',
      native_symbol: c.symbol,
      instrument_key: buildInstrumentKey(multiplier.base_asset, c.quoteCoin, c.quoteCoin),
      base_asset: multiplier.base_asset,
      quote_asset: c.quoteCoin,
      settle_asset: c.quoteCoin,
      listed_base_asset: c.baseCoin,
      price_multiplier: multiplier.price_multiplier,
      qty_unit_in_base: multiplier.qty_unit_in_base,
      multiplier_source: multiplier.multiplier_source,
      contract_type: 'LINEAR_PERPETUAL',
      native_contract_type: c.symbolType,
      status,
      native_status: c.symbolStatus,
      tick_size: tickSize,
      qty_step: Number(c.sizeMultiplier),
      min_qty: Number(c.minTradeNum),
      min_notional: c.minTradeUSDT != null ? Number(c.minTradeUSDT) : null,
      funding: {
        next_funding_time: nextFundingTime,
        funding_interval_hours: fundingIntervalHours,
        interval_source: fundingIntervalHours !== null ? 'EXCHANGE_FIELD' : 'UNKNOWN',
        schedule_status: nextFundingTime === null ? 'MISSING' : nextFundingTime <= params.now ? 'STALE' : 'VALID',
        exchange_timestamp: nextFundingTime,
        local_received_timestamp: params.now,
        updated_at: params.now,
      },
    };
  });
}
