## Why

Paper Runtime 必須從「模擬成交（Fill）」一路推導出部位、對沖比例、資金費入帳與最終 TradeResult，才能驗證套利是否真的賺錢（規格書 §0 第 1、3、5 點）。研究原型的損益直接以 `notional × rate` 與固定價格漂移計算，單腿失敗時仍計入對沖的資金費（Q-08），也沒有 Position 概念（`PositionState` 綁在單一 trade，規格書 §2.1）。依技術書 §50.1（✅ C-09）第 5 項「Schema → Execution → **Position / Funding / PnL** → Risk」，本 change 在 `net-cost-model` 提供的公式之上，實作 Position 推導與 PnL 帳務。

分支：`feature-position-funding-pnl`（來自 `develop`）。

## What Changes

- **Position 由 Fill 推導**（技術書 §20、§21）：每腿一個 Position，`Order → Fill → Position`；進場 Fill 以加權平均更新 `average_entry_price`、逐筆累加數量；出場 Fill 減倉並逐筆實現 Price PnL；同一 `fill_id` 重複套用不得重複計算；由事件重播重建的 Position 必須與逐筆更新結果相同。
- **Hedge ratio**（規格書 §13、§14，✅ C-12）：`hedge_ratio = min / max`，計算基準設計為可切換 `hedge_ratio_basis: 'NOTIONAL' | 'QUANTITY'`；**⚠️ C-19 未決**，依規格書 §14「決議前先用 notional」預設 `NOTIONAL`，不在本 change 決定，列為 Open Question。提供 `HEDGED` / `PARTIALLY_HEDGED` / `LEG_IMBALANCE` 分類函式（門檻讀設定）與 `max_leg_imbalance_usdt`、`max_leg_imbalance_duration_ms` 量測。設定欄位 `hedge_ratio_basis` 與 `paper-execution-engine` 共用；該 change 目前也規劃了 `hedgeRatio.ts`，本 change 要求收斂為單一實作，`HEDGE_RATIO_CHANGED` 只由雙腿協調者發出一次。
- **Unrealized / Realized PnL**（技術書 §22）：Realized 以實際平均成交價計算（已含滑價）；Unrealized 以 mark price 對未平倉數量計價。
- **FundingSettlement 金額與寫入**（規格書 §18、技術書 §23）：**只實作金額 / 帳務**——EXPECTED 時以預測費率 × 目標數量 × 當下 mark 估計 `expected_cashflow_usdt`；SETTLED 時以 `net-cost-model` 的 `fundingCashflow`（T 時 mark × 持倉數量 × 已結算費率）寫入 `actual_cashflow_usdt`、`position_notional`、`settled_funding_rate`。**狀態機與入帳推定規則沿用 `paper-trading-event-loop` 的 `funding-settlement-rules`，本 change 不重新定義任何狀態或轉換條件。**
- **TradeResult 組裝**（規格書 §21、✅ C-13、✅ C-17）：`funding_pnl_usdt`、`price_pnl_usdt`（已含滑價）、`fee_usdt`（正值 = 成本）、`slippage_attribution_usdt`（僅歸因）、`net_pnl_usdt = composeNetPnl(funding, price, fee, other)`、`roi_on_notional_pct` 分母 = 雙腿實際名目合計、`roi_on_capital_pct`、`final_status`、`result_reason`、durations；`funding_confirmed` / `finalized_at` 依 `funding-settlement-rules` 的定案規則填寫（CLOSED 時先產生暫定結果，兩腿結算終態後定案）。
- **單腿失敗只計該腿實際 funding**（Q-08、規格書 §15 📎）：沒有 FundingSettlement 或 `NOT_ELIGIBLE` 的腿 funding = 0；裸腿若全程持倉通過鎖定區間，只記該腿實際（可能為付出）的現金流；緊急平倉的價格、滑價、手續費全部計入。研究端 `dryRunEngine.ts:145` 的同一 bug 一併修正（凍結模組允許修 bug）。
- 所有新實體（Position、TradeResult）具備 `created_at` / `updated_at`；Position 開 / 平、hedge ratio 變動、資金費入帳、TradeResult 定案皆產生 TradingEvent（規格書 §25）。

