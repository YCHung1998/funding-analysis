import { describe, expect, it } from 'vitest';
import { finalizeTradeResult, resolveSettlement } from './settlementInference';

const T = 1_000_000;
const settlementConfirmTimeoutMs = 600_000;

describe('resolveSettlement (funding-settlement-rules spec "Funding settlement is inferred from public settled rates")', () => {
  it('settles after exit: SHORT 10 units, rate 0.0010, mark 100 -> cashflow +1.0, delay 45000ms', () => {
    const result = resolveSettlement({
      T,
      now: T + 45_000,
      side: 'SHORT',
      quantity: 10,
      heldContinuously: true,
      settledRecord: { rate: 0.0010, markPrice: 100, publishedAt: T + 45_000 },
      settlementConfirmTimeoutMs,
    });

    expect(result.status).toBe('SETTLED');
    expect(result.cashflowUsdt).toBeCloseTo(1.0);
    expect(result.publicationDelayMs).toBe(45_000);
    expect(result.markPriceSource).toBe('EXCHANGE');
  });

  it('LONG pays when rate is positive (negative cashflow)', () => {
    const result = resolveSettlement({
      T,
      now: T + 10_000,
      side: 'LONG',
      quantity: 10,
      heldContinuously: true,
      settledRecord: { rate: 0.0010, markPrice: 100, publishedAt: T + 10_000 },
      settlementConfirmTimeoutMs,
    });
    expect(result.cashflowUsdt).toBeCloseTo(-1.0);
  });

  it('is NOT_ELIGIBLE with zero cashflow when not held through [hedged_by, lock_end]', () => {
    const result = resolveSettlement({
      T,
      now: T + 10_000,
      side: 'SHORT',
      quantity: 10,
      heldContinuously: false,
      settlementConfirmTimeoutMs,
    });
    expect(result).toMatchObject({ status: 'NOT_ELIGIBLE', cashflowUsdt: 0 });
  });

  it('is MISSED after the confirmation timeout with no settled record', () => {
    const result = resolveSettlement({
      T,
      now: T + settlementConfirmTimeoutMs + 1,
      side: 'SHORT',
      quantity: 10,
      heldContinuously: true,
      settlementConfirmTimeoutMs,
    });
    expect(result.status).toBe('MISSED');
    expect(result.needsManualReview).toBe(true);
  });

  it('is ELIGIBLE (not yet SETTLED) before a settled record appears and before the timeout', () => {
    const result = resolveSettlement({
      T,
      now: T + 10_000,
      side: 'SHORT',
      quantity: 10,
      heldContinuously: true,
      settlementConfirmTimeoutMs,
    });
    expect(result.status).toBe('ELIGIBLE');
  });

  it('uses the market snapshot as an estimate and marks mark_price_source = SNAPSHOT when the settled source has no mark price', () => {
    const result = resolveSettlement({
      T,
      now: T + 10_000,
      side: 'SHORT',
      quantity: 10,
      heldContinuously: true,
      settledRecord: { rate: 0.0010, publishedAt: T + 10_000 },
      marketSnapshotAtT: { markPrice: 100 },
      settlementConfirmTimeoutMs,
    });
    expect(result.status).toBe('SETTLED');
    expect(result.markPriceSource).toBe('SNAPSHOT');
    expect(result.cashflowUsdt).toBeCloseTo(1.0);
  });
});

describe('finalizeTradeResult (funding-settlement-rules spec "PnL finalization after both legs settle")', () => {
  it('is not finalized while a leg is still EXPECTED/ELIGIBLE', () => {
    const result = finalizeTradeResult(['ELIGIBLE', 'SETTLED'], T + 31_000);
    expect(result).toEqual({ fundingConfirmed: false, finalizedAt: null });
  });

  it('finalizes with funding_confirmed=true once both legs are SETTLED', () => {
    const result = finalizeTradeResult(['SETTLED', 'SETTLED'], T + 50_000);
    expect(result).toEqual({ fundingConfirmed: true, finalizedAt: T + 50_000 });
  });

  it('finalizes with funding_confirmed=false when a leg is MISSED (amount unknown, manual review)', () => {
    const result = finalizeTradeResult(['SETTLED', 'MISSED'], T + 700_000);
    expect(result).toEqual({ fundingConfirmed: false, finalizedAt: T + 700_000 });
  });

  it('treats NOT_ELIGIBLE as confirmed: no funding for that leg is a known outcome (design Decision 6)', () => {
    expect(finalizeTradeResult(['SETTLED', 'NOT_ELIGIBLE'], T + 50_000)).toEqual({ fundingConfirmed: true, finalizedAt: T + 50_000 });
    expect(finalizeTradeResult(['NOT_ELIGIBLE', 'NOT_ELIGIBLE'], T + 50_000)).toEqual({ fundingConfirmed: true, finalizedAt: T + 50_000 });
  });
});
