/**
 * runtime/src/trading/entryCoordinator.ts
 *
 * `paper-execution-engine` tasks 3.2 (two-leg entry coordination) + 3.3
 * (emergency close, triggered by `LEG_IMBALANCE`). Depends only on
 * `ExecutionEngine` (spec "Replaceable execution interface" — coordinators
 * never import `PaperExecutionAdapter`), `FundingWindowGuard`,
 * `InstrumentSource` (for step-size rounding of the `PARTIALLY_HEDGED`
 * resubmission quantity), `Ledger` (trade/leg transitions + capital
 * release, design.md Decision 6), and `hedgeRatio.ts`'s
 * `computeHedgeRatio`/`classifyHedge` via `hedgeRatioEvent.ts` (never
 * reimplemented, design.md Decision 5).
 *
 * Implementation notes (see design.md "Task Group 3-4" for the full
 * rationale):
 *  - Per-leg fill state (`base_quantity`/`average_entry_price` for the
 *    hedge-ratio formula) is tracked from this coordinator's own order/fill
 *    bookkeeping (via `onOrderUpdate`), not from a `PositionReader` port —
 *    `PositionReader.getOpenQuantity` has no average-price field, and
 *    extending that port is out of scope here (it would change a shape
 *    another not-yet-merged capability depends on).
 *  - `TradeLeg.actual_quantity`/`actual_notional_usdt`/`average_entry_price`
 *    are persisted on every leg status transition so `ExitCoordinator` (a
 *    separate instance with no shared in-memory state) can read a leg's
 *    current open quantity straight from `TradeRepository.getTrade`.
 *  - "Caused by timeout" vs "caused by rejection" (spec "ABORTED (ENTRY_TIMEOUT
 *    if caused by timeout, ENTRY_REJECTED if by rejection)") is inferred
 *    from each leg's terminal `order_state`: any `CANCELED` (only reachable
 *    via the adapter's own `max_order_lifetime_ms` cancel path during entry,
 *    since this coordinator never cancels an entry order itself before
 *    classification) -> `ENTRY_TIMEOUT`; otherwise (`REJECTED`/`EXPIRED`
 *    only) -> `ENTRY_REJECTED`.
 */
import type { Clock, TimerHandle } from '../clock/types';
import type { TradeRepository } from '../storage/tradeRepository';
import type { Ledger } from '../storage/ledger';
import { ORDER_TERMINAL_STATES } from '../types/status';
import type { OrderState } from '../types/status';
import type { Trade, TradeLeg } from '../types/trade';
import type { ExecutionEngine, FundingWindowGuard, InstrumentSource, OrderRequest } from '../execution/executionInterface';
import type { PaperOrder, Fill } from '../types';
import { evaluateHedgeRatio, buildHedgeRatioChangedEvent, type HedgeRatioConfig } from './hedgeRatioEvent';
import type { HedgeLegInput } from './hedgeRatio';

const TERMINAL_ORDER_STATES = new Set<OrderState>(ORDER_TERMINAL_STATES);

export interface EntryCoordinatorConfig extends HedgeRatioConfig {
  /** Default 5000ms (spec §14 / ✅ C-12). */
  partial_hedge_max_duration_ms: number;
  /** Default 200ms. */
  cancel_retry_interval_ms?: number;
  /** Default 5. */
  cancel_retry_max?: number;
  /** Deadline from `EMERGENCY_EXIT` start to flat, else `FAILED`/`EMERGENCY_EXIT_TIMEOUT`. */
  emergency_exit_timeout_ms: number;
}

export interface EntryCoordinatorDeps {
  clock: Clock;
  ledger: Ledger;
  execution: ExecutionEngine;
  guard: FundingWindowGuard;
  instruments: InstrumentSource;
  tradeRepo: TradeRepository;
  config: EntryCoordinatorConfig;
}

interface LegFillState {
  leg: TradeLeg;
  activeOrderId: string;
  orderIds: string[];
  filled_quantity: number;
  notional: number;
  activeOrderTerminal: boolean;
  activeOrderState: OrderState;
  hadCancel: boolean;
  zeroFillTriggered: boolean;
}

