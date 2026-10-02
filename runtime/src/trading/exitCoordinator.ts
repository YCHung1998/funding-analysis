/**
 * runtime/src/trading/exitCoordinator.ts
 *
 * `paper-execution-engine` task 3.3 (second half) — normal close. Depends
 * only on `ExecutionEngine`/`FundingWindowGuard`/`Ledger` (never
 * `PaperExecutionAdapter` directly, spec "Replaceable execution interface").
 *
 * Unlike `EntryCoordinator`, `ExitCoordinator` never holds a long-lived
 * `Trade` snapshot across an `await` boundary that could go stale — each
 * `exit()` call re-reads `TradeRepository.getTrade` for the current leg
 * `actual_quantity` (written by `EntryCoordinator` when the trade reached
 * `HEDGED`), so there is no `Trade.legs` staleness hazard to guard against
 * here (see design.md Implementation Notes point 2).
 */
import type { Clock, TimerHandle } from '../clock/types';
import type { ExecutionEngine, FundingWindowGuard, GuardResult, OrderRequest } from '../execution/executionInterface';
import type { Ledger } from '../storage/ledger';
import type { TradeRepository } from '../storage/tradeRepository';
import { ORDER_TERMINAL_STATES, type OrderState } from '../types/status';
import type { Fill, PaperOrder, Trade, TradeLeg } from '../types';

const TERMINAL_ORDER_STATES = new Set<OrderState>(ORDER_TERMINAL_STATES);

export interface ExitCoordinatorConfig {
  /** Deadline from `EXIT_STARTED` to flat, else `FAILED`/`EXIT_TIMEOUT` (spec reuses `emergency_exit_timeout_ms`). */
  emergency_exit_timeout_ms: number;
}

export interface ExitCoordinatorDeps {
  clock: Clock;
  ledger: Ledger;
  execution: ExecutionEngine;
  guard: FundingWindowGuard;
  tradeRepo: TradeRepository;
  config: ExitCoordinatorConfig;
}

export type ExitResult = { allowed: true } | { allowed: false; reason: string };

interface ExitLegState {
  leg: TradeLeg;
  openQty: number;
  closedQty: number;
  activeOrderId?: string;
  orderCount: number;
  flat: boolean;
}

interface ExitState {
  trade: Trade;
  legs: Map<string, ExitLegState>;
  timeoutHandle?: TimerHandle;
  resolved: boolean;
}

export class ExitCoordinator {
  private readonly trades = new Map<string, ExitState>();

  constructor(private readonly deps: ExitCoordinatorDeps) {
    this.deps.execution.onOrderUpdate((order, fills) => this.handleOrderUpdate(order, fills));
  }

  /**
   * spec "Normal exit": `canSubmitExit` first; if refused (e.g.
   * `LOCK_WINDOW`) the trade is left unchanged and the refusal is returned.
   * Otherwise a `HEDGED` trade moves to `EXIT_PENDING` (event
   * `EXIT_STARTED`), legs to `CLOSING`, and reduce-only EXIT MARKET orders
   * are submitted for each leg's open quantity.
   */
  async exit(tradeId: string): Promise<ExitResult> {
    const now = this.deps.clock.now();
    const guardResult: GuardResult = this.deps.guard.canSubmitExit(tradeId, 'EXIT', now);
    if (!guardResult.allowed) return { allowed: false, reason: guardResult.reason };

    const trade = this.deps.tradeRepo.getTrade(tradeId);
    if (!trade) throw new Error(`ExitCoordinator.exit: unknown trade ${tradeId}`);
    if (trade.status !== 'HEDGED') {
      throw new Error(`ExitCoordinator.exit: trade ${tradeId} is not HEDGED (status=${trade.status})`);
    }

    const legs = new Map<string, ExitLegState>();
    for (const leg of trade.legs) {
      const openQty = leg.actual_quantity ?? leg.target_quantity;
      legs.set(leg.leg_id, { leg, openQty, closedQty: 0, orderCount: 0, flat: openQty <= 1e-9 });
    }
    const state: ExitState = { trade, legs, resolved: false };
    this.trades.set(tradeId, state);

    // Legs persisted before the trade-level transition (assertTraceability
    // discipline, design.md Implementation Notes point 3).
    for (const legState of legs.values()) {
      const beforeLeg = legState.leg;
      const afterLeg: TradeLeg = { ...beforeLeg, status: 'CLOSING', updated_at: now, exit_started_at: now };
      this.deps.ledger.applyLegTransition(beforeLeg, afterLeg, 'exit coordinator start');
      legState.leg = afterLeg;
    }

    const exitPending: Trade = {
      ...trade,
      legs: [...legs.values()].map((l) => l.leg),
      status: 'EXIT_PENDING',
      updated_at: now,
      exit_started_at: now,
    };
    this.deps.ledger.applyTradeTransition(trade, exitPending, 'exit coordinator start');
    this.deps.ledger.appendEvent({
      event_id: crypto.randomUUID(),
      event_type: 'EXIT_STARTED',
      timestamp: now,
      trade_id: tradeId,
      payload: {},
    });
    state.trade = exitPending;

    state.timeoutHandle = this.deps.clock.after(this.deps.config.emergency_exit_timeout_ms, () => this.handleTimeout(tradeId));

    for (const legState of legs.values()) this.submitExitOrder(tradeId, legState);
    this.checkFlat(tradeId);

    return { allowed: true };
  }

