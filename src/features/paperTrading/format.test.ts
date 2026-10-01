import { describe, expect, it } from 'vitest';
import {
  EMPTY_VALUE,
  formatClockUtc,
  formatRatePct,
  formatRatioPct,
  formatRelativeOffsetMs,
  formatSignedUsdt,
  formatUsdt,
  isStale,
} from './format';

describe('formatRatePct', () => {
  it('converts a decimal funding rate to a percent string with 4 decimals (spec scenario)', () => {
    expect(formatRatePct(0.0001)).toBe('0.0100%');
  });

  it('renders missing values as the em dash, never 0', () => {
    expect(formatRatePct(undefined)).toBe(EMPTY_VALUE);
    expect(formatRatePct(null)).toBe(EMPTY_VALUE);
  });
});

describe('formatRatioPct', () => {
  it('converts a decimal hedge ratio to a 1-decimal percent (spec scenario)', () => {
    expect(formatRatioPct(0.995)).toBe('99.5%');
  });
});

describe('formatUsdt', () => {
  it('formats with thousands separator and 2 decimals', () => {
    expect(formatUsdt(1000)).toBe('1,000.00');
  });

  it('renders 0 as a real value, not the empty dash (0 fills are meaningful)', () => {
    expect(formatUsdt(0)).toBe('0.00');
  });

  it('renders missing as the em dash', () => {
    expect(formatUsdt(undefined)).toBe(EMPTY_VALUE);
  });
});

describe('formatSignedUsdt', () => {
  it('prefixes positive amounts with +', () => {
    expect(formatSignedUsdt(3)).toBe('+3.00');
  });
  it('keeps the minus sign for negative amounts', () => {
    expect(formatSignedUsdt(-1.5)).toBe('-1.50');
  });
});

describe('formatClockUtc', () => {
  it('formats epoch ms as HH:mm:ss.SSS in UTC', () => {
    // 15:31:02.130 UTC
    const ms = Date.UTC(2024, 0, 1, 15, 31, 2, 130);
    expect(formatClockUtc(ms)).toBe('15:31:02.130');
  });
});

describe('formatRelativeOffsetMs', () => {
  it('shows a + sign for offsets at or after the base time', () => {
    expect(formatRelativeOffsetMs(1035, 1000)).toBe('+35ms');
    expect(formatRelativeOffsetMs(1000, 1000)).toBe('+0ms');
  });
  it('shows a - sign for offsets before the base time', () => {
    expect(formatRelativeOffsetMs(965, 1000)).toBe('-35ms');
  });
});

describe('isStale', () => {
  it('is stale when now - reference exceeds the threshold', () => {
    expect(isStale(1000, 12000, 10000)).toBe(true);
  });
  it('is not stale within the threshold', () => {
    expect(isStale(1000, 9000, 10000)).toBe(false);
  });
  it('treats a missing reference as stale', () => {
    expect(isStale(null, 9000, 10000)).toBe(true);
  });
});