interface EmergencyLegState {
  openQty: number;
  closedQty: number;
  closeOrderIds: string[];
  activeCloseOrderId?: string;
  flat: boolean;
  cancelRetries: number;
}

interface EmergencyState {
  reason: string;
  startedAt: number;
  pendingCancels: number;
  timeoutHandle?: TimerHandle;
  legs: Map<string, EmergencyLegState>;
  resolved: boolean;
}

interface TradeEntryState {
  trade: Trade;
  legs: Map<string, LegFillState>;
  phase: 'ENTRY' | 'PARTIAL_WAIT' | 'DONE';
  partialHedgeTimerHandle?: TimerHandle;
  emergency?: EmergencyState;
}

function legDirectionKey(leg: TradeLeg): 'long' | 'short' {
  return leg.direction === 'LONG' ? 'long' : 'short';
}

function toHedgeLegInput(legState: LegFillState | undefined): HedgeLegInput {
  if (!legState || legState.filled_quantity <= 0) return { base_quantity: 0, average_entry_price: 0 };
  return { base_quantity: legState.filled_quantity, average_entry_price: legState.notional / legState.filled_quantity };
}

function floorToStep(qty: number, stepSize: number): number {
  if (!stepSize || stepSize <= 0) return qty;
  return Math.floor(qty / stepSize) * stepSize;
}

export class EntryCoordinator {
  private readonly trades = new Map<string, TradeEntryState>();

  constructor(private readonly deps: EntryCoordinatorDeps) {
    this.deps.execution.onOrderUpdate((order, fills) => this.handleOrderUpdate(order, fills));
  }

  /** spec "Two-leg entry coordination": `trade.status` MUST be `PRE_FLIGHT`. */
  async start(trade: Trade): Promise<void> {
    if (trade.status !== 'PRE_FLIGHT') {
      throw new Error(`EntryCoordinator.start: trade ${trade.trade_id} is not PRE_FLIGHT (status=${trade.status})`);
    }
    const now = this.deps.clock.now();
    // `entryPending` is only used as the `before`/base for the trade-level
    // transition (committed LAST, see `legsSnapshot` doc comment) — legs are
    // persisted first.
    const entryPending: Trade = { ...trade, status: 'ENTRY_PENDING', updated_at: now, entry_started_at: now };

    const legs = new Map<string, LegFillState>();
    const state: TradeEntryState = { trade, legs, phase: 'ENTRY' };
    this.trades.set(trade.trade_id, state);

    for (const leg of trade.legs) {
      const opening: TradeLeg = { ...leg, status: 'OPENING', updated_at: now, entry_started_at: now };
      this.deps.ledger.applyLegTransition(leg, opening, 'entry coordinator start');

      const legState: LegFillState = {
        leg: opening,
        activeOrderId: '',
        orderIds: [],
        filled_quantity: 0,
        notional: 0,
        activeOrderTerminal: false,
        activeOrderState: 'CREATED',
        hadCancel: false,
        zeroFillTriggered: false,
      };
      legs.set(leg.leg_id, legState);

      const guardResult = this.deps.guard.canSubmitEntry(trade.trade_id, now);
      if (!guardResult.allowed) {
        legState.activeOrderTerminal = true;
        legState.activeOrderState = 'REJECTED';
        continue;
      }

      const clientOrderId = `${trade.trade_id}:${leg.leg_id}:entry:0`;
      const order = await this.deps.execution.submit(this.buildEntryRequest(entryPending, leg, clientOrderId, leg.target_quantity, leg.target_entry_price));
      legState.activeOrderId = order.order_id;
      legState.orderIds.push(order.order_id);
    }

    const after: Trade = { ...entryPending, legs: this.legsSnapshot(state) };
    this.deps.ledger.applyTradeTransition(trade, after, 'entry coordinator start');
    state.trade = after;

    this.maybeAdvance(trade.trade_id);
  }

