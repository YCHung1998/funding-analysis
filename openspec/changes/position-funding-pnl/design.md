## Context

- 規格書 v0.2 定義了 `Trade → Legs → Orders → Fills → Position` 的階層（§0 第 5 點）與 `Fill`（§11）、`FundingSettlement`（§18）、`TradeResult`（§21）；技術書 §20–§23 定義 Position / PnL / Funding Engine 的公式；§29 列出 `positions` 資料表，但規格書沒有 `Position` 的欄位定義。
- 研究原型沒有 Position：`dryRunEngine.ts:139-146` 價格 PnL 為常數、資金費 = 名目 × 費率，且單腿失敗時 long 腿仍計資金費（Q-08）；`PositionState` 綁在單一 trade（規格書 §2.1）。
- 已存在的上游：
  - `net-cost-model`（`cost-model`）：`fundingCashflow`、`composeNetPnl`、`slippageAttribution`、`feeForFill`——本 change 的所有金額公式都呼叫它們。
  - `paper-trading-event-loop`（`funding-settlement-rules`，design Decision 6）：FundingSettlement 狀態 `EXPECTED → ELIGIBLE → SETTLED / NOT_ELIGIBLE / MISSED`、鎖定區間、`exit_at` 不等確認、`funding_confirmed` / `finalized_at` 定案規則。**本 change 只實作金額與帳務，不重新定義狀態。**
- ✅ C-19（hedge ratio 基準＝`QUANTITY`）、✅ C-16（Kill Switch 三層分級）已於 2026-10-02 決議，見規格書 §14/§23/§34。
- 限制：HANDOFF §3 Invariants；規格書 §25（所有實體有 `created_at` / `updated_at`、每次狀態轉換產生 TradingEvent、事件時間 ≠ 寫入時間）。

## Goals / Non-Goals

**Goals:**

- Position 完全由 Fill 推導，冪等、可重播，數值可由事件庫完整還原（技術書 §43「Database 必須可以完整還原以上流程」）。
- Hedge ratio 支援兩種基準並可切換，讓 C-19 決議時只改設定、不改程式。
- 以 `cost-model` 的唯一公式組裝 TradeResult，C-13 / C-17 / Q-08 規則由測試鎖住。
- 金額寫入與 `funding-settlement-rules` 的狀態轉換在同一交易、同一筆事件中完成。

**Non-Goals:**

- 成本公式本身、FundingSettlement 狀態 / 時間點、Trade 狀態機、模擬撮合、風控、Kill Switch、UI、pnl / account snapshot、跨期持倉。詳見 proposal Non-goals。

## Decisions

### 1. 模組切分與呼叫關係

```
paper-execution ──Fill──▶ trading/positionManager ──▶ Position（每腿一個）
                                 │  ├─ hedgeRatio（basis 可切換）→ classifyHedge → Trade Manager 決定轉換
                                 │  └─ leg imbalance 量測
                                 ▼
 funding-settlement-rules 狀態機（event-loop）──呼叫──▶ trading/fundingAmount（本 change：金額）
                                 │                         └─ cost-model.fundingCashflow
                                 ▼
          accounting/pnlEngine + tradeResultAssembler ──▶ TradeResult（暫定 → 定案）
                                 └─ cost-model.composeNetPnl / slippageAttribution
```

- **為什麼**：技術書 §4 已把 `positionManager`、`fundingSettlement` 放在 `trading/`，`pnlEngine` 放在 `accounting/`。金額計算抽成 `fundingAmount` 供 event-loop 的狀態機呼叫，讓「何時」（狀態 / 時間）與「多少」（金額）分屬兩個 change，但只有一份實作。
- **替代方案**：把金額寫進 event-loop 的狀態機模組 → 金額公式會與 `cost-model` 重複（Q-05 式的口徑分裂風險），否決。若 event-loop 先合併且已自帶現金流計算，本 change 的 tasks 3.2 將其改為呼叫 `fundingAmount`，並以其既有測試（"Settled after exit" +1.0 USDT）作為特性測試。

### 2. Position 型別：沿用 `trading-schema` 的 `PaperPosition`，提議加法欄位

