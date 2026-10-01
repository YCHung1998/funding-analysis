/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — live/mock data source selection (design.md Decision 9,
 * HANDOFF Invariant #7). `VITE_PAPER_DATA_SOURCE` picks the implementation;
 * default is `'live'`. The live implementation never silently falls back to
 * mock data on failure — callers see the error / RUNTIME_UNREACHABLE state
 * instead (spec.md "live 失敗不偷換 mock").
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
import * as paperApi from './paperApi';
import {
  FIXTURE_ACCOUNT,
  FIXTURE_COMPLETED_TRADES,
  FIXTURE_CURRENT_TRADES,
  FIXTURE_GLOBAL_EVENTS,
  FIXTURE_HEALTH,
  FIXTURE_TRADE_DETAILS,
  FIXTURE_TRADE_EVENTS,
} from './mock/fixtures';

export type PaperDataSourceKind = 'live' | 'mock';

export interface PaperDataSource {
  kind: PaperDataSourceKind;
  getAccount(signal: AbortSignal): Promise<AccountSnapshot>;
  getHealth(signal: AbortSignal): Promise<RuntimeHealth>;
  getCurrentTrades(signal: AbortSignal): Promise<CurrentTradesResponse>;
  getCompletedTrades(
    params: { finalStatus: CompletedFinalStatusFilter; cursor: string | null; limit?: number },
    signal: AbortSignal,
  ): Promise<CompletedTradesResponse>;
  getTradeDetail(tradeId: string, signal: AbortSignal): Promise<TradeDetailResponse>;
  getTradeEvents(
    tradeId: string,
    params: { cursor: string | null; limit?: number },
    signal: AbortSignal,
  ): Promise<TradeEventsResponse>;
  getEventsAfter(afterSeq: number, signal: AbortSignal, limit?: number): Promise<GlobalEventsResponse>;
}

const PAGE_SIZE = 50;

function applyCompletedFilter(
  finalStatus: CompletedFinalStatusFilter,
  cursor: string | null,
  limit: number,
): CompletedTradesResponse {
  const filtered =
    finalStatus === 'ALL'
      ? FIXTURE_COMPLETED_TRADES
      : FIXTURE_COMPLETED_TRADES.filter((t) => t.result.final_status === finalStatus);
  const sorted = [...filtered].sort(
    (a, b) => (b.result.finalized_at ?? b.updated_at) - (a.result.finalized_at ?? a.updated_at),
  );
  const start = cursor ? Number(cursor) : 0;
  const page = sorted.slice(start, start + limit);
  const nextStart = start + limit;
  const next_cursor = nextStart < sorted.length ? String(nextStart) : null;
  return { items: page, next_cursor };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export const mockDataSource: PaperDataSource = {
  kind: 'mock',
  async getAccount(signal) {
    await wait(0, signal);
    return FIXTURE_ACCOUNT;
  },
  async getHealth(signal) {
    await wait(0, signal);
    return FIXTURE_HEALTH;
  },
  async getCurrentTrades(signal) {
    await wait(0, signal);
    return { items: FIXTURE_CURRENT_TRADES };
  },
  async getCompletedTrades(params, signal) {
    await wait(0, signal);
    return applyCompletedFilter(params.finalStatus, params.cursor, params.limit ?? PAGE_SIZE);
  },
  async getTradeDetail(tradeId, signal) {
    await wait(0, signal);
    const detail = FIXTURE_TRADE_DETAILS[tradeId];
    if (!detail) throw new Error(`mock: no fixture trade detail for ${tradeId}`);
    return detail;
  },
  async getTradeEvents(tradeId, params, signal) {
    await wait(0, signal);
    const events = FIXTURE_TRADE_EVENTS[tradeId] ?? [];
    const limit = params.limit ?? 200;
    const start = params.cursor ? Number(params.cursor) : 0;
    const page = events.slice(start, start + limit);
    const nextStart = start + limit;
    const next_cursor = nextStart < events.length ? String(nextStart) : null;
    return { items: page.map((e, i) => ({ ...e, seq: start + i + 1 })), next_cursor };
  },
  async getEventsAfter(afterSeq, signal, limit = 500) {
    await wait(0, signal);
    const withSeq = FIXTURE_GLOBAL_EVENTS.map((e, i) => ({ ...e, seq: i + 1 }));
    return { items: withSeq.filter((e) => e.seq > afterSeq).slice(0, limit) };
  },
};

export const liveDataSource: PaperDataSource = {
  kind: 'live',
  getAccount: paperApi.getAccount,
  getHealth: paperApi.getHealth,
  getCurrentTrades: paperApi.getCurrentTrades,
  getCompletedTrades: paperApi.getCompletedTrades,
  getTradeDetail: paperApi.getTradeDetail,
  getTradeEvents: paperApi.getTradeEvents,
  getEventsAfter: paperApi.getEventsAfter,
};

export function resolveDataSourceKind(): PaperDataSourceKind {
  const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_PAPER_DATA_SOURCE;
  return raw === 'mock' ? 'mock' : 'live';
}

export function getPaperDataSource(): PaperDataSource {
  return resolveDataSourceKind() === 'mock' ? mockDataSource : liveDataSource;
}
