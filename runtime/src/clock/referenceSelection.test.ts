import { describe, expect, it } from 'vitest';
import { selectReference } from './referenceSelection';

describe('selectReference (shared by VirtualClock and RealClock)', () => {
  it('picks the first healthy exchange in priority order', () => {
    const result = selectReference(['Binance', 'Bybit', 'OKX'], (ex) => ex !== 'Binance', null);
    expect(result).toEqual({ reference: 'Bybit', changed: false });
  });

  it('reports changed=true when the reference differs from the previous one', () => {
    const result = selectReference(['Binance', 'Bybit', 'OKX'], (ex) => ex !== 'Binance', 'Binance');
    expect(result).toEqual({ reference: 'Bybit', changed: true });
  });

  it('falls back to the first priority entry when nothing is healthy', () => {
    const result = selectReference(['Binance', 'Bybit'], () => false, null);
    expect(result.reference).toBe('Binance');
  });
});
