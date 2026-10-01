import type { TimerHandle } from '../clock/types';

interface Entry {
  readonly id: number;
  readonly dueAt: number;
  readonly seq: number;
  cb: (() => void) | null;
}

/**
 * Ordered timer queue shared by `VirtualClock` and `RealClock`: due-time ascending,
 * ties broken by registration order (trading-clock spec "Same due time keeps registration order").
 * Pure data structure — no system time access, so it carries no architecture-guard risk.
 */
export class TimerQueue {
  private entries: Entry[] = [];
  private nextId = 1;
  private nextSeq = 0;

  schedule(dueAt: number, cb: () => void): TimerHandle {
    const entry: Entry = { id: this.nextId++, dueAt, seq: this.nextSeq++, cb };
    this.entries.push(entry);
    return { id: entry.id };
  }

  cancel(handle: TimerHandle): void {
    const entry = this.entries.find((e) => e.id === handle.id);
    if (entry) entry.cb = null;
  }

  /**
   * Fire every non-cancelled callback due at or before `target`, one at a time, re-scanning the
   * live queue before each fire (not a one-shot snapshot). This means:
   *  - a callback that cancels a later-but-already-due entry in the same batch stops it from
   *    firing (the "SKIPPED" / cancel-remaining-transitions use case in SettlementSession);
   *  - a callback that schedules a *new* timer due at or before `target` gets it fired in the
   *    same `fireDueBy` call, in its correct due-time position, instead of being silently
   *    dropped by a pre-computed snapshot.
   * `onBeforeFire(dueAt)` is called with each entry's own due time right before it fires, so a
   * caller (VirtualClock) can advance `now()` to that time first — later entries in the same
   * batch must not observe a `now()` that has already jumped to `target`.
   */
  fireDueBy(target: number, onBeforeFire?: (dueAt: number) => void): void {
    while (true) {
      const next = this.earliestDue(target);
      if (!next) break;
      const cb = next.cb;
      if (!cb) continue; // defensive: earliestDue never returns a null-cb entry, but keep it explicit
      next.cb = null; // consumed: prevents double-fire and makes a later cancel() a no-op
      onBeforeFire?.(next.dueAt);
      cb();
    }
    this.entries = this.entries.filter((e) => e.cb !== null);
  }

  private earliestDue(target: number): Entry | null {
    let earliest: Entry | null = null;
    for (const entry of this.entries) {
      if (entry.cb === null || entry.dueAt > target) continue;
      if (!earliest || entry.dueAt < earliest.dueAt || (entry.dueAt === earliest.dueAt && entry.seq < earliest.seq)) {
        earliest = entry;
      }
    }
    return earliest;
  }

  get pendingCount(): number {
    return this.entries.filter((e) => e.cb !== null).length;
  }
}