  private buildExitRequest(trade: Trade, leg: TradeLeg, clientOrderId: string, quantity: number): OrderRequest {
    return {
      client_order_id: clientOrderId,
      trade_id: trade.trade_id,
      leg_id: leg.leg_id,
      purpose: 'EXIT',
      exchange: leg.exchange,
      symbol: leg.symbol,
      order_type: 'MARKET',
      side: leg.order_side === 'BUY' ? 'SELL' : 'BUY',
      position_side: leg.direction,
      reduce_only: true,
      requested_quantity: quantity,
      requested_notional_usdt: quantity * (leg.average_entry_price ?? leg.target_entry_price),
      reference_price: leg.average_entry_price ?? leg.target_entry_price,
      estimated_fee_usdt: 0,
      estimated_slippage_pct: 0,
    };
  }

  private submitExitOrder(tradeId: string, legState: ExitLegState): void {
    const state = this.trades.get(tradeId);
    if (!state || state.resolved) return;
    const remaining = legState.openQty - legState.closedQty;
    if (legState.flat || remaining <= 1e-9 || legState.activeOrderId) return;

    const clientOrderId = `${tradeId}:${legState.leg.leg_id}:exit:${legState.orderCount++}`;
    // Set synchronously — order_id === client_order_id by the paper
    // adapter's deterministic-identity convention; see design.md
    // Implementation Notes point 4 (same race avoided as in EntryCoordinator).
    legState.activeOrderId = clientOrderId;
    void this.deps.execution.submit(this.buildExitRequest(state.trade, legState.leg, clientOrderId, remaining)).catch(() => undefined);
  }

  private handleOrderUpdate(order: PaperOrder, fills: Fill[]): void {
    if (order.purpose !== 'EXIT') return;
    const state = this.trades.get(order.trade_id);
    if (!state || state.resolved) return;
    const legState = state.legs.get(order.leg_id);
    if (!legState || legState.activeOrderId !== order.order_id) return;

    if (fills.length > 0) {
      for (const f of fills) legState.closedQty += f.quantity;
    }

    if (TERMINAL_ORDER_STATES.has(order.order_state)) {
      legState.activeOrderId = undefined;
      const remaining = legState.openQty - legState.closedQty;
      if (remaining <= 1e-9) {
        legState.flat = true;
      } else {
        // Timed-out/expired/rejected with quantity still open -> resubmit the remainder.
        this.submitExitOrder(order.trade_id, legState);
        return;
      }
    }

    this.checkFlat(order.trade_id);
  }

  private checkFlat(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || state.resolved) return;
    const allFlat = [...state.legs.values()].every((l) => l.flat);
    if (!allFlat) return;
    this.finalizeClosed(tradeId);
  }

  private finalizeClosed(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || state.resolved) return;
    state.resolved = true;
    if (state.timeoutHandle) this.deps.clock.cancel(state.timeoutHandle);
    const now = this.deps.clock.now();

    for (const legState of state.legs.values()) {
      const beforeLeg = legState.leg;
      if (beforeLeg.status === 'CLOSED') continue;
      const afterLeg: TradeLeg = { ...beforeLeg, status: 'CLOSED', updated_at: now, exit_completed_at: now };
      this.deps.ledger.applyLegTransition(beforeLeg, afterLeg, 'NORMAL_EXIT');
      legState.leg = afterLeg;
    }

    const before = state.trade;
    const after: Trade = {
      ...before,
      legs: [...state.legs.values()].map((l) => l.leg),
      status: 'CLOSED',
      close_reason: 'NORMAL_EXIT',
      updated_at: now,
      exit_completed_at: now,
    };
    this.deps.ledger.applyTradeTransition(before, after, 'NORMAL_EXIT', { releaseCapitalReason: 'NORMAL_EXIT' });
    state.trade = after;
  }

  private handleTimeout(tradeId: string): void {
    const state = this.trades.get(tradeId);
    if (!state || state.resolved) return;
    state.resolved = true;
    const now = this.deps.clock.now();
    const before = state.trade;
    // spec design.md Decision 6: FAILED does NOT release capital (manual confirmation pending).
    const after: Trade = { ...before, legs: [...state.legs.values()].map((l) => l.leg), status: 'FAILED', updated_at: now };
    this.deps.ledger.applyTradeTransition(before, after, 'EXIT_TIMEOUT');
    state.trade = after;
  }
}
