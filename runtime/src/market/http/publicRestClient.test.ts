import { describe, expect, it, vi } from 'vitest';
import { BasicRestClient, UpstreamError } from './publicRestClient';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('BasicRestClient', () => {
  it('returns parsed JSON with timestamps on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    let tick = 100;
    const client = new BasicRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch, localNow: () => tick++ });
    const result = await client.getJson({ exchange: 'Binance', url: 'https://example.test/x' });
    expect(result.data).toEqual({ ok: true });
    expect(result.http_status).toBe(200);
    expect(result.local_sent).toBe(100);
    expect(result.local_received).toBe(101);
  });

  it('[spec] non-2xx throws UpstreamError, not an empty array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
    const client = new BasicRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch, localNow: () => 0 });
    await expect(client.getJson({ exchange: 'Binance', url: 'https://example.test/x' })).rejects.toThrow(UpstreamError);
  });

  it('429 maps to RATE_LIMITED with retry_after_ms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }));
    const client = new BasicRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch, localNow: () => 0 });
    try {
      await client.getJson({ exchange: 'Binance', url: 'https://example.test/x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      expect((err as UpstreamError).kind).toBe('RATE_LIMITED');
      expect((err as UpstreamError).retry_after_ms).toBe(2000);
    }
  });

  it('network error maps to NETWORK kind', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const client = new BasicRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch, localNow: () => 0 });
    try {
      await client.getJson({ exchange: 'Binance', url: 'https://example.test/x' });
      expect.unreachable();
    } catch (err) {
      expect((err as UpstreamError).kind).toBe('NETWORK');
    }
  });

  it('JSON parse error maps to PARSE kind', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const client = new BasicRestClient({ fetchImpl: fetchImpl as unknown as typeof fetch, localNow: () => 0 });
    try {
      await client.getJson({ exchange: 'Binance', url: 'https://example.test/x' });
      expect.unreachable();
    } catch (err) {
      expect((err as UpstreamError).kind).toBe('PARSE');
    }
  });
});
