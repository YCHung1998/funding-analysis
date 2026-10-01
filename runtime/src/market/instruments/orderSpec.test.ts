import { describe, expect, it } from 'vitest';
import { checkOrderMinimums, roundPrice, roundQtyDown, toBaseQty } from './orderSpec';
import type { Instrument } from './types';

function makeInstrument(overrides: Partial<Instrument> = {}): Instrument {
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
    ambiguous: false,
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
    created_at: 0,
    updated_at: 0,
    status_changed_at: 0,
    last_seen_at: 0,
    ...overrides,
  };
}

describe('roundQtyDown', () => {
  it('[spec] Quantity rounded down to step', () => {
    const instrument = makeInstrument({ qty_step: 0.001 });
    expect(roundQtyDown(instrument, 0.0129)).toBeCloseTo(0.012, 12);
  });

  it('avoids float garbage like 0.1 + 0.2', () => {
    const instrument = makeInstrument({ qty_step: 0.1 });
    expect(roundQtyDown(instrument, 0.30000000000000004)).toBeCloseTo(0.3, 12);
  });
});

describe('roundPrice', () => {
  it('rounds buy down and sell up to tick size', () => {
    const instrument = makeInstrument({ tick_size: 0.1 });
    expect(roundPrice(instrument, 100.37, 'buy')).toBeCloseTo(100.3, 12);
    expect(roundPrice(instrument, 100.31, 'sell')).toBeCloseTo(100.4, 12);
  });
});

describe('checkOrderMinimums', () => {
  it('[spec] Below minimum notional', () => {
    const instrument = makeInstrument({ min_qty: 0.001, min_notional: 50 });
    expect(checkOrderMinimums(instrument, 0.0008, 60000)).toBe('BELOW_MIN_QTY');
    expect(checkOrderMinimums(instrument, 0.001, 40000)).toBe('BELOW_MIN_NOTIONAL');
    expect(checkOrderMinimums(instrument, 0.001, 60000)).toBe('OK');
  });
});

describe('toBaseQty', () => {
  it('[spec] Base quantity conversion', () => {
    const instrument = makeInstrument({ qty_unit_in_base: 10_000_000 });
    expect(toBaseQty(instrument, 0.5)).toBe(5_000_000);
  });
});
