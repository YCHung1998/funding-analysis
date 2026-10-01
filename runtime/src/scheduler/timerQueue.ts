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

  /** Fire every non-cancelled callback due at or before `target`, in (dueAt, seq) order; remove them from the queue. */
  fireDueBy(target: number): void {
    const due = this.entries
      .filter((e) => e.dueAt <= target)
      .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
    this.entries = this.entries.filter((e) => e.dueAt > target);
    for (const entry of due) {
      entry.cb?.();
    }
  }

  get pendingCount(): number {
    return this.entries.filter((e) => e.cb !== null).length;
  }
}
