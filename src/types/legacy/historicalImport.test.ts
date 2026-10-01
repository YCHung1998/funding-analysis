import { describe, expect, it } from 'vitest';
import { importWithUnknownTimestamps } from './historicalImport';

interface LegacyLikeTradeResult {
  trade_id: string;
  symbol: string;
  funding_time: number;
  created_at: number;
  finalized_at: number;
}

describe('importWithUnknownTimestamps (spec §2.1 rule 5)', () => {
  it('v0.1 ArbitrageTradeResult with only funding_time imported: timestamp_source UNKNOWN, created_at/finalized_at null, no fabricated clock value', () => {
    const legacy = { trade_id: 'legacy-1', symbol: 'BTCUSDT', funding_time: 1_700_000_000_000 };
    const importClockTime = 1_800_000_000_000;

    const result = importWithUnknownTimestamps<LegacyLikeTradeResult, 'created_at' | 'finalized_at'>(legacy, [
      'created_at',
      'finalized_at',
    ]);

    expect(result.timestamp_source).toBe('UNKNOWN');
    expect(result.created_at).toBeNull();
    expect(result.finalized_at).toBeNull();
    expect(Object.values(result)).not.toContain(importClockTime);
  });
});
