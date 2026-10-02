/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * live-klines 的輸入驗證與跨所 symbol 解析（spec「Research server uses the registry
 * during transition」Scenario: Klines resolves 1000x symbol / Invalid klines symbol）。
 */

import type { InstrumentRegistry } from '../runtime/src/market/instruments/registry';

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;

export interface KlinesResolution {
  instrument_key: string;
  binance_native_symbol: string;
  pionex_native_symbol: string | null;
}

export type ResolveKlinesSymbolResult =
  | { ok: true; resolution: KlinesResolution }
  | { ok: false; reason: 'INVALID_SYMBOL' | 'NOT_FOUND' };

export function resolveKlinesSymbol(rawSymbol: string, registry: InstrumentRegistry): ResolveKlinesSymbolResult {
  const symbol = rawSymbol.toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    return { ok: false, reason: 'INVALID_SYMBOL' };
  }

  const binanceInstrument = registry.get('Binance', symbol);
  if (!binanceInstrument) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const pionexInstrument = registry.findByKey(binanceInstrument.instrument_key).find((i) => i.exchange === 'Pionex');

  return {
    ok: true,
    resolution: {
      instrument_key: binanceInstrument.instrument_key,
      binance_native_symbol: binanceInstrument.native_symbol,
      pionex_native_symbol: pionexInstrument?.native_symbol ?? null,
    },
  };
}
