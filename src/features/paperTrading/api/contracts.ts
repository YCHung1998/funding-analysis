/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — API contracts.
 *
 * This module ONLY re-exports types owned by `runtime/src/types` (the
 * `trading-schema-types` capability) and adds the thin response-envelope /
 * assumption types this UI needs on top (design.md Decision 1, assumptions
 * A-1–A-12). It MUST NOT redeclare any entity or status type that already
 * exists under `runtime/src/types` — see openspec/changes/paper-trading-ui
 * design.md "為什麼放 src/features/" and the single-source-of-truth rule in
 * CLAUDE.md-equivalent project instructions.
 */

export type {
  // ids
  ExchangeId,
  OpportunityId,
  TradeId,
  LegId,
  OrderId,
  FundingSettlementId,
  // status
  TradeStatus,
  LegStatus,
  OrderState,
  OpportunityStatus,
  FundingSettlementStatus,
  // entities
  Opportunity,
  Trade,
  TradeLeg,
  PaperOrder,
  Fill,
  FundingSettlement,
  TradeResult,
  // events
  TradingEvent,
  TradingEventType,
  // glossary
  GlossaryEntry,
} from '../../../../runtime/src/types';

export {
  TRADE_STATUSES,
  LEG_STATUSES,
  ORDER_STATES,
  OPPORTUNITY_STATUSES,
  FUNDING_SETTLEMENT_STATUSES,
  TRADING_EVENT_TYPES,
  GLOSSARY,
  getGlossaryEntry,
} from '../../../../runtime/src/types';

import type {
  AccountSnapshot,
  Trade,
  TradeLeg,
  PaperOrder,
  Fill,
  FundingSettlement,
  TradeResult,
  Opportunity,
  TradingEvent,
  ExchangeId,
} from '../../../../runtime/src/types';

/** assumption A-4 (design.md §11) */
export interface RuntimeHealth {
  engine: string;
  exchanges: Array<{ exchange: ExchangeId; status: string }>;
  market_data: string;
  scanner: string;
  risk_engine: string;
  paper_execution: string;
  database: string;
  kill_switch?: string;
  last_event_at: number | null;
  runtime_heartbeat_at: number;
  server_time: number;
}

/** A synthetic status this UI shows when the Health API itself can't be reached. */
export const RUNTIME_UNREACHABLE = 'RUNTIME_UNREACHABLE' as const;
/** A synthetic status this UI shows when a heartbeat/snapshot is older than its staleness threshold. */
export const STALE = 'STALE' as const;

/** assumption A-6 (design.md §11) — summary fields layered on top of `Trade`. */
export interface CurrentTradeSummary extends Trade {
  long_exchange: ExchangeId;
  short_exchange: ExchangeId;
  hedge_ratio: number;
  unrealized_pnl_usdt: number;
  funding_expected_usdt: number;
}

export interface CompletedTradeSummary extends Trade {
  result: TradeResult;
}

/** assumption A-7 */
export interface TradeDetailResponse {
  trade: Trade;
  legs: TradeLeg[];
  orders: PaperOrder[];
  fills: Fill[];
  funding_settlements: FundingSettlement[];
  opportunity: Opportunity;
  result?: TradeResult;
}

/** assumption A-8 */
export interface TradeEventsResponse {
  items: Array<TradingEvent & { seq: number }>;
  next_cursor: string | null;
}

/** assumption A-9 */
export interface GlobalEventsResponse {
  items: Array<TradingEvent & { seq: number }>;
}

/** assumption A-6 (completed trades scope) */
export interface CompletedTradesResponse {
  items: CompletedTradeSummary[];
  next_cursor: string | null;
}

export interface CurrentTradesResponse {
  items: CurrentTradeSummary[];
}

export type CompletedFinalStatusFilter =
  | 'ALL'
  | 'PROFIT'
  | 'LOSS'
  | 'BREAK_EVEN'
  | 'ABORTED'
  | 'FAILED'
  | 'EMERGENCY_EXIT';

/** assumption A-10 */
export type PaperWsMessage =
  | { type: 'event'; seq: number; event: TradingEvent }
  | { type: 'health'; health: RuntimeHealth }
  | { type: 'hello'; last_seq: number };

/** assumption A-11 — control channel request shape, no call sites in this change (blocked-by C-16). */
export interface ControlCommand {
  command: string;
  request_id: string;
}

export interface ControlAck {
  request_id: string;
  forwarded_at: number;
}

export type { AccountSnapshot };