  /** spec "forceLegImbalance" — exposed for `funding-settlement-rules` (e.g. `NOT_HEDGED_BEFORE_WINDOW` at `hedged_by`). */
  forceLegImbalance(tradeId: string, reason: string): void {
    const state = this.trades.get(tradeId);
    if (!state) return;
    // `phase === 'DONE'` means entry resolution is over (set by resolveHedged
    // too, the moment a trade reaches HEDGED) — NOT that the trade is
    // terminal, so it must not gate this call; only an actually-terminal or
    // already-emergency trade status should.
    const TERMINAL_OR_EMERGENCY = new Set(['CLOSED', 'ABORTED', 'FAILED', 'EMERGENCY_EXIT']);
    if (TERMINAL_OR_EMERGENCY.has(state.trade.status)) return;
    if (state.partialHedgeTimerHandle) {
      this.deps.clock.cancel(state.partialHedgeTimerHandle);
      state.partialHedgeTimerHandle = undefined;
    }
    if (state.trade.status === 'HEDGED') {
      this.emergencyClose(tradeId, reason);
      return;
    }
    this.transitionToLegImbalance(tradeId, reason);
  }

  // -------------------------------------------------------------------
  // Order request building
  // -------------------------------------------------------------------

  private buildEntryRequest(trade: Trade, leg: TradeLeg, clientOrderId: string, quantity: number, referencePrice: number): OrderRequest {
    return {
      client_order_id: clientOrderId,
      trade_id: trade.trade_id,
      leg_id: leg.leg_id,
      purpose: 'ENTRY',
      exchange: leg.exchange,
      symbol: leg.symbol,
      order_type: 'MARKET',
      side: leg.order_side,
      position_side: leg.direction,
      reduce_only: false,
      requested_quantity: quantity,
      requested_notional_usdt: quantity * referencePrice,
      reference_price: referencePrice,
      estimated_fee_usdt: 0,
      estimated_slippage_pct: 0,
    };
  }

  private buildCloseRequest(
    trade: Trade,
    leg: TradeLeg,
    clientOrderId: string,
    quantity: number,
    referencePrice: number,
    purpose: 'EMERGENCY_CLOSE',
  ): OrderRequest {
    return {
      client_order_id: clientOrderId,
      trade_id: trade.trade_id,
      leg_id: leg.leg_id,
      purpose,
      exchange: leg.exchange,
      symbol: leg.symbol,
      order_type: 'MARKET',
      side: leg.order_side === 'BUY' ? 'SELL' : 'BUY',
      position_side: leg.direction,
      reduce_only: true,
      requested_quantity: quantity,
      requested_notional_usdt: quantity * referencePrice,
      reference_price: referencePrice,
      estimated_fee_usdt: 0,
      estimated_slippage_pct: 0,
    };
  }

  // -------------------------------------------------------------------
  // Order update handling
  // -------------------------------------------------------------------

  private handleOrderUpdate(order: PaperOrder, fills: Fill[]): void {
    const state = this.trades.get(order.trade_id);
    if (!state) return;
    if (order.purpose === 'ENTRY') this.handleEntryOrderUpdate(state, order, fills);
    else if (order.purpose === 'EMERGENCY_CLOSE') this.handleEmergencyOrderUpdate(state, order, fills);
  }

