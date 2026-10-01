/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * instrument_key 與倍數解析（design.md Decision 3）。
 * 倍數優先序：OVERRIDE → METADATA（由各 adapter 自行決定，不經此檔） → PREFIX → NONE。
 */

import type { MultiplierOverride, MultiplierSource } from './types';

export interface MultiplierResolution {
  base_asset: string;
  price_multiplier: number;
  qty_unit_in_base: number;
  multiplier_source: MultiplierSource;
}

// 前綴白名單：緊接字母才視為倍數前綴，避免 1INCH 誤判（spec Scenario）。
const PREFIX_PATTERN = /^(1000000|100000|10000|1000|1M)([A-Z][A-Z0-9]*)$/;

export function resolveMultiplier(
  listedBaseAsset: string,
  override?: MultiplierOverride,
): MultiplierResolution {
  if (override) {
    return {
      base_asset: override.base_asset,
      price_multiplier: override.price_multiplier,
      qty_unit_in_base: override.price_multiplier,
      multiplier_source: 'OVERRIDE',
    };
  }

  const match = PREFIX_PATTERN.exec(listedBaseAsset);
  if (match) {
    const multiplier = match[1] === '1M' ? 1_000_000 : Number(match[1]);
    return {
      base_asset: match[2],
      price_multiplier: multiplier,
      qty_unit_in_base: multiplier,
      multiplier_source: 'PREFIX',
    };
  }

  return {
    base_asset: listedBaseAsset,
    price_multiplier: 1,
    qty_unit_in_base: 1,
    multiplier_source: 'NONE',
  };
}

export function buildInstrumentKey(baseAsset: string, quoteAsset: string, settleAsset: string): string {
  return `${baseAsset}/${quoteAsset}:${settleAsset}`;
}
