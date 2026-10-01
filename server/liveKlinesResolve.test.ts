import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../runtime/src/market/instruments/registry';
import type { EventSink, InstrumentSnapshotInput } from '../runtime/src/market/instruments/types';
import { resolveKlinesSymbol } from './liveKlinesResolve';

function makeInput(overrides: Partial<InstrumentSnapshotInput>): InstrumentSnapshotInput {
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

const noopSink: EventSink = { emit: () => {} };

describe('resolveKlinesSymbol', () => {
  it('[spec] Klines resolves 1000x symbol per exchange', () => {
    const registry = new InstrumentRegistry(noopSink);
    registry.applySnapshot(
      'Binance',
      [makeInput({ instrument_id: 'Binance:1000PEPEUSDT', native_symbol: '1000PEPEUSDT', instrument_key: 'PEPE/USDT:USDT', base_asset: 'PEPE', listed_base_asset: '1000PEPE', price_multiplier: 1000 })],
      1000,
    );
    registry.applySnapshot(
      'Pionex',
      [makeInput({ instrument_id: 'Pionex:PEPE_USDT_PERP', exchange: 'Pionex', native_symbol: 'PEPE_USDT_PERP', instrument_key: 'PEPE/USDT:USDT', base_asset: 'PEPE', listed_base_asset: 'PEPE' })],
      1000,
    );

    const result = resolveKlinesSymbol('1000PEPEUSDT', registry);
    expect(result).toMatchObject({
      ok: true,
      resolution: { binance_native_symbol: '1000PEPEUSDT', pionex_native_symbol: 'PEPE_USDT_PERP' },
    });
  });

  it('[spec] Invalid klines symbol rejected', () => {
    const registry = new InstrumentRegistry(noopSink);
    const result = resolveKlinesSymbol('BTCUSDT&limit=1500', registry);
    expect(result).toEqual({ ok: false, reason: 'INVALID_SYMBOL' });
  });

  it('symbol not found in registry', () => {
    const registry = new InstrumentRegistry(noopSink);
    const result = resolveKlinesSymbol('NOPEUSDT', registry);
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});
