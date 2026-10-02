/**
 * runtime/test/fakes/fakeFeeRates.ts
 *
 * Fake `FeeRateSource` (stands in for `cost-model`). Defaults match
 * `accounting/feeConfig.ts`'s `DEFAULT_FEE_TABLE` VIP0 taker rate of 0.0005
 * so scenario numbers (tech spec §14 example) line up without extra setup.
 */
import type { ExchangeId } from '../../src/types/ids';
import type { FeeRateSource } from '../../src/execution/executionInterface';

export class FakeFeeRateSource implements FeeRateSource {
  constructor(
    private takerRate = 0.0005,
    private makerRate = 0.0002,
  ) {}

  setTakerFeeRate(rate: number): void {
    this.takerRate = rate;
  }

  setMakerFeeRate(rate: number): void {
    this.makerRate = rate;
  }

  getTakerFeeRate(_exchange: ExchangeId, _symbol: string): number {
    return this.takerRate;
  }

  getMakerFeeRate(_exchange: ExchangeId, _symbol: string): number {
    return this.makerRate;
  }
}
