/**
 * runtime/src/health/types.ts
 *
 * `HealthConfig` (proposal.md "Impact": `health_publish_interval_ms`) — an
 * owned `PaperTradingConfig` field, following the same local-config
 * precedent as `ReconciliationConfig` (`runtime/src/reconciliation/types.ts`)
 * and `RiskConfig`/`SessionTimingConfig` (design.md Implementation Notes
 * "PaperTradingConfig" — no aggregate config file exists yet).
 */

export interface HealthConfig {
  /** `health_publish_interval_ms`; default 5_000 (design.md Decision 3 "每 health_publish_interval_ms 與元件變化時 upsert"). */
  publishIntervalMs: number;
  /**
   * Multiplier applied to `publishIntervalMs` to decide server-side
   * staleness ("失聯閾值 3 倍間隔吸收兩者偏差", design.md Decision 3).
   * `healthPublisher.ts`'s `buildHealthApiPayload` takes the resulting
   * `staleThresholdMs` directly; this field is the Runtime-side constant
   * that derives it.
   */
  staleThresholdMultiplier: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  publishIntervalMs: 5_000,
  staleThresholdMultiplier: 3,
};
