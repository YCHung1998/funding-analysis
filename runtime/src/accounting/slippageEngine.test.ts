import { describe, expect, it } from 'vitest';
import { topOfBook, walkBook, withBuffer } from './slippageEngine';

describe('walkBook', () => {
  it('[Scenario] BUY 逐檔吃單均價 100.006', () => {
    const book = {
      bids: [{ price: 99.99, quantity: 1000 }],
      asks: [
        { price: 100.0, quantity: 100 },
        { price: 100.01, quantity: 200 },
        { price: 100.03, quantity: 300 },
      ],
    };
    const result = walkBook('BUY', 250, book);
    expect(result.model).toBe('ORDERBOOK');
    expect(result.expected_avg_price).toBeCloseTo(100.006, 6);
    expect(result.reference_price).toBeCloseTo(99.995, 6);
    expect(result.expected_slippage_usdt).toBeCloseTo(2.75, 2);
    expect(result.expected_slippage_pct).toBeCloseTo(0.00011, 6);
    expect(result.depth_sufficient).toBe(true);
    expect(result.fillable_quantity).toBe(250);
  });

  it('[Scenario] SELL 逐檔吃單', () => {
    const book = {
      bids: [
        { price: 99.99, quantity: 50 },
        { price: 99.98, quantity: 100 },
      ],
      asks: [{ price: 100.0, quantity: 1000 }],
    };
    const result = walkBook('SELL', 100, book);
    expect(result.expected_avg_price).toBeCloseTo(99.985, 6);
    expect(result.expected_slippage_usdt).toBeCloseTo(1.0, 2);
    expect(result.expected_slippage_pct).toBeCloseTo(0.0001, 6);
  });

  it('[Scenario] 深度不足', () => {
    const book = {
      bids: [{ price: 99.99, quantity: 1000 }],
      asks: [
        { price: 100.0, quantity: 300 },
        { price: 100.01, quantity: 300 },
      ],
    };
    const result = walkBook('BUY', 700, book);
    expect(result.depth_sufficient).toBe(false);
    expect(result.fillable_quantity).toBe(600);
    expect(result.reason).toBe('INSUFFICIENT_DEPTH');
  });

  it('輸入驗證：quantity 非正數或非有限時拋出', () => {
    const book = { bids: [{ price: 99, quantity: 10 }], asks: [{ price: 101, quantity: 10 }] };
    expect(() => walkBook('BUY', 0, book)).toThrow(TypeError);
    expect(() => walkBook('BUY', NaN, book)).toThrow(TypeError);
    expect(() => walkBook('BUY', -5, book)).toThrow(TypeError);
  });

  it('空盤口（無 bid/ask）拋出，呼叫端應改用 topOfBook/UNAVAILABLE 判斷', () => {
    expect(() => walkBook('BUY', 10, { bids: [], asks: [] })).toThrow(TypeError);
  });
});

describe('topOfBook', () => {
  it('[Scenario] 冷門合約半價差：bid 23.91 / ask 23.96', () => {
    const result = topOfBook('BUY', 10, { bestBid: 23.91, bestAsk: 23.96 });
    expect(result.model).toBe('TOP_OF_BOOK');
    expect(result.expected_slippage_pct).toBeCloseTo(0.0010445, 6);
  });

  it('輸入驗證：NaN bid/ask 拋出', () => {
    expect(() => topOfBook('BUY', 10, { bestBid: NaN, bestAsk: 100 })).toThrow(TypeError);
  });
});

describe('withBuffer', () => {
  it('[Scenario] Buffer 疊加：BUY 250 案例加上 0.0001', () => {
    const book = {
      bids: [{ price: 99.99, quantity: 1000 }],
      asks: [
        { price: 100.0, quantity: 100 },
        { price: 100.01, quantity: 200 },
        { price: 100.03, quantity: 300 },
      ],
    };
    const base = walkBook('BUY', 250, book);
    const buffered = withBuffer(base, 0.0001, 250);
    expect(buffered.slippage_with_buffer_pct).toBeCloseTo(0.00021, 5);
    expect(buffered.slippage_with_buffer_usdt).toBeCloseTo(5.25, 1);
  });

  it('buffer 為 0 時兩者相等', () => {
    const base = topOfBook('BUY', 10, { bestBid: 99, bestAsk: 101 });
    const buffered = withBuffer(base, 0, 10);
    expect(buffered.slippage_with_buffer_pct).toBeCloseTo(base.expected_slippage_pct, 9);
    expect(buffered.slippage_with_buffer_usdt).toBeCloseTo(base.expected_slippage_usdt, 9);
  });

  it('輸入驗證：非有限 buffer 拋出', () => {
    const base = topOfBook('BUY', 10, { bestBid: 99, bestAsk: 101 });
    expect(() => withBuffer(base, NaN, 10)).toThrow(TypeError);
    expect(() => withBuffer(base, Infinity, 10)).toThrow(TypeError);
  });
});
