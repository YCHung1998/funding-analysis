> 前置：`setup-vitest`、`net-cost-model`、`trading-schema-types`、`trading-event-store` 已完成；`paper-trading-event-loop` 的 `funding-settlement-rules` 狀態機已存在（或與本 change 並行時依 design Decision 1 收斂）。分支 `feature-position-funding-pnl`（來自 `develop`）。
> 每個公式 / 帳務任務先寫失敗測試（使用 spec 情境中的數字）再實作；所有時間用 VirtualClock，Fill 以固定 fixture 產生，不打任何交易所 API。每個任務結束時 lint / build / test 皆綠。

## 1. Position（position-accounting）

- [x] 1.1 `PaperPosition` 補充欄位（提交給 `trading-schema-types`）與純函式 `positionManager.applyFill` 開倉：`Fill.quantity × contract_multiplier` 換算、Fill 分類（entry / exit order ids）、加權平均與逐筆累加（30 / 20 / 50 → 100.03）、無 Fill 不建倉、`fill_id` 冪等、TradeLeg 實際欄位回寫
  - 證據：`runtime/src/types/account.ts`（`PaperPosition` 加法欄位）+ `runtime/src/storage/migrations/002_position_accounting_fields.ts`（可逆遷移）+ `runtime/src/storage/orderRepository.ts`（持久化）；`runtime/src/trading/positionManager.ts` + `positionManager.test.ts`（14 tests，含 30/20/50 → 100.03 加權平均、冪等案例）。
- [x] 1.2 平倉與實現 PnL（LONG 60 / 40 → +23.00、avg exit 100.26；SHORT +10.00）、手續費與滑價歸因累加（呼叫 `cost-model.slippageAttribution`）、`RECONCILIATION_ERROR`（`UNKNOWN_ORDER`、`POSITION_OVERCLOSE`、`UNSUPPORTED_FEE_ASSET`）
  - 證據：`runtime/src/trading/positionManager.test.ts`（LONG 60/40 → +23.00 avg exit 100.26、SHORT → +10.00、fee/slippage 累加、UNKNOWN_ORDER/POSITION_OVERCLOSE/UNSUPPORTED_FEE_ASSET/RECONCILIATION_ERROR 四種錯誤測試）。
- [x] 1.3 `unrealizedPnl`（+9.94 / −10.00）、Position 時間戳、`status` OPEN / CLOSED 與 `POSITION_OPENED` / `POSITION_CLOSED` 事件（經 `Ledger.applyFill` 原子寫入）、重播一致性測試
  - 證據：`runtime/src/trading/positionManager.ts` `unrealizedPnl`（+9.94/−10.00 測試）；`runtime/test/scenarios/positionFundingPnl.scenario.test.ts` S01（`Ledger.applyFill` 原子寫入 Position + ORDER_FILL + POSITION_OPENED）；`positionManager.test.ts` replay consistency 測試（相同 Fill 序列重播與冪等）。

## 2. Hedge ratio 與 imbalance（position-accounting）

- [x] 2.1 `hedgeRatio`：`NOTIONAL` / `QUANTITY` 可切換（預設 `QUANTITY`，✅ C-19 2026-10-02 已決議）、0.30 / 0.995025 vs 1.0 / 合約乘數案例、`notional_ratio` / `quantity_ratio` 同時回傳、`classifyHedge`（邊界 0.99、0.90、tier 覆寫）；與 `paper-execution-engine` 的 `hedgeRatio.ts` 收斂為單一實作（該 change 改為 import，或本 change 沿用其實作並補測試），不重複發 `HEDGE_RATIO_CHANGED`
  - 證據：`runtime/src/trading/hedgeRatio.ts`（`computeHedgeRatio`/`classifyHedge`，CONTRACT_MEMO.md 釘選簽章）+ `hedgeRatio.test.ts`（15 tests，含 0.995025 vs 1.0 案例、合約乘數換算案例、0.99/0.90 邊界、symbol tier 覆寫）。`positionManager`/`tradeResultAssembler` 皆不發 `HEDGE_RATIO_CHANGED`（留給 `paper-execution-engine` 的雙腿協調者）。
- [x] 2.2 Leg imbalance 量測：`leg_imbalance_usdt`、`max_leg_imbalance_usdt`、`max_leg_imbalance_duration_ms`（補足案例 1000 / 800 ms、緊急平倉案例 1000 / 5,200 ms）
  - 證據：`runtime/src/trading/hedgeRatio.ts` `updateLegImbalance` + `hedgeRatio.test.ts`（1000 USDT / 800ms 案例、緊急平倉 1000 USDT / 5200ms 案例）。

## 3. FundingSettlement 金額（pnl-engine）

- [x] 3.1 `fundingAmount` hook：EXPECTED（+1.80）、ELIGIBLE 以實際數量重算（+1.791）、SETTLED 寫入 `actual_cashflow_usdt` / `position_notional` / `settled_funding_rate` / 覆寫 `funding_rate`（+1.00、快照 +0.501）、NOT_ELIGIBLE = 0、MISSED 空值；全部呼叫 `cost-model.fundingCashflow`
  - 證據：`runtime/src/trading/fundingAmount.ts`（簽章正式釘選，CONTRACT_MEMO.md §1 重構版）+ `fundingAmount.test.ts`（7 tests：+1.80/+1.791/+1.00/快照+0.501/NOT_ELIGIBLE=0/MISSED 空值/LONG 符號翻轉）。
