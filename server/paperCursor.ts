/**
 * server/paperCursor.ts
 *
 * `paper-trading-read-api` design.md Decision 2: opaque keyset-pagination
 * cursor, shared by `getCompletedTrades` (A-6) and `getTradeEvents` (A-8),
 * and intended for reuse by the sibling `paper-trading-event-stream`
 * change's global-events route if it ever needs one (design.md Decision 2
 * "Why base64url JSON over a raw numeric string").
 *
 * The wire contract (`src/features/paperTrading/api/paperApi.ts`,
 * `contracts.ts`) treats `cursor` as an opaque `string | null` — never
 * parsed client-side, only ever replayed verbatim from a prior
 * `next_cursor`. That frees this module to choose any internal encoding;
 * base64url-encoded JSON keeps one implementation serving both routes'
 * different key shapes (`{ sort_key, trade_id }` vs. `{ seq }`) without
 * inventing a second cursor format.
 *
 * Exported (not made private) per this change's Impact note — the
 * not-yet-started `paper-trading-event-stream` change is expected to import
 * these directly rather than duplicate them.
 */

/** Encodes `key` as a base64url string. Never throws (any JSON-serializable value is valid input). */
export function encodeCursor<T>(key: T): string {
  const json = JSON.stringify(key);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor produced by `encodeCursor`. Returns `null` — never
 * throws — for anything that isn't valid base64url JSON (design.md Decision
 * 2: "格式錯誤回傳 null（由呼叫端轉 400）"); callers are responsible for
 * turning a `null` result into an HTTP 400.
 */
export function decodeCursor<T>(cursor: string): T | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
