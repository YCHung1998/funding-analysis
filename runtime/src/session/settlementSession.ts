import type { Clock, TimerHandle } from '../clock/types';
import type { PhaseTimetable } from './types';

export type SessionPhase = 'WATCH' | 'SHORTLIST' | 'ARM' | 'ENTRY' | 'LOCK' | 'CONFIRM' | 'DONE' | 'SKIPPED';

// TODO(trading-schema-types): 合併後改為 import { TradingEvent } from 'runtime/src/types'
export interface SessionPhaseChangedEvent {
  type: 'SESSION_PHASE_CHANGED';
  at: number;
  from: SessionPhase;
  to: SessionPhase;
  reason?: string;
}

export interface SettlementSessionHooks {
  /** Checked once at `arm_at`; returning false SKIPs the session with NO_VALID_OPPORTUNITY. */
  hasValidOpportunity: () => boolean;
}

/**
 * Drives one funding time T's session through its phases purely from clock-scheduled events
 * (settlement-session spec "One settlement session per funding time"). The session starts in
 * WATCH at construction (no event emitted for the initial state — only actual transitions emit
 * `SESSION_PHASE_CHANGED`). `DONE` is not reached by this clock-driven schedule alone: it is set
 * externally via `markDone()` once PnL finalization (funding-settlement-rules spec) completes,
 * which is driven by data outside this module's scope (public settled-rate confirmation).
 */
export class SettlementSession {
  readonly settlementTime: number;
  readonly timetable: PhaseTimetable;

  private _phase: SessionPhase = 'WATCH';
  private readonly eventLog: SessionPhaseChangedEvent[] = [];
  private readonly handles: TimerHandle[] = [];

  constructor(
    settlementTime: number,
    timetable: PhaseTimetable,
    private readonly clock: Clock,
    private readonly hooks: SettlementSessionHooks,
  ) {
    this.settlementTime = settlementTime;
    this.timetable = timetable;
    this.scheduleTransitions();
  }

  get phase(): SessionPhase {
    return this._phase;
  }

  events(): readonly SessionPhaseChangedEvent[] {
    return this.eventLog;
  }

  /** External hook for when funding settlement finalizes (funding-settlement-rules spec). */
  markDone(reason?: string): void {
    this.transition('DONE', reason);
  }

  private scheduleTransitions(): void {
    this.handles.push(this.clock.at(this.timetable.shortlistAt, () => this.transition('SHORTLIST')));
    this.handles.push(this.clock.at(this.timetable.armAt, () => this.enterArm()));
    this.handles.push(this.clock.at(this.timetable.entryOpen, () => this.transition('ENTRY')));
    this.handles.push(this.clock.at(this.timetable.hedgedBy, () => this.transition('LOCK')));
    this.handles.push(this.clock.at(this.timetable.lockEnd, () => this.transition('CONFIRM')));
  }

  private enterArm(): void {
    if (!this.hooks.hasValidOpportunity()) {
      this.transition('SKIPPED', 'NO_VALID_OPPORTUNITY');
      this.cancelRemaining();
      return;
    }
    this.transition('ARM');
  }

  private transition(to: SessionPhase, reason?: string): void {
    const from = this._phase;
    this._phase = to;
    this.eventLog.push({ type: 'SESSION_PHASE_CHANGED', at: this.clock.now(), from, to, reason });
  }

  private cancelRemaining(): void {
    for (const handle of this.handles) this.clock.cancel(handle);
  }
}
