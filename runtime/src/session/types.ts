// TODO(trading-schema-types): 合併後改為 import { ExchangeId } from 'runtime/src/types'
export type ExchangeId = 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';

/** One leg of a candidate pair: just enough to look up its venue rule and exchange clock. */
export interface SettlementLeg {
  exchange: ExchangeId;
}

/** `PaperTradingConfig` phase-lead fields (design.md §3). All values are milliseconds. */
export interface SessionTimingConfig {
  watchLeadMs: number;
  shortlistLeadMs: number;
  armLeadMs: number;
  entryOpenLeadMs: number;
  entryBufferMs: number;
  partialHedgeMaxDurationMs: number;
  exitBufferMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTimingConfig = {
  watchLeadMs: 30 * 60_000,
  shortlistLeadMs: 5 * 60_000,
  armLeadMs: 60_000,
  entryOpenLeadMs: 45_000,
  entryBufferMs: 5_000,
  partialHedgeMaxDurationMs: 5_000,
  exitBufferMs: 15_000,
};

/** Local-scheduling-time boundaries for one `SettlementSession` (settlement-session spec). */
export interface PhaseTimetable {
  watchStart: number;
  shortlistAt: number;
  armAt: number;
  entryOpen: number;
  entryDeadline: number;
  hedgedBy: number;
  lockEnd: number;
  exitAt: number;
}
