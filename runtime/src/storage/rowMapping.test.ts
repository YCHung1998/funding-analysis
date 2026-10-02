/**
 * runtime/src/storage/rowMapping.test.ts
 *
 * Task 2.2 — generic type <-> row helpers used by every repository.
 */
import { describe, expect, it } from 'vitest';
import { boolFromRow, boolToRow, jsonFromRow, jsonToRow, optionalFromRow, optionalToRow } from './rowMapping';

describe('rowMapping helpers', () => {
  it('boolToRow / boolFromRow round trip true/false to 1/0', () => {
    expect(boolToRow(true)).toBe(1);
    expect(boolToRow(false)).toBe(0);
    expect(boolFromRow(1)).toBe(true);
    expect(boolFromRow(0)).toBe(false);
  });

  it('jsonToRow / jsonFromRow round trip nested objects and arrays', () => {
    const value = { a: [1, 2, { b: 'c' }], d: null };
    expect(jsonFromRow(jsonToRow(value))).toEqual(value);
  });

  it('optionalToRow maps undefined to null, keeps defined values', () => {
    expect(optionalToRow(undefined)).toBeNull();
    expect(optionalToRow(5)).toBe(5);
    expect(optionalToRow('x')).toBe('x');
  });

  it('optionalFromRow maps null to undefined, keeps defined values', () => {
    expect(optionalFromRow(null)).toBeUndefined();
    expect(optionalFromRow(5)).toBe(5);
  });
});
