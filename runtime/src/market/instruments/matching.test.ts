import { describe, expect, it } from 'vitest';
import { candidatePairs, matchPair } from './matching';
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
      next_funding_time: 10_000,
      funding_interval_hours: 8,
      interval_source: 'EXCHANGE_FIELD',
      schedule_status: 'VALID',
      exchange_timestamp: 1,
      local_received_timestamp: 1,
      updated_at: 1,
    },
    created_at: 0,
    updated_at: 0,
    status_changed_at: 0,
    last_seen_at: 0,
    ...overrides,
  };
}

const OPTS = { now: 0, funding_alignment_tolerance_ms: 60_000, price_mismatch_tolerance_pct: 0.02 };

describe('matchPair', () => {
  it('[spec] Aligned linear pair matches', () => {
    const long = makeInstrument({ instrument_id: 'Binance:BTCUSDT', exchange: 'Binance', funding: { ...makeInstrument().funding, next_funding_time: 10_000 } });
    const short = makeInstrument({ instrument_id: 'Bybit:BTCUSDT', exchange: 'Bybit', funding: { ...makeInstrument().funding, next_funding_time: 10_500 } });
    const result = matchPair(long, short, OPTS);
    expect(result.matched).toBe(true);
    expect(result.instrument_key).toBe('BTC/USDT:USDT');
    expect(result.funding_time_diff_ms).toBe(500);
    expect(result.funding_aligned).toBe(true);
  });

  it('[spec] Same exchange rejected', () => {
    const a = makeInstrument({ instrument_id: 'Binance:BTCUSDT', exchange: 'Binance' });
    const b = makeInstrument({ instrument_id: 'Binance:BTCUSDT2', exchange: 'Binance' });
    expect(matchPair(a, b, OPTS)).toMatchObject({ matched: false, reason: 'SAME_EXCHANGE' });
  });

  it('[spec] Key mismatch rejected (reverse-quoted contract)', () => {
    const long = makeInstrument({ exchange: 'Binance', instrument_key: 'BTC/USDT:USDT' });
    const short = makeInstrument({
      exchange: 'Pionex',
      instrument_id: 'Pionex:USDT_BTC_PERP',
      instrument_key: 'USDT/BTC:BTC',
      base_asset: 'USDT',
      quote_asset: 'BTC',
      contract_type: 'INVERSE_PERPETUAL',
    });
    expect(matchPair(long, short, OPTS)).toMatchObject({ matched: false, reason: 'KEY_MISMATCH' });
  });

  it('[spec] 4h leg and 8h leg at different times rejected', () => {
    const long = makeInstrument({ exchange: 'Binance', funding: { ...makeInstrument().funding, next_funding_time: 1000, funding_interval_hours: 4 } });
    const short = makeInstrument({ exchange: 'OKX', funding: { ...makeInstrument().funding, next_funding_time: 1000 + 4 * 3600 * 1000, funding_interval_hours: 8 } });
    expect(matchPair(long, short, OPTS)).toMatchObject({ matched: false, reason: 'FUNDING_NOT_ALIGNED' });
  });

  it('[spec] Delisting leg rejected', () => {
    const long = makeInstrument({ exchange: 'Binance', status: 'DELISTING' });
    const short = makeInstrument({ exchange: 'Bybit' });
    expect(matchPair(long, short, OPTS)).toMatchObject({ matched: false, reason: 'NOT_TRADING' });
  });

  it('[spec] TradFi leg rejected', () => {
    const long = makeInstrument({ exchange: 'Binance', contract_type: 'TRADFI_PERPETUAL' });
    const short = makeInstrument({ exchange: 'Bybit' });
    expect(matchPair(long, short, OPTS)).toMatchObject({ matched: false, reason: 'CONTRACT_TYPE_NOT_PAIRABLE' });
  });

  it('[spec] Missing funding time rejected', () => {
    const long = makeInstrument({ exchange: 'Binance' });
    const short = makeInstrument({
      exchange: 'Bitget',
      funding: { ...makeInstrument().funding, schedule_status: 'MISSING', next_funding_time: null },
    });
    expect(matchPair(long, short, OPTS)).toMatchObject({ matched: false, reason: 'FUNDING_TIME_MISSING' });
  });

  it('[spec] 1000x pair normalizes prices', () => {
    const long = makeInstrument({
      exchange: 'Binance',
      instrument_id: 'Binance:1000PEPEUSDT',
      instrument_key: 'PEPE/USDT:USDT',
      price_multiplier: 1000,
    });
    const short = makeInstrument({
      exchange: 'Bitget',
      instrument_id: 'Bitget:PEPEUSDT',
      instrument_key: 'PEPE/USDT:USDT',
      price_multiplier: 1,
    });
    const result = matchPair(long, short, {
      ...OPTS,
      prices: { long: 0.004295, short: 0.000004296 },
    });
    expect(result.matched).toBe(true);
  });

  it('[spec] Same ticker different asset rejected by price guard', () => {
    const long = makeInstrument({ exchange: 'Binance', instrument_id: 'Binance:ONUSDT' });
    const short = makeInstrument({ exchange: 'Bybit', instrument_id: 'Bybit:ONUSDT' });
    const result = matchPair(long, short, { ...OPTS, prices: { long: 0.1161, short: 75.91 } });
    expect(result).toMatchObject({ matched: false, reason: 'PRICE_MISMATCH' });
  });

  it('[spec] Ambiguous instrument rejected', () => {
    const long = makeInstrument({ exchange: 'Binance', ambiguous: true });
    const short = makeInstrument({ exchange: 'Bybit' });
    expect(matchPair(long, short, OPTS)).toMatchObject({ matched: false, reason: 'AMBIGUOUS_INSTRUMENT' });
  });
});

describe('candidatePairs', () => {
  it('enumerates all cross-exchange combinations with their results', () => {
    const a = makeInstrument({ exchange: 'Binance', instrument_id: 'Binance:BTCUSDT' });
    const b = makeInstrument({ exchange: 'Bybit', instrument_id: 'Bybit:BTCUSDT' });
    const c = makeInstrument({ exchange: 'OKX', instrument_id: 'OKX:BTC-USDT-SWAP', status: 'DELISTING' });
    const results = candidatePairs([a, b, c], OPTS);
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.result.matched)).toHaveLength(1);
  });
});
