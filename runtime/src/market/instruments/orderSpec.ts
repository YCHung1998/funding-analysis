/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 下單規格輔助：十進位安全的取整與最小值檢查（design.md Decision 1, spec「Order specification helpers」）。
 */

import type { Instrument } from './types';

function decimalsOf(step: number): number {
  const s = step.toString();
  if (s.includes('e-')) {
    return Number(s.split('e-')[1]);
  }
  const dotIndex = s.indexOf('.');
  return dotIndex === -1 ? 0 : s.length - dotIndex - 1;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** 向下取整到 qty_step。 */
export function roundQtyDown(instrument: Instrument, qty: number): number {
  const step = instrument.qty_step;
  const steps = Math.floor(qty / step + 1e-9);
  return roundToDecimals(steps * step, decimalsOf(step));
}

/** 買單向下、賣單向上取整到 tick_size。 */
export function roundPrice(instrument: Instrument, price: number, side: 'buy' | 'sell'): number {
  const step = instrument.tick_size;
  const decimals = decimalsOf(step);
  if (side === 'buy') {
    const steps = Math.floor(price / step + 1e-9);
    return roundToDecimals(steps * step, decimals);
  }
  const steps = Math.ceil(price / step - 1e-9);
  return roundToDecimals(steps * step, decimals);
}

export type OrderMinimumCheck = 'OK' | 'BELOW_MIN_QTY' | 'BELOW_MIN_NOTIONAL';

export function checkOrderMinimums(instrument: Instrument, qty: number, price: number): OrderMinimumCheck {
  if (qty < instrument.min_qty) return 'BELOW_MIN_QTY';
  if (instrument.min_notional != null && qty * price < instrument.min_notional) {
    return 'BELOW_MIN_NOTIONAL';
  }
  return 'OK';
}

/** 下單數量換算為標的數量（OKX 等以合約張數下單的交易所）。 */
export function toBaseQty(instrument: Instrument, qty: number): number {
  return qty * instrument.qty_unit_in_base;
}
