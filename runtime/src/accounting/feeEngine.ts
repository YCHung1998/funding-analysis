/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * cost-model capability: Fee Engine (design.md Decision 2; spec "手續費計算").
 * Data-driven, no exchange-name branching — all differences come from `FeeTierConfig`.
 */

import type { ExchangeId } from '../types/ids';
import { computeFeeConfigVersion, DEFAULT_FEE_TABLE, type FeeTierConfig } from './feeConfig';

export type Liquidity = 'MAKER' | 'TAKER' | 'SIMULATED';

export class FeeTierMissingError extends Error {
  readonly code = 'FEE_TIER_MISSING' as const;
  constructor(exchange: string) {
    super(`FEE_TIER_MISSING: no default-lowest fee tier for ${exchange}`);
    this.name = 'FeeTierMissingError';
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

function lowestTierFor(table: readonly FeeTierConfig[], exchange: ExchangeId): FeeTierConfig {
  const row = table.find((r) => r.exchange === exchange && r.is_default_lowest);
  if (!row) throw new FeeTierMissingError(exchange);
  return row;
}

/**
 * `liquidity` -> `FeeTierConfig` field. `SIMULATED` MUST be treated as `TAKER` (conservative;
 * Paper matching currently always simulates taker fills).
 */
export function feeRate(exchange: ExchangeId, liquidity: Liquidity, table: readonly FeeTierConfig[] = DEFAULT_FEE_TABLE): number {
  const row = lowestTierFor(table, exchange);
  return liquidity === 'MAKER' ? row.maker_fee : row.taker_fee;
}

export interface FeeEstimate {
  fee_usdt: number;
  rate: number;
  fee_config_version: string;
}

/**
 * `fee_usdt = notional_usdt * rate(exchange, tier, liquidity)`. Positive value = cost (spec
 * "手續費計算").
 */
export function estimateFee(
  exchange: ExchangeId,
  notionalUsdt: number,
  liquidity: Liquidity,
  table: readonly FeeTierConfig[] = DEFAULT_FEE_TABLE,
): FeeEstimate {
  assertFiniteNumber(notionalUsdt, 'notionalUsdt');
  const rate = feeRate(exchange, liquidity, table);
  return { fee_usdt: notionalUsdt * rate, rate, fee_config_version: computeFeeConfigVersion(table) };
}

/** Convenience wrapper for a single fill: notional = fillPrice * quantity. */
export function feeForFill(
  exchange: ExchangeId,
  fillPrice: number,
  quantity: number,
  liquidity: Liquidity,
  table: readonly FeeTierConfig[] = DEFAULT_FEE_TABLE,
): FeeEstimate {
  assertFiniteNumber(fillPrice, 'fillPrice');
  assertFiniteNumber(quantity, 'quantity');
  return estimateFee(exchange, fillPrice * quantity, liquidity, table);
}

/** Interface consumed by `paper-execution-engine`'s matching simulator (design.md Decision 2). */
export interface FeeRateSource {
  getTakerFeeRate(exchange: ExchangeId, symbol?: string): number;
  getMakerFeeRate(exchange: ExchangeId, symbol?: string): number;
}

export function createDefaultFeeRateSource(table: readonly FeeTierConfig[] = DEFAULT_FEE_TABLE): FeeRateSource {
  return {
    getTakerFeeRate: (exchange) => feeRate(exchange, 'TAKER', table),
    getMakerFeeRate: (exchange) => feeRate(exchange, 'MAKER', table),
  };
}
