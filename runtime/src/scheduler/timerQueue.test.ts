import { describe, expect, it } from 'vitest';
import { TimerQueue } from './timerQueue';

describe('TimerQueue', () => {
  it('fires due callbacks in ascending due-time order', () => {
    const q = new TimerQueue();
    const fired: number[] = [];
    q.schedule(300, () => fired.push(300));
    q.schedule(100, () => fired.push(100));
    q.schedule(200, () => fired.push(200));

    q.fireDueBy(300);

    expect(fired).toEqual([100, 200, 300]);
  });

  it('fires callbacks with the same due time in registration order', () => {
    const q = new TimerQueue();
    const fired: string[] = [];
    q.schedule(100, () => fired.push('A'));
    q.schedule(100, () => fired.push('B'));

    q.fireDueBy(100);

    expect(fired).toEqual(['A', 'B']);
  });

  it('does not fire a cancelled callback', () => {
    const q = new TimerQueue();
    const fired: number[] = [];
    const handle = q.schedule(100, () => fired.push(100));
    q.cancel(handle);

    q.fireDueBy(200);

    expect(fired).toEqual([]);
  });

  it('only fires callbacks due at or before the target time', () => {
    const q = new TimerQueue();
    const fired: number[] = [];
    q.schedule(100, () => fired.push(100));
    q.schedule(300, () => fired.push(300));

    q.fireDueBy(200);

    expect(fired).toEqual([100]);

    q.fireDueBy(300);

    expect(fired).toEqual([100, 300]);
  });

  it('fires a timer scheduled during the batch if its due time is still <= target (regression)', () => {
    const q = new TimerQueue();
    const fired: string[] = [];
    q.schedule(100, () => {
      fired.push('A');
      q.schedule(150, () => fired.push('B'));
    });

    q.fireDueBy(300);

    expect(fired).toEqual(['A', 'B']);
  });

  it('reports each callback its own due time via the onBeforeFire hook, not the final target (regression)', () => {
    const q = new TimerQueue();
    const seenDueAt: number[] = [];
    q.schedule(100, () => {});
    q.schedule(300, () => {});

    q.fireDueBy(300, (dueAt) => seenDueAt.push(dueAt));

    expect(seenDueAt).toEqual([100, 300]);
  });

  it('a callback can cancel a later-but-already-due entry in the same batch', () => {
    const q = new TimerQueue();
    const fired: string[] = [];
    const laterHandle = q.schedule(200, () => fired.push('B'));
    q.schedule(100, () => {
      fired.push('A');
      q.cancel(laterHandle);
    });

    q.fireDueBy(300);

    expect(fired).toEqual(['A']);
  });
});
