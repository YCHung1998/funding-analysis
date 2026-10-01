/**
 * src/types/legacy/historicalImport.ts
 *
 * Historical v0.1 data import rule (spec §2.1 rule 5): when importing
 * v0.1 records into v0.2 shapes without real timestamps, unknown time
 * fields MUST be left `null` and `timestamp_source` set to `'UNKNOWN'`.
 * The importer MUST NOT substitute the current (import-time) clock value
 * for a missing timestamp — this module's functions never read the clock
 * at all, which makes that mistake structurally impossible here.
 */

export type WithUnknownTimestamps<T, TimeFields extends keyof T> = Omit<T, TimeFields> & {
  [K in TimeFields]: null;
} & { timestamp_source: 'UNKNOWN' };

/**
 * Builds a `WithUnknownTimestamps<T, TimeFields>` from legacy data that has
 * no value for `unknownTimeFields`: those fields become `null` and
 * `timestamp_source` is set to `'UNKNOWN'`. Every other field is copied
 * through unchanged.
 */
export function importWithUnknownTimestamps<T extends object, TimeFields extends keyof T>(
  data: Omit<T, TimeFields | 'timestamp_source'>,
  unknownTimeFields: readonly TimeFields[],
): WithUnknownTimestamps<T, TimeFields> {
  const result: Record<string, unknown> = { ...data, timestamp_source: 'UNKNOWN' };
  for (const field of unknownTimeFields) {
    result[field as string] = null;
  }
  return result as WithUnknownTimestamps<T, TimeFields>;
}
