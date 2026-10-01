import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from './registry';
import type { EventSink, InstrumentSnapshotInput, TradingEvent } from './types';
import { TRADING_EVENT_TYPES } from '../../types/event';
import { assertNoCredentials } from '../../types/validate';

function makeInput(overrides: Partial<InstrumentSnapshotInput> = {}): InstrumentSnapshotInput {
  return {
    instrument_id: 'Binance:BTCUSDT',
    exchange: 'Binance',
    native_symbol: 'BTCUSDT',
    instrument_key: 'BTC/USDT:USDT',
    base_asset: 'BTC',
    quote_asset: 'USDT',
    settle_asset: 'USDT',
    listed_base_asset: 'BTC',
    price_multiplier: 1,
    qty_unit_in_base: 1,
    multiplier_source: 'NONE',
    contract_type: 'LINEAR_PERPETUAL',
    native_contract_type: 'PERPETUAL',
    status: 'TRADING',
    native_status: 'TRADING',
    tick_size: 0.1,
    qty_step: 0.001,
    min_qty: 0.001,
    min_notional: 50,
    funding: {
      next_funding_time: null,
      funding_interval_hours: null,
      interval_source: 'UNKNOWN',
      schedule_status: 'MISSING',
      exchange_timestamp: null,
      local_received_timestamp: null,
      updated_at: 0,
    },
    ...overrides,
  };
}

function makeSink(): { sink: EventSink; events: TradingEvent[] } {
  const events: TradingEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

describe('InstrumentRegistry.applySnapshot', () => {
  it('[spec] First registration sets timestamps', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    const instrument = registry.get('Binance', 'BTCUSDT')!;
    expect(instrument.instrument_id).toBe('Binance:BTCUSDT');
    expect(instrument.created_at).toBe(1000);
    expect(instrument.updated_at).toBe(1000);
    expect(instrument.last_seen_at).toBe(1000);
  });

  it('[spec] Refresh updates only mutable timestamps when spec unchanged', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    registry.applySnapshot('Binance', [makeInput()], 5000);
    const instrument = registry.get('Binance', 'BTCUSDT')!;
    expect(instrument.created_at).toBe(1000);
    expect(instrument.last_seen_at).toBe(5000);
    expect(instrument.updated_at).toBe(1000);
  });

  it('[spec] One exchange fails, others refresh (source isolation)', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    registry.markSourceFailed('OKX', 'HTTP', 429, 2000);
    expect(registry.get('Binance', 'BTCUSDT')).toBeDefined();
    expect(registry.sourceStatus('OKX')).toMatchObject({ status: 'FAILED', error_kind: 'HTTP', http_status: 429 });
  });

  it('[spec] Failure never empties the registry', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    registry.markSourceFailed('Binance', 'TIMEOUT', undefined, 2000);
    expect(registry.get('Binance', 'BTCUSDT')).toBeDefined();
    expect(registry.sourceStatus('Binance')).toMatchObject({ status: 'FAILED', error_kind: 'TIMEOUT' });
  });

  it('[spec] Contract missing from successful snapshot becomes DELISTED', () => {
    const { sink, events } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput({ instrument_id: 'Binance:OLDUSDT', native_symbol: 'OLDUSDT' })], 1000);
    registry.applySnapshot('Binance', [], 2000);
    const instrument = registry.get('Binance', 'OLDUSDT')!;
    expect(instrument.status).toBe('DELISTED');
    expect(events.some((e) => e.event_type === 'INSTRUMENT_STATUS_CHANGED' && e.payload.reason === 'ABSENT_FROM_SOURCE')).toBe(true);
  });

  it('emitted events use the canonical TradingEvent shape (runtime/src/types/event)', () => {
    const { sink, events } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput({ instrument_id: 'Binance:OLDUSDT', native_symbol: 'OLDUSDT' })], 1000);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(typeof e.event_id).toBe('string');
      expect(e.event_id.length).toBeGreaterThan(0);
      expect(TRADING_EVENT_TYPES).toContain(e.event_type);
      expect(e.trade_id).toBeNull();
      expect(e.timestamp).toBe(1000);
      expect(e.exchange).toBe('Binance');
      expect(() => assertNoCredentials(e, [])).not.toThrow();
    }
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
  });

  it('[spec] Duplicate key on one exchange marks both ambiguous', () => {
    const { sink, events } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot(
      'Binance',
      [
        makeInput({ instrument_id: 'Binance:PEPEUSDT', native_symbol: 'PEPEUSDT', instrument_key: 'PEPE/USDT:USDT', price_multiplier: 1 }),
        makeInput({ instrument_id: 'Binance:1000PEPEUSDT', native_symbol: '1000PEPEUSDT', instrument_key: 'PEPE/USDT:USDT', price_multiplier: 1000 }),
      ],
      1000,
    );
    expect(registry.get('Binance', 'PEPEUSDT')!.ambiguous).toBe(true);
    expect(registry.get('Binance', '1000PEPEUSDT')!.ambiguous).toBe(true);
    expect(events.some((e) => e.event_type === 'INSTRUMENT_AMBIGUOUS')).toBe(true);
  });

  it('[spec] Tick size change emits INSTRUMENT_SPEC_CHANGED', () => {
    const { sink, events } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput({ tick_size: 0.1 })], 1000);
    registry.applySnapshot('Binance', [makeInput({ tick_size: 0.01 })], 2000);
    const instrument = registry.get('Binance', 'BTCUSDT')!;
    expect(instrument.tick_size).toBe(0.01);
    expect(instrument.updated_at).toBe(2000);
    const specEvent = events.find((e) => e.event_type === 'INSTRUMENT_SPEC_CHANGED');
    expect(specEvent?.payload).toMatchObject({ field: 'tick_size', from: 0.1, to: 0.01 });
  });

  it('[spec] Unknown native status flagged UNKNOWN and not overwritten to TRADING', () => {
    const { sink, events } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Bybit', [makeInput({ exchange: 'Bybit', instrument_id: 'Bybit:FOOUSDT', native_symbol: 'FOOUSDT', status: 'UNKNOWN', native_status: 'Foo' })], 1000);
    const instrument = registry.get('Bybit', 'FOOUSDT')!;
    expect(instrument.status).toBe('UNKNOWN');
  });
});

