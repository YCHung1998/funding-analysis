/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * instrument-registry 型別定義。
 *
 * `ExchangeId`、`TradingEvent` 由 `runtime/src/types/`（trading-schema）提供，本檔只 re-export。
 */

import type { ExchangeId } from '../../types/ids';
import type { TradingEvent } from '../../types/event';

export type { ExchangeId, TradingEvent };

export interface EventSink {
  emit(event: TradingEvent): void;
}

export type InstrumentStatus =
  | 'TRADING'
  | 'PRE_TRADING'
  | 'HALTED'
  | 'DELISTING'
  | 'DELISTED'
  | 'UNKNOWN';

export type ContractType =
  | 'LINEAR_PERPETUAL'
  | 'INVERSE_PERPETUAL'
  | 'TRADFI_PERPETUAL'
  | 'DATED_FUTURE'
  | 'UNKNOWN';

export type MultiplierSource = 'METADATA' | 'PREFIX' | 'OVERRIDE' | 'NONE';

export type IntervalSource =
  | 'EXCHANGE_FIELD'
  | 'EXCHANGE_DOC_DEFAULT'
  | 'DERIVED_FROM_TIMES'
  | 'UNKNOWN';

export type ScheduleStatus = 'VALID' | 'STALE' | 'MISSING';

export interface FundingSchedule {
  next_funding_time: number | null;
  funding_interval_hours: number | null;
  interval_source: IntervalSource;
  schedule_status: ScheduleStatus;
  exchange_timestamp: number | null;
  local_received_timestamp: number | null;
  updated_at: number;
}

export interface Instrument {
  instrument_id: string; // `${exchange}:${native_symbol}`
  exchange: ExchangeId;
  native_symbol: string;
  instrument_key: string; // `${base_asset}/${quote_asset}:${settle_asset}`
  base_asset: string;
  quote_asset: string;
  settle_asset: string;
  listed_base_asset: string;
  price_multiplier: number;
  qty_unit_in_base: number;
  multiplier_source: MultiplierSource;
  contract_type: ContractType;
  native_contract_type: string;
  status: InstrumentStatus;
  native_status: string;
  ambiguous: boolean;
  tick_size: number;
  qty_step: number;
  min_qty: number;
  min_notional: number | null;
  funding: FundingSchedule;
  created_at: number;
  updated_at: number;
  status_changed_at: number;
  last_seen_at: number;
}

/**
 * Adapter 正規化輸出：Instrument 扣除由 registry 管理的時間戳與 ambiguous 欄位。
 */
export type InstrumentSnapshotInput = Omit<
  Instrument,
  'created_at' | 'updated_at' | 'status_changed_at' | 'last_seen_at' | 'ambiguous'
>;

export type InstrumentSourceStatusKind = 'OK' | 'FAILED';

export interface InstrumentSourceStatus {
  exchange: ExchangeId;
  status: InstrumentSourceStatusKind;
  error_kind?: string;
  http_status?: number;
  updated_at: number;
}

export type MatchFailureReason =
  | 'SAME_EXCHANGE'
  | 'UNKNOWN_INSTRUMENT'
  | 'AMBIGUOUS_INSTRUMENT'
  | 'KEY_MISMATCH'
  | 'CONTRACT_TYPE_NOT_PAIRABLE'
  | 'NOT_TRADING'
  | 'FUNDING_TIME_MISSING'
  | 'FUNDING_NOT_ALIGNED'
  | 'PRICE_MISMATCH';

export interface PairMatchResult {
  matched: boolean;
  reason?: MatchFailureReason;
  instrument_key?: string;
  long_instrument_id?: string;
  short_instrument_id?: string;
  long_funding_time?: number;
  short_funding_time?: number;
  long_funding_interval_hours?: number | null;
  short_funding_interval_hours?: number | null;
  funding_time_diff_ms?: number;
  funding_aligned?: boolean;
}

export interface FundingScheduleUpdate {
  next_funding_time: number | null;
  funding_interval_hours?: number | null;
  interval_source?: IntervalSource;
  exchange_timestamp: number;
}

export type UpdateFundingScheduleStatus = 'OK' | 'IGNORED_OUT_OF_ORDER' | 'UNKNOWN_INSTRUMENT';

export interface UpdateFundingScheduleResult {
  status: UpdateFundingScheduleStatus;
}

export interface RegistryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface MultiplierOverride {
  base_asset: string;
  price_multiplier: number;
}
