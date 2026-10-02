// @vitest-environment jsdom
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaperEventStream, type SeqEvent, type UsePaperEventStreamResult } from './usePaperEventStream';
import type { GlobalEventsResponse, TradingEvent } from '../api/contracts';

type Listener = (ev: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners: Record<string, Listener[]> = {};
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: Listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
  emit(type: string, payload: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(payload);
  }
  emitOpen() {
    this.emit('open', {});
  }
  emitMessage(data: unknown) {
    this.emit('message', { data: JSON.stringify(data) });
  }
}

function baseEvent(overrides: Partial<TradingEvent> & { event_id: string; timestamp: number }): TradingEvent {
  return {
    event_type: 'ORDER_FILL',
    trade_id: null,
    payload: {},
    recorded_at: overrides.timestamp,
    ...overrides,
  };
}

function Probe(props: {
  getEventsAfter: (afterSeq: number, signal: AbortSignal) => Promise<GlobalEventsResponse>;
  onRender: (s: UsePaperEventStreamResult) => void;
  onTradeEvent?: (tradeId: string) => void;
}) {
  const state = usePaperEventStream({
    source: {
      kind: 'live',
      url: 'ws://test/ws/paper',
      getEventsAfter: props.getEventsAfter,
      createSocket: (url: string) => new FakeWebSocket(url) as unknown as WebSocket,
    },
    onTradeEvent: props.onTradeEvent,
  });
  props.onRender(state);
  return null;
}

describe('usePaperEventStream (live)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reaches CONNECTED on open and backfills once connected', async () => {
    const getEventsAfter = vi.fn(async () => ({ items: [] }) as GlobalEventsResponse);
    const states: UsePaperEventStreamResult[] = [];
    render(<Probe getEventsAfter={getEventsAfter} onRender={(s) => states.push(s)} />);

    expect(states[0].status).toBe('CONNECTING');
    act(() => FakeWebSocket.instances[0].emitOpen());

    await waitFor(() => expect(states[states.length - 1].status).toBe('CONNECTED'));
    expect(getEventsAfter).toHaveBeenCalledTimes(1);
  });

  it('dedupes by event_id and sorts by (timestamp, seq)', async () => {
    const getEventsAfter = vi.fn(async () => ({ items: [] }) as GlobalEventsResponse);
    const states: UsePaperEventStreamResult[] = [];
    render(<Probe getEventsAfter={getEventsAfter} onRender={(s) => states.push(s)} />);
    act(() => FakeWebSocket.instances[0].emitOpen());
    await waitFor(() => expect(states[states.length - 1].status).toBe('CONNECTED'));

    act(() => {
      FakeWebSocket.instances[0].emitMessage({
        type: 'event',
        seq: 125,
        event: baseEvent({ event_id: 'e-125', timestamp: 2000 }),
      });
      FakeWebSocket.instances[0].emitMessage({
        type: 'event',
        seq: 125,
        event: baseEvent({ event_id: 'e-125', timestamp: 2000 }),
      });
      FakeWebSocket.instances[0].emitMessage({
        type: 'event',
        seq: 121,
        event: baseEvent({ event_id: 'e-121', timestamp: 1000 }),
      });
    });

    await waitFor(() => expect(states[states.length - 1].events.length).toBe(2));
    const last = states[states.length - 1];
    expect(last.events.map((e: SeqEvent) => e.event_id)).toEqual(['e-121', 'e-125']);
  });

  it('keeps only the newest 500 events when more arrive (buffer cap)', async () => {
    const getEventsAfter = vi.fn(async () => ({ items: [] }) as GlobalEventsResponse);
    const states: UsePaperEventStreamResult[] = [];
    render(<Probe getEventsAfter={getEventsAfter} onRender={(s) => states.push(s)} />);
    act(() => FakeWebSocket.instances[0].emitOpen());
    await waitFor(() => expect(states[states.length - 1].status).toBe('CONNECTED'));

    act(() => {
      for (let i = 0; i < 800; i++) {
        FakeWebSocket.instances[0].emitMessage({
          type: 'event',
          seq: i + 1,
          event: baseEvent({ event_id: `e-${i}`, timestamp: i }),
        });
      }
    });

    await waitFor(() => expect(states[states.length - 1].events.length).toBe(500));
  });

  it('notifies onTradeEvent (debounced) when a trade-scoped event arrives', async () => {
    vi.useFakeTimers();
    const getEventsAfter = vi.fn(async () => ({ items: [] }) as GlobalEventsResponse);
    const onTradeEvent = vi.fn();
    const states: UsePaperEventStreamResult[] = [];
    render(<Probe getEventsAfter={getEventsAfter} onRender={(s) => states.push(s)} onTradeEvent={onTradeEvent} />);
    act(() => FakeWebSocket.instances[0].emitOpen());

    act(() => {
      FakeWebSocket.instances[0].emitMessage({
        type: 'event',
        seq: 1,
        event: baseEvent({ event_id: 'e-1', timestamp: 1, trade_id: 'trade-x' }),
      });
    });
    expect(onTradeEvent).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    expect(onTradeEvent).toHaveBeenCalledWith('trade-x');
  });

  it('cleans up on unmount: closes the socket and stops further state updates', async () => {
    const getEventsAfter = vi.fn(async () => ({ items: [] }) as GlobalEventsResponse);
    const onRender = vi.fn();
    const { unmount } = render(<Probe getEventsAfter={getEventsAfter} onRender={onRender} />);
    act(() => FakeWebSocket.instances[0].emitOpen());
    await waitFor(() => expect(onRender.mock.calls.at(-1)?.[0].status).toBe('CONNECTED'));

    const socket = FakeWebSocket.instances[0];
    const renderCountBefore = onRender.mock.calls.length;
    unmount();
    expect(socket.closed).toBe(true);

    act(() => socket.emitMessage({ type: 'event', seq: 999, event: baseEvent({ event_id: 'late', timestamp: 1 }) }));
    expect(onRender.mock.calls.length).toBe(renderCountBefore);
  });
});
