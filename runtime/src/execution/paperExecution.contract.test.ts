/**
 * runtime/src/execution/paperExecution.contract.test.ts
 *
 * Task 1.1 — runs the reusable `ExecutionEngine` contract suite against
 * `PaperExecutionAdapter` with a fake order book and a `VirtualClock`
 * (spec "Replaceable execution interface", Scenario "Contract suite runs
 * against paper adapter").
 */
import { afterEach } from 'vitest';
import { runExecutionEngineContractTests, type ExecutionEngineContractContext } from '../../test/contracts/executionEngine.contract';
import { FakeFeeRateSource } from '../../test/fakes/fakeFeeRates';
import { FakeFundingWindowGuard } from '../../test/fakes/fakeGuard';
import { FakeInstrumentSource } from '../../test/fakes/fakeInstruments';
import { FakeOrderBookSource } from '../../test/fakes/fakeOrderBook';
import { FakePositionReader } from '../../test/fakes/fakePositions';
import { makeTestLedger, type TestLedgerHarness } from '../../test/fakes/testLedger';
import { PaperExecutionAdapter } from './paperExecution';

const harnesses: TestLedgerHarness[] = [];

function makeContext(): ExecutionEngineContractContext {
  const harness = makeTestLedger({ start: 1000 });
  harnesses.push(harness);
  const orderBook = new FakeOrderBookSource();
  const engine = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    orderBook,
    instruments: new FakeInstrumentSource(),
    feeRates: new FakeFeeRateSource(),
    positions: new FakePositionReader(),
    guard: new FakeFundingWindowGuard(),
    config: {
      seed: 42,
      execution_latency: {
        Binance: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Bybit: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Pionex: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        Bitget: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
        OKX: { ack_ms: 45, fill_ms: 10, cancel_ms: 60 },
      },
      max_order_lifetime_ms: 60_000,
      ack_timeout_ms: 30_000,
    },
  });
  return { engine, clock: harness.clock, orderBook, exchange: 'Binance', symbol: 'BTCUSDT' };
}

afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

runExecutionEngineContractTests(makeContext);
