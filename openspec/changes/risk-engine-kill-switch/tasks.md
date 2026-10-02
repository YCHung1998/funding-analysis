> 前置：`setup-vitest` 已完成。分支 `feature-risk-engine-kill-switch`（來自 `develop`）。
> 每個檢查 / 狀態機任務先寫失敗測試再實作（fail-then-pass 證據貼在 commit 或 PR）；全部用 VirtualClock 與 fake 輸入，不打真實 API、不下任何訂單。
> 尚未完成的跨 change 介面（design Decision 8）以 fake 實作測試。
> ⚠️ **第 4 組 blocked-by C-16**：待 C-16 決議，決議後可能修改 `kill-switch` spec 與第 4 組內容；第 1–3 組不依賴第 4 組，可先實作並合併。

## 1. 風控骨架（risk-engine）

- [x] 1.1 先為 `src/types/systemSpec.ts` 的 `RiskStatusReport` / `RiskCheckItem` 寫特性測試鎖住欄位；再建立 `runtime/src/risk/checks/registry.ts`（28 項定義）、`RiskEvaluation` 結果模型、`INPUT_MISSING` 規則與 `RiskStatusReport` 彙總 / 映射（BLOCK、HALT_ENTRY、EMERGENCY_EXIT），以及「每個 `check_code` 都有 FAIL 與 INPUT_MISSING 測試」的覆蓋率測試（此時應為紅燈，隨 2.x / 3.x 轉綠）
  - 證據：`runtime/src/risk/riskStatusReportShape.test.ts`（特性測試）、`runtime/src/risk/checks/registry.ts`+`registry.test.ts`（28 項、順序、唯一性）、`runtime/src/risk/types.ts`（`RiskEvaluation`/`INPUT_MISSING` 規則）、`runtime/src/risk/checks/coverage.test.ts`（覆蓋率測試，以暫時插入一個無情境的假 `check_code` 實測會紅燈，移除後全綠）。
- [x] 1.2 `riskReport.ts`：評估結果 → `risk_checks` 紀錄（Pre-Trade 每項一筆；Entry / Position 只在開始、狀態改變、結束時寫入）與 `RISK_CHECK_STARTED` / `PASSED` / `FAILED` 事件（Clock 時間戳、`clock_offset_ms`、`created_at` / `updated_at`、payload 無憑證）
  - 證據：`runtime/src/risk/riskReport.ts` + `riskReport.test.ts`（10 tests）。

## 2. Pre-Trade Risk（risk-engine）

- [x] 2.1 資金與上限：`CAPITAL`、`MAX_POSITIONS`、`MAX_NOTIONAL_PER_LEG`、`MAX_LEVERAGE`、`EXISTING_EXPOSURE`（每項先寫 spec 中的 FAIL / PASS 情境測試）
- [x] 2.2 經濟性與流動性：`MIN_FUNDING_SPREAD`、`EXPECTED_NET_PNL`、`MAX_SLIPPAGE`、`ORDERBOOK_DEPTH`（深度不得由 24h 量推估）
- [x] 2.3 健康與時間：`EXCHANGE_CONNECTIVITY`、`API_LATENCY`（含 WARN 帶）、`FUNDING_TIME_ALIGNMENT`（呼叫 settlement-session 資格判斷 + `ENTRY_WINDOW_CLOSED`）、`DATA_FRESHNESS`（時鐘校正後 `data_age_ms`）、`CLOCK_RELIABILITY`（`CLOCK_UNRELIABLE`）、`ENTRY_GATE`（`TRADE_FAILED_PENDING_REVIEW` + 可注入來源）；加入「檢查程式不得出現交易所名稱字串」的自動檢查
  - 證據：`runtime/src/risk/preTradeRisk.ts` + `preTradeRisk.test.ts`（15 項全部，42 tests）、`runtime/src/risk/noExchangeLiteral.test.ts`。

## 3. 呼叫點與持續檢查（risk-engine）