`trading-schema-types` 已定義儲存列 `PaperPosition`（`position_id`、`trade_id`、`leg_id`、`exchange`、`symbol`、`position_side`、`quantity`、`average_entry_price`、`status: 'OPEN' | 'CLOSED'`、`opened_at`、`closed_at?`、`created_at`、`updated_at`），並註明「計算語意屬 `position-accounting`」。本 change 不另宣告同名型別（該 change 規定 `runtime/src/` 其他模組不得宣告這些名稱），只提議以下**加法欄位**：

```typescript
// 提議加入 PaperPosition（trading-schema-types）
base_quantity: number;              // 未平倉基礎資產數量 = quantity × contract_multiplier
entry_filled_quantity: number;      // 合約數量
exit_filled_quantity: number;
entry_notional_usdt: number;        // Σ Fill.notional_usdt of entry fills → TradeLeg.actual_notional_usdt
average_exit_price?: number;
realized_price_pnl_usdt: number;
fees_usdt: number;
slippage_attribution_usdt: number;
applied_fill_ids: string[];         // 冪等用（亦可改由 fills 表查詢，視 event-store 決定）
```

- `quantity` = 未平倉**合約**數量（與 `Fill.quantity` 同單位）；所有 PnL 與 hedge ratio 一律用 `base_quantity`。
- `status` 只有 `OPEN` / `CLOSED`，由 `base_quantity` 是否 > 0 決定；Leg 層狀態（`OPEN`、`PARTIAL`、`CLOSED`…）仍由 `TradeLeg.status`、Trade Manager 維護，避免兩套狀態互相矛盾。
- `TradeLeg.average_entry_price` / `average_exit_price` / `actual_quantity` / `actual_notional_usdt` 由 Position 回寫，與 Fill、Position 一起經 `Ledger.applyFill(fill, order, position, events)` 原子提交（`event-store`）。positionManager 本身是純函式，不碰資料庫。

### 3. Fill 套用規則

- **分類**：`order_id ∈ entry_order_ids` → 開倉；`∈ exit_order_ids`（含緊急平倉單）→ 平倉；兩者皆非 → 拒絕（`UNKNOWN_ORDER`）。不以 BUY / SELL 推斷，因為 LONG 的平倉是 SELL、SHORT 的開倉也是 SELL。
- **開倉**：加權平均（技術書 §21）。**平倉**：`average_entry_price` 不變，逐筆實現 Price PnL；不允許平倉後反手（超量 → `POSITION_OVERCLOSE`）。
- **冪等**：以 `fill_id` 去重；**順序**：重播以 `(timestamp, fill_id)` 排序。paper-execution 的 Fill 抵達順序即使與 timestamp 不同，重播結果也必須一致——因此平倉 Fill 若早於任何開倉 Fill 抵達（理論上不應發生），先暫存到對應開倉 Fill 到達或以 `POSITION_OVERCLOSE` 拒絕；第一版採拒絕 + `RECONCILIATION_ERROR`，交由 `reconciliation` 處理。
- **手續費**：只接受 `fee_asset = 'USDT'`（Binance / Bybit USDT 永續），其他 → `UNSUPPORTED_FEE_ASSET`。
- **參考價**：滑價歸因使用 Fill 所屬訂單的 `reference_price`（`paper-execution` 的 `OrderRequest.reference_price`；規格書 §16）。不使用 `Fill.slippage_from_reference_pct`（該欄位為百分比、正值 = 較差，與歸因 USDT / 負值 = 成本不同口徑）。
- **替代方案**：FIFO lot 會計 → 單次結算、單向開平倉的情境下與加權平均結果相同，但實作與儲存較複雜，否決。

### 4. Hedge ratio：可切換基準（✅ C-19 2026-10-02 已決議為 `QUANTITY`）

```typescript
type HedgeRatioBasis = 'NOTIONAL' | 'QUANTITY';          // PaperTradingConfig.hedge_ratio_basis，預設 'QUANTITY'（與 paper-execution 同一設定）
computeHedgeRatio(long, short, basis) → { hedge_ratio, basis, long_value, short_value, notional_ratio, quantity_ratio, has_exposure }
hedge_ratio = min(long_value, short_value) / max(long_value, short_value)
  NOTIONAL:      value = base_quantity × average_entry_price
  QUANTITY: value = base_quantity                    // 已乘合約乘數
```

