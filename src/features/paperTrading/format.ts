/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — display-only formatting helpers (design.md Decision 10).
 * These functions MUST NOT perform any financial computation — they only
 * format values the Runtime API already computed (HANDOFF Invariant #5:
 * rates are stored/transmitted as decimals, ×100 happens only here).
 */

export const EMPTY_VALUE = '—';

/** Decimal funding rate (e.g. 0.0001) -> '0.0100%' (4 decimal places on the percent). */
export function formatRatePct(rate: number | undefined | null): string {
  if (rate === undefined || rate === null || Number.isNaN(rate)) return EMPTY_VALUE;
  return `${(rate * 100).toFixed(4)}%`;
}

/** Decimal ratio (e.g. 0.995) -> '99.5%' (1 decimal place). */
export function formatRatioPct(ratio: number | undefined | null): string {
  if (ratio === undefined || ratio === null || Number.isNaN(ratio)) return EMPTY_VALUE;
  return `${(ratio * 100).toFixed(1)}%`;
}

/** USDT amount -> '1,000.00' (2 decimals, thousands separator). 0 is a valid value, not empty. */
export function formatUsdt(amount: number | undefined | null): string {
  if (amount === undefined || amount === null || Number.isNaN(amount)) return EMPTY_VALUE;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** USDT amount with explicit sign, e.g. for PnL waterfall bars: '+3.00' / '-1.50'. */
export function formatSignedUsdt(amount: number | undefined | null): string {
  if (amount === undefined || amount === null || Number.isNaN(amount)) return EMPTY_VALUE;
  const sign = amount > 0 ? '+' : amount < 0 ? '' : '+';
  return `${sign}${formatUsdt(amount)}`;
}

/** Integer/plain count with thousands separator, e.g. notional-per-leg quantities. */
export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return EMPTY_VALUE;
  return value.toLocaleString('en-US');
}

/** Epoch ms (UTC) -> 'HH:mm:ss.SSS'. */
export function formatClockUtc(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return EMPTY_VALUE;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const sss = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${sss}`;
}

/** Epoch ms (UTC) -> 'YYYY-MM-DD', for use as a tooltip alongside formatClockUtc. */
export function formatDateUtc(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return EMPTY_VALUE;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Relative offset in ms from a trade's created_at, displayed as '+Δms'. */
export function formatRelativeOffsetMs(timestampMs: number, baseMs: number): string {
  const delta = timestampMs - baseMs;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta}ms`;
}

/** now - snapshot_at style data-freshness check used by Account/Health staleness rules. */
export function isStale(referenceMs: number | null | undefined, nowMs: number, thresholdMs: number): boolean {
  if (referenceMs === null || referenceMs === undefined) return true;
  return nowMs - referenceMs > thresholdMs;
}
