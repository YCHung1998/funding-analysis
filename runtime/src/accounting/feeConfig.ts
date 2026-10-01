/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * cost-model capability: Fee tier configuration — the single place `FeeTierConfig` is
 * declared (design.md Decision 1 / 2; proposal "手續費設定化"). `src/types/schema.ts`
 * re-exports from here (old -> new direction, §2.1 rule 3).
 *
 * Pure data + validation only: no Node API, no I/O, no clock.
 */

import type { ExchangeId } from '../types/ids';

export type FeeRateSourceKind = 'DEFAULT_ESTIMATE' | 'CONFIG' | 'ACCOUNT_API';

export interface FeeTierConfig {
  exchange: ExchangeId;
  tier_name: string;
  /** Decimal, e.g. 0.0002 for 0.02% (Invariant #5: rates are decimals, never percent-as-float). */
  maker_fee: number;
  /** Decimal, e.g. 0.0005 for 0.05%. */
  taker_fee: number;
  source: FeeRateSourceKind;
  effective_from?: string;
  effective_to?: string;
  is_default_lowest: boolean;
}

export type FeeConfigErrorCode = 'FEE_RATE_OUT_OF_RANGE';

export class FeeConfigError extends Error {
  readonly code: FeeConfigErrorCode;
  constructor(code: FeeConfigErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'FeeConfigError';
  }
}

/** Validation range (spec "手續費費率為設定值"): allows maker rebates, rejects percent-as-decimal typos. */
export const FEE_RATE_MIN = -0.001;
export const FEE_RATE_MAX = 0.01;

/**
 * 待定：VIP0 費率來自第三方頁面彙整，非交易所官方費率頁逐一驗證（design.md Open Question 1）。
 * 之後以唯讀帳戶端點（例如 Binance GET /fapi/v1/commissionRate）覆寫，標示 source = 'ACCOUNT_API'。
 */
export const DEFAULT_FEE_TABLE: readonly FeeTierConfig[] = [
  { exchange: 'Binance', tier_name: 'VIP0', maker_fee: 0.0002, taker_fee: 0.0005, source: 'DEFAULT_ESTIMATE', is_default_lowest: true },
  { exchange: 'Bybit', tier_name: 'VIP0', maker_fee: 0.0002, taker_fee: 0.00055, source: 'DEFAULT_ESTIMATE', is_default_lowest: true },
  { exchange: 'Bitget', tier_name: 'VIP0', maker_fee: 0.0002, taker_fee: 0.0006, source: 'DEFAULT_ESTIMATE', is_default_lowest: true },
  { exchange: 'OKX', tier_name: 'VIP0', maker_fee: 0.0002, taker_fee: 0.0005, source: 'DEFAULT_ESTIMATE', is_default_lowest: true },
  { exchange: 'Pionex', tier_name: 'VIP0', maker_fee: 0.0002, taker_fee: 0.0005, source: 'DEFAULT_ESTIMATE', is_default_lowest: true },
];

/**
 * Validates every row's maker_fee / taker_fee is within [FEE_RATE_MIN, FEE_RATE_MAX] and finite.
 * Throws `FeeConfigError('FEE_RATE_OUT_OF_RANGE')` naming the offending `exchange.field` on the
 * first violation (spec Scenario "百分比誤填被拒絕").
 */
export function validateFeeTable(table: readonly FeeTierConfig[]): void {
  for (const row of table) {
    for (const field of ['maker_fee', 'taker_fee'] as const) {
      const value = row[field];
      if (!Number.isFinite(value) || value < FEE_RATE_MIN || value > FEE_RATE_MAX) {
        throw new FeeConfigError(
          'FEE_RATE_OUT_OF_RANGE',
          `${row.exchange}.${field} = ${value} is out of range [${FEE_RATE_MIN}, ${FEE_RATE_MAX}] (tier ${row.tier_name})`,
        );
      }
    }
  }
}

/** Deterministic stable string hash (FNV-1a), no crypto import (I/O-free requirement). */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * `fee_config_version` = stable hash of the fee table's content (order-independent). Any change
 * to the table produces a new version (spec Scenario "VIP 覆寫不需改程式").
 */
export function computeFeeConfigVersion(table: readonly FeeTierConfig[]): string {
  const sorted = [...table].sort((a, b) => a.exchange.localeCompare(b.exchange) || a.tier_name.localeCompare(b.tier_name));
  const canonical = sorted.map((row) => [row.exchange, row.tier_name, row.maker_fee, row.taker_fee, row.source, row.is_default_lowest]);
  return `v${stableHash(JSON.stringify(canonical))}`;
}

// Fail fast if the shipped default table is ever edited into an invalid state.
validateFeeTable(DEFAULT_FEE_TABLE);
