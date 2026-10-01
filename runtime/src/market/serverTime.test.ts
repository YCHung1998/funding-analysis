import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock/virtualClock';
import type { TradingEvent } from '../types/event';
import type { EventSink } from './instruments/types';
import { GuardedRestClient } from './http/guardedRestClient';
import { SourceStatusTracker } from './sourceStatus';
import { queryServerTime } from './serverTime';
import type { MarketDataAdapter } from './types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

function makeClient(clock: VirtualClock, fetchImpl: typeof fetch) {
  const sink: EventSink = { emit: () => {} };
  return new GuardedRestClient({
    clock,
    eventSink: sink,
    rateLimitRules: { Bybit: [] } as any,
    sourceStatus: new SourceStatusTracker({ eventSink: sink, now: () => clock.now() }),
    fetchImpl,
  });
}

describe('queryServerTime', () => {
  it('carries local send/receive time around the exchange server_time', async () => {
    const clock = new VirtualClock(1000);
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      clock.advanceTo(1040);
      return jsonResponse({ time: 1100 });
    };
    const client = makeClient(clock, fetchImpl);
    const adapter: Pick<MarketDataAdapter, 'exchange' | 'serverTime'> = {
      exchange: 'Bybit',
      serverTime: {
        request: () => ({ exchange: 'Bybit', url: 'https://api.bybit.com/v5/market/time' }),
        parse: (body: any) => body.time,
      },
    };

    const sample = await queryServerTime(client, adapter);
    expect(sample).toEqual({ exchange: 'Bybit', server_time: 1100, local_sent: 1000, local_received: 1040 });
    expect(call).toBe(1);
  });

  it('does not coalesce concurrent calls for the same exchange', async () => {
    const clock = new VirtualClock(0);
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      return jsonResponse({ time: 500 + call });
    };
    const client = makeClient(clock, fetchImpl);
    const adapter: Pick<MarketDataAdapter, 'exchange' | 'serverTime'> = {
      exchange: 'Binance',
      serverTime: {
        request: () => ({ exchange: 'Binance', url: 'https://fapi.binance.com/fapi/v1/time' }),
        parse: (body: any) => body.time,
      },
    };

    const [a, b] = await Promise.all([queryServerTime(client, adapter), queryServerTime(client, adapter)]);
    expect(call).toBe(2);
    expect(a.server_time).not.toBe(b.server_time);
  });
});
