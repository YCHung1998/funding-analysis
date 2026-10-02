import { describe, expect, it } from 'vitest';
import { evaluateContractEligibility } from './eligibility';
import type { CandidateLegInfo, EligibilityConfig } from './eligibility';

const baseConfig: EligibilityConfig = {
  tradingExchanges: ['Binance', 'Bybit', 'OKX'],
  fundingAlignmentToleranceMs: 1_000,
};

const T = 1_000_000;

function leg(partial: Partial<CandidateLegInfo> & Pick<CandidateLegInfo, 'exchange'>): CandidateLegInfo {
  return { nextFundingTime: T, fundingIntervalHours: 8, ...partial };
}

describe('evaluateContractEligibility (settlement-session spec)', () => {
  it('is eligible when both legs are trading-exchange, aligned, and >=2h interval', () => {
    const result = evaluateContractEligibility(leg({ exchange: 'Binance' }), leg({ exchange: 'Bybit' }), baseConfig);
    expect(result).toEqual({ eligible: true });
  });

  it('rejects a one-hour contract with FUNDING_INTERVAL_TOO_SHORT', () => {
    const result = evaluateContractEligibility(
      leg({ exchange: 'Binance' }),
      leg({ exchange: 'Bybit', fundingIntervalHours: 1 }),
      baseConfig,
    );
    expect(result).toEqual({ eligible: false, reason: 'FUNDING_INTERVAL_TOO_SHORT' });
  });

  it('rejects misaligned settlement times with FUNDING_NOT_ALIGNED', () => {
    const result = evaluateContractEligibility(
      leg({ exchange: 'Binance', nextFundingTime: T }),
      leg({ exchange: 'Bybit', nextFundingTime: T + 5_000 }),
      baseConfig,
    );
    expect(result).toEqual({ eligible: false, reason: 'FUNDING_NOT_ALIGNED' });
  });

  it('rejects a non-trading exchange with EXCHANGE_NOT_TRADABLE', () => {
    const result = evaluateContractEligibility(
      leg({ exchange: 'Binance' }),
      leg({ exchange: 'Pionex' }),
      baseConfig,
    );
    expect(result).toEqual({ eligible: false, reason: 'EXCHANGE_NOT_TRADABLE' });
  });

  it('re-evaluating with a freshly-read hourly interval rejects a previously-eligible pair', () => {
    const atShortlist = evaluateContractEligibility(leg({ exchange: 'Binance' }), leg({ exchange: 'Bybit' }), baseConfig);
    expect(atShortlist.eligible).toBe(true);

    const atArm = evaluateContractEligibility(
      leg({ exchange: 'Binance' }),
      leg({ exchange: 'Bybit', fundingIntervalHours: 1 }),
      baseConfig,
    );
    expect(atArm).toEqual({ eligible: false, reason: 'FUNDING_INTERVAL_TOO_SHORT' });
  });
});
