/**
 * runtime/test/fakes/fakeInstruments.ts
 *
 * Fake `InstrumentSource` (stands in for `instrument-registry`). Defaults to
 * `step_size = 0.001`, `contract_multiplier = 1` for any exchange/symbol not
 * explicitly configured, so most tests need no setup.
 */
import type { ExchangeId } from '../../src/types/ids';
import type { InstrumentSource } from '../../src/execution/executionInterface';

export class FakeInstrumentSource implements InstrumentSource {
  private overrides = new Map<string, { step_size: number; contract_multiplier: number }>();
  private defaultSpec = { step_size: 0.001, contract_multiplier: 1 };

  private key(exchange: ExchangeId, symbol: string): string {
    return `${exchange}:${symbol}`;
  }

  setInstrument(exchange: ExchangeId, symbol: string, spec: { step_size: number; contract_multiplier: number }): void {
    this.overrides.set(this.key(exchange, symbol), spec);
  }

  getInstrument(exchange: ExchangeId, symbol: string): { step_size: number; contract_multiplier: number } | undefined {
    return this.overrides.get(this.key(exchange, symbol)) ?? this.defaultSpec;
  }
}