- [x] 3.1 `riskCoordinator`：ARM 完整 Pre-Trade → `SELECTED` + 資金保留 / `REJECTED`（`rejection_reason` = 第一個 FAIL，不保留資金）；`PRE_FLIGHT` 重跑 6 項 → `ABORTED` + 釋放資金；確認 event-loop 的 `MAX_POSITIONS` / `BELOW_MIN_NET_PNL` / `STALE_MARKET_DATA` / `CLOCK_UNRELIABLE` 只有這一份實作；Scenario S09
  - 證據：`runtime/src/risk/riskCoordinator.ts`（`runArmPreTradeRisk`/`runPreFlightRisk`）+ `riskCoordinator.test.ts`；`runtime/test/scenarios/riskEngine.scenario.test.ts` S09。單一實作的說明見檔頭註解（event-loop 的 `armDecision.ts`/`positionLimiter.ts` 是場次篩選用途，ARM 的 Pre-Trade 閘門本身只有這一份）。
- [x] 3.2 Entry Risk 7 項（`PRICE_DEVIATION`、`FUNDING_RATE_CHANGE`、`ORDER_TIMEOUT`、`PARTIAL_FILL`、`LEG_IMBALANCE`、`EXCHANGE_CONNECTION`、`MARKET_VOLATILITY`）、動作彙總與對 `paper-execution` 的 `HALT_ENTRY` / `EMERGENCY_EXIT` 請求（事件 + `entry_risk_interval_ms` 觸發）；Scenario S10
  - 證據：`runtime/src/risk/executionRisk.ts` + `executionRisk.test.ts`（7 項 + 動作彙總）、`EntryRiskMonitor`（`riskCoordinator.ts`）+ `riskCoordinator.test.ts`、`runtime/test/scenarios/riskEngine.scenario.test.ts` S10。
  - 部分未完成：`entry_risk_interval_ms` 的**週期性排程呼叫**（用 `Clock.after` 每 N ms 呼叫一次 `EntryRiskMonitor.continue()`）未接線——本 change 沒有 runtime 主迴圈可掛，`EntryRiskMonitor` 的 `start`/`continue`/`end` 是給主迴圈（屬於尚未存在的 runtime 入口 / `paper-execution`）呼叫的介面；留給整合者在接上主迴圈時用 `clock.after(cfg.entry_risk_interval_ms, loop)` 驅動。
- [x] 3.3 Position Risk 6 項（`POSITION_IMBALANCE`、`MARK_PRICE_MOVEMENT`、`BASIS_DIVERGENCE`、`FUNDING_CHANGE`（`hedged_by` 前後行為不同）、`HOLDING_TIME`、`EXIT_CONDITION`）與 `EMERGENCY_EXIT` 請求；此時 1.1 的覆蓋率測試必須全綠
  - 證據：`runtime/src/risk/positionRisk.ts` + `positionRisk.test.ts`（6 項）、`PositionRiskMonitor`（`riskCoordinator.ts`）+ `riskCoordinator.test.ts`；`npx vitest run runtime/src/risk/checks/coverage.test.ts` 全綠（127/127 風控測試皆綠）。同 3.2，`position_risk_interval_ms` 的排程呼叫未接線，原因相同。

## 4. Kill Switch（kill-switch）— ✅ C-16 已於 2026-10-02 決議，不再 blocked，可於下一輪 apply

- [ ] 4.1 依決議（design.md §6–§7，全採推薦方案）修正 `kill-switch` spec 並更新規格書 §23 / §34、技術書 §33（已由整合者先行改寫，見本輪 HANDOFF）；於 `TradingEventType` 與術語表加入 `KILL_SWITCH_*` 事件碼；實作層級狀態機（只升不降、手動解除、清理中拒絕解除）、`KILL_SWITCH_*` 事件、由事件重建狀態、向 `ENTRY_GATE` 注入 `KILL_SWITCH_ACTIVE`、L1 行為（`CREATED` / `PRE_FLIGHT` → `ABORTED`，進行中 Trade 與補足單不受影響）
- [ ] 4.2 L2 只撤 `ENTRY` 單（絕不撤 `EXIT` / `EMERGENCY_CLOSE`）、撤單重試與 `KILL_SWITCH_CANCEL_FAILED`、撤單後依 §14 分類（0 成交 → ABORTED；≥ hedged_min → HEDGED；其餘 → LEG_IMBALANCE → §15，`close_reason = 'KILL_SWITCH'`）
- [ ] 4.3 L3 兩段式確認（一次性確認碼、TTL、逾時 / 錯誤拒絕）與全部平倉（保留既有出場單、鎖定區間 → `NOT_ELIGIBLE`）；自動觸發（斷線 / 資料持續過舊 → L1；`RECONCILIATION_ERROR` → L1 + Trade `FAILED`；`CLOCK_UNRELIABLE` 不觸發；已啟動時只記 `KILL_SWITCH_TRIGGERED`）；Scenario S11

