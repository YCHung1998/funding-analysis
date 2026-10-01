import { describe, expect, it } from 'vitest';
import { assertNoCredentials, CredentialLeakError, validateEntity } from './validate';

describe('assertNoCredentials', () => {
  it('rejects a credential key at depth, message has path not value', () => {
    expect(() => assertNoCredentials({ order: { apiKey: 'x' } }, [])).toThrow(CredentialLeakError);
    try {
      assertNoCredentials({ order: { apiKey: 'x' } }, []);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('order.apiKey');
      expect((e as Error).message).not.toContain('x');
    }
  });

  it('rejects a known secret value embedded in a string, without leaking it', () => {
    const knownSecrets = ['s3cr3tVALUE'];
    expect(() => assertNoCredentials({ note: 'debug s3cr3tVALUE' }, knownSecrets)).toThrow(CredentialLeakError);
    try {
      assertNoCredentials({ note: 'debug s3cr3tVALUE' }, knownSecrets);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('s3cr3tVALUE');
    }
  });

  it('accepts an ordinary payload', () => {
    expect(() => assertNoCredentials({ from: 'SUBMITTED', to: 'ACKNOWLEDGED', reason: 'ACK' }, [])).not.toThrow();
  });

  it('is case-insensitive and checks nested/renamed keys (api_secret, secret, passphrase, signature, password, private_key)', () => {
    for (const key of ['API_SECRET', 'Secret', 'passPhrase', 'Signature', 'PASSWORD', 'private_key']) {
      expect(() => assertNoCredentials({ a: { [key]: 'x' } }, [])).toThrow(CredentialLeakError);
    }
  });
});

describe('validateEntity: PaperOrder reduce_only (Invariant #6)', () => {
  const baseOrder = {
    order_id: 'o1',
    client_order_id: 'c1',
    trade_id: 't1',
    leg_id: 'l1',
    exchange: 'Binance',
    symbol: 'BTCUSDT',
    order_type: 'MARKET',
    side: 'BUY',
    position_side: 'LONG',
    requested_quantity: 100,
    requested_notional_usdt: 1000,
    reference_price: 10,
    order_state: 'FILLED',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_100,
    terminal_time: 1_700_000_000_100,
    filled_quantity: 100,
    remaining_quantity: 0,
    estimated_fee_usdt: 1,
    estimated_slippage_pct: 0.001,
  };

  it('EXIT without reduce_only fails with REDUCE_ONLY_REQUIRED', () => {
    const errs = validateEntity('PaperOrder', { ...baseOrder, purpose: 'EXIT', reduce_only: false });
    expect(errs).toContain('REDUCE_ONLY_REQUIRED');
  });

  it('ENTRY with reduce_only=true also fails with REDUCE_ONLY_REQUIRED (must be false)', () => {
    const errs = validateEntity('PaperOrder', { ...baseOrder, purpose: 'ENTRY', reduce_only: true });
    expect(errs).toContain('REDUCE_ONLY_REQUIRED');
  });

  it('remaining_quantity mismatch', () => {
    const errs = validateEntity('PaperOrder', {
      ...baseOrder,
      purpose: 'ENTRY',
      reduce_only: false,
      requested_quantity: 100,
      filled_quantity: 30,
      remaining_quantity: 60,
    });
    expect(errs).toContain('REMAINING_QUANTITY_MISMATCH');
  });

  it('rejected without reason', () => {
    const errs = validateEntity('PaperOrder', {
      ...baseOrder,
      purpose: 'ENTRY',
      reduce_only: false,
      order_state: 'REJECTED',
      rejection_reason: '',
    });
    expect(errs).toContain('REJECTION_REASON_REQUIRED');
  });

  it('valid order has no errors', () => {
    const errs = validateEntity('PaperOrder', { ...baseOrder, purpose: 'ENTRY', reduce_only: false });
    expect(errs).toEqual([]);
  });
});

describe('validateEntity: timestamps', () => {
  it('missing updated_at', () => {
    const t = {
      trade_id: 't1',
      opportunity_id: 'o1',
      strategy_id: 's1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      created_at: 1_700_000_000_000,
      status: 'CREATED',
      target_notional_per_leg_usdt: 1000,
      leverage: 5,
      allocated_margin_usdt: 200,
      allocated_capital_usdt: 250,
      legs: [],
      expected_pnl_usdt: 1,
      risk_status: {
        overall_status: 'PASS',
        checks: [],
        failed_reasons: [],
        leg_imbalance_detected: false,
        action_recommendation: 'PROCEED_TRADE',
      },
    };
    const errs = validateEntity('Trade', t);
    expect(errs).toContain('MISSING_TIMESTAMP:updated_at');
  });

  it('non-epoch-ms values rejected', () => {
    for (const bad of [1_700_000_000.5, '2026-09-30T00:00:00Z', 1]) {
      const errs = validateEntity('Fill', {
        fill_id: 'f1',
        order_id: 'o1',
        trade_id: 't1',
        leg_id: 'l1',
        exchange: 'Binance',
        timestamp: bad,
        recorded_at: 1_700_000_000_000,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        quantity: 1,
        price: 1,
        notional_usdt: 1,
        fee_usdt: 0,
        fee_asset: 'USDT',
        liquidity: 'TAKER',
        slippage_from_reference_pct: 0,
      });
      expect(errs).toContain('INVALID_TIMESTAMP:timestamp');
    }
  });
});