- **預設改為 `QUANTITY`**：C-19 已決議改用合約乘數換算後的基礎資產數量計算（規格書 §14、§34）；`NOTIONAL` 實作保留（供對照與既有 Paper 資料相容），但不再是預設。
- 兩種實作仍都在本 change 完成並測試；§14.1 的 `hedged_min` 建議值已依新基準調整（跨所價差不再是誤差來源，只剩 step size）。
- `QUANTITY` 使用**成交數量 × 合約乘數**（非 notional）：分類發生在進場瞬間，累計基礎資產數量即可代表當時的對沖狀態，且結果可由 Fill 重播確定性重建。
- **與 `paper-execution-engine` 的重疊**：該 change（平行撰寫）的 tasks 3.1 也規劃 `hedgeRatio.ts`（基準 `NOTIONAL` / `QUANTITY`，並在 `HEDGE_RATIO_CHANGED` 同時記錄兩種比率）。本 change 要求收斂為**單一實作**（建議放在 `trading/hedgeRatio.ts`，由先合併者建立、後合併者 import 並沿用測試）；`HEDGE_RATIO_CHANGED` 由雙腿協調者（`paper-execution`）發出一次，positionManager 不發。
- `classifyHedge` 只回傳 `HEDGED` / `PARTIALLY_HEDGED` / `LEG_IMBALANCE`；「何時轉換、是否重送剩餘量、何時緊急平倉」屬 Trade Manager（規格書 §14.2）與 `funding-settlement-rules`（`hedged_by` 未 HEDGED → LEG_IMBALANCE）。

### 5. Leg imbalance 量測

- 每筆 Fill 套用後重算 `leg_imbalance_usdt`（與 hedge ratio 同一基準）並更新最大值；「不平衡區間」= `hedge_ratio < hedged_min` 且任一腿有部位，以 Fill.timestamp 的連續區間計算最長者。
- 出場時兩腿先後成交造成的短暫不平衡也計入（是真實曝險）。
- 結果寫入 TradeResult 的 `max_leg_imbalance_usdt`、`max_leg_imbalance_duration_ms`，供 §14.3 校準門檻。

### 6. FundingSettlement 金額（只做金額，狀態引用 `funding-settlement-rules`）

| funding-settlement-rules 狀態 | 本 change 寫入的欄位 |
|------------------------------|--------------------|
| 建立 `EXPECTED`（ARM） | `expected_cashflow_usdt = fundingCashflow(side, target_quantity, mark_now, predicted_rate)`、`position_side` |
| → `ELIGIBLE`（`lock_end`） | 以實際 `base_quantity`、當下 mark、最新預測費率重算 `expected_cashflow_usdt` |
| → `SETTLED` | `actual_cashflow_usdt = fundingCashflow(side, qty_at_T, mark_T, settled_rate)`、`position_notional = mark_T × qty_at_T`、`settled_funding_rate`、`funding_rate` 以已結算值覆寫（§18） |
| → `NOT_ELIGIBLE` | `actual_cashflow_usdt = 0` |
| → `MISSED` | 不寫 `actual_cashflow_usdt`（空值）；TradeResult 計 0 並標記人工檢查 |

- **`qty_at_T`**：鎖定區間內不得減倉（`funding-settlement-rules`），故 = `lock_end` 時的 `base_quantity`；若鎖定區間內有緊急減倉，該腿已被規則標為 `NOT_ELIGIBLE`，不會進入 SETTLED。
- **`mark_T` 來源**：沿用 event-loop Decision 6（Binance 用已結算紀錄的 `markPrice`；Bybit 用 market state 在 T 的快照，`mark_price_source = 'SNAPSHOT'`）。
- **事件**：金額與狀態轉換同一交易寫入，並放進狀態機產生的那一筆事件（`FUNDING_SETTLED` 等）的 payload；本 change 不產生第二筆事件，避免重播時重複入帳。
- **為什麼 MISSED 計 0**：保守（現金為王），不把未確認的收入算進定案損益；以 `FUNDING_MISSED_MANUAL_REVIEW` 讓人工補登。替代方案「MISSED 用 expected 金額」會讓定案結果含有未證實收入，否決；但此點列為 Open Question 讓使用者確認。

### 7. TradeResult 組裝

