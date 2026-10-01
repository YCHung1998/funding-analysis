/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * OKX SWAP instrument adapter（design.md Decision 4）。僅掃描用；OKX 未來加入交易時沿用。
 */

import { buildInstrumentKey } from '../../market/instruments/canonical';
import type { ContractType, InstrumentSnapshotInput, InstrumentStatus, MultiplierOverride } from '../../market/instruments/types';

export interface OkxInstrument {
  instId: string; // e.g. 'BTC-USDT-SWAP'
  ctType: string; // 'linear' | 'inverse'
  ctValCcy: string;
  ctVal: string;
  ctMult: string;
  settleCcy: string;
  state: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
}

export interface OkxFundingRate {
  instId: string;
  fundingTime: string;
  nextFundingTime: string;
}

const STATUS_MAP: Record<string, InstrumentStatus> = {
  live: 'TRADING',
};

const CT_TYPE_MAP: Record<string, ContractType> = {
  linear: 'LINEAR_PERPETUAL',
  inverse: 'INVERSE_PERPETUAL',
};

export interface NormalizeOkxInstrumentsParams {
  instruments: OkxInstrument[];
  fundingRates: OkxFundingRate[];
  now: number;
  overrides?: Record<string, MultiplierOverride>;
  onUnknown?: (field: string, nativeValue: string, nativeSymbol: string) => void;
}

export function normalizeOkxInstruments(params: NormalizeOkxInstrumentsParams): InstrumentSnapshotInput[] {
  const fundingMap = new Map(params.fundingRates.map((f) => [f.instId, f]));

  return params.instruments.map((inst) => {
    const [base, quote] = inst.instId.split('-');

    const status = STATUS_MAP[inst.state] ?? 'UNKNOWN';
    if (status === 'UNKNOWN') params.onUnknown?.('state', inst.state, inst.instId);

    const contractType = CT_TYPE_MAP[inst.ctType] ?? 'UNKNOWN';
    if (contractType === 'UNKNOWN') params.onUnknown?.('ctType', inst.ctType, inst.instId);

    const override = params.overrides?.[`OKX:${inst.instId}`];
    const baseAsset = override?.base_asset ?? base;
    const priceMultiplier = override?.price_multiplier ?? 1;
    const qtyUnitInBase = Number(inst.ctVal) * Number(inst.ctMult);

    const funding = fundingMap.get(inst.instId);
    const nextFundingTime = funding ? Number(funding.fundingTime) : null;
    const intervalHours =
      funding && Number(funding.nextFundingTime) > Number(funding.fundingTime)
        ? (Number(funding.nextFundingTime) - Number(funding.fundingTime)) / 3_600_000
        : null;

    return {
      instrument_id: `OKX:${inst.instId}`,
      exchange: 'OKX',
      native_symbol: inst.instId,
      instrument_key: buildInstrumentKey(baseAsset, quote, inst.settleCcy),
      base_asset: baseAsset,
      quote_asset: quote,
      settle_asset: inst.settleCcy,
      listed_base_asset: base,
      price_multiplier: priceMultiplier,
      qty_unit_in_base: qtyUnitInBase,
      multiplier_source: override ? 'OVERRIDE' : 'METADATA',
      contract_type: contractType,
      native_contract_type: inst.ctType,
      status,
      native_status: inst.state,
      tick_size: Number(inst.tickSz),
      qty_step: Number(inst.lotSz),
      min_qty: Number(inst.minSz),
      min_notional: null,
      funding: {
        next_funding_time: nextFundingTime,
        funding_interval_hours: intervalHours,
        interval_source: intervalHours !== null ? 'DERIVED_FROM_TIMES' : 'UNKNOWN',
        schedule_status: nextFundingTime === null ? 'MISSING' : nextFundingTime <= params.now ? 'STALE' : 'VALID',
        exchange_timestamp: nextFundingTime,
        local_received_timestamp: params.now,
        updated_at: params.now,
      },
    };
  });
}
