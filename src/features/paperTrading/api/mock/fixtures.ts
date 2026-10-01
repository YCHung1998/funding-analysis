/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — mock fixtures (design.md Decision 9, HANDOFF
 * Invariant #7). Declared entirely with `runtime/src/types` so an upstream
 * type-shape change breaks the TypeScript build instead of silently
 * drifting (design.md "mock fixtures MUST be declared with runtime types").
 *
 * Covers the 7 scenarios tasks.md 1.2 / spec.md require at least one of
 * each: normal profit, 0-fill timeout ABORTED, order rejected, cancel
 * rejected, LEG_IMBALANCE -> EMERGENCY_EXIT, closed-pending-funding, and a
 * MISSED settlement.
 */
import type {
  AccountSnapshot,
  CompletedTradeSummary,
  CurrentTradeSummary,
  Fill,
  FundingSettlement,
  Opportunity,
  PaperOrder,
  RuntimeHealth,
  Trade,
  TradeDetailResponse,
  TradeLeg,
  TradeResult,
  TradingEvent,
} from '../contracts';

const BASE_TIME = Date.UTC(2024, 0, 1, 8, 0, 0, 0);

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString().padStart(4, '0')}`;
}

const PASS_RISK_STATUS = {
  overall_status: 'PASS' as const,
  checks: [],
  failed_reasons: [],
  leg_imbalance_detected: false,
  action_recommendation: 'PROCEED_TRADE' as const,
};

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const detected_at = overrides.detected_at ?? BASE_TIME;
  return {
    opportunity_id: nextId('opp'),
    symbol: 'PEPEUSDT',
    created_at: detected_at,
    detected_at,
    expires_at: detected_at + 30_000,
    updated_at: detected_at,
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    long_funding_rate: 0.0001,
    short_funding_rate: 0.0035,
    funding_spread: 0.0034,
    long_funding_time: detected_at + 3_600_000,
    short_funding_time: detected_at + 3_600_000,
    long_funding_interval_hours: 8,
    short_funding_interval_hours: 4,
    funding_time_diff_ms: 0,
    funding_aligned: true,
    long_price: 0.000182,
    short_price: 0.0001822,
    price_difference_pct: 0.11,
    estimated_fee_pct: 0.002,
    estimated_slippage_pct: 0.0008,
    estimated_funding_pnl: 3.4,
    estimated_net_pnl: 0.7,
    liquidity_score: 0.92,
    strategy_version: 'v1',
    status: 'SELECTED',
    ...overrides,
  };
}

function makeLeg(overrides: Partial<TradeLeg> & { trade_id: string }): TradeLeg {
  return {
    leg_id: nextId('leg'),
    exchange: 'Binance',
    symbol: 'PEPEUSDT',
    direction: 'LONG',
    order_side: 'BUY',
    leverage: 3,
    target_notional_usdt: 1000,
    target_quantity: 5_494_505,
    margin_allocated_usdt: 333.33,
    target_entry_price: 0.000182,
    entry_order_ids: [],
    exit_order_ids: [],
    status: 'OPEN',
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> & { legs: TradeLeg[] }): Trade {
  return {
    trade_id: nextId('trade'),
    opportunity_id: nextId('opp'),
    strategy_id: 'funding-arb-v1',
    strategy_version: 'v1',
    config_version: 'cfg-2024.01',
    symbol: 'PEPEUSDT',
    mode: 'PAPER',
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    status: 'HEDGED',
    target_notional_per_leg_usdt: 1000,
    leverage: 3,
    allocated_margin_usdt: 400,
    allocated_capital_usdt: 454,
    expected_pnl_usdt: 0.7,
    risk_status: PASS_RISK_STATUS,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<PaperOrder> & { trade_id: string; leg_id: string }): PaperOrder {
  return {
    order_id: nextId('order'),
    client_order_id: nextId('corder'),
    purpose: 'ENTRY',
    exchange: 'Binance',
    symbol: 'PEPEUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    reduce_only: false,
    requested_quantity: 5_494_505,
    requested_notional_usdt: 1000,
    reference_price: 0.000182,
    order_state: 'FILLED',
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    filled_quantity: 5_494_505,
    remaining_quantity: 0,
    average_fill_price: 0.0001821,
    estimated_fee_usdt: 0.5,
    estimated_slippage_pct: 0.0005,
    ...overrides,
  };
}

function makeFill(overrides: Partial<Fill> & { trade_id: string; leg_id: string; order_id: string }): Fill {
  return {
    fill_id: nextId('fill'),
    exchange: 'Binance',
    timestamp: BASE_TIME,
    recorded_at: BASE_TIME,
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    quantity: 5_494_505,
    price: 0.0001821,
    notional_usdt: 1000.5,
    fee_usdt: 0.5,
    fee_asset: 'USDT',
    liquidity: 'TAKER',
    slippage_from_reference_pct: 0.0005,
    ...overrides,
  };
}

function makeFunding(
  overrides: Partial<FundingSettlement> & { trade_id: string; leg_id: string },
): FundingSettlement {
  return {
    funding_id: nextId('funding'),
    exchange: 'Binance',
    symbol: 'PEPEUSDT',
    funding_time: BASE_TIME + 3_600_000,
    position_notional: 1000,
    funding_rate: 0.0001,
    position_side: 'LONG',
    expected_cashflow_usdt: 0.1,
    settlement_status: 'SETTLED',
    created_at: BASE_TIME,
    updated_at: BASE_TIME + 3_600_000,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TradeResult> & { trade_id: string }): TradeResult {
  return {
    symbol: 'PEPEUSDT',
    mode: 'PAPER',
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    target_notional_per_leg_usdt: 1000,
    actual_long_notional_usdt: 1000,
    actual_short_notional_usdt: 998,
    leverage: 3,
    entry_duration_ms: 820,
    exit_duration_ms: 640,
    total_trade_duration_ms: 3_600_000,
    funding_pnl_usdt: 3.0,
    price_pnl_usdt: -1.5,
    fee_usdt: 0.8,
    slippage_attribution_usdt: -1.2,
    net_pnl_usdt: 0.7,
    roi_on_capital_pct: 0.0015,
    roi_on_notional_pct: 0.0007,
    max_leg_imbalance_usdt: 0,
    max_leg_imbalance_duration_ms: 0,
    final_status: 'PROFIT',
    result_reason: 'NORMAL_EXIT',
    funding_confirmed: true,
    finalized_at: BASE_TIME + 3_600_000,
    created_at: BASE_TIME,
    updated_at: BASE_TIME + 3_600_000,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TradingEvent> & { event_type: TradingEvent['event_type'] }): TradingEvent {
  const timestamp = overrides.timestamp ?? BASE_TIME;
  return {
    event_id: nextId('evt'),
    trade_id: null,
    payload: {},
    recorded_at: timestamp,
    timestamp,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: normal profit, fully closed & funding-confirmed
// ---------------------------------------------------------------------------
const t1 = makeTrade({
  trade_id: 'trade-profit-01',
  status: 'CLOSED',
  close_reason: 'NORMAL_EXIT',
  entry_started_at: BASE_TIME,
  entry_completed_at: BASE_TIME + 820,
  exit_started_at: BASE_TIME + 3_600_000,
  exit_completed_at: BASE_TIME + 3_600_640,
  realized_pnl_usdt: 0.7,
  legs: [],
});
const t1LegLong = makeLeg({ trade_id: t1.trade_id, exchange: 'Binance', direction: 'LONG', status: 'CLOSED' });
const t1LegShort = makeLeg({
  trade_id: t1.trade_id,
  exchange: 'Bybit',
  direction: 'SHORT',
  order_side: 'SELL',
  status: 'CLOSED',
  actual_notional_usdt: 998,
});
t1.legs = [t1LegLong, t1LegShort];
const t1Opportunity = makeOpportunity({ opportunity_id: t1.opportunity_id });
const t1OrderEntryLong = makeOrder({ trade_id: t1.trade_id, leg_id: t1LegLong.leg_id, purpose: 'ENTRY' });
const t1FillEntryLong = makeFill({
  trade_id: t1.trade_id,
  leg_id: t1LegLong.leg_id,
  order_id: t1OrderEntryLong.order_id,
});
const t1FundingLong = makeFunding({ trade_id: t1.trade_id, leg_id: t1LegLong.leg_id, exchange: 'Binance' });
const t1FundingShort = makeFunding({
  trade_id: t1.trade_id,
  leg_id: t1LegShort.leg_id,
  exchange: 'Bybit',
  funding_rate: 0.0035,
  position_side: 'SHORT',
  expected_cashflow_usdt: 3.49,
});
const t1Result = makeResult({ trade_id: t1.trade_id });
const t1Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t1.trade_id, timestamp: BASE_TIME }),
  makeEvent({
    event_type: 'ORDER_SUBMITTED',
    trade_id: t1.trade_id,
    leg_id: t1LegLong.leg_id,
    order_id: t1OrderEntryLong.order_id,
    timestamp: BASE_TIME + 10,
  }),
  makeEvent({
    event_type: 'ORDER_ACK',
    trade_id: t1.trade_id,
    leg_id: t1LegLong.leg_id,
    order_id: t1OrderEntryLong.order_id,
    timestamp: BASE_TIME + 45,
  }),
  makeEvent({
    event_type: 'ORDER_FILL',
    trade_id: t1.trade_id,
    leg_id: t1LegLong.leg_id,
    order_id: t1OrderEntryLong.order_id,
    exchange: 'Binance',
    payload: { fill_pct: 1 },
    timestamp: BASE_TIME + 130,
  }),
  makeEvent({
    event_type: 'TRADE_STATUS_CHANGED',
    trade_id: t1.trade_id,
    payload: { from: 'ENTRY_PENDING', to: 'HEDGED' },
    timestamp: BASE_TIME + 820,
  }),
  makeEvent({
    event_type: 'FUNDING_SETTLED',
    trade_id: t1.trade_id,
    leg_id: t1LegLong.leg_id,
    timestamp: BASE_TIME + 3_600_000,
    recorded_at: BASE_TIME + 3_600_035,
  }),
  makeEvent({
    event_type: 'TRADE_COMPLETED',
    trade_id: t1.trade_id,
    payload: { final_status: 'PROFIT' },
    timestamp: BASE_TIME + 3_600_640,
  }),
];

// ---------------------------------------------------------------------------
// Scenario 2: 0-fill entry timeout -> ABORTED
// ---------------------------------------------------------------------------
const t2 = makeTrade({
  trade_id: 'trade-aborted-timeout-02',
  status: 'ABORTED',
  close_reason: undefined,
  entry_started_at: BASE_TIME + 10_000,
  legs: [],
  expected_pnl_usdt: 0.5,
});
const t2Leg = makeLeg({
  trade_id: t2.trade_id,
  exchange: 'Binance',
  status: 'FAILED',
  actual_notional_usdt: 0,
  actual_quantity: 0,
});
t2.legs = [t2Leg];
const t2Opportunity = makeOpportunity({ opportunity_id: t2.opportunity_id });
const t2Order = makeOrder({
  trade_id: t2.trade_id,
  leg_id: t2Leg.leg_id,
  order_state: 'EXPIRED',
  filled_quantity: 0,
  remaining_quantity: 5_494_505,
  average_fill_price: undefined,
  timeout_reason: 'ENTRY_TIMEOUT',
});
const t2Result = makeResult({
  trade_id: t2.trade_id,
  actual_long_notional_usdt: 0,
  actual_short_notional_usdt: 0,
  funding_pnl_usdt: 0,
  price_pnl_usdt: 0,
  fee_usdt: 0,
  slippage_attribution_usdt: 0,
  net_pnl_usdt: 0,
  final_status: 'ABORTED',
  result_reason: 'ENTRY_TIMEOUT',
  funding_confirmed: true,
  finalized_at: BASE_TIME + 40_000,
});
const t2Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t2.trade_id, timestamp: BASE_TIME + 10_000 }),
  makeEvent({
    event_type: 'ORDER_SUBMITTED',
    trade_id: t2.trade_id,
    leg_id: t2Leg.leg_id,
    order_id: t2Order.order_id,
    timestamp: BASE_TIME + 10_010,
  }),
  makeEvent({
    event_type: 'ORDER_TIMEOUT',
    trade_id: t2.trade_id,
    leg_id: t2Leg.leg_id,
    order_id: t2Order.order_id,
    payload: { timeout_reason: 'ENTRY_TIMEOUT' },
    timestamp: BASE_TIME + 40_010,
  }),
  makeEvent({
    event_type: 'TRADE_STATUS_CHANGED',
    trade_id: t2.trade_id,
    payload: { from: 'ENTRY_PENDING', to: 'ABORTED', reason: 'ENTRY_TIMEOUT' },
    timestamp: BASE_TIME + 40_020,
  }),
];

// ---------------------------------------------------------------------------
// Scenario 3: order rejected
// ---------------------------------------------------------------------------
const t3 = makeTrade({
  trade_id: 'trade-order-rejected-03',
  status: 'ABORTED',
  legs: [],
});
const t3Leg = makeLeg({ trade_id: t3.trade_id, exchange: 'Bitget', status: 'FAILED' });
t3.legs = [t3Leg];
const t3Opportunity = makeOpportunity({ opportunity_id: t3.opportunity_id });
const t3Order = makeOrder({
  trade_id: t3.trade_id,
  leg_id: t3Leg.leg_id,
  exchange: 'Bitget',
  order_state: 'REJECTED',
  filled_quantity: 0,
  remaining_quantity: 5_494_505,
  average_fill_price: undefined,
  rejection_reason: 'INSUFFICIENT_MARGIN',
});
const t3Result = makeResult({
  trade_id: t3.trade_id,
  actual_long_notional_usdt: 0,
  actual_short_notional_usdt: 0,
  funding_pnl_usdt: 0,
  price_pnl_usdt: 0,
  fee_usdt: 0,
  slippage_attribution_usdt: 0,
  net_pnl_usdt: 0,
  final_status: 'ABORTED',
  result_reason: 'ORDER_REJECTED',
  funding_confirmed: true,
  finalized_at: BASE_TIME + 5_000,
});
const t3Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t3.trade_id, timestamp: BASE_TIME }),
  makeEvent({
    event_type: 'ORDER_SUBMITTED',
    trade_id: t3.trade_id,
    leg_id: t3Leg.leg_id,
    order_id: t3Order.order_id,
    timestamp: BASE_TIME + 5,
  }),
  makeEvent({
    event_type: 'ORDER_REJECTED',
    trade_id: t3.trade_id,
    leg_id: t3Leg.leg_id,
    order_id: t3Order.order_id,
    payload: { rejection_reason: 'INSUFFICIENT_MARGIN' },
    timestamp: BASE_TIME + 120,
  }),
];

// ---------------------------------------------------------------------------
// Scenario 4: cancel rejected (撤單失敗)
// ---------------------------------------------------------------------------
const t4 = makeTrade({ trade_id: 'trade-cancel-rejected-04', status: 'HEDGED', legs: [] });
const t4Leg = makeLeg({ trade_id: t4.trade_id, status: 'OPEN' });
t4.legs = [t4Leg];
const t4Opportunity = makeOpportunity({ opportunity_id: t4.opportunity_id });
const t4Order = makeOrder({
  trade_id: t4.trade_id,
  leg_id: t4Leg.leg_id,
  order_state: 'ACKNOWLEDGED',
  filled_quantity: 0,
  remaining_quantity: 5_494_505,
  average_fill_price: undefined,
});
const t4Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t4.trade_id, timestamp: BASE_TIME }),
  makeEvent({
    event_type: 'ORDER_CANCEL_REQUESTED',
    trade_id: t4.trade_id,
    leg_id: t4Leg.leg_id,
    order_id: t4Order.order_id,
    timestamp: BASE_TIME + 2_000,
  }),
  makeEvent({
    event_type: 'ORDER_CANCEL_REJECTED',
    trade_id: t4.trade_id,
    leg_id: t4Leg.leg_id,
    order_id: t4Order.order_id,
    payload: { cancel_reject_reason: 'ALREADY_FILLING' },
    timestamp: BASE_TIME + 2_080,
  }),
];

// ---------------------------------------------------------------------------
// Scenario 5: LEG_IMBALANCE -> EMERGENCY_EXIT
// ---------------------------------------------------------------------------
const t5 = makeTrade({
  trade_id: 'trade-emergency-exit-05',
  status: 'CLOSED',
  close_reason: 'EMERGENCY_EXIT',
  legs: [],
});
const t5LegLong = makeLeg({ trade_id: t5.trade_id, exchange: 'Binance', status: 'CLOSED' });
const t5LegShort = makeLeg({
  trade_id: t5.trade_id,
  exchange: 'OKX',
  direction: 'SHORT',
  order_side: 'SELL',
  status: 'FAILED',
  actual_notional_usdt: 0,
});
t5.legs = [t5LegLong, t5LegShort];
const t5Opportunity = makeOpportunity({ opportunity_id: t5.opportunity_id });
const t5Result = makeResult({
  trade_id: t5.trade_id,
  actual_short_notional_usdt: 0,
  max_leg_imbalance_usdt: 1000,
  max_leg_imbalance_duration_ms: 480,
  final_status: 'EMERGENCY_EXIT',
  result_reason: 'LEG_IMBALANCE_TIMEOUT',
  funding_confirmed: true,
  finalized_at: BASE_TIME + 60_000,
});
const t5Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t5.trade_id, timestamp: BASE_TIME }),
  makeEvent({
    event_type: 'LEG_IMBALANCE_DETECTED',
    trade_id: t5.trade_id,
    leg_id: t5LegShort.leg_id,
    timestamp: BASE_TIME + 30_000,
  }),
  makeEvent({
    event_type: 'EMERGENCY_EXIT_STARTED',
    trade_id: t5.trade_id,
    timestamp: BASE_TIME + 30_480,
  }),
  makeEvent({
    event_type: 'TRADE_STATUS_CHANGED',
    trade_id: t5.trade_id,
    payload: { from: 'EMERGENCY_EXIT', to: 'CLOSED', reason: 'EMERGENCY_EXIT' },
    timestamp: BASE_TIME + 60_000,
  }),
];
// Also exposed as a CURRENT trade (mid emergency-exit) for Current Trades warning-style demo.
const t5Current = makeTrade({
  trade_id: 'trade-emergency-exit-current-05b',
  status: 'EMERGENCY_EXIT',
  legs: [t5LegLong, t5LegShort],
});

// ---------------------------------------------------------------------------
// Scenario 6: closed, pending funding confirmation (already-closed, 待入帳)
// ---------------------------------------------------------------------------
const t6 = makeTrade({ trade_id: 'trade-pending-funding-06', status: 'CLOSED', close_reason: 'NORMAL_EXIT', legs: [] });
const t6LegLong = makeLeg({ trade_id: t6.trade_id, exchange: 'Binance', status: 'CLOSED' });
const t6LegShort = makeLeg({
  trade_id: t6.trade_id,
  exchange: 'Bybit',
  direction: 'SHORT',
  order_side: 'SELL',
  status: 'CLOSED',
});
t6.legs = [t6LegLong, t6LegShort];
const t6Opportunity = makeOpportunity({ opportunity_id: t6.opportunity_id });
const t6FundingLong = makeFunding({
  trade_id: t6.trade_id,
  leg_id: t6LegLong.leg_id,
  settlement_status: 'ELIGIBLE',
});
const t6Result = makeResult({
  trade_id: t6.trade_id,
  funding_confirmed: false,
  finalized_at: undefined,
});
const t6Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t6.trade_id, timestamp: BASE_TIME }),
  makeEvent({
    event_type: 'TRADE_STATUS_CHANGED',
    trade_id: t6.trade_id,
    payload: { from: 'EXIT_PENDING', to: 'CLOSED' },
    timestamp: BASE_TIME + 3_600_000,
  }),
];

// ---------------------------------------------------------------------------
// Scenario 7: MISSED settlement (needs manual review)
// ---------------------------------------------------------------------------
const t7 = makeTrade({ trade_id: 'trade-missed-settlement-07', status: 'CLOSED', close_reason: 'NORMAL_EXIT', legs: [] });
const t7LegLong = makeLeg({ trade_id: t7.trade_id, exchange: 'Binance', status: 'CLOSED' });
const t7LegShort = makeLeg({
  trade_id: t7.trade_id,
  exchange: 'Bitget',
  direction: 'SHORT',
  order_side: 'SELL',
  status: 'CLOSED',
});
t7.legs = [t7LegLong, t7LegShort];
const t7Opportunity = makeOpportunity({ opportunity_id: t7.opportunity_id });
const t7FundingLong = makeFunding({
  trade_id: t7.trade_id,
  leg_id: t7LegLong.leg_id,
  settlement_status: 'MISSED',
});
const t7FundingShort = makeFunding({
  trade_id: t7.trade_id,
  leg_id: t7LegShort.leg_id,
  exchange: 'Bitget',
  position_side: 'SHORT',
  settlement_status: 'SETTLED',
});
const t7Result = makeResult({
  trade_id: t7.trade_id,
  funding_confirmed: false,
  finalized_at: undefined,
  result_reason: 'FUNDING_SETTLEMENT_MISSED',
});
const t7Events: TradingEvent[] = [
  makeEvent({ event_type: 'TRADE_CREATED', trade_id: t7.trade_id, timestamp: BASE_TIME }),
  makeEvent({
    event_type: 'TRADE_STATUS_CHANGED',
    trade_id: t7.trade_id,
    payload: { from: 'EXIT_PENDING', to: 'CLOSED' },
    timestamp: BASE_TIME + 3_600_000,
  }),
];

// ---------------------------------------------------------------------------
// An extra non-terminal (current) trade so Current Trades always has >1 row.
// ---------------------------------------------------------------------------
const tCurrentHedged = makeTrade({
  trade_id: 'trade-current-hedged-08',
  status: 'HEDGED',
  legs: [],
});
const tCurrentHedgedLegLong = makeLeg({ trade_id: tCurrentHedged.trade_id, exchange: 'Binance', status: 'OPEN' });
const tCurrentHedgedLegShort = makeLeg({
  trade_id: tCurrentHedged.trade_id,
  exchange: 'Bybit',
  direction: 'SHORT',
  order_side: 'SELL',
  status: 'OPEN',
  actual_notional_usdt: 998,
});
tCurrentHedged.legs = [tCurrentHedgedLegLong, tCurrentHedgedLegShort];

// ---------------------------------------------------------------------------
// Public fixture exports
// ---------------------------------------------------------------------------
export const FIXTURE_ACCOUNT: AccountSnapshot = {
  snapshot_id: nextId('snap'),
  mode: 'PAPER',
  snapshot_time: BASE_TIME + 3_600_700,
  total_capital_usdt: 10_000,
  reserved_capital_usdt: 908,
  available_capital_usdt: 9_092,
  used_margin_usdt: 800,
  realized_pnl_usdt: 0.7,
  open_trade_count: 2,
  reason: 'PERIODIC',
  config_version: 'cfg-2024.01',
  created_at: BASE_TIME,
  updated_at: BASE_TIME + 3_600_700,
};

export const FIXTURE_HEALTH: RuntimeHealth = {
  engine: 'RUNNING',
  exchanges: [
    { exchange: 'Binance', status: 'CONNECTED' },
    { exchange: 'Bybit', status: 'CONNECTED' },
    { exchange: 'Bitget', status: 'CONNECTED' },
    { exchange: 'OKX', status: 'CONNECTED' },
  ],
  market_data: 'HEALTHY',
  scanner: 'RUNNING',
  risk_engine: 'ARMED',
  paper_execution: 'RUNNING',
  database: 'HEALTHY',
  last_event_at: BASE_TIME + 3_600_700,
  runtime_heartbeat_at: BASE_TIME + 3_600_700,
  server_time: BASE_TIME + 3_600_700,
};

export const FIXTURE_CURRENT_TRADES: CurrentTradeSummary[] = [
  {
    ...tCurrentHedged,
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    hedge_ratio: 0.995,
    unrealized_pnl_usdt: 1.2,
    funding_expected_usdt: 0.4,
  },
  {
    ...t5Current,
    long_exchange: 'Binance',
    short_exchange: 'OKX',
    hedge_ratio: 0.5,
    unrealized_pnl_usdt: -2.1,
    funding_expected_usdt: 0,
  },
];

export const FIXTURE_COMPLETED_TRADES: CompletedTradeSummary[] = [
  { ...t1, result: t1Result },
  { ...t2, result: t2Result },
  { ...t3, result: t3Result },
  { ...t5, result: t5Result },
  { ...t6, result: t6Result },
  { ...t7, result: t7Result },
];

export const FIXTURE_TRADE_DETAILS: Record<string, TradeDetailResponse> = {
  [t1.trade_id]: {
    trade: t1,
    legs: t1.legs,
    orders: [t1OrderEntryLong],
    fills: [t1FillEntryLong],
    funding_settlements: [t1FundingLong, t1FundingShort],
    opportunity: t1Opportunity,
    result: t1Result,
  },
  [t2.trade_id]: {
    trade: t2,
    legs: t2.legs,
    orders: [t2Order],
    fills: [],
    funding_settlements: [],
    opportunity: t2Opportunity,
    result: t2Result,
  },
  [t3.trade_id]: {
    trade: t3,
    legs: t3.legs,
    orders: [t3Order],
    fills: [],
    funding_settlements: [],
    opportunity: t3Opportunity,
    result: t3Result,
  },
  [t4.trade_id]: {
    trade: t4,
    legs: t4.legs,
    orders: [t4Order],
    fills: [],
    funding_settlements: [],
    opportunity: t4Opportunity,
  },
  [t5.trade_id]: {
    trade: t5,
    legs: t5.legs,
    orders: [],
    fills: [],
    funding_settlements: [],
    opportunity: t5Opportunity,
    result: t5Result,
  },
  [t5Current.trade_id]: {
    trade: t5Current,
    legs: t5Current.legs,
    orders: [],
    fills: [],
    funding_settlements: [],
    opportunity: t5Opportunity,
  },
  [t6.trade_id]: {
    trade: t6,
    legs: t6.legs,
    orders: [],
    fills: [],
    funding_settlements: [t6FundingLong],
    opportunity: t6Opportunity,
    result: t6Result,
  },
  [t7.trade_id]: {
    trade: t7,
    legs: t7.legs,
    orders: [],
    fills: [],
    funding_settlements: [t7FundingLong, t7FundingShort],
    opportunity: t7Opportunity,
    result: t7Result,
  },
  [tCurrentHedged.trade_id]: {
    trade: tCurrentHedged,
    legs: tCurrentHedged.legs,
    orders: [],
    fills: [],
    funding_settlements: [],
    opportunity: makeOpportunity({ opportunity_id: tCurrentHedged.opportunity_id }),
  },
};

export const FIXTURE_TRADE_EVENTS: Record<string, TradingEvent[]> = {
  [t1.trade_id]: t1Events,
  [t2.trade_id]: t2Events,
  [t3.trade_id]: t3Events,
  [t4.trade_id]: t4Events,
  [t5.trade_id]: t5Events,
  [t6.trade_id]: t6Events,
  [t7.trade_id]: t7Events,
};

export const FIXTURE_GLOBAL_EVENTS: TradingEvent[] = [
  ...t1Events,
  ...t2Events,
  ...t3Events,
  ...t4Events,
  ...t5Events,
].sort((a, b) => a.timestamp - b.timestamp);
