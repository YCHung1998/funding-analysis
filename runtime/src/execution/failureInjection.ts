/**
 * runtime/src/execution/failureInjection.ts
 *
 * Config shapes + pure decision helpers for simulated latency and
 * reproducible failure injection (design.md Decision 3; spec "Simulated
 * latency and reproducible failure injection"). Config is keyed by
 * `ExchangeId` as *data* — no exchange-name branch ever appears in code
 * here (Invariant #3, guarded by `runtime/test/executionArchitecture.test.ts`).
 *
 * Task 1.1/2.1 introduce the config shapes and latency lookup only; reject /
 * ack-loss / cancel-failure / disconnect / stale / liquidity / price-shift
 * decision helpers are added by task 2.6 alongside their own failing tests.
 */
import type { ExchangeId } from '../types/ids';
import type { Rng } from './rng';

export interface ExecutionLatencyConfig {
  ack_ms: number;
  fill_ms: number;
  cancel_ms: number;
  jitter_ms?: number;
}

export interface DisconnectWindow {
  start: number;
  end: number;
}

export interface FailureInjectionConfig {
  ack_latency_ms?: number;
  reject_probability?: number;
  fill_probability?: number;
  max_fill_ratio?: number;
  ack_loss_probability?: number;
  cancel_failure_probability?: number;
  disconnect_windows?: DisconnectWindow[];
  liquidity_multiplier?: number;
  price_shift_pct?: number;
}

export type ExecutionLatencyTable = Record<ExchangeId, ExecutionLatencyConfig>;
export type FailureInjectionTable = Partial<Record<ExchangeId, FailureInjectionConfig>>;

/** Deterministic jitter in `[-jitter_ms, +jitter_ms]`, drawn from the order's own RNG stream. */
export function withJitter(baseMs: number, jitterMs: number | undefined, rng: Rng): number {
  if (!jitterMs) return baseMs;
  const delta = (rng.next() * 2 - 1) * jitterMs;
  return Math.max(0, baseMs + delta);
}

export function ackLatencyMs(latency: ExecutionLatencyConfig, failure: FailureInjectionConfig | undefined, rng: Rng): number {
  if (failure?.ack_latency_ms !== undefined) return failure.ack_latency_ms;
  return withJitter(latency.ack_ms, latency.jitter_ms, rng);
}

export function fillLatencyMs(latency: ExecutionLatencyConfig, rng: Rng): number {
  return withJitter(latency.fill_ms, latency.jitter_ms, rng);
}

export function cancelLatencyMs(latency: ExecutionLatencyConfig, rng: Rng): number {
  return withJitter(latency.cancel_ms, latency.jitter_ms, rng);
}

/** `now` is within one of `windows` (inclusive bounds) — spec "disconnect_windows". */
export function isDisconnected(windows: DisconnectWindow[] | undefined, now: number): boolean {
  if (!windows) return false;
  return windows.some((w) => now >= w.start && now <= w.end);
}

/** `true` with probability `p` (undefined/0 => never), drawn from the order's own RNG stream. */
export function rollProbability(p: number | undefined, rng: Rng): boolean {
  if (!p) return false;
  return rng.next() < p;
}
