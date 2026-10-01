import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../clock/virtualClock';
import type { TradingEvent } from '../../types/event';
import type { EventSink } from '../instruments/types';
import type { RateLimitRule } from '../types';
import { SourceStatusTracker } from '../sourceStatus';
import { GuardedRestClient } from './guardedRestClient';
import { UpstreamError } from './publicRestClient';

function makeSink() {
  const events: TradingEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  return { events, sink };
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: init?.headers ?? {} });
}

describe('GuardedRestClient', () => {
  it('coalesces concurrent identical requests into one upstream call (single-flight)', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    let upstreamCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      upstreamCalls += 1;
      return jsonResponse({ ok: true });
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: [] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });

    const req = { exchange: 'Bybit' as const, url: 'https://api.bybit.com/v5/market/tickers?category=linear' };
    const results = await Promise.all(Array.from({ length: 50 }, () => client.getJson(req)));

    expect(upstreamCalls).toBe(1);
    expect(results).toHaveLength(50);
    for (const r of results) expect(r.data).toEqual({ ok: true });
  });

  it('shares the same UpstreamError across coalesced callers', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    const fetchImpl: typeof fetch = async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: [] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });
    const req = { exchange: 'Bybit' as const, url: 'https://api.bybit.com/v5/market/tickers?category=linear' };

    const settled = await Promise.allSettled(Array.from({ length: 50 }, () => client.getJson(req)));
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      if (s.status === 'rejected') expect((s.reason as UpstreamError).kind).toBe('TIMEOUT');
    }
  });

  it('issues a new upstream call after the first one has settled', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    let upstreamCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      upstreamCalls += 1;
      return jsonResponse({ n: upstreamCalls });
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: [] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });
    const req = { exchange: 'Bybit' as const, url: 'https://api.bybit.com/v5/market/tickers?category=linear' };

    await client.getJson(req);
    await client.getJson(req);
    expect(upstreamCalls).toBe(2);
  });

  it('classifies an OKX 429 body as RATE_LIMITED, not data', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: '50011' }, { status: 429 });
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { OKX: [] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });
    await expect(client.getJson({ exchange: 'OKX', url: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP' })).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
      http_status: 429,
    });
  });

  it('classifies a Bybit HTTP 200 envelope error (retCode != 0) as API_ERROR', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    const fetchImpl: typeof fetch = async () => jsonResponse({ retCode: 10006, result: {} });
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: [] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
      envelopeError: (_ex, body: any) => (body?.retCode !== undefined && body.retCode !== 0 ? `retCode ${body.retCode}` : null),
    });
    await expect(client.getJson({ exchange: 'Bybit', url: 'https://api.bybit.com/v5/market/tickers?category=linear' })).rejects.toMatchObject({
      kind: 'API_ERROR',
    });
  });

  it('drives rate-limit budget from the Binance weight header and doubles the soft-cap poll multiplier', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    const fetchImpl: typeof fetch = async () => jsonResponse([], { headers: { 'X-MBX-USED-WEIGHT-1M': '1700' } });
    const rule: RateLimitRule = {
      name: 'weight-1m',
      window_ms: 60_000,
      limit: 2400,
      unit: 'WEIGHT',
      usage_header: 'x-mbx-used-weight-1m',
      block_statuses: [429, 418],
      cooldown_ms: 120_000,
      verified: true,
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Binance: [rule] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });

    await client.getJson({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' });

    const status = client.rateLimiter('Binance' as any).status();
    expect(status.used).toBe(1700);
    expect(client.rateLimiter('Binance' as any).pollIntervalMultiplier()).toBe(2);
  });

  it('defers the 11th request within a 1 rps window instead of exceeding it', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    let upstreamCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      upstreamCalls += 1;
      return jsonResponse({ n: upstreamCalls });
    };
    const rule: RateLimitRule = {
      name: 'per-second',
      window_ms: 1000,
      limit: 10,
      unit: 'REQUESTS',
      block_statuses: [429],
      cooldown_ms: 60_000,
      verified: true,
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Pionex: [rule] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });
    const req = { exchange: 'Pionex' as const, url: 'https://api.pionex.com/api/v1/market/indexes' };

    for (let i = 0; i < 10; i++) {
      await client.getJson({ ...req, url: `${req.url}?i=${i}` });
    }
    expect(upstreamCalls).toBe(10);

    const eleventh = client.getJson({ ...req, url: `${req.url}?i=10` });
    await Promise.resolve();
    await Promise.resolve();
    expect(upstreamCalls).toBe(10); // 尚未送出，延後中

    clock.advanceTo(1000);
    await eleventh;
    expect(upstreamCalls).toBe(11);
  });

  it('opens the circuit for max(Retry-After, rule cooldown) on Bybit 403', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    let upstreamCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      upstreamCalls += 1;
      return jsonResponse({}, { status: 403 });
    };
    const rule: RateLimitRule = {
      name: 'ip',
      window_ms: 5000,
      limit: 600,
      unit: 'REQUESTS',
      block_statuses: [403],
      cooldown_ms: 600_000,
      verified: true,
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: [rule] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });

    await expect(client.getJson({ exchange: 'Bybit', url: 'https://api.bybit.com/v5/market/tickers?category=linear' })).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(upstreamCalls).toBe(1);

    clock.advanceTo(599_000);
    await expect(client.getJson({ exchange: 'Bybit', url: 'https://api.bybit.com/v5/market/tickers?category=linear' })).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(upstreamCalls).toBe(1); // 冷卻期間 0 次上游請求
  });

  it('keeps the circuit open for Retry-After when it exceeds the rule cooldown (Binance 418)', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    let upstreamCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      upstreamCalls += 1;
      return jsonResponse({}, { status: 418, headers: { 'retry-after': '180' } });
    };
    const rule: RateLimitRule = {
      name: 'weight-1m',
      window_ms: 60_000,
      limit: 2400,
      unit: 'WEIGHT',
      block_statuses: [418, 429],
      cooldown_ms: 120_000,
      verified: true,
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Binance: [rule] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });

    await expect(client.getJson({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' })).rejects.toMatchObject({ kind: 'RATE_LIMITED' });

    clock.advanceTo(150_000); // > 120s rule cooldown but < 180s retry-after
    await expect(client.getJson({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' })).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(upstreamCalls).toBe(1);
  });

  it('only sends one HALF_OPEN probe request when 3 are pending after cooldown', async () => {
    const clock = new VirtualClock(0);
    const { sink } = makeSink();
    let upstreamCalls = 0;
    let shouldFail = true;
    const fetchImpl: typeof fetch = async () => {
      upstreamCalls += 1;
      if (shouldFail) return jsonResponse({}, { status: 403 });
      return jsonResponse({ ok: true });
    };
    const rule: RateLimitRule = {
      name: 'ip',
      window_ms: 5000,
      limit: 600,
      unit: 'REQUESTS',
      block_statuses: [403],
      cooldown_ms: 1000,
      verified: true,
    };
    const client = new GuardedRestClient({
      clock,
      eventSink: sink,
      rateLimitRules: { Bybit: [rule] } as any,
      sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
      fetchImpl,
    });
    const req = { exchange: 'Bybit' as const, url: 'https://api.bybit.com/v5/market/tickers?category=linear' };

    await expect(client.getJson(req)).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(upstreamCalls).toBe(1);

    clock.advanceTo(1000);
    shouldFail = false;

    const [a, b, c] = [client.getJson({ ...req, url: `${req.url}&a=1` }), client.getJson({ ...req, url: `${req.url}&b=1` }), client.getJson({ ...req, url: `${req.url}&c=1` })];
    const settled = await Promise.allSettled([a, b, c]);
    // 只有一個探測請求真正送出；其餘因 circuit 非 CLOSED 被拒（CIRCUIT_OPEN，HALF_OPEN 不接受第二個）。
    expect(upstreamCalls).toBe(2); // 1 次第一回合的 403 + 1 次探測
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
  });
});
