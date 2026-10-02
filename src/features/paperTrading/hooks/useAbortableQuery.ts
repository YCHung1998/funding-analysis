/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `useAbortableQuery` (design.md Decision 4, FE-01).
 *
 * - Every query is identified by a `key` array (e.g. `['trade', trade_id]`).
 *   When `key` changes, the in-flight request for the previous key is
 *   aborted via `AbortController` in the effect cleanup.
 * - A monotonically increasing request sequence number guards against
 *   out-of-order responses: a response is only written to state if it is
 *   still the latest request for the *current* key. This covers both
 *   external key changes and React StrictMode's double-invoke of effects.
 * - `refetch()` bumps an internal nonce that is folded into the effect key,
 *   so polling call sites can force a refetch without changing `key` itself.
 * - `fetcher` is read through a ref updated every render (React 19
 *   `useEffectEvent`), so a new fetcher identity each render does NOT
 *   retrigger the effect / reset the in-flight request — only `key` and an
 *   explicit `refetch()` do.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

export interface UseAbortableQueryResult<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => void;
}

export function useAbortableQuery<T>(
  key: readonly unknown[],
  fetcher: (signal: AbortSignal) => Promise<T>,
): UseAbortableQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [nonce, setNonce] = useState(0);

  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const runFetch = useEffectEvent((signal: AbortSignal) => fetcher(signal));

  const keyString = JSON.stringify(key);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    const requestId = ++requestSeqRef.current;
    setLoading(true);

    runFetch(controller.signal)
      .then((result) => {
        if (!mountedRef.current) return;
        if (requestId !== requestSeqRef.current) return; // superseded by a newer request
        setData(result);
        setError(undefined);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // expected on cleanup/abort, not a real error
        if (!mountedRef.current) return;
        if (requestId !== requestSeqRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyString encodes `key`; runFetch is a useEffectEvent (intentionally excluded)
  }, [keyString, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, refetch };
}
