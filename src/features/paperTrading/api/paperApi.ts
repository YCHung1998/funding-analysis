/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — typed read-only client for `server.ts`'s Paper API
 * (design.md Decision 1 / 4, assumptions A-4–A-9). Every function here
 * issues a `GET` request and accepts an `AbortSignal`; none of them write.
 * `server.ts` itself is not implemented yet (see proposal.md Non-goals) —
 * these functions are exercised by the live branch of `dataSource.ts` once
 * the backend exists, and are unit-tested here only for request shape
 * (path / query parameters), not against a real server.
 */
import type {
  AccountSnapshot,
  CompletedFinalStatusFilter,
  CompletedTradesResponse,
  CurrentTradesResponse,
  GlobalEventsResponse,
  RuntimeHealth,
  TradeDetailResponse,
  TradeEventsResponse,
} from './contracts';

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: 'GET', signal });
  if (!res.ok) {
    throw new Error(`Paper API request failed: ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getAccount(signal: AbortSignal): Promise<AccountSnapshot> {
  return getJson<AccountSnapshot>('/api/paper/account', signal);
}

export function getHealth(signal: AbortSignal): Promise<RuntimeHealth> {
  return getJson<RuntimeHealth>('/api/paper/health', signal);
}

export function getCurrentTrades(signal: AbortSignal): Promise<CurrentTradesResponse> {
  return getJson<CurrentTradesResponse>('/api/paper/trades?scope=current', signal);
}

export function getCompletedTrades(
  params: { finalStatus: CompletedFinalStatusFilter; cursor: string | null; limit?: number },
  signal: AbortSignal,
): Promise<CompletedTradesResponse> {
  const search = new URLSearchParams({ scope: 'completed', limit: String(params.limit ?? 50) });
  if (params.finalStatus !== 'ALL') search.set('final_status', params.finalStatus);
  if (params.cursor) search.set('cursor', params.cursor);
  return getJson<CompletedTradesResponse>(`/api/paper/trades?${search.toString()}`, signal);
}

export function getTradeDetail(tradeId: string, signal: AbortSignal): Promise<TradeDetailResponse> {
  return getJson<TradeDetailResponse>(`/api/paper/trades/${encodeURIComponent(tradeId)}`, signal);
}

export function getTradeEvents(
  tradeId: string,
  params: { cursor: string | null; limit?: number },
  signal: AbortSignal,
): Promise<TradeEventsResponse> {
  const search = new URLSearchParams({ limit: String(params.limit ?? 200) });
  if (params.cursor) search.set('cursor', params.cursor);
  return getJson<TradeEventsResponse>(
    `/api/paper/trades/${encodeURIComponent(tradeId)}/events?${search.toString()}`,
    signal,
  );
}

export function getEventsAfter(afterSeq: number, signal: AbortSignal, limit = 500): Promise<GlobalEventsResponse> {
  const search = new URLSearchParams({ after_seq: String(afterSeq), limit: String(limit) });
  return getJson<GlobalEventsResponse>(`/api/paper/events?${search.toString()}`, signal);
}
