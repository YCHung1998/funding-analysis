/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `usePaperEventStream` (design.md Decision 5, FE-04).
 *
 * Connects to `server.ts`'s `/ws/paper` WebSocket, tracks connection status
 * (`CONNECTING -> CONNECTED -> RECONNECTING -> DISCONNECTED`), reconnects
 * with exponential backoff (1s, 2s, 4s, ... capped at 30s, ±20% jitter),
 * and on reconnect backfills missed events via `getEventsAfter(lastSeq)`
 * (assumption A-9). Events are deduped by `event_id` and kept sorted by
 * `(timestamp, seq)` in a bounded ring buffer (default 500). Trade-scoped
 * events are reported (debounced 250ms per trade) via `onTradeEvent` so a
 * caller can re-fetch that trade's REST snapshot — this hook itself never
 * writes/derives trade state (spec.md "UI 只觀察 Runtime 狀態").
 *
 * In `mock` mode (design.md Decision 9) there is no real WebSocket: the
 * hook replays `source.events` on a fixed interval, cycling, so the Event
 * Stream panel has something to show while clearly mock-labeled elsewhere
 * (`MockBadge` / `MOCK DATA` banner) by the caller.
 */
import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import type { GlobalEventsResponse, RuntimeHealth, TradingEvent } from '../api/contracts';

export type PaperEventStreamStatus = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

export type SeqEvent = TradingEvent & { seq: number };

export interface PaperEventStreamLiveSource {
  kind: 'live';
  url: string;
  getEventsAfter: (afterSeq: number, signal: AbortSignal, limit?: number) => Promise<GlobalEventsResponse>;
  /** Injectable for tests; defaults to `window.WebSocket`. */
  createSocket?: (url: string) => WebSocket;
}

export interface PaperEventStreamMockSource {
  kind: 'mock';
  events: SeqEvent[];
  /** ms between replayed events; default 1500. */
  intervalMs?: number;
}

export type PaperEventStreamSource = PaperEventStreamLiveSource | PaperEventStreamMockSource;

export interface UsePaperEventStreamOptions {
  source: PaperEventStreamSource;
  bufferSize?: number;
  onTradeEvent?: (tradeId: string) => void;
  tradeEventDebounceMs?: number;
}

export interface UsePaperEventStreamResult {
  status: PaperEventStreamStatus;
  events: SeqEvent[];
  health: RuntimeHealth | null;
}

type BufferAction = { type: 'add'; events: SeqEvent[] } | { type: 'reset' };

interface BufferState {
  events: SeqEvent[];
  seenIds: Set<string>;
}

function bufferReducer(state: BufferState, action: BufferAction, bufferSize: number): BufferState {
  if (action.type === 'reset') return { events: [], seenIds: new Set() };
  const seenIds = new Set(state.seenIds);
  const merged = [...state.events];
  for (const e of action.events) {
    if (seenIds.has(e.event_id)) continue;
    seenIds.add(e.event_id);
    merged.push(e);
  }
  merged.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  const trimmed = merged.slice(Math.max(0, merged.length - bufferSize));
  const trimmedIds = new Set(trimmed.map((e) => e.event_id));
  return { events: trimmed, seenIds: trimmedIds };
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function backoffDelay(attempt: number): number {
  const raw = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

export function usePaperEventStream(options: UsePaperEventStreamOptions): UsePaperEventStreamResult {
  const bufferSize = options.bufferSize ?? 500;
  const tradeEventDebounceMs = options.tradeEventDebounceMs ?? 250;

  const [status, setStatus] = useState<PaperEventStreamStatus>('CONNECTING');
  const [buffer, dispatchRaw] = useReducer(
    (state: BufferState, action: BufferAction) => bufferReducer(state, action, bufferSize),
    { events: [], seenIds: new Set<string>() },
  );
  const [health, setHealth] = useState<RuntimeHealth | null>(null);

  const lastSeqRef = useRef(0);
  const pendingTradeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const notifyTradeEvent = useEffectEvent((tradeId: string) => {
    const timers = pendingTradeTimers.current;
    const existing = timers.get(tradeId);
    if (existing) clearTimeout(existing);
    timers.set(
      tradeId,
      setTimeout(() => {
        timers.delete(tradeId);
        options.onTradeEvent?.(tradeId);
      }, tradeEventDebounceMs),
    );
  });

  const sourceRef = useRef(options.source);
  sourceRef.current = options.source;

  useEffect(() => {
    const source = sourceRef.current;
    dispatchRaw({ type: 'reset' });
    lastSeqRef.current = 0;
    const timers = pendingTradeTimers.current;

    function ingest(events: SeqEvent[]) {
      if (events.length === 0) return;
      dispatchRaw({ type: 'add', events });
      lastSeqRef.current = Math.max(lastSeqRef.current, ...events.map((e) => e.seq));
      for (const e of events) {
        if (e.trade_id) notifyTradeEvent(e.trade_id);
      }
    }

    if (source.kind === 'mock') {
      setStatus('CONNECTED');
      let cursor = 0;
      const intervalMs = source.intervalMs ?? 1500;
      let seq = 0;
      const timer = setInterval(() => {
        if (source.events.length === 0) return;
        const base = source.events[cursor % source.events.length];
        seq += 1;
        cursor += 1;
        ingest([{ ...base, seq }]);
      }, intervalMs);
      return () => {
        clearInterval(timer);
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
      };
    }

    // live
    const liveSource: PaperEventStreamLiveSource = source;
    let closedByCleanup = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let backfillController: AbortController | undefined;

    function scheduleReconnect() {
      if (closedByCleanup) return;
      setStatus('RECONNECTING');
      const delay = backoffDelay(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    function backfill() {
      backfillController = new AbortController();
      liveSource
        .getEventsAfter(lastSeqRef.current, backfillController.signal)
        .then((res) => ingest(res.items))
        .catch(() => {
          /* best-effort backfill; next reconnect cycle will retry */
        });
    }

    function connect() {
      if (closedByCleanup) return;
      setStatus(reconnectAttempt === 0 ? 'CONNECTING' : 'RECONNECTING');
      const create = liveSource.createSocket ?? ((url: string) => new WebSocket(url));
      const ws = create(liveSource.url);
      socket = ws;

      ws.addEventListener('open', () => {
        setStatus('CONNECTED');
        reconnectAttempt = 0;
        backfill();
      });

      ws.addEventListener('message', (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
          if (msg.type === 'event') {
            ingest([{ ...msg.event, seq: msg.seq }]);
          } else if (msg.type === 'health') {
            setHealth(msg.health);
          } else if (msg.type === 'hello') {
            lastSeqRef.current = Math.max(lastSeqRef.current, msg.last_seq ?? 0);
          }
        } catch {
          /* ignore malformed frames */
        }
      });

      ws.addEventListener('close', () => {
        if (closedByCleanup) return;
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        /* 'close' follows 'error' per the WebSocket spec; reconnect handled there */
      });
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      backfillController?.abort();
      socket?.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      setStatus('DISCONNECTED');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once; source read via sourceRef
  }, []);

  return { status, events: buffer.events, health };
}