describe('InstrumentRegistry.updateFundingSchedule', () => {
  it('[spec] Newer update applied', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput({ funding: { ...makeInput().funding, exchange_timestamp: 100 } })], 1000);
    const result = registry.updateFundingSchedule('Binance', 'BTCUSDT', { next_funding_time: 20_000, exchange_timestamp: 200 }, 5000);
    expect(result.status).toBe('OK');
    const instrument = registry.get('Binance', 'BTCUSDT')!;
    expect(instrument.funding.next_funding_time).toBe(20_000);
    expect(instrument.funding.schedule_status).toBe('VALID');
    expect(instrument.updated_at).toBe(5000);
  });

  it('[spec] Out-of-order update ignored', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput({ funding: { ...makeInput().funding, exchange_timestamp: 200, next_funding_time: 999 } })], 1000);
    const result = registry.updateFundingSchedule('Binance', 'BTCUSDT', { next_funding_time: 1, exchange_timestamp: 150 }, 5000);
    expect(result.status).toBe('IGNORED_OUT_OF_ORDER');
    expect(registry.get('Binance', 'BTCUSDT')!.funding.next_funding_time).toBe(999);
  });

  it('[spec] Interval switch recorded via FUNDING_SCHEDULE_CHANGED', () => {
    const { sink, events } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Bybit', [makeInput({ exchange: 'Bybit', instrument_id: 'Bybit:BTCUSDT', funding: { ...makeInput().funding, exchange_timestamp: 1, funding_interval_hours: 8 } })], 1000);
    registry.updateFundingSchedule('Bybit', 'BTCUSDT', { next_funding_time: 20_000, funding_interval_hours: 1, exchange_timestamp: 2 }, 5000);
    const changed = events.find((e) => e.event_type === 'FUNDING_SCHEDULE_CHANGED');
    expect(changed?.payload).toMatchObject({ from: 8, to: 1 });
  });

  it('[spec] Update for unregistered instrument rejected', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    const result = registry.updateFundingSchedule('Bybit', 'NEWUSDT', { next_funding_time: 1, exchange_timestamp: 1 }, 1000);
    expect(result.status).toBe('UNKNOWN_INSTRUMENT');
  });

  it('[spec] Zero funding time is missing', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    registry.updateFundingSchedule('Binance', 'BTCUSDT', { next_funding_time: 0, exchange_timestamp: 1 }, 2000);
    const instrument = registry.get('Binance', 'BTCUSDT')!;
    expect(instrument.funding.schedule_status).toBe('MISSING');
    expect(instrument.funding.next_funding_time).toBeNull();
  });

  it('[spec] Passed funding time becomes stale, not extrapolated', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    registry.updateFundingSchedule('Binance', 'BTCUSDT', { next_funding_time: 10_000, exchange_timestamp: 1 }, 2000);
    // now passes the funding time without a new update
    registry.applySnapshot('Binance', [makeInput()], 10_001);
    const instrument = registry.get('Binance', 'BTCUSDT')!;
    expect(instrument.funding.next_funding_time).toBe(10_000);
    expect(instrument.funding.schedule_status).toBe('STALE');
  });
});

describe('InstrumentRegistry subscription', () => {
  it('[spec] Delisting removes symbol from subscription list and notifies listeners', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput({ instrument_id: 'Binance:STORJUSDT', native_symbol: 'STORJUSDT' })], 1000);
    expect(registry.subscribableSymbols('Binance')).toContain('STORJUSDT');

    let lastDiff: { added: string[]; removed: string[]; changed: string[] } | undefined;
    registry.onChange((diff) => {
      lastDiff = diff;
    });
    const versionBefore = registry.version();
    registry.applySnapshot('Binance', [makeInput({ instrument_id: 'Binance:STORJUSDT', native_symbol: 'STORJUSDT', status: 'DELISTING' })], 2000);
    expect(registry.subscribableSymbols('Binance')).not.toContain('STORJUSDT');
    expect(registry.version()).toBeGreaterThan(versionBefore);
    expect(lastDiff?.changed).toContain('Binance:STORJUSDT');
  });

  it('[spec] No-op refresh does not notify', () => {
    const { sink } = makeSink();
    const registry = new InstrumentRegistry(sink);
    registry.applySnapshot('Binance', [makeInput()], 1000);
    const versionBefore = registry.version();
    let called = false;
    registry.onChange(() => {
      called = true;
    });
    registry.applySnapshot('Binance', [makeInput()], 2000);
    expect(registry.version()).toBe(versionBefore);
    expect(called).toBe(false);
  });
});
