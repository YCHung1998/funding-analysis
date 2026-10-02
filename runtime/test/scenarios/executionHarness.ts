/**
 * runtime/test/scenarios/executionHarness.ts
 *
 * Shared harness for the `paper-execution-engine` task 4.1 scenario tests
 * (S01, S02, S03, S04, S05, S06, S07, S10, S12, S13 of tech spec §42) — not
 * itself a scenario test. Wires `PaperExecutionAdapter` +
 * `EntryCoordinator` + `ExitCoordinator` against a fake order book / guard /
 * instruments / fee / position source and a fresh `VirtualClock`-backed
 * `Ledger`, mirroring `entryCoordinator.test.ts` / `exitCoordinator.test.ts`.
 */
import { FakeFeeRateSource } from '../fakes/fakeFeeRates';
import { FakeFundingWindowGuard } from '../fakes/fakeGuard';
import { FakeInstrumentSource } from '../fakes/fakeInstruments';
import { FakeOrderBookSource } from '../fakes/fakeOrderBook';
import { FakePositionReader } from '../fakes/fakePositions';
import { makeTestLedger, type TestLedgerHarness } from '../fakes/testLedger';
import { PaperExecutionAdapter, type PaperExecutionAdapterConfig } from '../../src/execution/paperExecution';
import { EntryCoordinator, type EntryCoordinatorConfig } from '../../src/trading/entryCoordinator';
import { ExitCoordinator, type ExitCoordinatorConfig } from '../../src/trading/exitCoordinator';
import type { Trade, TradeLeg } from '../../src/types';

export interface ExecutionScenarioHarness {
  harness: TestLedgerHarness;
  orderBook: FakeOrderBookSource;
  execution: PaperExecutionAdapter;
  entryCoordinator: EntryCoordinator;
  exitCoordinator: ExitCoordinator;
  positions: FakePositionReader;
  guard: FakeFundingWindowGuard;
  instruments: FakeInstrumentSource;
}

const DEFAULT_LATENCY = { ack_ms: 10, fill_ms: 5, cancel_ms: 20 };

export function buildExecutionScenario(
  coordinatorConfig: Partial<EntryCoordinatorConfig & ExitCoordinatorConfig> = {},
  adapterConfig: Partial<PaperExecutionAdapterConfig> = {},
): ExecutionScenarioHarness {
  const harness = makeTestLedger({ start: 0 });
  const orderBook = new FakeOrderBookSource();
  const positions = new FakePositionReader();
  const guard = new FakeFundingWindowGuard();
  const instruments = new FakeInstrumentSource();

  const execution = new PaperExecutionAdapter({
    clock: harness.clock,
    ledger: harness.ledger,
    eventStore: harness.eventStore,
    orderBook,
    instruments,
    feeRates: new FakeFeeRateSource(0.0005),
    positions,
    guard,
    config: {
      seed: 42,
      execution_latency: {
        Binance: { ...DEFAULT_LATENCY },
        Bybit: { ...DEFAULT_LATENCY },
        Pionex: { ...DEFAULT_LATENCY },
        Bitget: { ...DEFAULT_LATENCY },
        OKX: { ...DEFAULT_LATENCY },
      },
      max_order_lifetime_ms: 500,
      ack_timeout_ms: 500_000,
      ...adapterConfig,
    },
  });

  const mergedConfig = {
    partial_hedge_max_duration_ms: 5000,
    emergency_exit_timeout_ms: 10_000,
    ...coordinatorConfig,
  };

  const entryCoordinator = new EntryCoordinator({
    clock: harness.clock,
    ledger: harness.ledger,
    execution,
    guard,
    instruments,
    tradeRepo: harness.tradeRepo,
    config: mergedConfig,
  });

  const exitCoordinator = new ExitCoordinator({
    clock: harness.clock,
    ledger: harness.ledger,
    execution,
    guard,
    tradeRepo: harness.tradeRepo,
    config: mergedConfig,
  });

  return { harness, orderBook, execution, entryCoordinator, exitCoordinator, positions, guard, instruments };
}

/** `trade1`/`legL`/`legS` (from `makeTestLedger`) moved to `PRE_FLIGHT`, ready for `EntryCoordinator.start`. */
export function preFlightTrade(harness: TestLedgerHarness): Trade {
  const trade = harness.tradeRepo.getTrade('trade1')!;
  const now = harness.clock.now();
  const preFlight: Trade = { ...trade, status: 'PRE_FLIGHT', updated_at: now };
  harness.ledger.applyTradeTransition(trade, preFlight, 'scenario setup');
  return preFlight;
}

/** Both exchanges' books: entry liquidity on the native side, close liquidity on the opposite side. */
export function setSymmetricBooks(orderBook: FakeOrderBookSource, qty: number, price = 100): void {
  orderBook.setBook({ exchange: 'Binance', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price, qty }], asks: [{ price, qty }] });
  orderBook.setBook({ exchange: 'Bybit', symbol: 'BTCUSDT', local_received_timestamp: 0, bids: [{ price, qty }], asks: [{ price, qty }] });
}

export type { TradeLeg };
