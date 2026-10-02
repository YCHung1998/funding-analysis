/**
 * server/paperCursor.test.ts — task 1.2. Round-trip + malformed-cursor
 * behavior (design.md Decision 2: malformed -> `null`, never silently reset
 * to "start from the beginning").
 */
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './paperCursor';

describe('paperCursor — task 1.2', () => {
  it('round-trips a composite key', () => {
    const key = { sort_key: 1_700_000_000_000, trade_id: 'trade-abc-123' };
    const cursor = encodeCursor(key);
    expect(typeof cursor).toBe('string');
    expect(decodeCursor<typeof key>(cursor)).toEqual(key);
  });

  it('round-trips a single-field key', () => {
    const key = { seq: 42 };
    const cursor = encodeCursor(key);
    expect(decodeCursor<typeof key>(cursor)).toEqual(key);
  });

  it('produces a URL-safe (base64url) string with no +, /, or = characters', () => {
    const cursor = encodeCursor({ sort_key: 1, trade_id: 'a/b+c==' });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('returns null for a malformed cursor instead of throwing', () => {
    expect(decodeCursor('not-valid-base64-json')).toBeNull();
  });

  it('returns null for valid base64url that is not JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(decodeCursor(notJson)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });
});
