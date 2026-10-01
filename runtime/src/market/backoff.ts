/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 共用退避工具（design.md Decision 7：「暫時性錯誤退避與重連退避共用同一個
 * Backoff 工具」）：`min(max, base × 2^(n−1)) × (1 + jitter)`，
 * `jitter` 均勻分布於 `[-jitter_ratio, +jitter_ratio]`。亂數來源可注入（測試固定 jitter = 0）。
 */

export interface BackoffConfig {
  base_ms: number;
  max_ms: number;
  jitter_ratio: number;
  /** 回傳 [0, 1) 的亂數；預設 Math.random。 */
  random?: () => number;
}

/** 第 n 次嘗試（n ≥ 1）的等待時間，不含抖動。 */
export function backoffBaseMs(n: number, base_ms: number, max_ms: number): number {
  return Math.min(max_ms, base_ms * 2 ** (n - 1));
}

export function computeBackoffMs(n: number, config: BackoffConfig): number {
  const base = backoffBaseMs(n, config.base_ms, config.max_ms);
  const rand = (config.random ?? Math.random)();
  const jitter = (rand * 2 - 1) * config.jitter_ratio; // [-ratio, +ratio]
  return Math.round(base * (1 + jitter));
}

/** 有狀態的退避計數器：`next()` 回傳下一次等待並遞增內部嘗試次數；`reset()` 歸零。 */
export class Backoff {
  private attempt = 0;

  constructor(private readonly config: BackoffConfig) {}

  next(): number {
    this.attempt += 1;
    return computeBackoffMs(this.attempt, this.config);
  }

  reset(): void {
    this.attempt = 0;
  }

  attemptCount(): number {
    return this.attempt;
  }
}
