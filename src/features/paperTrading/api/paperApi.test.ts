import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompletedTrades, getEventsAfter, getTradeDetail, getTradeEvents } from './paperApi';

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('paperApi request shapes (FE-01 / Invariant #2: GET + AbortSignal only)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getTradeDetail issues GET /api/paper/trades/:id with the AbortSignal', async () => {
    const controller = new AbortController();
    await getTradeDetail('trade-123', controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/paper/trades/trade-123', {
      method: 'GET',
      signal: controller.signal,
    });
  });

  it('getCompletedTrades encodes final_status and cursor as query params', async () => {
    const controller = new AbortController();
    await getCompletedTrades({ finalStatus: 'EMERGENCY_EXIT', cursor: 'abc' }, controller.signal);
    const [path] = fetchMock.mock.calls[0];
    expect(path).toContain('scope=completed');
    expect(path).toContain('final_status=EMERGENCY_EXIT');
    expect(path).toContain('cursor=abc');
    expect(path).toContain('limit=50');
  });

  it('getCompletedTrades omits final_status when filter is ALL', async () => {
    const controller = new AbortController();
    await getCompletedTrades({ finalStatus: 'ALL', cursor: null }, controller.signal);
    const [path] = fetchMock.mock.calls[0];
    expect(path).not.toContain('final_status');
  });

  it('getTradeEvents paginates with cursor + default limit 200', async () => {
    const controller = new AbortController();
    await getTradeEvents('trade-123', { cursor: null }, controller.signal);
    const [path] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/paper/trades/trade-123/events?limit=200');
  });

  it('getEventsAfter requests after_seq with default limit 500', async () => {
    const controller = new AbortController();
    await getEventsAfter(120, controller.signal);
    const [path] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/paper/events?after_seq=120&limit=500');
  });

  it('every call uses method GET only', async () => {
    const controller = new AbortController();
    await getTradeDetail('t1', controller.signal);
    await getEventsAfter(0, controller.signal);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.method).toBe('GET');
    }
  });
});
