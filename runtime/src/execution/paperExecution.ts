/**
 * runtime/src/execution/paperExecution.ts
 *
 * `PaperExecutionAdapter` — implements `ExecutionEngine` (design.md Decision
 * 1). State machine per C-14 (spec "Order state machine per C-14"); every
 * transition is committed via `Ledger.applyOrderTransition` /
 * `Ledger.createOrder` (task 1.1/2.1). Matching uses `matching.ts` (task
 * 2.2); timeouts and cancel use `Clock` scheduling only — never
 * `Date.now`/`setTimeout` (spec "Clock-driven scheduling").
 */
import type { Clock, TimerHandle } from '../clock/types';
import type { AppendEventInput, EventStore } from '../storage/eventStore';
import { Ledger } from '../storage/ledger';
import type { Fill, PaperOrder } from '../types';
import type { ExchangeId } from '../types/ids';
import type {
  ExecutionEngine,
  FeeRateSource,
  FundingWindowGuard,
  InstrumentSource,
  OrderBookSource,
  OrderRequest,
  PositionReader,
} from './executionInterface';
import {
  ackLatencyMs,
  cancelLatencyMs,
  fillLatencyMs,
  isDisconnected,
  rollProbability,
  type ExecutionLatencyTable,
  type FailureInjectionTable,
} from './failureInjection';
import { averageFillPrice, feeUsdt, isValidStep, notionalUsdt, slippagePct, walkBook } from './matching';
import { stream, type Rng } from './rng';

export class InvalidOrderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'INVALID_ORDER_REQUEST';
  }
}

export class OrderNotCancelableError extends Error {
  constructor(orderId: string) {
    super(`ORDER_NOT_CANCELABLE: ${orderId}`);
    this.name = 'ORDER_NOT_CANCELABLE';
  }
}

export interface PaperExecutionAdapterConfig {
  seed: number;
  execution_latency: ExecutionLatencyTable;
  enable_failure_injection?: boolean;
  failure_injection?: FailureInjectionTable;
  /** Default `time_in_force` for MARKET orders when the request omits it. */
  market_order_time_in_force?: 'GTC' | 'IOC';
  enable_partial_fill?: boolean;
  max_order_lifetime_ms: number;
  ack_timeout_ms: number;
  data_stale_threshold_ms?: number;
}

export interface PaperExecutionAdapterDeps {
  clock: Clock;
  ledger: Ledger;
  /** For informational, non-transition events (`ORDER_TIMEOUT`, `ORDER_ACK_TIMEOUT`, `STALE_MARKET_DATA`, `EXCHANGE_DISCONNECTED`). */
  eventStore?: EventStore;
  orderBook: OrderBookSource;
  instruments: InstrumentSource;
  feeRates: FeeRateSource;
  positions: PositionReader;
  guard: FundingWindowGuard;
  config: PaperExecutionAdapterConfig;
}

type Listener = (order: PaperOrder, fills: Fill[]) => void;

interface InternalOrder {
  order: PaperOrder;
  request: OrderRequest;
  timeInForce: 'GTC' | 'IOC';
  rng: Rng;
  contractMultiplier: number;
  stepSize: number;
  takerFeeRate: number;
  ackLatency: number;
  ackLost: boolean;
  ackHandle?: TimerHandle;
  ackTimeoutHandle?: TimerHandle;
  ackTimeoutFired: boolean;
  lifetimeHandle?: TimerHandle;
  cancelHandle?: TimerHandle;
  /** Cancel requested while SUBMITTED (before ACK) — deferred per spec, applied once ACKNOWLEDGED. */
  deferredCancel: boolean;
  unsubscribeBookUpdates?: () => void;
  matchedLevelKeys: Set<string>;
}

function endpointGuardReason(guard: FundingWindowGuard, request: OrderRequest, now: number): string | undefined {
  const result =
    request.purpose === 'ENTRY'
      ? guard.canSubmitEntry(request.trade_id, now)
      : guard.canSubmitExit(request.trade_id, request.purpose as 'EXIT' | 'EMERGENCY_CLOSE', now);
  return result.allowed ? undefined : result.reason;
}

