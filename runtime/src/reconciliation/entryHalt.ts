/**
 * runtime/src/reconciliation/entryHalt.ts
 *
 * `EntryHaltPort` + `EntryHaltLatch` (design.md Decision 2). `requestHalt`
 * writes a synchronous `ENTRY_HALT_REQUESTED` event (`trade_id: null`, both
 * codes already in `NO_TRADE_EVENT_TYPES`); the halt SURVIVES a Runtime
 * restart only because it is never trusted as in-memory state alone — every
 * `EntryHaltLatch` instance rebuilds its halted/reasons state by replaying
 * `ENTRY_HALT_REQUESTED` / `ENTRY_HALT_CLEARED` from the `EventStore` at
 * construction time (same "replay to rebuild memory state" technique as the
 * reconciliation dedup set and `KillSwitchCoordinator.rebuildLevel`).
 *
 * Only an operator action (`clearHalt`, writing `ENTRY_HALT_CLEARED`) clears
 * a halt — `requestHalt` never clears a prior one, it only adds another
 * reason (design.md Decision 2: "只有操作員動作（ENTRY_HALT_CLEARED 事件）能
 * 解除"). The operator-facing control surface that calls `clearHalt` belongs
 * to `risk-engine-kill-switch` / `paper-trading-ui` (design.md Decision 2);
 * this change only provides the latch itself.
 */
import type { EventStoreClock, StoredTradingEvent } from '../storage/eventStore';

/** `EventStore`'s read side — the only part `EntryHaltLatch` needs. */
export interface EntryHaltEventStore {
  replay(): StoredTradingEvent[];
  append(input: {
    event_id: string;
    event_type: 'ENTRY_HALT_REQUESTED' | 'ENTRY_HALT_CLEARED';
    timestamp: number;
    trade_id: null;
    payload: Record<string, unknown>;
  }): StoredTradingEvent;
}

export type EntryHaltSource = 'RECONCILIATION' | 'RUNTIME_RECOVERY' | 'DATABASE';

export interface HaltRequest {
  source: EntryHaltSource;
  reason: string;
  trade_ids: string[];
  requested_at: number;
}

/** design.md Decision 2 — the port other capabilities (Kill Switch's `ENTRY_GATE`, Risk Engine) depend on. */
export interface EntryHaltPort {
  requestHalt(r: { source: EntryHaltSource; reason: string; trade_ids: string[] }): void;
  isHalted(): boolean;
  reasons(): HaltRequest[];
}

export class EntryHaltLatch implements EntryHaltPort {
  private halted = false;
  private active: HaltRequest[] = [];

  constructor(
    private readonly eventStore: EntryHaltEventStore,
    private readonly clock: EventStoreClock,
  ) {
    this.rebuild();
  }

  /**
   * Replays every `ENTRY_HALT_REQUESTED` / `ENTRY_HALT_CLEARED` event in
   * `seq` order: requests after the LAST clear are still active (design.md
   * Implementation Notes: "最後一個 ENTRY_HALT_CLEARED 之後若還有未被清除的
   * ENTRY_HALT_REQUESTED，視為仍 halted").
   */
  private rebuild(): void {
    const events = this.eventStore.replay();
    let lastClearIdx = -1;
    events.forEach((e, i) => {
      if (e.event_type === 'ENTRY_HALT_CLEARED') lastClearIdx = i;
    });
    this.active = events
      .slice(lastClearIdx + 1)
      .filter((e) => e.event_type === 'ENTRY_HALT_REQUESTED')
      .map((e) => e.payload as unknown as HaltRequest);
    this.halted = this.active.length > 0;
  }

  requestHalt(r: { source: EntryHaltSource; reason: string; trade_ids: string[] }): void {
    const timestamp = this.clock.now();
    const request: HaltRequest = { source: r.source, reason: r.reason, trade_ids: r.trade_ids, requested_at: timestamp };
    this.eventStore.append({
      event_id: crypto.randomUUID(),
      event_type: 'ENTRY_HALT_REQUESTED',
      timestamp,
      trade_id: null,
      payload: request as unknown as Record<string, unknown>,
    });
    this.active.push(request);
    this.halted = true;
  }

  /** Operator-only clear (design.md Decision 2); not part of `EntryHaltPort` since nothing but an operator surface should call it. */
  clearHalt(input: { actor: string; reason: string }): void {
    const timestamp = this.clock.now();
    this.eventStore.append({
      event_id: crypto.randomUUID(),
      event_type: 'ENTRY_HALT_CLEARED',
      timestamp,
      trade_id: null,
      payload: { actor: input.actor, reason: input.reason },
    });
    this.active = [];
    this.halted = false;
  }

  isHalted(): boolean {
    return this.halted;
  }

  reasons(): HaltRequest[] {
    return [...this.active];
  }
}
