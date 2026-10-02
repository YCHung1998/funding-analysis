# Interface Contract Memo — `position-funding-pnl` for `paper-execution-engine`

Audience: engineer implementing `position-funding-pnl`. Goal: make its public exports match exactly what `paper-execution-engine` (Decisions 4/5, task 3.1) will later import — zero rework.

## 1. Exact exported symbols paper-execution-engine depends on

All of these are **new** modules (`runtime/src/trading/` does not exist yet).

### `runtime/src/trading/hedgeRatio.ts`

```typescript
export type HedgeRatioBasis = 'NOTIONAL' | 'QUANTITY';

export interface HedgeRatioResult {
  hedge_ratio: number;        // min(long_value, short_value) / max(long_value, short_value)
  basis: HedgeRatioBasis;     // the basis actually used for `hedge_ratio`
  long_value: number;
  short_value: number;
  notional_ratio: number;     // computed under NOTIONAL basis, always returned (paper-execution-engine Decision 5: "同時記錄兩種基準")
  quantity_ratio: number;     // computed under QUANTITY basis, always returned
  has_exposure: boolean;
}

export function computeHedgeRatio(
  long: { base_quantity: number; average_entry_price: number },
  short: { base_quantity: number; average_entry_price: number },
  basis: HedgeRatioBasis
): HedgeRatioResult;

export type HedgeClassification = 'HEDGED' | 'PARTIALLY_HEDGED' | 'LEG_IMBALANCE';

export function classifyHedge(
  hedge_ratio: number,
  symbol: string,
  overrides?: Record<string, { hedged_min: number; imbalance_min: number }>
): HedgeClassification;
```

- `computeHedgeRatio`'s `long`/`short` param shape is **not spelled out** in either design.md — I inferred it from Decision 2's `base_quantity`/`average_entry_price` fields and Decision 4's value formulas. **Pin this shape explicitly in position-funding-pnl's task 2.1 implementation**, since paper-execution-engine's fake (`FakePositions`/`PositionReader`, task 3.1) must match it structurally.
- `classifyHedge`'s parameter list is **a real gap** — see §3 below.

### `runtime/src/trading/positionManager.ts` — `PaperPosition` additive fields (Decision 2)

Not a function export but a type contract: these fields must land on `trading-schema-types`' `PaperPosition` (submitted as a PR to that change, per tasks 1.1):

```typescript
base_quantity: number;
entry_filled_quantity: number;
exit_filled_quantity: number;
entry_notional_usdt: number;
average_exit_price?: number;
realized_price_pnl_usdt: number;
fees_usdt: number;
slippage_attribution_usdt: number;
applied_fill_ids: string[];
```
Plus `applyFill(fill, order, position, events): …` as the positionManager entry point (pure function; actual DB commit happens via `Ledger.applyFill`).

### `runtime/src/trading/fundingAmount.ts` — hook for `funding-settlement-rules` state machine (Decision 6 / task 3.1)

Return-shape per state is specified (Decision 6 table) but the **function signature itself is not written out** in design.md. Based on the table's inputs, the contract should be:

```typescript
export function fundingAmount(
  state: 'EXPECTED' | 'ELIGIBLE' | 'SETTLED' | 'NOT_ELIGIBLE' | 'MISSED',
  input: {
    side: PositionSide;
    quantity: number;        // target_quantity | base_quantity at lock_end | qty_at_T
    mark_price: number;
    funding_rate: number;    // predicted or settled, depending on state
  }
): {
  expected_cashflow_usdt?: number;
  actual_cashflow_usdt?: number;   // absent/undefined for MISSED
  position_notional?: number;
  settled_funding_rate?: number;
};
```
**This signature is my reconstruction, not a quote from design.md** — flag to the implementer that task 3.1 ("fundingAmount hook") needs its exact signature written down as the first sub-step, since paper-trading-event-loop's state machine (a *different* change) will call it directly.

## 2. Recommended file layout under `runtime/src/`