export class PaperExecutionAdapter implements ExecutionEngine {
  private readonly orders = new Map<string, InternalOrder>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: PaperExecutionAdapterDeps) {}

  async submit(request: OrderRequest): Promise<PaperOrder> {
    const expectReduceOnly = request.purpose !== 'ENTRY';
    if (request.reduce_only !== expectReduceOnly) {
      throw new InvalidOrderRequestError(
        `INVALID_ORDER_REQUEST: purpose=${request.purpose} requires reduce_only=${expectReduceOnly}`,
      );
    }

    const now = this.deps.clock.now();
    const orderId = crypto.randomUUID();
    const instrument = this.deps.instruments.getInstrument(request.exchange, request.symbol);
    const contractMultiplier = instrument?.contract_multiplier ?? 1;
    const stepSize = instrument?.step_size ?? 0;
    const takerFeeRate = this.deps.feeRates.getTakerFeeRate(request.exchange, request.symbol);
    const timeInForce: 'GTC' | 'IOC' =
      request.time_in_force ?? this.deps.config.market_order_time_in_force ?? 'GTC';

    const created: PaperOrder = {
      order_id: orderId,
      client_order_id: request.client_order_id,
      trade_id: request.trade_id,
      leg_id: request.leg_id,
      purpose: request.purpose,
      exchange: request.exchange,
      symbol: request.symbol,
      order_type: request.order_type,
      side: request.side,
      position_side: request.position_side,
      reduce_only: request.reduce_only,
      requested_quantity: request.requested_quantity,
      requested_notional_usdt: request.requested_notional_usdt,
      requested_price: request.requested_price,
      reference_price: request.reference_price,
      order_state: 'CREATED',
      created_at: now,
      updated_at: now,
      filled_quantity: 0,
      remaining_quantity: request.requested_quantity,
      estimated_fee_usdt: request.estimated_fee_usdt,
      estimated_slippage_pct: request.estimated_slippage_pct,
    };
    const submitted: PaperOrder = { ...created, order_state: 'SUBMITTED', submit_time: now, updated_at: now };

    const rng = stream(this.deps.config.seed, request.client_order_id);
    const latency = this.deps.config.execution_latency[request.exchange];
    const failure = this.deps.config.enable_failure_injection ? this.deps.config.failure_injection?.[request.exchange] : undefined;

    const internal: InternalOrder = {
      order: submitted,
      request,
      timeInForce,
      rng,
      contractMultiplier,
      stepSize,
      takerFeeRate,
      ackLatency: ackLatencyMs(latency, failure, rng),
      ackLost: rollProbability(failure?.ack_loss_probability, rng),
      ackTimeoutFired: false,
      deferredCancel: false,
      matchedLevelKeys: new Set(),
    };

    // Step-size / disconnect / stale-book / reject checks resolve at ACK time
    // (post-SUBMITTED), per spec "Order state machine": CREATED -> SUBMITTED
    // is unconditional; REJECTED is only reachable from SUBMITTED.
    const guardReason = endpointGuardReason(this.deps.guard, request, now);
    void guardReason; // consumed by coordinators (group 3); submit() itself does not refuse on guard result.

    this.deps.ledger.createOrder(created, submitted, 'submitted');
    this.orders.set(orderId, internal);
    this.notify(submitted, []);

    this.scheduleAck(internal);
    this.scheduleLifetimeTimeout(internal);

    return submitted;
  }

  async cancel(orderId: string): Promise<PaperOrder> {
    const internal = this.requireOrder(orderId);
    const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    if (TERMINAL.has(internal.order.order_state)) {
      throw new OrderNotCancelableError(orderId);
    }
    if (internal.order.order_state === 'SUBMITTED') {
      // Deferred: §9 has no SUBMITTED -> CANCEL_REQUESTED; applied once ACKNOWLEDGED.
      internal.deferredCancel = true;
      return internal.order;
    }
    this.beginCancelRequested(internal, 'cancel requested');
    return internal.order;
  }

  async getOrder(orderId: string): Promise<PaperOrder> {
    return this.requireOrder(orderId).order;
  }

  onOrderUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private requireOrder(orderId: string): InternalOrder {
    const internal = this.orders.get(orderId);
    if (!internal) throw new Error(`PaperExecutionAdapter: unknown order ${orderId}`);
    return internal;
  }

  private notify(order: PaperOrder, fills: Fill[]): void {
    for (const listener of this.listeners) listener(order, fills);
  }

  private transition(internal: InternalOrder, patch: Partial<PaperOrder>, reason: string): PaperOrder {
    const before = internal.order;
    const now = this.deps.clock.now();
    const after: PaperOrder = { ...before, ...patch, updated_at: now };
    const result = this.deps.ledger.applyOrderTransition(before, after, reason);
    internal.order = result.order;
    return result.order;
  }

  private appendInfoEvent(internal: InternalOrder, eventType: AppendEventInput['event_type'], payload: Record<string, unknown>): void {
    this.deps.eventStore?.append({
      event_id: crypto.randomUUID(),
      event_type: eventType,
      timestamp: this.deps.clock.now(),
      trade_id: internal.order.trade_id,
      leg_id: internal.order.leg_id,
      order_id: internal.order.order_id,
      payload,
    });
  }

  private scheduleAck(internal: InternalOrder): void {
    internal.ackHandle = this.deps.clock.after(internal.ackLatency, () => this.handleAck(internal));

    const ackTimeoutMs = this.deps.config.ack_timeout_ms;
    internal.ackTimeoutHandle = this.deps.clock.after(ackTimeoutMs, () => this.handleAckTimeout(internal));
  }

  private handleAck(internal: InternalOrder): void {
    if (internal.order.order_state !== 'SUBMITTED') return; // already resolved (e.g. REJECTED via ack-timeout lost path)
    if (internal.ackLost) return; // never acknowledges via the normal path; ack-timeout resolves it

    const request = internal.request;
    const failure = this.deps.config.enable_failure_injection
      ? this.deps.config.failure_injection?.[request.exchange]
      : undefined;

    if (isDisconnected(failure?.disconnect_windows, this.deps.clock.now())) {
      this.transition(internal, { order_state: 'REJECTED', rejection_reason: 'EXCHANGE_DISCONNECTED', terminal_time: this.deps.clock.now() }, 'exchange disconnected');
      this.notify(internal.order, []);
      return;
    }
    if (rollProbability(failure?.reject_probability, internal.rng)) {
      this.transition(internal, { order_state: 'REJECTED', rejection_reason: 'INSUFFICIENT_MARGIN_SIMULATED', terminal_time: this.deps.clock.now() }, 'rejected');
      this.notify(internal.order, []);
      return;
    }
    if (!isValidStep(request.requested_quantity, internal.stepSize)) {
      this.transition(internal, { order_state: 'REJECTED', rejection_reason: 'INVALID_QUANTITY_STEP', terminal_time: this.deps.clock.now() }, 'invalid step');
      this.notify(internal.order, []);
      return;
    }
    if (request.reduce_only) {
      const open = this.deps.positions.getOpenQuantity(request.leg_id);
      if (request.requested_quantity > open) {
        this.transition(
          internal,
          { order_state: 'REJECTED', rejection_reason: 'REDUCE_ONLY_EXCEEDS_POSITION', terminal_time: this.deps.clock.now() },
          'reduce-only exceeds position',
        );
        this.notify(internal.order, []);
        return;
      }
    }

    this.transition(internal, { order_state: 'ACKNOWLEDGED', ack_time: this.deps.clock.now() }, 'ack');
    this.notify(internal.order, []);

    if (internal.deferredCancel) {
      internal.deferredCancel = false;
      this.beginCancelRequested(internal, 'deferred cancel applied after ack');
      return;
    }

    this.scheduleMatch(internal);
    internal.unsubscribeBookUpdates = this.deps.orderBook.onUpdate((snapshot) => {
      if (snapshot.exchange !== internal.request.exchange || snapshot.symbol !== internal.request.symbol) return;
      if (internal.timeInForce !== 'GTC') return;
      const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
      if (TERMINAL.has(internal.order.order_state)) return;
      this.scheduleMatch(internal);
    });
  }

  private handleAckTimeout(internal: InternalOrder): void {
    if (internal.ackTimeoutFired) return;
    internal.ackTimeoutFired = true;
    if (internal.order.order_state !== 'SUBMITTED') return; // already acknowledged/resolved
    this.appendInfoEvent(internal, 'ORDER_ACK_TIMEOUT', { reason: 'ACK_TIMEOUT' });
    if (internal.ackLost) {
      this.transition(
        internal,
        { order_state: 'REJECTED', rejection_reason: 'ORDER_NOT_FOUND_AFTER_ACK_TIMEOUT', terminal_time: this.deps.clock.now() },
        'ack timeout: order lost',
      );
      this.notify(internal.order, []);
    }
    // else: the normal ack timer (scheduled at submit time, possibly later than ack_timeout_ms) still fires and resolves it.
  }

  private scheduleLifetimeTimeout(internal: InternalOrder): void {
    internal.lifetimeHandle = this.deps.clock.after(this.deps.config.max_order_lifetime_ms, () => this.handleLifetimeTimeout(internal));
  }

  private handleLifetimeTimeout(internal: InternalOrder): void {
    const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    if (TERMINAL.has(internal.order.order_state)) return;
    this.appendInfoEvent(internal, 'ORDER_TIMEOUT', { timeout_reason: 'MAX_ORDER_LIFETIME' });
    if (internal.order.order_state === 'SUBMITTED') return; // nothing cancelable yet; ack-timeout path owns SUBMITTED resolution
    this.beginCancelRequested(internal, 'max order lifetime exceeded', 'MAX_ORDER_LIFETIME');
  }

  private scheduleMatch(internal: InternalOrder): void {
    const latency = this.deps.config.execution_latency[internal.request.exchange];
    const delay = fillLatencyMs(latency, internal.rng);
    this.deps.clock.after(delay, () => this.runMatch(internal));
  }

  private runMatch(internal: InternalOrder): void {
    const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    if (TERMINAL.has(internal.order.order_state)) return;
    // CANCEL_REQUESTED stays eligible to match (spec "Cancel outcomes": "Fills
    // arriving during CANCEL_REQUESTED SHALL be recorded ... unless they
    // complete the order"); see the completing-fill-only guard below.
    const MATCHABLE = new Set(['ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED']);
    if (!MATCHABLE.has(internal.order.order_state)) return;

    const snapshot = this.deps.orderBook.getOrderBook(internal.request.exchange, internal.request.symbol);
    if (!snapshot) return;

    const request = internal.request;
    const side = request.side;
    const levels = side === 'BUY' ? snapshot.asks : snapshot.bids;
    const failure = this.deps.config.enable_failure_injection
      ? this.deps.config.failure_injection?.[request.exchange]
      : undefined;
    const liquidityMultiplier = failure?.liquidity_multiplier ?? 1;
    const priceShiftPct = failure?.price_shift_pct ?? 0;
    const shiftedLevels = levels.map((l) => ({
      price: side === 'BUY' ? l.price * (1 + priceShiftPct / 100) : l.price * (1 - priceShiftPct / 100),
      qty: l.qty * liquidityMultiplier,
    }));

    const remaining = internal.order.remaining_quantity;
    const limitPrice = internal.order.order_type === 'LIMIT' ? internal.order.requested_price : undefined;
    const walk = walkBook(shiftedLevels, side, remaining, limitPrice);

    let fillQty = walk.filledQuantity;
    const maxFillRatio = failure?.max_fill_ratio;
    if (maxFillRatio !== undefined && maxFillRatio < 1) {
      fillQty = Math.min(fillQty, remaining * maxFillRatio);
    }
    if (rollProbability(failure?.fill_probability !== undefined ? 1 - failure.fill_probability : undefined, internal.rng)) {
      fillQty = 0; // fill_probability roll failed -> no fill this pass
    }
    if (this.deps.config.enable_partial_fill === false && fillQty < remaining) {
      fillQty = 0; // all-or-nothing: no fill unless the full remainder is available
    }
    if (fillQty <= 0) {
      if (internal.timeInForce === 'IOC') this.expireRemainder(internal);
      return;
    }

    // Trim level fills to fillQty (in case of max_fill_ratio / fill_probability reduction).
    let toAllocate = fillQty;
    const trimmedLevels: { price: number; quantity: number }[] = [];
    for (const lf of walk.levelFills) {
      if (toAllocate <= 0) break;
      const take = Math.min(lf.quantity, toAllocate);
      trimmedLevels.push({ price: lf.price, quantity: take });
      toAllocate -= take;
    }

    const avgPrice = averageFillPrice(trimmedLevels);
    if (avgPrice === undefined) {
      if (internal.timeInForce === 'IOC') this.expireRemainder(internal);
      return;
    }

    const now = this.deps.clock.now();
    const newRemaining = internal.order.remaining_quantity - fillQty;
    const nextState: PaperOrder['order_state'] = newRemaining <= 1e-9 ? 'FILLED' : 'PARTIALLY_FILLED';
    const startBefore = internal.order;

    if (startBefore.order_state === 'CANCEL_REQUESTED' && nextState !== 'FILLED') {
      // Only a *completing* fill is applied while a cancel is pending (spec
      // "without leaving CANCEL_REQUESTED unless they complete the order");
      // a non-completing fill is deferred until the cancel resolves (success
      // -> CANCELED keeps the prior filled_quantity; failure -> reverts to
      // ACKNOWLEDGED/PARTIALLY_FILLED and normal matching resumes there).
      return;
    }

    const fills: Fill[] = trimmedLevels.map((lf) => {
      const notional = notionalUsdt(lf.quantity, lf.price, internal.contractMultiplier);
      const fee = feeUsdt(notional, internal.takerFeeRate);
      internal.matchedLevelKeys.add(`${lf.price}`);
      return {
        fill_id: crypto.randomUUID(),
        order_id: startBefore.order_id,
        trade_id: startBefore.trade_id,
        leg_id: startBefore.leg_id,
        exchange: startBefore.exchange,
        timestamp: now,
        recorded_at: now,
        created_at: now,
        updated_at: now,
        quantity: lf.quantity,
        price: lf.price,
        notional_usdt: notional,
        fee_usdt: fee,
        fee_asset: 'USDT',
        liquidity: 'TAKER' as const,
        slippage_from_reference_pct: slippagePct(side, lf.price, startBefore.reference_price),
      };
    });

    // Apply fills one at a time, each its own atomic Ledger commit (spec §11
    // "one Order many Fills"), accumulating filled/remaining/avg price/fee
    // so the last iteration lands exactly on the final post-match state.
    let runningOrder = startBefore;
    fills.forEach((fill, idx) => {
      const isLast = idx === fills.length - 1;
      const cumFilled = runningOrder.filled_quantity + fill.quantity;
      const cumRemaining = Math.max(0, runningOrder.remaining_quantity - fill.quantity);
      const priorNotional = (runningOrder.average_fill_price ?? 0) * runningOrder.filled_quantity;
      const cumAvgPrice = (priorNotional + fill.price * fill.quantity) / cumFilled;
      const cumFee = (runningOrder.actual_fee_usdt ?? 0) + fill.fee_usdt;
      const stepState: PaperOrder['order_state'] = isLast ? nextState : 'PARTIALLY_FILLED';
      const stepAfter: PaperOrder = {
        ...runningOrder,
        order_state: stepState,
        filled_quantity: cumFilled,
        remaining_quantity: cumRemaining,
        average_fill_price: cumAvgPrice,
        actual_fee_usdt: cumFee,
        first_fill_time: runningOrder.first_fill_time ?? now,
        final_fill_time: stepState === 'FILLED' ? now : runningOrder.final_fill_time,
        terminal_time: stepState === 'FILLED' ? now : runningOrder.terminal_time,
        actual_slippage_pct: slippagePct(side, cumAvgPrice, runningOrder.reference_price),
        updated_at: now,
      };
      const result = this.deps.ledger.applyFill({ fill, orderBefore: runningOrder, orderAfter: stepAfter, reason: 'fill' });
      runningOrder = result.order;
    });
    internal.order = runningOrder;

    this.notify(internal.order, fills);

    if (nextState === 'PARTIALLY_FILLED' && internal.timeInForce === 'IOC') {
      this.expireRemainder(internal);
    }
  }

  private expireRemainder(internal: InternalOrder): void {
    const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    if (TERMINAL.has(internal.order.order_state)) return;
    const now = this.deps.clock.now();
    this.transition(internal, { order_state: 'EXPIRED', terminal_time: now }, 'IOC remainder expired');
    this.notify(internal.order, []);
  }

  private beginCancelRequested(internal: InternalOrder, reason: string, cancelReason?: string): void {
    void cancelReason;
    const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    if (TERMINAL.has(internal.order.order_state) || internal.order.order_state === 'CANCEL_REQUESTED') return;
    const now = this.deps.clock.now();
    this.transition(internal, { order_state: 'CANCEL_REQUESTED', cancel_request_time: now }, reason);
    this.notify(internal.order, []);

    const latency = this.deps.config.execution_latency[internal.request.exchange];
    const delay = cancelLatencyMs(latency, internal.rng);
    internal.cancelHandle = this.deps.clock.after(delay, () => this.resolveCancel(internal));
  }

  private resolveCancel(internal: InternalOrder): void {
    if (internal.order.order_state !== 'CANCEL_REQUESTED') return; // already resolved by a fill arriving first

    const failure = this.deps.config.enable_failure_injection
      ? this.deps.config.failure_injection?.[internal.request.exchange]
      : undefined;
    const disconnected = isDisconnected(failure?.disconnect_windows, this.deps.clock.now());
    const failed = disconnected || rollProbability(failure?.cancel_failure_probability, internal.rng);

    if (failed) {
      const revertState: PaperOrder['order_state'] = internal.order.filled_quantity > 0 ? 'PARTIALLY_FILLED' : 'ACKNOWLEDGED';
      this.transition(
        internal,
        { order_state: revertState, cancel_reject_reason: disconnected ? 'EXCHANGE_DISCONNECTED' : 'CANCEL_REJECTED_SIMULATED' },
        'cancel rejected',
      );
      this.notify(internal.order, []);
      return;
    }

    const now = this.deps.clock.now();
    this.transition(internal, { order_state: 'CANCELED', cancel_ack_time: now, terminal_time: now }, 'canceled');
    this.notify(internal.order, []);
  }
}
