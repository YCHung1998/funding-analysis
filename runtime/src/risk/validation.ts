/**
 * runtime/src/risk/validation.ts
 *
 * Centralized "is this input usable" checks — fixes a fail-open bug found
 * by integrator review: checks that only tested `=== undefined` let NaN
 * and ±Infinity silently pass numeric comparisons (`NaN > threshold` is
 * `false`, `Infinity > threshold` is `true` but meaningless), so a
 * malformed numeric input could PASS a check instead of FAILing per spec
 * "任一必要輸入缺失（undefined、NaN、來源回報不可用）時，該項 MUST 為 FAIL".
 *
 * Every required numeric input MUST go through `isFiniteNumber` (or the
 * array helper below) before being compared — never a raw `=== undefined`
 * check.
 */

/** `undefined`, `null`, `NaN`, and `±Infinity` are all "missing" — only a finite number is usable. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Non-numeric presence check (booleans, strings, objects). */
export function isPresent<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

/** A non-empty array of finite numbers — an empty array, or one containing any non-finite entry, counts as missing. */
export function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => isFiniteNumber(v));
}
