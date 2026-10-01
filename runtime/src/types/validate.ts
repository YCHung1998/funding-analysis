/**
 * runtime/src/types/validate.ts
 *
 * `assertNoCredentials` (Invariant #2, spec §33) and `validateEntity`
 * (spec.md "Entity invariants" requirement). Pure functions — no network,
 * no system time, no environment reads (the secret list is injected by the
 * runtime caller, design.md Decision 5).
 */

const CREDENTIAL_KEY_PATTERN = /^(api[_-]?key|api[_-]?secret|secret|passphrase|signature|password|private[_-]?key)$/i;

export class CredentialLeakError extends Error {
  constructor(path: string) {
    super(`Credential leak detected at path: ${path}`);
    this.name = 'CredentialLeakError';
  }
}

/**
 * Throws `CredentialLeakError` when any key (any depth, case-insensitive)
 * matches a known credential-key pattern, or any string value equals or
 * contains one of `knownSecrets` (non-empty values only). The thrown
 * message never includes the offending value.
 */
export function assertNoCredentials(value: unknown, knownSecrets: readonly string[]): void {
  const secrets = knownSecrets.filter((s) => s.length > 0);
  walk(value, '', secrets);
}

function walk(value: unknown, path: string, secrets: readonly string[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    for (const secret of secrets) {
      if (value.includes(secret)) {
        throw new CredentialLeakError(path || '<root>');
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, path ? `${path}[${i}]` : `[${i}]`, secrets));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        throw new CredentialLeakError(childPath);
      }
      walk(v, childPath, secrets);
    }
  }
}

// ---------------------------------------------------------------------------
// validateEntity
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'Opportunity'
  | 'Trade'
  | 'TradeLeg'
  | 'PaperOrder'
  | 'Fill'
  | 'FundingSettlement'
  | 'TradeResult'
  | 'RiskCheck'
  | 'AccountSnapshot'
  | 'PaperPosition';

const EPOCH_MS_FLOOR = 1_000_000_000_000; // ~2001-09-09, well before any real data this system handles
const RATE_FIELD_PATTERN = /(^|_)(funding_rate|settled_funding_rate)$/;
const MAX_ABS_RATE = 0.05;
const QUANTITY_TOLERANCE = 1e-9;

type AnyRecord = Record<string, unknown>;

function isEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= EPOCH_MS_FLOOR;
}

function checkTimestampField(rec: AnyRecord, field: string, errors: string[], required = true): void {
  const v = rec[field];
  if (v === undefined || v === null) {
    if (required) errors.push(`MISSING_TIMESTAMP:${field}`);
    return;
  }
  if (!isEpochMs(v)) {
    errors.push(`INVALID_TIMESTAMP:${field}`);
  }
}

function checkCreatedUpdated(rec: AnyRecord, errors: string[]): void {
  checkTimestampField(rec, 'created_at', errors);
  checkTimestampField(rec, 'updated_at', errors);
  if (typeof rec.created_at === 'number' && typeof rec.updated_at === 'number' && isEpochMs(rec.created_at) && isEpochMs(rec.updated_at)) {
    if (rec.updated_at < rec.created_at) errors.push('UPDATED_BEFORE_CREATED');
  }
}

function checkRateFields(rec: AnyRecord, errors: string[], prefix = ''): void {
  for (const [key, value] of Object.entries(rec)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (RATE_FIELD_PATTERN.test(key) && typeof value === 'number') {
      if (Math.abs(value) > MAX_ABS_RATE) {
        errors.push(`RATE_NOT_DECIMAL:${fieldPath}`);
      }
    }
  }
}

function validateOpportunity(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  checkTimestampField(rec, 'detected_at', errors);
  checkTimestampField(rec, 'expires_at', errors);
  checkRateFields(rec, errors);
  if (typeof rec.funding_time_diff_ms === 'number' && typeof rec.funding_aligned === 'boolean') {
    // Only checked when an explicit tolerance is supplied (spec.md scenario is opt-in).
    const tolerance = rec.funding_alignment_tolerance_ms;
    if (typeof tolerance === 'number') {
      const expected = rec.funding_time_diff_ms <= tolerance;
      if (rec.funding_aligned !== expected) errors.push('FUNDING_ALIGNED_MISMATCH');
    }
  }
}

function validateTrade(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  checkRateFields(rec, errors);
}

function validateTradeLeg(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
}

function validatePaperOrder(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  checkRateFields(rec, errors);

  const purpose = rec.purpose;
  const reduceOnly = rec.reduce_only;
  if (purpose === 'EXIT' || purpose === 'EMERGENCY_CLOSE') {
    if (reduceOnly !== true) errors.push('REDUCE_ONLY_REQUIRED');
  } else if (purpose === 'ENTRY') {
    if (reduceOnly !== false) errors.push('REDUCE_ONLY_REQUIRED');
  }

  const requested = rec.requested_quantity;
  const filled = rec.filled_quantity;
  const remaining = rec.remaining_quantity;
  if (typeof requested === 'number' && typeof filled === 'number') {
    if (filled > requested + QUANTITY_TOLERANCE) errors.push('FILLED_EXCEEDS_REQUESTED');
    if (typeof remaining === 'number' && Math.abs(remaining - (requested - filled)) > QUANTITY_TOLERANCE) {
      errors.push('REMAINING_QUANTITY_MISMATCH');
    }
  }

  if (rec.order_state === 'REJECTED' && !rec.rejection_reason) {
    errors.push('REJECTION_REASON_REQUIRED');
  }

  const TERMINAL_ORDER_STATES = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
  if (typeof rec.order_state === 'string' && TERMINAL_ORDER_STATES.has(rec.order_state) && rec.terminal_time === undefined) {
    errors.push('TERMINAL_TIME_REQUIRED');
  }
}

function validateFill(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  checkTimestampField(rec, 'timestamp', errors);
  checkTimestampField(rec, 'recorded_at', errors);
}

function validateFundingSettlement(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  checkRateFields(rec, errors);
}

function validateTradeResult(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  if (rec.funding_confirmed === true && (rec.finalized_at === undefined || rec.finalized_at === null)) {
    errors.push('FINALIZATION_MISSING');
  }
}

function validateRiskCheck(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
}

function validateAccountSnapshot(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
  const total = rec.total_capital_usdt;
  const reserved = rec.reserved_capital_usdt;
  const available = rec.available_capital_usdt;
  if (typeof total === 'number' && typeof reserved === 'number' && typeof available === 'number') {
    if (Math.abs(available - (total - reserved)) > QUANTITY_TOLERANCE) {
      errors.push('LEDGER_IDENTITY_MISMATCH');
    }
  }
}

function validatePaperPosition(rec: AnyRecord, errors: string[]): void {
  checkCreatedUpdated(rec, errors);
}

const VALIDATORS: Record<EntityKind, (rec: AnyRecord, errors: string[]) => void> = {
  Opportunity: validateOpportunity,
  Trade: validateTrade,
  TradeLeg: validateTradeLeg,
  PaperOrder: validatePaperOrder,
  Fill: validateFill,
  FundingSettlement: validateFundingSettlement,
  TradeResult: validateTradeResult,
  RiskCheck: validateRiskCheck,
  AccountSnapshot: validateAccountSnapshot,
  PaperPosition: validatePaperPosition,
};

/**
 * Validates an entity against spec.md "Entity invariants". Returns a list
 * of machine-readable error codes (empty = valid). Does not throw.
 */
export function validateEntity(kind: EntityKind, value: unknown): string[] {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object') {
    return ['INVALID_VALUE'];
  }
  VALIDATORS[kind](value as AnyRecord, errors);
  return errors;
}