describe('validateEntity: percent-not-decimal (Invariant #5)', () => {
  it('Opportunity.long_funding_rate = 0.25 is rejected', () => {
    const errs = validateEntity('Opportunity', {
      opportunity_id: 'o1',
      symbol: 'BTCUSDT',
      created_at: 1_700_000_000_000,
      detected_at: 1_700_000_000_000,
      expires_at: 1_700_000_060_000,
      updated_at: 1_700_000_000_000,
      long_exchange: 'Binance',
      short_exchange: 'Bybit',
      long_funding_rate: 0.25,
      short_funding_rate: 0.0001,
      funding_spread: 0.2499,
      long_funding_time: 1_700_000_100_000,
      short_funding_time: 1_700_000_100_000,
      long_funding_interval_hours: 8,
      short_funding_interval_hours: 8,
      funding_time_diff_ms: 0,
      funding_aligned: true,
      long_price: 1,
      short_price: 1,
      price_difference_pct: 0,
      estimated_fee_pct: 0,
      estimated_slippage_pct: 0,
      estimated_funding_pnl: 0,
      estimated_net_pnl: 0,
      liquidity_score: 1,
      strategy_version: 'v1',
      status: 'DETECTED',
    });
    expect(errs).toContain('RATE_NOT_DECIMAL:long_funding_rate');
  });
});

describe('validateEntity: TradeResult funding finalization', () => {
  const base = {
    trade_id: 't1',
    symbol: 'BTCUSDT',
    mode: 'PAPER',
    long_exchange: 'Binance',
    short_exchange: 'Bybit',
    target_notional_per_leg_usdt: 1000,
    actual_long_notional_usdt: 1000,
    actual_short_notional_usdt: 1000,
    leverage: 5,
    entry_duration_ms: 100,
    exit_duration_ms: 100,
    total_trade_duration_ms: 200,
    funding_pnl_usdt: 1,
    price_pnl_usdt: 0,
    fee_usdt: 0.5,
    slippage_attribution_usdt: 0,
    net_pnl_usdt: 0.5,
    roi_on_capital_pct: 0.1,
    roi_on_notional_pct: 0.1,
    max_leg_imbalance_usdt: 0,
    max_leg_imbalance_duration_ms: 0,
    final_status: 'PROFIT',
    result_reason: 'NORMAL_EXIT',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  it('funding_confirmed=false, finalized_at unset: accepted', () => {
    const errs = validateEntity('TradeResult', { ...base, funding_confirmed: false });
    expect(errs).toEqual([]);
  });

  it('funding_confirmed=true, finalized_at unset: FINALIZATION_MISSING', () => {
    const errs = validateEntity('TradeResult', { ...base, funding_confirmed: true });
    expect(errs).toContain('FINALIZATION_MISSING');
  });
});

describe('validateEntity: unknown-timestamp records refused as PAPER (spec §2.1 rule 5)', () => {
  it('timestamp_source UNKNOWN + mode PAPER -> UNKNOWN_TIMESTAMP_NOT_ALLOWED', () => {
    const errs = validateEntity('Trade', {
      trade_id: 't1',
      opportunity_id: 'o1',
      strategy_id: 's1',
      strategy_version: 'v1',
      config_version: 'c1',
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      timestamp_source: 'UNKNOWN',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      status: 'CREATED',
      target_notional_per_leg_usdt: 1000,
      leverage: 5,
      allocated_margin_usdt: 200,
      allocated_capital_usdt: 250,
      legs: [],
      expected_pnl_usdt: 1,
      risk_status: {
        overall_status: 'PASS',
        checks: [],
        failed_reasons: [],
        leg_imbalance_detected: false,
        action_recommendation: 'PROCEED_TRADE',
      },
    });
    expect(errs).toContain('UNKNOWN_TIMESTAMP_NOT_ALLOWED');
  });
});

describe('validateEntity: AccountSnapshot ledger identity', () => {
  const base = {
    snapshot_id: 's1',
    mode: 'PAPER',
    snapshot_time: 1_700_000_000_000,
    total_capital_usdt: 10000,
    used_margin_usdt: 0,
    realized_pnl_usdt: 0,
    open_trade_count: 0,
    reason: 'INITIAL',
    config_version: 'c1',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  it('available = total - reserved passes', () => {
    const errs = validateEntity('AccountSnapshot', {
      ...base,
      reserved_capital_usdt: 1000,
      available_capital_usdt: 9000,
    });
    expect(errs).toEqual([]);
  });

  it('available != total - reserved fails with LEDGER_IDENTITY_MISMATCH', () => {
    const errs = validateEntity('AccountSnapshot', {
      ...base,
      reserved_capital_usdt: 1000,
      available_capital_usdt: 9500,
    });
    expect(errs).toContain('LEDGER_IDENTITY_MISMATCH');
  });
});
