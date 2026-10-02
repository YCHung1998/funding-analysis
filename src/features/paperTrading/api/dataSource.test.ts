import { describe, expect, it } from 'vitest';
import { mockDataSource, resolveDataSourceKind } from './dataSource';

describe('resolveDataSourceKind', () => {
  it('defaults to live when VITE_PAPER_DATA_SOURCE is unset (design.md Decision 9)', () => {
    expect(resolveDataSourceKind()).toBe('live');
  });
});

describe('mockDataSource', () => {
  it('serves the mock AccountSnapshot without any network access', async () => {
    const controller = new AbortController();
    const account = await mockDataSource.getAccount(controller.signal);
    expect(account.total_capital_usdt).toBeGreaterThan(0);
  });

  it('paginates completed trades at the requested page size', async () => {
    const controller = new AbortController();
    const page = await mockDataSource.getCompletedTrades(
      { finalStatus: 'ALL', cursor: null, limit: 2 },
      controller.signal,
    );
    expect(page.items.length).toBeLessThanOrEqual(2);
  });

  it('filters completed trades by final_status', async () => {
    const controller = new AbortController();
    const page = await mockDataSource.getCompletedTrades(
      { finalStatus: 'EMERGENCY_EXIT', cursor: null },
      controller.signal,
    );
    expect(page.items.every((t) => t.result.final_status === 'EMERGENCY_EXIT')).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('throws for an unknown trade id instead of returning fabricated data', async () => {
    const controller = new AbortController();
    await expect(mockDataSource.getTradeDetail('does-not-exist', controller.signal)).rejects.toThrow();
  });

  it('rejects in-flight calls when the signal is aborted', async () => {
    const controller = new AbortController();
    const promise = mockDataSource.getAccount(controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