## 5. 收尾

- [ ] 5.1 文件：技術書 §38 加入新設定欄位與預設值、規格書 §22 / 技術書 §11 附 28 項檢查對照表、術語表補 `reason_code` 中英對照、HANDOFF §4.2 P7 標註 Runtime 端已解（研究原型凍結不回改）；接著執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate risk-engine-kill-switch --strict` 全數通過並附輸出（第 4 組若仍 blocked，於紀錄中註明並列出剩餘 tasks）；更新 HANDOFF §7 交接紀錄
  - [x] 自動化檢查部分：`npm run lint`（`tsc --noEmit`）、`npm run build`、`npm test` 全數通過（58 test files / 444 tests，見本 change 的 risk-engine 相關 commits 與最終報告）；`openspec validate risk-engine-kill-switch --strict` 通過。第 4 組（Kill Switch）blocked-by C-16，完全未實作，見上方第 4 組所有項目維持 `[ ]`。
  - [ ] 文件部分（未做）：本任務的執行規則禁止修改 `docs/`、`assets/HANDOFF.md`、`README.md`（這些屬於其他 change / 整合者所有）。以下文字留給整合者直接採用：
    - **技術書 §38**（新設定欄位，建議加入 `PaperTradingConfig`，預設值見 `runtime/src/risk/types.ts` 的 `DEFAULT_RISK_CONFIG`——這些是起算值、非使用者已決議值，Open Question 8 待確認）：`depth_coverage_ratio`(3)、`max_api_latency_ms`(500)、`warn_api_latency_ms`(200)、`max_exchange_notional_usdt`(3000)、`max_entry_price_deviation_pct`(0.003)、`max_entry_volatility_pct`(0.005)、`volatility_window_ms`(5000)、`max_leg_margin_loss_ratio`(0.5)、`max_basis_divergence_pct`(0.005)、`max_holding_time_ms`(600000)、`entry_risk_interval_ms`(250)、`position_risk_interval_ms`(1000)。
    - **規格書 §22 / 技術書 §11**（28 項檢查對照表）：可直接從 `runtime/src/risk/checks/registry.ts` 的三個陣列（`PRE_TRADE_CHECKS`/`ENTRY_CHECKS`/`POSITION_CHECKS`）與 `preTradeRisk.ts`/`executionRisk.ts`/`positionRisk.ts` 的實作逐項轉錄成表格，欄位對應 `check_code`/`name`/`category`/`critical`/`failAction`。
    - **術語表 `reason_code` 中英對照**：reason_code 清單見 `runtime/src/risk/{preTradeRisk,executionRisk,positionRisk}.ts` 內的字面值（如 `INSUFFICIENT_CAPITAL`、`MAX_POSITIONS`、…、`EXIT_STALLED`）。本 change 未新增任何 `TradingEventType`（`RISK_CHECK_STARTED/PASSED/FAILED` 已存在），故 `runtime/src/types/event.ts`、`glossary.ts` 未修改、`glossary.test.ts` 不受影響。
    - **HANDOFF §4.2 P7**：建議文字——「Runtime 端已解：`runtime/src/risk/` 的 28 項 Pre-Trade/Entry/Position 檢查皆由注入輸入計算、輸入缺失一律 FAIL（`runtime/src/risk/checks/coverage.test.ts` 強制每項都有 FAIL 測試）。研究原型 `src/engine/dryRunEngine.ts` 維持凍結、不回改，UI 仍標示為 mock。」
    - **HANDOFF §7 交接紀錄**：建議新增一行——「`risk-engine-kill-switch`（tasks 1–3，risk-engine capability）已在 `feature-risk-engine` 分支完成並通過 `npm run check`；tasks 第 4 組（kill-switch）blocked-by C-16，未實作。」