```
runtime/src/trading/hedgeRatio.ts        computeHedgeRatio, classifyHedge, HedgeRatioBasis, HedgeRatioResult, HedgeClassification
runtime/src/trading/positionManager.ts   applyFill, leg-imbalance measurement
runtime/src/trading/fundingAmount.ts     fundingAmount hook (Decision 6)
runtime/src/accounting/pnlEngine.ts      price/fee/slippage/funding aggregation (Decision 7)
runtime/src/accounting/tradeResultAssembler.ts   TradeResult assembly, provisional→final (Decision 7/8)
```

Rationale: Decision 1's module diagram puts `positionManager`/`fundingAmount` in `trading/`, `pnlEngine` in `accounting/`. `hedgeRatio.ts` must sit in `trading/` per Decision 4's own text ("建議放在 `trading/hedgeRatio.ts`"). Note `runtime/src/trading/` will also hold paper-execution-engine's `entryCoordinator.ts`/`exitCoordinator.ts` (its design §7) — same directory, no collision since filenames differ, but worth a heads-up so whoever lands second doesn't accidentally overwrite `hedgeRatio.ts`.

## 3. Discrepancies to resolve before coding

1. **Stale default value inside position-funding-pnl's own design.md.** Decision 4 (line ~76, ~83) and tasks.md 2.1 both state the default `hedge_ratio_basis` is `QUANTITY` (per C-19, resolved 2026-10-02). But §"跨change假設" item 7 (design.md line 148) still says: `PaperTradingConfig 新增 hedge_ratio_basis（預設 NOTIONAL）`. This is an internal contradiction, not just cross-doc — fix line 148 to say `QUANTITY` before paper-execution-engine's Decision 5 (which correctly says "預設改為 QUANTITY") is implemented against it, or an engineer could wire the wrong default.
2. **`classifyHedge` signature is underspecified in both docs.** position-funding-pnl tasks 2.1 only says "邊界 0.99、0.90、tier 覆寫" (boundary values + tier override) without a formal signature. paper-execution-engine tasks 3.1 references `symbol_tier_overrides` as if it's an agreed parameter name but doesn't cite position-funding-pnl's actual export. Resolve by having position-funding-pnl's task 2.1 commit to a literal signature (I propose `classifyHedge(hedge_ratio, symbol, overrides?)` above) before paper-execution-engine builds its fake.
3. **`computeHedgeRatio`'s parameter shape** (`long`/`short` objects) is implied, not stated, in either doc — same risk as #2: paper-execution-engine's `PositionReader` fake (Decision 1: `getOpenQuantity(leg_id): number`) only returns a bare number, not `{base_quantity, average_entry_price}`. Whoever lands position-funding-pnl first must document whether `computeHedgeRatio` takes raw numbers or structured position slices — this changes what paper-execution-engine's entryCoordinator needs to assemble before calling it.

## 4. Circular-import check

**No circular import risk.** Dependency graph is strictly one-directional:

- `trading-schema-types`, `trading-event-store`, `trading-clock`, `net-cost-model` (foundations) → `position-funding-pnl` (`trading/hedgeRatio.ts`, `trading/positionManager.ts`, `trading/fundingAmount.ts`, `accounting/pnlEngine.ts`) → consumed by `paper-execution-engine` (imports `hedgeRatio`/`classifyHedge`) and by `paper-trading-event-loop` (calls `fundingAmount` from its state machine).
- `position-funding-pnl` never imports from `paper-execution-engine` or `paper-trading-event-loop` — Fills reach it via `Ledger.applyFill` (a neutral event-store API), not a direct call from the execution adapter; and it only references `funding-settlement-rules`' *states* as a lookup table (Decision 6), not by importing that change's code.
- The only shared surface is the `runtime/src/trading/` directory housing files from both changes (hedgeRatio.ts from position-funding-pnl; entryCoordinator.ts/exitCoordinator.ts from paper-execution-engine) — a namespace concern, not a dependency cycle.

Maintainability note: keep it this way — if a future change ever makes `position-funding-pnl` import `paper-execution-engine` types (e.g. `OrderRequest`), that would create the first cycle in this chain. None of the current design decisions require that.