  private handleEntryOrderUpdate(state: TradeEntryState, order: PaperOrder, fills: Fill[]): void {
    const legState = state.legs.get(order.leg_id);
    if (!legState || legState.activeOrderId !== order.order_id) return;

    if (fills.length > 0) {
      for (const f of fills) {
        legState.filled_quantity += f.quantity;
        legState.notional += f.quantity * f.price;
      }
      if (state.phase !== 'DONE') this.emitHedgeRatioChanged(state);
    }

    const previousState = legState.activeOrderState;
    legState.activeOrderState = order.order_state;
    const becameTerminal = TERMINAL_ORDER_STATES.has(order.order_state);
    if (becameTerminal) {
      legState.activeOrderTerminal = true;
      if (order.order_state === 'CANCELED') legState.hadCancel = true;
    }

    // Once emergency close has started, this entry order's remaining
    // lifecycle (cancel ack / cancel-rejected revert / race-filled) is
    // routed to the emergency bookkeeping instead of (re-)running
    // classification — `state.phase === 'DONE'` by the time emergencyClose
    // sets `state.emergency`, so this branch MUST come before the early
    // 'DONE' phase would otherwise have dropped the update entirely.
    if (state.emergency) {
      const isCancelRejectedRevert =
        !becameTerminal && (order.order_state === 'ACKNOWLEDGED' || order.order_state === 'PARTIALLY_FILLED') && previousState === 'CANCEL_REQUESTED';
      if (becameTerminal || isCancelRejectedRevert) {
        this.handleEmergencyEntryCancelResolution(state, legState, order);
      }
      return;
    }

    if (becameTerminal && legState.filled_quantity <= 1e-9 && !legState.zeroFillTriggered) {
      legState.zeroFillTriggered = true;
      // spec: "the other leg's pending orders are then canceled first".
      for (const [otherLegId, otherLegState] of state.legs) {
        if (otherLegId === order.leg_id) continue;
        if (!otherLegState.activeOrderTerminal && otherLegState.activeOrderId) {
          void this.deps.execution.cancel(otherLegState.activeOrderId).catch(() => undefined);
        }
      }
    }

    if (becameTerminal) this.maybeAdvance(state.trade.trade_id);
  }

  private emitHedgeRatioChanged(state: TradeEntryState): void {
    const legsByDirection = new Map<'long' | 'short', LegFillState>();
    for (const legState of state.legs.values()) legsByDirection.set(legDirectionKey(legState.leg), legState);
    const long = toHedgeLegInput(legsByDirection.get('long'));
    const short = toHedgeLegInput(legsByDirection.get('short'));
    const { result } = evaluateHedgeRatio({ symbol: state.trade.symbol, long, short, config: this.deps.config });
    const event = buildHedgeRatioChangedEvent({ trade_id: state.trade.trade_id, symbol: state.trade.symbol, result }, this.deps.clock);
    this.deps.ledger.appendEvent(event);
  }

  // -------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------