```
price_pnl_usdt             = Σ legs realized_price_pnl_usdt          （實際均價，已含滑價）
fee_usdt                   = Σ legs fees_usdt                        （正值 = 成本）
slippage_attribution_usdt  = Σ legs slippage_attribution_usdt        （僅歸因）
funding_pnl_usdt           = Σ legs cashflow（SETTLED → actual；暫定期 EXPECTED/ELIGIBLE → expected；NOT_ELIGIBLE/MISSED/無 → 0）
net_pnl_usdt               = cost-model.composeNetPnl(funding, price, fee, other_costs = 0)
roi_on_notional_pct        = net / (actual_long_notional + actual_short_notional) × 100     （✅ C-17；分母 0 → 0）
roi_on_capital_pct         = net / allocated_capital_usdt × 100                            （分母 0 → 0）
```

- **暫定 → 定案**：Trade 進入終態即建立 TradeResult（`funding_confirmed = false`），讓 UI 能顯示「已平倉 · 待入帳」（event-loop Decision 6）；所有腿結算終態後設定 `finalized_at`，`funding_confirmed` = 全部為 `SETTLED` / `NOT_ELIGIBLE`；定案產生一筆 `TRADE_COMPLETED`（技術書 §26；對應 §43 最後一步「PnL Finalized」）。定案後不再自動修改。
- **ABORTED 的定案時間**：零成交的 Trade 其 FundingSettlement 會在 `lock_end` 轉 `NOT_ELIGIBLE`（event-loop 規則），因此最早在 T+15s 定案；這是沿用規則的結果，不另設捷徑。
- **final_status**：`ABORTED` / `FAILED` / `EMERGENCY_EXIT` 優先，其餘依 `break_even_tolerance_usdt`（預設 0.01）分 `PROFIT` / `LOSS` / `BREAK_EVEN`。`close_reason = 'KILL_SWITCH'` 暫依淨值分類、`result_reason = 'KILL_SWITCH'`（C-16 已決議三層分級，但是否需要調整本 change 的分類方式仍列 Open Question，待 `risk-engine-kill-switch` group 4 落地後核對）。
- **Durations**：由 Trade 的時間戳計算（規格書 §25 衍生指標）。

### 8. 事件與持久化

| 觸發 | 事件 | 發出者 |
|------|------|-------|
| 第一筆開倉 Fill | `POSITION_OPENED` | positionManager |
| `base_quantity` 歸零 | `POSITION_CLOSED` | positionManager |
| hedge ratio 數值改變 | `HEDGE_RATIO_CHANGED` | `paper-execution` 雙腿協調者（使用本 change 的 `computeHedgeRatio`） |
| Fill 無法套用 | `RECONCILIATION_ERROR` | positionManager |
| FundingSettlement 狀態轉換 | （既有事件，payload 加金額） | funding-settlement-rules 狀態機 |
| TradeResult 定案 | `TRADE_COMPLETED` | tradeResultAssembler |

- 事件 `timestamp` = 事件時間（Fill 成交時間 / 時鐘時間），`recorded_at` = 寫入時間；Position 經 `Ledger.applyFill`、FundingSettlement 與 TradeResult 經 `event-store` 的同步帳本方法，與事件在同一 SQLite 交易提交。所有時間取自注入的 Clock（`trading-clock`）。

## 跨 change 假設

