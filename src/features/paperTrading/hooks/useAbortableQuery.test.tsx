// @vitest-environment jsdom
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAbortableQuery } from './useAbortableQuery';

function Probe<T>({
  queryKey,
  fetcher,
  onRender,
}: {
  queryKey: readonly unknown[];
  fetcher: (signal: AbortSignal) => Promise<T>;
  onRender: (state: ReturnType<typeof useAbortableQuery<T>>) => void;
}) {
  const state = useAbortableQuery(queryKey, fetcher);
  onRender(state);
  return null;
}

describe('useAbortableQuery (FE-01)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discards a stale response that arrives after the key changed (filter switch scenario)', async () => {
    let resolveLoss!: (v: { tag: string }) => void;
    let resolveAborted!: (v: { tag: string }) => void;
    const states: Array<ReturnType<typeof useAbortableQuery<{ tag: string }>>> = [];

    function fetcherFor(filter: string) {
      return (signal: AbortSignal) =>
        new Promise<{ tag: string }>((resolve, reject) => {
          if (filter === 'LOSS') resolveLoss = resolve;
          if (filter === 'ABORTED') resolveAborted = resolve;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
    }

    function Wrapper({ filter }: { filter: string }) {
      return <Probe queryKey={['completed', filter]} fetcher={fetcherFor(filter)} onRender={(s) => states.push(s)} />;
    }

    const { rerender } = render(<Wrapper filter="LOSS" />);
    rerender(<Wrapper filter="ABORTED" />);

    // The ABORTED request resolves first ...
    await act(async () => {
      resolveAborted({ tag: 'ABORTED' });
    });
    // ... then the stale LOSS response arrives late and MUST be dropped.
    await act(async () => {
      resolveLoss({ tag: 'LOSS' });
    });

    const last = states[states.length - 1];
    expect(last.data).toEqual({ tag: 'ABORTED' });
  });

  it('does not update state after unmount', async () => {
    let resolveFn!: (v: number) => void;
    const onRender = vi.fn();
    const fetcher = (signal: AbortSignal) =>
      new Promise<number>((resolve, reject) => {
        resolveFn = resolve;
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });

    const { unmount } = render(<Probe queryKey={['x']} fetcher={fetcher} onRender={onRender} />);
    unmount();

    const callsBeforeResolve = onRender.mock.calls.length;
    await act(async () => {
      resolveFn(42);
    });
    // no additional render should have been triggered by the late resolution
    expect(onRender.mock.calls.length).toBe(callsBeforeResolve);
  });

  it('loads successfully and exposes refetch', async () => {
    const fetcher = vi.fn(async () => 'ok');
    const states: Array<ReturnType<typeof useAbortableQuery<string>>> = [];
    render(<Probe queryKey={['y']} fetcher={fetcher} onRender={(s) => states.push(s)} />);

    await waitFor(() => expect(states[states.length - 1].data).toBe('ok'));
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      states[states.length - 1].refetch();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('under StrictMode, only one response is ever written to state per key', async () => {
    const fetcher = vi.fn(async () => 'strict-ok');
    const states: Array<ReturnType<typeof useAbortableQuery<string>>> = [];
    render(
      <React.StrictMode>
        <Probe queryKey={['z']} fetcher={fetcher} onRender={(s) => states.push(s)} />
      </React.StrictMode>,
    );

    await waitFor(() => expect(states[states.length - 1].data).toBe('strict-ok'));
    // every rendered state snapshot for data is either undefined (loading) or the single resolved value
    for (const s of states) {
      expect(s.data === undefined || s.data === 'strict-ok').toBe(true);
    }
  });
});