- [x] 3.2 與 `funding-settlement-rules` 狀態機串接：金額與狀態轉換同一交易、金額放入同一筆事件 payload、不產生第二筆事件；若狀態機已自帶現金流計算，改為呼叫 `fundingAmount` 並保留其 +1.0 USDT 測試
  - 證據：`runtime/src/trading/fundingAmount.crossCheck.test.ts`（3 tests）。**偏離 design.md 字面敘述，已記錄**：無法讓 `funding/settlementInference.ts`（`funding-settlement-rules` 狀態機）直接呼叫 `trading/fundingAmount.ts`，因為 `accounting/fundingMath.ts`（`fundingAmount` 的依賴）已反向 import `settlementInference.ts` 的 `computeSettlementCashflow`，形成循環 import。兩者皆為同一 `computeSettlementCashflow` 原語的薄包裝，Q-07 已透過共用原語滿足（無口徑分裂風險），故改以等價性測試鎖住（`resolveSettlement` 的 +1.0 USDT 案例與 `fundingAmount('SETTLED',...)` 逐一比對），並以 `EventStore.append` 示範「金額欄位併入同一筆事件 payload、只產生一筆事件」的用法。
- [x] 3.3 Q-08：單腿失敗只計實際 funding（鎖定區間前緊急平倉 → 0、net −3.00；裸腿跨結算 → −0.50）；研究端 `dryRunEngine.ts:145` 先補失敗測試 `leg_long === 0` 再修正
  - 證據：`src/engine/dryRunEngine.test.ts`（fail-then-pass：先改既有測試斷言 `funding_pnl.leg_long` 應為 `0`，確認紅燈 `expected 0, got -0.1`，再修正 `src/engine/dryRunEngine.ts:151` 後轉綠，9/9 tests）；`runtime/test/scenarios/positionFundingPnl.scenario.test.ts` 單腿 EMERGENCY_EXIT 情境（鎖定區間前緊急平倉 → funding 0）；`accounting/pnlEngine.test.ts` `legFundingPnl` 的 NOT_ELIGIBLE/MISSED/無結算一律 0 測試。

## 4. TradeResult（pnl-engine）

- [x] 4.1 `tradeResultAssembler`：price / fee / slippage attribution / funding 加總、`net = composeNetPnl(...)`（S01 −0.50、非 −0.90）、ROI（C-17：−0.02499 / −0.11013、單腿 −0.30、零成交 0）、`final_status` / `result_reason`、durations、leg imbalance 欄位；確認 `trading-schema` 的 `TradeResult` 含 `funding_confirmed`
  - 證據：`runtime/src/accounting/pnlEngine.ts`（`aggregatePnl`/`roiOnNotional`/`roiOnCapital`）+ `pnlEngine.test.ts`（8 tests，含 Q-05 迴歸測試 −0.50 非 −0.90、ROI −0.02499%/−0.11013%、單腿 −0.30%、零成交 0）；`runtime/src/accounting/tradeResultAssembler.ts` + `tradeResultAssembler.test.ts`（10 tests，`final_status`/`result_reason`/durations/leg imbalance 欄位）；`runtime/src/types/result.ts` 已含 `funding_confirmed`（`trading-schema-types` 既有）。
- [x] 4.2 暫定與定案：終態建立（`funding_confirmed = false`）、每次結算更新重算（2.00 → 1.90）、全部終態後 `finalized_at` 與 `funding_confirmed`、MISSED 標記 `FUNDING_MISSED_MANUAL_REVIEW`、單一 `TRADE_COMPLETED` 事件、定案後不可自動修改
  - 證據：`runtime/src/accounting/tradeResultAssembler.test.ts`（provisional funding_confirmed=false、2.00→1.90 重算、兩腿皆終態才 finalized、MISSED → `result_reason` 含 `FUNDING_MISSED_MANUAL_REVIEW`、`shouldEmitTradeCompleted` 只在 finalized_at 新產生時為 true 且定案後不再觸發）。
- [x] 4.3 帳務情境測試（`runtime/test/scenarios/`）：S01 完整成功（技術書 §43）、零成交 ABORTED（§44）、單腿失敗 EMERGENCY_EXIT（§45 / S03 / S12）的 Position → FundingSettlement → TradeResult 全鏈；斷言所有實體有 `created_at` / `updated_at`、事件時間單調不減（技術書 §42）
  - 證據：`runtime/test/scenarios/positionFundingPnl.scenario.test.ts`（3 tests：S01、零成交 ABORTED、單腿 EMERGENCY_EXIT 全鏈；`assertTimestamped`/`assertMonotonicTimestamps` helper 把關）。

## 5. 收尾

- [x] 5.1 更新文件（規格書 §14 註明 `hedge_ratio_basis` 預設已改 `QUANTITY`（C-19 已決議）、§21 欄位計算方式；技術書 §20–§23、§38 新設定欄位）；執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate position-funding-pnl --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄
  - 證據：見下方「驗證輸出」一節與 `assets/HANDOFF.md` §7 新增條目（`2026-10-03（2）— Claude Sonnet 5，position-funding-pnl`）。

## 驗證輸出（task 5.1）

```
$ npm run lint
> react-example@0.0.0 lint
> tsc --noEmit
(no output — passes)

$ npm run build
> react-example@0.0.0 build
> vite build
✓ 1721 modules transformed.
dist/index.html                            1.00 kB │ gzip:   0.45 kB
dist/assets/index-CQVEhrVz.css            53.38 kB │ gzip:   9.01 kB
dist/assets/PaperTradingTab-Dfj_gPRn.js   57.76 kB │ gzip:  15.79 kB
dist/assets/index-IxEiAlDU.js            445.86 kB │ gzip: 123.00 kB
✓ built in 656ms

$ npm test
> react-example@0.0.0 test
> vitest run
 Test Files  128 passed (128)
      Tests  1179 passed (1179)

$ npx openspec validate position-funding-pnl --strict
Change 'position-funding-pnl' is valid
```