1. **`trading-schema-types`**（`trading-schema`）提供規格書 §6–§11、§18、§21 型別與 `PaperPosition`，並接受 Decision 2 的加法欄位；`TradeResult.funding_confirmed` 已由該 change 加入。**已知不一致**：該 change 的 spec 寫「`finalized_at` set only when funding is confirmed」，但 `funding-settlement-rules` 規定三種終態（含 `MISSED`）即設定 `finalized_at`；本 change 依 `funding-settlement-rules`（`MISSED` 時 `finalized_at` 有值、`funding_confirmed = false`），需該 change 的 `validateEntity` 同步放寬。**`trading-event-store`**（`event-store`）提供 `Ledger.applyFill(fill, order, position, events)` 及 FundingSettlement / TradeResult 的同步寫入方法。
2. **`Fill.quantity` 為合約數量**，`Fill.notional_usdt = quantity × price × contract_multiplier`（依 `paper-execution` spec）；positionManager 以 `instrument-registry` 的 `contract_multiplier` 換算 `base_quantity`。
3. **訂單帶有 `reference_price`**（`paper-execution` 的 `OrderRequest.reference_price`，規格書 §16）；缺少時該筆 Fill 的滑價歸因記為 0 並產生 `RECONCILIATION_ERROR`（不回推）。
4. **`paper-trading-event-loop`** 的 `funding-settlement-rules` 狀態機在每次轉換時呼叫本 change 的 `fundingAmount` hook，並把回傳欄位放入同一交易與同一事件；本 change 不改變其任何狀態、時間點或逾時設定。
5. **`net-cost-model`** 已合併：`fundingCashflow`、`composeNetPnl`、`slippageAttribution` 的簽章如該 change 的 spec 所述。
6. **Trade Manager**（屬 `paper-execution-engine` 或其後續 change）負責 Trade / Leg 狀態轉換與 `TRADE_STATUS_CHANGED` 事件，呼叫本 change 的 `classifyHedge` 與 TradeResult 建立函式。
7. **`PaperTradingConfig`** 新增 `hedge_ratio_basis`（預設 `NOTIONAL`）與 `break_even_tolerance_usdt`（預設 0.01）。

## Risks / Trade-offs

- [C-19 決議改為 `QUANTITY` 後，既有 Paper 資料的 hedge ratio 不可直接比較] → 每筆 Trade 記錄 `config_version`，事件 payload 記錄 `basis`；需要時可由 Fill 重播以新基準重算。
- [與 `paper-execution-engine` 重複實作 hedge ratio] → Decision 4 規定收斂為單一實作；由協調者（使用者 / 主 agent）決定放在哪個 change 先落地。
- [Fill 亂序抵達導致誤判超量平倉] → 第一版拒絕並產生 `RECONCILIATION_ERROR`（不靜默修正）；Paper 撮合為單執行緒佇列（event-loop Decision 1），實務上不應發生。
- [Bybit 已結算紀錄無 mark price，快照可能偏離交易所實際計價] → 標示 `mark_price_source = 'SNAPSHOT'`，差異在 Live 前以私有端點驗證。
- [MISSED 計 0 可能低估獲利] → 標記人工檢查；Paper 期間統計 MISSED 比例。
- [暫定結果被誤讀為最終結果] → `funding_confirmed = false` 且 `finalized_at` 為空；UI 依 event-loop 規則顯示「待入帳」。
- [event-loop 與本 change 合併順序不同造成重複金額實作] → Decision 1 的替代方案段已規定收斂方式（改為呼叫 `fundingAmount`，保留其既有測試）。

## Migration Plan

1. 在 `feature-position-funding-pnl`（來自 `develop`）開發；全部為 `runtime/src/` 新增檔案，研究端只改 `dryRunEngine.ts:145` 一行（先補失敗測試）。
2. `--no-ff` merge 回 `develop`；rollback：`git revert -m 1 <merge-commit>`。若已產生 Paper 資料，`positions` 表的 migration 必須可逆（技術書 §51.3），Runtime 啟動前自動備份 SQLite。

## Open Questions

1. ~~**⚠️ C-19**：hedge ratio 以 `NOTIONAL` 或 `QUANTITY`計算？~~ ✅ 2026-10-02 已決議：`QUANTITY`（合約乘數換算後的基礎資產數量），見本檔 §4、規格書 §14/§34。`NOTIONAL` 實作保留供對照。
2. `MISSED` 的腿在定案結果中計 0（保守）是否可接受？或應以 `expected_cashflow_usdt` 暫計並標示？
3. `close_reason = 'KILL_SWITCH'` 的 `final_status` 對應方式——C-16 已決議三層分級（見規格書 §23/§34），但本 change 目前仍依淨值分類、`result_reason = 'KILL_SWITCH'`；`risk-engine-kill-switch` group 4 實作後需回頭核對是否一致。
4. `break_even_tolerance_usdt` 預設 0.01 USDT 是否合適？
5. 零成交 ABORTED 的 TradeResult 必須等到 `lock_end` 才定案（沿用結算規則）——若使用者希望立即定案，需在 `funding-settlement-rules` 增加「零持倉直接 NOT_ELIGIBLE」規則（屬 event-loop，不在本 change 修改）。
