import { describe, expect, it } from 'vitest';
import { normalizeOkxInstruments } from './instruments';

// Fixture: 節錄自 GET /api/v5/public/instruments?instType=SWAP 的真實欄位形狀。
const instruments = [
  {
    instId: 'BTC-USDT-SWAP',
    ctType: 'linear',
    ctValCcy: 'BTC',
    ctVal: '0.01',
    ctMult: '1',
    settleCcy: 'USDT',
    state: 'live',
    tickSz: '0.1',
    lotSz: '1',
    minSz: '1',
  },
  {
    instId: 'PEPE-USDT-SWAP',
    ctType: 'linear',
    ctValCcy: 'PEPE',
    ctVal: '10000000',
    ctMult: '1',
    settleCcy: 'USDT',
    state: 'live',
    tickSz: '0.0001',
    lotSz: '1',
    minSz: '1',
  },
  {
    instId: 'BTC-USD-SWAP',
    ctType: 'inverse',
    ctValCcy: 'BTC',
    ctVal: '100',
    ctMult: '1',
    settleCcy: 'BTC',
    state: 'live',
    tickSz: '0.1',
    lotSz: '1',
    minSz: '1',
  },
  {
    instId: 'FOO-USDT-SWAP',
    ctType: 'linear',
    ctValCcy: 'FOO',
    ctVal: '1',
    ctMult: '1',
    settleCcy: 'USDT',
    state: 'suspend',
    tickSz: '0.1',
    lotSz: '1',
    minSz: '1',
  },
];

const fundingRates = [
  { instId: 'BTC-USDT-SWAP', fundingTime: '1700000000000', nextFundingTime: '1700014400000' },
];

describe('normalizeOkxInstruments', () => {
  const result = normalizeOkxInstruments({ instruments, fundingRates, now: 1000 });
  const byId = new Map(result.map((r) => [r.instrument_id, r]));

  it('[spec] ctVal/ctMult drive qty_unit_in_base while price_multiplier is 1', () => {
    const pepe = byId.get('OKX:PEPE-USDT-SWAP')!;
    expect(pepe.base_asset).toBe('PEPE');
    expect(pepe.price_multiplier).toBe(1);
    expect(pepe.qty_unit_in_base).toBe(10_000_000);
    expect(pepe.multiplier_source).toBe('METADATA');
  });

  it('ctType inverse maps to INVERSE_PERPETUAL', () => {
    expect(byId.get('OKX:BTC-USD-SWAP')!.contract_type).toBe('INVERSE_PERPETUAL');
  });

  it('ctType linear maps to LINEAR_PERPETUAL', () => {
    expect(byId.get('OKX:BTC-USDT-SWAP')!.contract_type).toBe('LINEAR_PERPETUAL');
  });

  it('[spec] interval derived from fundingTime/nextFundingTime difference', () => {
    const btc = byId.get('OKX:BTC-USDT-SWAP')!;
    expect(btc.funding.next_funding_time).toBe(1_700_000_000_000);
    expect(btc.funding.funding_interval_hours).toBe(4);
    expect(btc.funding.interval_source).toBe('DERIVED_FROM_TIMES');
  });

  it('missing funding-rate entry leaves schedule MISSING', () => {
    const pepe = byId.get('OKX:PEPE-USDT-SWAP')!;
    expect(pepe.funding.schedule_status).toBe('MISSING');
    expect(pepe.funding.interval_source).toBe('UNKNOWN');
  });

  it('unknown state maps to UNKNOWN status', () => {
    expect(byId.get('OKX:FOO-USDT-SWAP')!.status).toBe('UNKNOWN');
  });
});
