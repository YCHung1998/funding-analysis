/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Funding Arbitrage System Spec - 7 Module Architecture
 * Covers Research → Dry-Run → Live Trading pipeline.
 */

export type ModuleId = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7';

export type ExchangeLayer = 'TruthLayer' | 'IntelligenceLayer';

export type SupportedExchange = 'Pionex' | 'Binance' | 'Bitget' | 'CoinGlass' | 'OKX' | 'Bybit';

/**
 * Dynamic funding interval: never assume 8 hours!
 * Contracts can be 1h, 4h, 8h, etc., with ~1m settlement tolerance.
 */
export type FundingIntervalHours = 1 | 2 | 4 | 8 | 'Dynamic';

/**
 * Latency Tracking Telemetry (M5 / M6)
 * Request & Order latency is structured schema, not unparsed log text.
 */
export interface LatencyTelemetry {
  request_sent_at: number;       // Epoch ms / microsecond marker
  request_received_at: number;   // Epoch ms
  response_received_at: number;  // Epoch ms
  network_latency_ms: number;    // Roundtrip time
  server_latency_ms: number;     // Exchange processing time
  total_latency_ms: number;      // Total turnaround
}

export interface OrderLatencyMetrics {
  order_submit_time: number;
  order_ack_time: number;
  order_fill_time: number;
  order_cancel_time?: number;
  api_latency_ms: number;        // submit -> ack
  fill_latency_ms: number;       // ack -> fill
  cancel_latency_ms?: number;    // cancel request -> ack
}

/**
 * Order State Machine (M5 & M6)
 * Explicit distinction between Pending Order Cancel vs Position Close
 */
/**
 * @deprecated v0.1 5-state order enum (spec §2.1, C-11). Replaced by
 * `OrderState` in `runtime/src/types/status.ts` (v0.2, 9 states, no
 * `CLOSED`). Migration order (design.md Decision 7, trading-schema-types):
 * step 1 of 6 (migrate first). Display adapter: `toLegacyOrderState` in
 * `src/types/legacy/adapters.ts`.
 */
export type OrderState = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';
/**
 * @deprecated v0.1 position state (spec §2.1, C-11). Replaced by
 * `Trade.status` (`TradeStatus`) in `runtime/src/types/status.ts` (v0.2).
 * Migration order (design.md Decision 7, trading-schema-types): step 3 of 6
 * (after `OrderState`, `SimulatedOrderLeg`; before `TimelineMilestone`,
 * `ArbitrageTradeResult`, `FunnelCandidate`). Display adapter:
 * `toLegacyPositionState` in `src/types/legacy/adapters.ts`.
 */
export type PositionState = 'FLAT' | 'OPENING' | 'BALANCED_HEDGED' | 'LEG_IMBALANCE' | 'CLOSING' | 'EMERGENCY_EXIT';

/**
 * @deprecated v0.1 single-order-per-leg shape (spec §2.1, C-11). Replaced
 * by `PaperOrder` + `Fill` (one order can have many fills) in
 * `runtime/src/types/order.ts` / `fill.ts` (v0.2). Migration order
 * (design.md Decision 7, trading-schema-types): step 2 of 6 (after
 * `OrderState`; before `PositionState`, `TimelineMilestone`,
 * `ArbitrageTradeResult`, `FunnelCandidate`).
 */
export interface SimulatedOrderLeg {
  exchange: 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';
  client_order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  contract_side: 'LONG' | 'SHORT';
  notional: number;
  quantity: number;
  order_state: OrderState;
  submit_time: number;
  ack_time: number;
  fill_time: number;
  latency: OrderLatencyMetrics;
  target_price: number;
  executed_price: number;
  slippage_pct: number;
  fee_usdt: number;
}

/**
 * Three-Level Funnel Scanner (M3)
 */
export type CoverageTier = 'universal_5' | 'popular_4' | 'mainstream_3' | 'pair_2';

