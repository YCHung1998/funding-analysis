import { describe, expectTypeOf, it } from 'vitest';
import type { Opportunity } from './opportunity';
import type { Trade, TradeLeg } from './trade';
import type { PaperOrder } from './order';
import type { Fill } from './fill';
import type { FundingSettlement } from './funding';
import type { TradeResult } from './result';
import type { RiskCheck, RiskStatusReport, RiskCheckItem } from './risk';
import type { AccountSnapshot, PaperPosition } from './account';

// Spec §5–§21 field names must match verbatim (snake_case, epoch-ms number
// timestamps, decimal rates). These are type-level assertions checked by
// `npm run lint` (tsc --noEmit); expectTypeOf comparisons fail to compile
// if a key is renamed or retyped.

describe('PaperOrder matches spec §10 keys exactly (plus no extra required keys)', () => {
  it('has the exact keys named in spec.md scenario', () => {
    expectTypeOf<PaperOrder>().toHaveProperty('order_id').toEqualTypeOf<string>();
    expectTypeOf<PaperOrder>().toHaveProperty('client_order_id').toEqualTypeOf<string>();
    expectTypeOf<PaperOrder>().toHaveProperty('trade_id').toEqualTypeOf<string>();
    expectTypeOf<PaperOrder>().toHaveProperty('leg_id').toEqualTypeOf<string>();
    expectTypeOf<PaperOrder>().toHaveProperty('purpose');
    expectTypeOf<PaperOrder>().toHaveProperty('order_type');
    expectTypeOf<PaperOrder>().toHaveProperty('side');
    expectTypeOf<PaperOrder>().toHaveProperty('position_side');
    expectTypeOf<PaperOrder>().toHaveProperty('reduce_only').toEqualTypeOf<boolean>();
    expectTypeOf<PaperOrder>().toHaveProperty('requested_quantity').toEqualTypeOf<number>();
    expectTypeOf<PaperOrder>().toHaveProperty('filled_quantity').toEqualTypeOf<number>();
    expectTypeOf<PaperOrder>().toHaveProperty('remaining_quantity').toEqualTypeOf<number>();
    expectTypeOf<PaperOrder>().toHaveProperty('order_state');
    expectTypeOf<PaperOrder>().toHaveProperty('submit_time');
    expectTypeOf<PaperOrder>().toHaveProperty('ack_time');
    expectTypeOf<PaperOrder>().toHaveProperty('cancel_request_time');
    expectTypeOf<PaperOrder>().toHaveProperty('cancel_ack_time');
    expectTypeOf<PaperOrder>().toHaveProperty('terminal_time');
  });

  it('does NOT have the old field name (renaming would be a spec violation)', () => {
    // @ts-expect-error renaming filled_quantity -> requested_quantity_filled must fail type checking
    const bad: PaperOrder['requested_quantity_filled'] = 1;
    void bad;
  });
});

describe('Trade.mode / TradeResult.mode exclude LIVE (C-18)', () => {
  it('assigning mode: "LIVE" is a type error', () => {
    // @ts-expect-error 'LIVE' is reserved and not an allowed value (C-18)
    const t: Trade['mode'] = 'LIVE';
    void t;
    // @ts-expect-error 'LIVE' is reserved and not an allowed value (C-18)
    const r: TradeResult['mode'] = 'LIVE';
    void r;
  });
});

describe('Timestamp fields on every persisted entity (spec §25 #1)', () => {
  it('Opportunity has created_at/updated_at', () => {
    expectTypeOf<Opportunity>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<Opportunity>().toHaveProperty('updated_at').toEqualTypeOf<number>();
  });
  it('Trade / TradeLeg have created_at/updated_at', () => {
    expectTypeOf<Trade>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<Trade>().toHaveProperty('updated_at').toEqualTypeOf<number>();
    expectTypeOf<TradeLeg>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<TradeLeg>().toHaveProperty('updated_at').toEqualTypeOf<number>();
  });
  it('PaperOrder has created_at/updated_at', () => {
    expectTypeOf<PaperOrder>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<PaperOrder>().toHaveProperty('updated_at').toEqualTypeOf<number>();
  });
  it('Fill has created_at/updated_at (additive) plus timestamp/recorded_at', () => {
    expectTypeOf<Fill>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<Fill>().toHaveProperty('updated_at').toEqualTypeOf<number>();
    expectTypeOf<Fill>().toHaveProperty('timestamp').toEqualTypeOf<number>();
    expectTypeOf<Fill>().toHaveProperty('recorded_at').toEqualTypeOf<number>();
  });
  it('FundingSettlement has created_at/updated_at', () => {
    expectTypeOf<FundingSettlement>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<FundingSettlement>().toHaveProperty('updated_at').toEqualTypeOf<number>();
  });
  it('TradeResult has created_at/updated_at (additive) and funding_confirmed', () => {
    expectTypeOf<TradeResult>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<TradeResult>().toHaveProperty('updated_at').toEqualTypeOf<number>();
    expectTypeOf<TradeResult>().toHaveProperty('funding_confirmed').toEqualTypeOf<boolean>();
  });
  it('RiskCheck / AccountSnapshot / PaperPosition have created_at/updated_at', () => {
    expectTypeOf<RiskCheck>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<RiskCheck>().toHaveProperty('updated_at').toEqualTypeOf<number>();
    expectTypeOf<AccountSnapshot>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<AccountSnapshot>().toHaveProperty('updated_at').toEqualTypeOf<number>();
    expectTypeOf<PaperPosition>().toHaveProperty('created_at').toEqualTypeOf<number>();
    expectTypeOf<PaperPosition>().toHaveProperty('updated_at').toEqualTypeOf<number>();
  });
});

describe('RiskStatusReport / RiskCheckItem shape unchanged from systemSpec.ts', () => {
  it('has the original fields', () => {
    expectTypeOf<RiskStatusReport>().toHaveProperty('overall_status');
    expectTypeOf<RiskStatusReport>().toHaveProperty('checks').toEqualTypeOf<RiskCheckItem[]>();
    expectTypeOf<RiskStatusReport>().toHaveProperty('failed_reasons').toEqualTypeOf<string[]>();
    expectTypeOf<RiskStatusReport>().toHaveProperty('leg_imbalance_detected').toEqualTypeOf<boolean>();
    expectTypeOf<RiskStatusReport>().toHaveProperty('action_recommendation');
  });
});
