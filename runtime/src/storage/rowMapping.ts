/**
 * runtime/src/storage/rowMapping.ts
 *
 * Generic `trading-schema` type <-> SQLite row helpers (design.md §7, spec
 * "Lossless repository round trip"): booleans <-> 0/1, nested
 * objects/arrays <-> JSON TEXT, optional fields <-> NULL.
 */

export function boolToRow(value: boolean): number {
  return value ? 1 : 0;
}

export function boolFromRow(value: number): boolean {
  return value !== 0;
}

export function jsonToRow(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonFromRow<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function optionalToRow<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function optionalFromRow<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