## Non-goals

- 不實作成本公式本身（手續費、滑價、資金費金額、Net 組合）——全部由 `net-cost-model` 的 `cost-model` 提供，本 change 只呼叫。
- 不定義或修改 FundingSettlement 的狀態、轉換條件、時間點（`EXPECTED → ELIGIBLE → SETTLED / NOT_ELIGIBLE / MISSED`、`hedged_by`、`lock_end`、`exit_at`、`settlement_confirm_timeout_ms`）——屬 `funding-settlement-rules`。
- 不決定 hedge ratio 計算基準（⚠️ C-19），只提供切換與兩種實作。
- 不實作 Trade 狀態機轉換（`HEDGED` / `PARTIALLY_HEDGED` / `LEG_IMBALANCE` / `EMERGENCY_EXIT` 的轉換與事件由 Trade Manager 負責，本 change 只提供分類函式與量測）、不實作模擬撮合（`paper-execution`）、風控（`risk-engine`）、Kill Switch（⚠️ C-16）。
- 不實作 `pnl_snapshots` / `account_snapshots` 的週期性寫入、不做 UI（`paper-trading-ui`）。
- 不支援跨期持倉（D-1）、不支援非 USDT 計價的手續費資產。
- 不擴充 `dryRunEngine`（✅ C-04 凍結），只修 Q-08 的單腿資金費 bug。

## Capabilities

### New Capabilities

- `position-accounting`: 由 Fill 推導每腿 Position（`PaperPosition`；加權平均、逐筆累加、減倉實現、冪等、重播一致）、Unrealized PnL、hedge ratio（可切換基準，回傳兩種比率）與分類、leg imbalance 量測，以及 `POSITION_OPENED` / `POSITION_CLOSED` 事件。
- `pnl-engine`: FundingSettlement 金額計算與寫入（引用 `funding-settlement-rules` 的狀態）、單腿失敗的 funding 規則（Q-08）、滑價歸因彙總、TradeResult 組裝（暫定 / 定案、ROI、final_status）。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability。引用但不修改：`cost-model`、`funding-settlement-rules`、`trading-schema`、`event-store`、`instrument-registry`、`paper-execution`、`test-infrastructure`。）

## Impact

- **新增程式**：`runtime/src/trading/positionManager.ts`、`runtime/src/trading/hedgeRatio.ts`、`runtime/src/trading/fundingSettlement.ts` 的金額部分（`fundingAmount.ts`，由狀態機模組呼叫）、`runtime/src/accounting/pnlEngine.ts`、`runtime/src/accounting/tradeResultAssembler.ts`，以及 `runtime/test/scenarios/` 的帳務情境（S01、S03、S12 的 PnL 部分）。
- **修改程式（研究端）**：`src/engine/dryRunEngine.ts:145`（單腿失敗時 long 腿 funding = 0）。
- **文件**：規格書 §14（C-19 切換設定說明，不改決策狀態）、§21（TradeResult 欄位計算方式）；技術書 §20–§23、§38（`hedge_ratio_basis`、`break_even_tolerance_usdt`）；`assets/HANDOFF.md` §7。
- **依賴**：`setup-vitest`（必要）、`net-cost-model`（`fundingCashflow`、`composeNetPnl`、`slippageAttribution`）、`trading-schema-types`（`trading-schema`：`Fill`、`TradeLeg`、`Trade`、`FundingSettlement`、`TradeResult`、`PaperPosition` 型別）、`trading-event-store`（`event-store`：`Ledger.applyFill` 等同步帳本寫入與事件）、`paper-trading-event-loop`（`funding-settlement-rules` 狀態機）、`instrument-registry`（合約乘數）。`paper-execution-engine` 產生真實 Fill；本 change 的測試以固定 Fill fixture 進行，不依賴其實作。
- **對應**：規格書 §6–§8、§11、§13–§15、§18、§20、§21、§25、✅ C-12、✅ C-13、✅ C-17、⚠️ C-19；技術書 §20–§23、§38、§42–§45；issue Q-07（資金費以持倉價值）、Q-08。
