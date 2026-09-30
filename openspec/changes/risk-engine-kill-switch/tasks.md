> 前置：`setup-vitest` 已完成。分支 `feature-risk-engine-kill-switch`（來自 `develop`）。
> 每個檢查 / 狀態機任務先寫失敗測試再實作（fail-then-pass 證據貼在 commit 或 PR）；全部用 VirtualClock 與 fake 輸入，不打真實 API、不下任何訂單。
> 尚未完成的跨 change 介面（design Decision 8）以 fake 實作測試。
> ⚠️ **第 4 組 blocked-by C-16**：待 C-16 決議，決議後可能修改 `kill-switch` spec 與第 4 組內容；第 1–3 組不依賴第 4 組，可先實作並合併。

## 1. 風控骨架（risk-engine）

- [ ] 1.1 先為 `src/types/systemSpec.ts` 的 `RiskStatusReport` / `RiskCheckItem` 寫特性測試鎖住欄位；再建立 `runtime/src/risk/checks/registry.ts`（28 項定義）、`RiskEvaluation` 結果模型、`INPUT_MISSING` 規則與 `RiskStatusReport` 彙總 / 映射（BLOCK、HALT_ENTRY、EMERGENCY_EXIT），以及「每個 `check_code` 都有 FAIL 與 INPUT_MISSING 測試」的覆蓋率測試（此時應為紅燈，隨 2.x / 3.x 轉綠）
- [ ] 1.2 `riskReport.ts`：評估結果 → `risk_checks` 紀錄（Pre-Trade 每項一筆；Entry / Position 只在開始、狀態改變、結束時寫入）與 `RISK_CHECK_STARTED` / `PASSED` / `FAILED` 事件（Clock 時間戳、`clock_offset_ms`、`created_at` / `updated_at`、payload 無憑證）

## 2. Pre-Trade Risk（risk-engine）

- [ ] 2.1 資金與上限：`CAPITAL`、`MAX_POSITIONS`、`MAX_NOTIONAL_PER_LEG`、`MAX_LEVERAGE`、`EXISTING_EXPOSURE`（每項先寫 spec 中的 FAIL / PASS 情境測試）
- [ ] 2.2 經濟性與流動性：`MIN_FUNDING_SPREAD`、`EXPECTED_NET_PNL`、`MAX_SLIPPAGE`、`ORDERBOOK_DEPTH`（深度不得由 24h 量推估）
- [ ] 2.3 健康與時間：`EXCHANGE_CONNECTIVITY`、`API_LATENCY`（含 WARN 帶）、`FUNDING_TIME_ALIGNMENT`（呼叫 settlement-session 資格判斷 + `ENTRY_WINDOW_CLOSED`）、`DATA_FRESHNESS`（時鐘校正後 `data_age_ms`）、`CLOCK_RELIABILITY`（`CLOCK_UNRELIABLE`）、`ENTRY_GATE`（`TRADE_FAILED_PENDING_REVIEW` + 可注入來源）；加入「檢查程式不得出現交易所名稱字串」的自動檢查

## 3. 呼叫點與持續檢查（risk-engine）

- [ ] 3.1 `riskCoordinator`：ARM 完整 Pre-Trade → `SELECTED` + 資金保留 / `REJECTED`（`rejection_reason` = 第一個 FAIL，不保留資金）；`PRE_FLIGHT` 重跑 6 項 → `ABORTED` + 釋放資金；確認 event-loop 的 `MAX_POSITIONS` / `BELOW_MIN_NET_PNL` / `STALE_MARKET_DATA` / `CLOCK_UNRELIABLE` 只有這一份實作；Scenario S09
- [ ] 3.2 Entry Risk 7 項（`PRICE_DEVIATION`、`FUNDING_RATE_CHANGE`、`ORDER_TIMEOUT`、`PARTIAL_FILL`、`LEG_IMBALANCE`、`EXCHANGE_CONNECTION`、`MARKET_VOLATILITY`）、動作彙總與對 `paper-execution` 的 `HALT_ENTRY` / `EMERGENCY_EXIT` 請求（事件 + `entry_risk_interval_ms` 觸發）；Scenario S10
- [ ] 3.3 Position Risk 6 項（`POSITION_IMBALANCE`、`MARK_PRICE_MOVEMENT`、`BASIS_DIVERGENCE`、`FUNDING_CHANGE`（`hedged_by` 前後行為不同）、`HOLDING_TIME`、`EXIT_CONDITION`）與 `EMERGENCY_EXIT` 請求；此時 1.1 的覆蓋率測試必須全綠

## 4. Kill Switch（kill-switch）— ⚠️ blocked-by C-16

- [ ] 4.1 （blocked-by C-16）依決議修正 `kill-switch` spec 並更新規格書 §23 / §31 / §34、技術書 §26 / §33；於 `TradingEventType` 與術語表加入 `KILL_SWITCH_*` 事件碼；實作層級狀態機（只升不降、手動解除、清理中拒絕解除）、`KILL_SWITCH_*` 事件、由事件重建狀態、向 `ENTRY_GATE` 注入 `KILL_SWITCH_ACTIVE`、L1 行為（`CREATED` / `PRE_FLIGHT` → `ABORTED`，進行中 Trade 與補足單不受影響）
- [ ] 4.2 （blocked-by C-16）L2 只撤 `ENTRY` 單（絕不撤 `EXIT` / `EMERGENCY_CLOSE`）、撤單重試與 `KILL_SWITCH_CANCEL_FAILED`、撤單後依 §14 分類（0 成交 → ABORTED；≥ hedged_min → HEDGED；其餘 → LEG_IMBALANCE → §15，`close_reason = 'KILL_SWITCH'`）
- [ ] 4.3 （blocked-by C-16）L3 兩段式確認（一次性確認碼、TTL、逾時 / 錯誤拒絕）與全部平倉（保留既有出場單、鎖定區間 → `NOT_ELIGIBLE`）；自動觸發（斷線 / 資料持續過舊 → L1；`RECONCILIATION_ERROR` → L1 + Trade `FAILED`；已啟動時只記 `KILL_SWITCH_TRIGGERED`）；Scenario S11

## 5. 收尾

- [ ] 5.1 文件：技術書 §38 加入新設定欄位與預設值、規格書 §22 / 技術書 §11 附 28 項檢查對照表、術語表補 `reason_code` 中英對照、HANDOFF §4.2 P7 標註 Runtime 端已解（研究原型凍結不回改）；接著執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate risk-engine-kill-switch --strict` 全數通過並附輸出（第 4 組若仍 blocked，於紀錄中註明並列出剩餘 tasks）；更新 HANDOFF §7 交接紀錄