/**
 * @deprecated v0.1 5-exchange flattened candidate shape (spec §2.1, C-11).
 * Replaced by `Opportunity` in `runtime/src/types/opportunity.ts` (v0.2;
 * `long_exchange`/`short_exchange` pair instead of flattened per-exchange
 * fields). Migration order (design.md Decision 7, trading-schema-types):
 * step 6 of 6 (last — depends on Instrument Registry and Runtime scanner).
 */
export interface FunnelCandidate {
  rank: number;
  symbol: string;
  pionex_rate: number;
  binance_rate: number;
  bybit_rate?: number | null;
  bitget_rate?: number | null;
  okx_rate?: number | null;
  okx_mark?: number | null;
  spread: number;
  interval_hours: FundingIntervalHours;
  settlement_time: number;
  time_to_settlement_sec: number;
  volume_24h: number;
  orderbook_depth_usd: number;
  est_slippage_pct: number;
  fee_drag_pct: number;
  expected_net_pnl_pct: number;
  expected_net_pnl_usdt: number;
  meets_threshold: boolean;
  funnel_stage: 'Level1_Top20' | 'Level2_Top3' | 'Level3_Selected' | 'Eliminated';
  elimination_reason?: string;
  // Multi-Exchange Expansion
  long_exchange?: 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';
  short_exchange?: 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX';
  long_rate?: number;
  short_rate?: number;
  pair_label?: string;
  coverage_count?: number;
  coverage_tier?: CoverageTier;
  available_exchanges?: Array<'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX'>;
  missing_exchanges?: Array<'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX'>;
}

/**
 * 9-Factor Pre-Flight Risk Checklist (M6)
 *
 * Moved to `runtime/src/types/risk.ts` (spec §6 "沿用"; design.md
 * Decision 3) — re-exported here, shape unchanged, so the research UI
 * keeps compiling without importing from `runtime/` directly.
 */
export type { RiskCheckItem, RiskStatusReport } from '../../runtime/src/types/risk';

/**
 * Execution Timeline Milestone Event
 *
 * @deprecated v0.1 relative-T timeline shape (spec §2.1, C-11). Replaced by
 * deriving the timeline from `TradingEvent`'s absolute timestamps
 * (`runtime/src/types/event.ts`; tech spec §27, spec §24). Migration order
 * (design.md Decision 7, trading-schema-types): step 4 of 6 (after
 * `OrderState`, `SimulatedOrderLeg`, `PositionState`; before
 * `ArbitrageTradeResult`, `FunnelCandidate`).
 */
export interface TimelineMilestone {
  id: string;
  timestamp_offset_str: string; // e.g. "T-30.000s", "T-29.950s", "T+00.000s"
  offset_ms: number;            // ms relative to T0
  title: string;
  description: string;
  type: 'SCAN' | 'CHECK' | 'POST' | 'ACK' | 'FILL' | 'FUNDING' | 'EXIT' | 'RISK_ALERT';
  exchange?: 'Pionex' | 'Binance' | 'Bybit' | 'Bitget' | 'OKX' | 'System';
  status: 'SUCCESS' | 'WARNING' | 'ERROR' | 'INFO';
  latency_ms?: number;
  long_status?: string;
  short_status?: string;
}

/**
 * Local-Only Privacy Secrets Configuration (M7 & Local Vault)
 * Strict Rule: API keys and secrets NEVER leave browser memory / localStorage
 */
export interface LocalSecretsConfig {
  pionex_api_key: string;
  pionex_api_secret: string;
  binance_api_key: string;
  binance_api_secret: string;
  bybit_api_key?: string;
  bybit_api_secret?: string;
  bitget_api_key?: string;
  bitget_api_secret?: string;
  okx_api_key?: string;
  okx_api_secret?: string;
  okx_passphrase?: string;
  coinglass_api_key?: string;
  trading_capital_usdt: number;
  max_position_usdt: number;
  max_slippage_pct: number;
  min_funding_spread_pct: number;
  ip_whitelist_confirmed: boolean;
  withdrawal_disabled_confirmed: boolean;
}