  private maybeAdvance(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || state.phase === 'DONE') return;
    const allTerminal = [...state.legs.values()].every((l) => l.activeOrderTerminal);
    if (!allTerminal) return;
    this.classify(tradeId);
  }

  /**
   * `Trade.legs` is an embedded array, and `TradeRepository.saveTrade`
   * (called by every `Ledger.applyTradeTransition`) re-writes ALL
   * `trade_legs` rows from it — so every `Trade` patch built here MUST
   * carry the coordinator's current per-leg snapshots, never the stale
   * `trade.legs` captured once at `start()`, or a trade-level transition
   * would silently clobber leg rows back to their pre-entry state.
   */
  private legsSnapshot(state: TradeEntryState): TradeLeg[] {
    return [...state.legs.values()].map((l) => l.leg);
  }

  private legsByDirection(state: TradeEntryState): { long?: LegFillState; short?: LegFillState } {
    const result: { long?: LegFillState; short?: LegFillState } = {};
    for (const legState of state.legs.values()) result[legDirectionKey(legState.leg)] = legState;
    return result;
  }

  private classify(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || state.phase === 'DONE') return;
    const { long, short } = this.legsByDirection(state);

    const bothZero = (long?.filled_quantity ?? 0) <= 1e-9 && (short?.filled_quantity ?? 0) <= 1e-9;
    if (bothZero) {
      const anyTimeout = [long, short].some((l) => l?.hadCancel);
      this.abort(tradeId, anyTimeout ? 'ENTRY_TIMEOUT' : 'ENTRY_REJECTED');
      return;
    }

    const { classification } = evaluateHedgeRatio({
      symbol: state.trade.symbol,
      long: toHedgeLegInput(long),
      short: toHedgeLegInput(short),
      config: this.deps.config,
    });

    if (classification === 'HEDGED') {
      this.resolveHedged(tradeId);
    } else if (classification === 'PARTIALLY_HEDGED') {
      this.resolvePartiallyHedged(tradeId);
    } else {
      this.transitionToLegImbalance(tradeId, 'LEG_IMBALANCE');
    }
  }

  private abort(tradeId: string, reason: 'ENTRY_TIMEOUT' | 'ENTRY_REJECTED'): void {
    const state = this.trades.get(tradeId)!;
    const now = this.deps.clock.now();

    // Legs MUST be persisted before the trade-level transition: `TradeLeg`
    // and `Trade` events both carry `trade_id`, and `assertTraceability`'s
    // "trades" check treats the chronologically LAST trade_id-scoped event
    // with a `payload.to` as the trade's expected current status — so a leg
    // event after the trade event would be mistaken for it.
    for (const legState of state.legs.values()) {
      const beforeLeg = legState.leg;
      const afterLeg: TradeLeg = { ...beforeLeg, status: 'FAILED', updated_at: now, entry_completed_at: now };
      this.deps.ledger.applyLegTransition(beforeLeg, afterLeg, reason);
      legState.leg = afterLeg;
    }

    const before = state.trade;
    const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'ABORTED', updated_at: now, entry_completed_at: now };
    this.deps.ledger.applyTradeTransition(before, after, reason, { releaseCapitalReason: reason });
    state.trade = after;
    state.phase = 'DONE';
  }

  private persistLegActuals(legState: LegFillState, status: TradeLeg['status'], now: number): TradeLeg {
    const avg = legState.filled_quantity > 0 ? legState.notional / legState.filled_quantity : undefined;
    const beforeLeg = legState.leg;
    const afterLeg: TradeLeg = {
      ...beforeLeg,
      status,
      actual_quantity: legState.filled_quantity,
      actual_notional_usdt: legState.notional,
      average_entry_price: avg,
      updated_at: now,
      // entry is only "complete" for this leg once it reaches a resting
      // state (OPEN / FAILED) — PARTIAL is still awaiting resubmission.
      entry_completed_at: status === 'PARTIAL' ? beforeLeg.entry_completed_at : now,
    };
    if (status === beforeLeg.status) {
      // LEG_TRANSITIONS has no self-loop (e.g. OPEN -> OPEN) — refreshing
      // actual_quantity/average_entry_price when the status label itself
      // hasn't changed (e.g. HEDGED resolving a leg already marked OPEN by
      // an earlier PARTIALLY_HEDGED persist) is a metadata refresh, not a
      // state transition, so it is written directly with no new event
      // rather than through `applyLegTransition` (which would throw
      // IllegalTransitionError).
      this.deps.tradeRepo.saveTradeLeg(afterLeg);
    } else {
      this.deps.ledger.applyLegTransition(beforeLeg, afterLeg, `classification: ${status}`);
    }
    legState.leg = afterLeg;
    return afterLeg;
  }

  private resolveHedged(tradeId: string): void {
    const state = this.trades.get(tradeId)!;
    const now = this.deps.clock.now();
    if (state.partialHedgeTimerHandle) {
      this.deps.clock.cancel(state.partialHedgeTimerHandle);
      state.partialHedgeTimerHandle = undefined;
    }
    for (const legState of state.legs.values()) {
      this.persistLegActuals(legState, 'OPEN', now);
    }

    const before = state.trade;
    const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'HEDGED', updated_at: now, entry_completed_at: now };
    this.deps.ledger.applyTradeTransition(before, after, 'hedge ratio reached hedged_min');
    state.trade = after;
    state.phase = 'DONE';
  }

  private resolvePartiallyHedged(tradeId: string): void {
    const state = this.trades.get(tradeId)!;
    const now = this.deps.clock.now();

    if (state.trade.status === 'ENTRY_PENDING') {
      for (const legState of state.legs.values()) {
        const status: TradeLeg['status'] = legState.filled_quantity + 1e-9 >= legState.leg.target_quantity ? 'OPEN' : 'PARTIAL';
        this.persistLegActuals(legState, status, now);
      }

      const before = state.trade;
      const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'PARTIALLY_HEDGED', updated_at: now };
      this.deps.ledger.applyTradeTransition(before, after, 'hedge ratio below hedged_min, above imbalance_max');
      state.trade = after;

      state.partialHedgeTimerHandle = this.deps.clock.after(this.deps.config.partial_hedge_max_duration_ms, () =>
        this.handlePartialHedgeTimeout(tradeId),
      );
    }

    state.phase = 'PARTIAL_WAIT';
    this.resubmitLaggingLeg(tradeId);
  }

  private resubmitLaggingLeg(tradeId: string): void {
    const state = this.trades.get(tradeId)!;
    const { long, short } = this.legsByDirection(state);
    const lagging = [long, short]
      .filter((l): l is LegFillState => !!l)
      .find((l) => l.filled_quantity + 1e-9 < l.leg.target_quantity);
    if (!lagging) return;
    if (!lagging.activeOrderTerminal) return; // still waiting on an in-flight order for this leg

    const now = this.deps.clock.now();
    const guardResult = this.deps.guard.canSubmitEntry(tradeId, now);
    if (!guardResult.allowed) return; // spec "Resubmission after entry deadline": no new order, stays PARTIALLY_HEDGED

    const instrument = this.deps.instruments.getInstrument(lagging.leg.exchange, lagging.leg.symbol);
    const missingRaw = lagging.leg.target_quantity - lagging.filled_quantity;
    const missing = floorToStep(missingRaw, instrument?.step_size ?? 0);
    if (missing <= 1e-9) return;

    const clientOrderId = `${tradeId}:${lagging.leg.leg_id}:entry:${lagging.orderIds.length}`;
    // Set the id synchronously (order_id === client_order_id by the paper
    // adapter's deterministic-identity convention, design.md Implementation
    // Notes point 3) rather than in `submit()`'s `.then()` — `Clock.after`
    // timers registered synchronously inside `submit()` can fire (via a
    // later `advanceTo`) before that microtask resolves, which would drop
    // the order-update match in `handleEntryOrderUpdate`.
    lagging.activeOrderTerminal = false;
    lagging.activeOrderId = clientOrderId;
    lagging.orderIds.push(clientOrderId);
    void this.deps.execution
      .submit(this.buildEntryRequest(state.trade, lagging.leg, clientOrderId, missing, lagging.leg.target_entry_price))
      .catch(() => {
        lagging.activeOrderTerminal = true;
      });
  }

  private handlePartialHedgeTimeout(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || state.phase === 'DONE') return;
    if (state.trade.status !== 'PARTIALLY_HEDGED') return; // already resolved to HEDGED
    state.partialHedgeTimerHandle = undefined;
    this.transitionToLegImbalance(tradeId, 'PARTIAL_HEDGE_TIMEOUT');
  }

  private transitionToLegImbalance(tradeId: string, reason: string): void {
    const state = this.trades.get(tradeId)!;
    const now = this.deps.clock.now();
    if (state.partialHedgeTimerHandle) {
      this.deps.clock.cancel(state.partialHedgeTimerHandle);
      state.partialHedgeTimerHandle = undefined;
    }
    for (const legState of state.legs.values()) {
      let status: TradeLeg['status'];
      if (legState.filled_quantity <= 1e-9) {
        status = 'FAILED';
      } else if (legState.leg.status === 'PARTIAL' || legState.leg.status === 'OPEN') {
        status = legState.leg.status; // already set by a prior PARTIALLY_HEDGED persist; LEG_TRANSITIONS has no PARTIAL->FAILED self-loop needed
      } else {
        status = legState.filled_quantity + 1e-9 >= legState.leg.target_quantity ? 'OPEN' : 'PARTIAL';
      }
      if (status !== legState.leg.status || legState.leg.actual_quantity === undefined) {
        this.persistLegActuals(legState, status, now);
      }
    }

    const before = state.trade;
    const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'LEG_IMBALANCE', updated_at: now };
    this.deps.ledger.applyTradeTransition(before, after, reason);
    state.trade = after;

    this.emergencyClose(tradeId, reason);
  }

  // -------------------------------------------------------------------
  // Emergency close (task 3.3)
  // -------------------------------------------------------------------

  private emergencyClose(tradeId: string, reason: string): void {
    const state = this.trades.get(tradeId)!;
    const now = this.deps.clock.now();

    this.deps.ledger.appendEvent({
      event_id: crypto.randomUUID(),
      event_type: 'EMERGENCY_EXIT_STARTED',
      timestamp: now,
      trade_id: tradeId,
      payload: { reason },
    });

    const before = state.trade;
    const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'EMERGENCY_EXIT', updated_at: now };
    this.deps.ledger.applyTradeTransition(before, after, reason);
    state.trade = after;

    const emergency: EmergencyState = {
      reason,
      startedAt: now,
      pendingCancels: 0,
      legs: new Map(),
      resolved: false,
    };
    state.emergency = emergency;
    state.phase = 'DONE';

    for (const [legId, legState] of state.legs) {
      emergency.legs.set(legId, {
        openQty: legState.filled_quantity,
        closedQty: 0,
        closeOrderIds: [],
        flat: legState.filled_quantity <= 1e-9,
        cancelRetries: 0,
      });
      if (!legState.activeOrderTerminal && legState.activeOrderId) {
        emergency.pendingCancels++;
        void this.deps.execution.cancel(legState.activeOrderId).catch(() => undefined);
      }
    }

    emergency.timeoutHandle = this.deps.clock.after(this.deps.config.emergency_exit_timeout_ms, () => this.handleEmergencyTimeout(tradeId));

    if (emergency.pendingCancels === 0) this.submitEmergencyCloseOrders(tradeId);
  }

  private submitEmergencyCloseOrders(tradeId: string): void {
    const state = this.trades.get(tradeId)!;
    const emergency = state.emergency;
    if (!emergency || emergency.resolved) return;

    for (const [legId, legState] of state.legs) {
      const emg = emergency.legs.get(legId)!;
      const remaining = emg.openQty - emg.closedQty;
      if (emg.flat || remaining <= 1e-9 || emg.activeCloseOrderId) continue;

      const clientOrderId = `${tradeId}:${legId}:emergency:${emg.closeOrderIds.length}`;
      // Set synchronously — see the comment in `resubmitLaggingLeg`.
      emg.activeCloseOrderId = clientOrderId;
      emg.closeOrderIds.push(clientOrderId);
      void this.deps.execution
        .submit(this.buildCloseRequest(state.trade, legState.leg, clientOrderId, remaining, legState.leg.target_entry_price, 'EMERGENCY_CLOSE'))
        .catch(() => undefined);
    }

    this.checkEmergencyFlat(tradeId);
  }

  private handleEmergencyOrderUpdate(state: TradeEntryState, order: PaperOrder, fills: Fill[]): void {
    const emergency = state.emergency;
    if (!emergency || emergency.resolved) return;
    const emg = emergency.legs.get(order.leg_id);
    if (!emg || emg.activeCloseOrderId !== order.order_id) return;

    if (fills.length > 0) {
      for (const f of fills) emg.closedQty += f.quantity;
    }

    if (TERMINAL_ORDER_STATES.has(order.order_state)) {
      emg.activeCloseOrderId = undefined;
      const remaining = emg.openQty - emg.closedQty;
      if (remaining <= 1e-9) {
        emg.flat = true;
      } else {
        // Timed-out / rejected / canceled close order with quantity still
        // open -> resubmit the remainder (spec: "any later fills SHALL
        // trigger additional close orders").
        this.submitEmergencyCloseOrders(state.trade.trade_id);
        return;
      }
    }

    this.checkEmergencyFlat(state.trade.trade_id);
  }

  /** Called when a cancel-pending entry order resolves during emergency close (success, failure+retry, or race-filled). */
  private handleEmergencyEntryCancelResolution(state: TradeEntryState, legState: LegFillState, order: PaperOrder): void {
    const emergency = state.emergency;
    if (!emergency || emergency.resolved) return;
    const emg = emergency.legs.get(order.leg_id);
    if (!emg) return;

    if (TERMINAL_ORDER_STATES.has(order.order_state)) {
      emergency.pendingCancels = Math.max(0, emergency.pendingCancels - 1);
      emg.openQty = legState.filled_quantity;
      emg.flat = emg.openQty <= 1e-9;
    } else {
      // cancel was rejected -> order reverted to a non-terminal state; retry.
      const retries = emg.cancelRetries + 1;
      const max = this.deps.config.cancel_retry_max ?? 5;
      if (retries <= max) {
        emg.cancelRetries = retries;
        this.deps.clock.after(this.deps.config.cancel_retry_interval_ms ?? 200, () => {
          void this.deps.execution.cancel(legState.activeOrderId).catch(() => undefined);
        });
        return;
      }
      // give up retrying; treat as resolved so emergency close is not stuck forever.
      emergency.pendingCancels = Math.max(0, emergency.pendingCancels - 1);
      emg.openQty = legState.filled_quantity;
      emg.flat = emg.openQty <= 1e-9;
    }

    if (emergency.pendingCancels === 0) this.submitEmergencyCloseOrders(state.trade.trade_id);
  }

  private checkEmergencyFlat(tradeId: string): void {
    const state = this.trades.get(tradeId)!;
    const emergency = state.emergency;
    if (!emergency || emergency.resolved) return;
    const allFlat = [...emergency.legs.values()].every((l) => l.flat);
    if (!allFlat) return;
    this.finalizeEmergencyClosed(tradeId);
  }

  private finalizeEmergencyClosed(tradeId: string): void {
    const state = this.trades.get(tradeId)!;
    const emergency = state.emergency;
    if (!emergency || emergency.resolved) return;
    emergency.resolved = true;
    if (emergency.timeoutHandle) this.deps.clock.cancel(emergency.timeoutHandle);

    const now = this.deps.clock.now();

    for (const legState of state.legs.values()) {
      const beforeLeg = legState.leg;
      // FAILED (never opened, zero fill) is terminal — LEG_TRANSITIONS has no FAILED->CLOSED; only a leg that was
      // actually opened (OPENING/PARTIAL/OPEN/CLOSING) transitions to CLOSED here.
      if (beforeLeg.status === 'CLOSED' || beforeLeg.status === 'FAILED') continue;
      const closingLeg: TradeLeg = beforeLeg.status === 'CLOSING' ? beforeLeg : { ...beforeLeg, status: 'CLOSING', updated_at: now };
      if (closingLeg !== beforeLeg) this.deps.ledger.applyLegTransition(beforeLeg, closingLeg, 'EMERGENCY_EXIT');
      const afterLeg: TradeLeg = { ...closingLeg, status: 'CLOSED', updated_at: now, exit_completed_at: now };
      this.deps.ledger.applyLegTransition(closingLeg, afterLeg, 'EMERGENCY_EXIT');
      legState.leg = afterLeg;
    }

    const before = state.trade;
    const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'CLOSED', close_reason: 'EMERGENCY_EXIT', updated_at: now, exit_completed_at: now };
    this.deps.ledger.applyTradeTransition(before, after, 'EMERGENCY_EXIT', { releaseCapitalReason: 'EMERGENCY_EXIT' });
    state.trade = after;
  }

  private handleEmergencyTimeout(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || !state.emergency || state.emergency.resolved) return;
    state.emergency.resolved = true;
    const now = this.deps.clock.now();
    const before = state.trade;
    const after: Trade = { ...before, legs: this.legsSnapshot(state), status: 'FAILED', updated_at: now };
    // spec design.md Decision 6: FAILED does NOT release capital (manual confirmation pending).
    this.deps.ledger.applyTradeTransition(before, after, 'EMERGENCY_EXIT_TIMEOUT');
    state.trade = after;
  }
}
