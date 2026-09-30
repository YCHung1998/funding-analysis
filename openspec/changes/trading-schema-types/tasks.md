> 前置：`setup-vitest`（`test-infrastructure`）已完成。分支 `feature-trading-schema-types`（來自 `develop`）。
> 每個函式 / 狀態表任務先寫失敗測試再實作（fail-then-pass 證據貼在 PR）；每個任務結束 `npm run lint`、`npm run build`、`npm test` 全綠。

## 1. 鎖住現有行為與骨架

- [ ] 1.1 為舊型別的現有使用者補 characterization test：`executeDryRunSimulation`（固定輸入的 `position_state`、`cost_table`、order state）、`arbitrageEngine` 結果、`funnelScanner` 輸出快照；確認綠燈（C-11 規則 1）
- [ ] 1.2 若 `runtime/` 骨架尚未由 `paper-trading-event-loop` task 2.1 建立則建立（tsconfig、vitest 納入 `runtime/**/*.test.ts`）；加入兩個自動檢查測試：`runtime/src/**` 不得 import `src/**`、`runtime/src/types/` 以外不得宣告本 capability 的型別名稱

## 2. 型別與狀態

- [ ] 2.1 `ids.ts`、`status.ts`：狀態陣列 / union、五張轉換表、`isAllowedTransition`、`transitionEventType`（先寫窮舉測試：無 `CLOSED`、終態不可離開、每個轉換都有事件碼）；若 event-loop 已有暫時型別，改為 import 本檔
- [ ] 2.2 實體介面 `opportunity.ts`、`trade.ts`、`order.ts`、`fill.ts`、`funding.ts`、`result.ts`、`risk.ts`（自 `systemSpec.ts` 搬入並 re-export）、`account.ts`；以 `expectTypeOf` 型別測試逐欄對照規格書 §5–§21 與 design Decision 2 的加欄位
- [ ] 2.3 `event.ts`：`TradingEventType`（核心 + 擴充碼）、`TradingEvent`、`makeTransitionEvent`（使用 event-loop 的 `Clock` 介面取時間）；`validate.ts`：`assertNoCredentials`（先寫洩漏測試）
- [ ] 2.4 `validateEntity`：時間戳、reduce-only、`remaining_quantity`、終態時間、`REJECTED` 原因、費率小數、帳本恆等式、`funding_confirmed = true ⇒ finalized_at`、`UNKNOWN` 時間戳不得為 PAPER（先寫各錯誤碼的失敗測試）

## 3. 術語表

- [ ] 3.1 `glossary.ts`：全部狀態與事件代碼條目（§9、§18、§26 表格原文）＋ 完整性與唯一性測試

## 4. 舊型別遷移規則

- [ ] 4.1 六個舊型別加 `@deprecated`（註明 v0.2 對應與遷移順序）；`src/types/legacy/` 建立 v0.2 → v0.1 顯示 adapter（`toLegacyOrderState`、`toLegacyPositionState`）與歷史資料匯入（`WithUnknownTimestamps<T>`、`timestamp_source: 'UNKNOWN'`），附測試；task 1.1 的 characterization test 仍全綠
- [ ] 4.2 在 `assets/HANDOFF.md` §6 Backlog 加入後續六個「一次一型別」遷移項目（順序見 design Decision 7）

## 5. 收尾

- [ ] 5.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate trading-schema-types --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄
