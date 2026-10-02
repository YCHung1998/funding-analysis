> ✅ **C-16 已於 2026-10-02 決議，採本檔描述的推薦方案（三層分級）。** 其他選項與決議過程見 design.md Decision 6。

## ADDED Requirements

### Requirement: 三層分級且只能升級
Kill Switch SHALL 有四個層級 `NONE` < `L1_STOP_ENTRY` < `L2_CANCEL_ENTRY` < `L3_FLATTEN`；較高層級 MUST 包含所有較低層級的行為。啟動時只能升級：要求的層級 ≤ 目前層級時狀態不變，回傳 `ALREADY_ACTIVE`。每一次層級改變 MUST 產生 `KILL_SWITCH_ACTIVATED` 事件，payload 含 `from`、`to`、`source`（`MANUAL` / `AUTO`）、`reason`、`actor`（手動時為操作者識別，不得含任何憑證）。未指定層級的手動啟動 SHALL 視為 `L1_STOP_ENTRY`。

#### Scenario: 預設按鈕為 L1
- **WHEN** 層級為 `NONE`，操作者送出未指定層級的手動啟動
- **THEN** 層級變為 `L1_STOP_ENTRY`，產生 `KILL_SWITCH_ACTIVATED`（`from = 'NONE'`、`to = 'L1_STOP_ENTRY'`、`source = 'MANUAL'`）

#### Scenario: 不可降級
- **WHEN** 層級為 `L2_CANCEL_ENTRY`，收到 `L1_STOP_ENTRY` 啟動要求
- **THEN** 層級維持 `L2_CANCEL_ENTRY`，回傳 `ALREADY_ACTIVE`，不產生 `KILL_SWITCH_ACTIVATED`

### Requirement: L1 STOP_ENTRY 只禁止新交易
層級 ≥ `L1_STOP_ENTRY` 時，Risk Engine 的 `ENTRY_GATE` SHALL 為 FAIL、`reason_code = 'KILL_SWITCH_ACTIVE'`，因此不得建立新 Trade；尚未送出任何訂單的 `CREATED` / `PRE_FLIGHT` Trade SHALL 轉 `ABORTED`（reason `KILL_SWITCH`）並釋放保留資金。已送單的 Trade（`ENTRY_PENDING`、`PARTIALLY_HEDGED`、`HEDGED`、`EXIT_PENDING`、`EMERGENCY_EXIT`）MUST 照原流程繼續，包含 `PARTIALLY_HEDGED` 的補足單（規格書 §14.2）與 `exit_at` 的正常平倉。

#### Scenario: L1 阻擋 ARM
- **WHEN** 層級為 `L1_STOP_ENTRY`，某場次到達 ARM 且有一筆 15 項中其餘 14 項皆 PASS 的 Opportunity
- **THEN** 該 Opportunity 為 `REJECTED`、`rejection_reason = 'KILL_SWITCH_ACTIVE'`

#### Scenario: 未送單的 Trade 被放棄
- **WHEN** 啟動 L1 時有一筆 `PRE_FLIGHT` Trade（保留資金 454 USDT、尚無任何 Order）
- **THEN** 該 Trade 轉 `ABORTED`、reason `KILL_SWITCH`，available capital 增加 454

#### Scenario: 進行中的交易不受影響
- **WHEN** 啟動 L1 時有一筆 `PARTIALLY_HEDGED` Trade（hedge ratio 0.95）
- **THEN** 該 Trade 仍可對落後腿送出補足單，且 `HEDGED` Trade 仍在 `exit_at` 正常平倉

### Requirement: L2 CANCEL_ENTRY 只撤進場單
啟動 `L2_CANCEL_ENTRY` 時，系統 SHALL 對所有 `purpose = 'ENTRY'` 且非終態（`CREATED`、`SUBMITTED`、`ACKNOWLEDGED`、`PARTIALLY_FILLED`）的訂單送出撤單，並拒絕之後任何進場單或補足單（reason `KILL_SWITCH`）。`purpose = 'EXIT'` 或 `'EMERGENCY_CLOSE'` 的訂單 MUST NOT 被撤銷。撤單被拒（`ORDER_CANCEL_REJECTED`）時 SHALL 每 `kill_switch_cancel_retry_interval_ms` 重試，最多 `kill_switch_cancel_retry_max` 次，仍失敗則產生 `KILL_SWITCH_CANCEL_FAILED` 事件；期間到達的成交照常記錄。

#### Scenario: 出場單不被撤
- **WHEN** 啟動 L2 時有 2 張 `ACKNOWLEDGED` 進場單、1 張 `SUBMITTED` 出場單、1 張 `ACKNOWLEDGED` 緊急平倉單
- **THEN** 只有 2 張進場單進入 `CANCEL_REQUESTED`，出場單與緊急平倉單狀態不變

#### Scenario: 撤單失敗重試
- **WHEN** `kill_switch_cancel_retry_max = 3`、`kill_switch_cancel_retry_interval_ms = 500`，某進場單撤單連續 4 次被拒
- **THEN** 共送出 1 次撤單 + 3 次重試（間隔 500 ms），之後產生一筆 `KILL_SWITCH_CANCEL_FAILED` 事件

### Requirement: L2 後單腿的 Trade 自動走緊急平倉
L2 撤單使某 Trade 的所有進場單到達終態後，系統 SHALL 依 `position-accounting` 的 `hedge_ratio` 與規格書 §14 門檻分類：兩腿皆 0 成交 → `ABORTED`（reason `KILL_SWITCH`）；`hedge_ratio ≥ hedge_ratio_hedged_min` → `HEDGED`，照常於 `exit_at` 平倉；其餘（原本 `PARTIALLY_HEDGED` 或低於下門檻）→ `LEG_IMBALANCE`，自動依規格書 §15 緊急平倉（不需人工確認），`close_reason = 'KILL_SWITCH'`。

#### Scenario: 單腿成交自動緊急平倉
- **WHEN** 啟動 L2 時一筆 `ENTRY_PENDING` Trade 的 long 腿已成交 1,000 USDT、short 腿進場單被撤且 0 成交
- **THEN** Trade 轉 `LEG_IMBALANCE` → `EMERGENCY_EXIT`，對 long 腿送出 `reduce_only = true`、`purpose = 'EMERGENCY_CLOSE'` 的平倉單，最終 `CLOSED`、`close_reason = 'KILL_SWITCH'`

#### Scenario: 部分對沖無法再補足
- **WHEN** 啟動 L2 時一筆 `PARTIALLY_HEDGED` Trade 的 hedge ratio 為 0.95（`hedged_min = 0.99`）
- **THEN** 補足單被撤銷，Trade 轉 `LEG_IMBALANCE` 並自動緊急平倉

#### Scenario: 兩腿都未成交
- **WHEN** 啟動 L2 時一筆 `ENTRY_PENDING` Trade 兩腿皆 0 成交，撤單成功
- **THEN** Trade 轉 `ABORTED`、reason `KILL_SWITCH`，保留資金釋放

### Requirement: L3 FLATTEN 需兩段式確認
啟動 `L3_FLATTEN` SHALL 分兩步，由 Runtime 強制執行（UI 只負責送出指令，技術書 §48.3）：第一步 `requestFlatten` 產生 `KILL_SWITCH_FLATTEN_REQUESTED` 事件並回傳一次性確認碼，有效期 `kill_switch_flatten_confirm_ttl_ms`；第二步 `confirmFlatten(token)` 在有效期內以正確確認碼呼叫才升級為 L3。確認碼錯誤、已使用或過期時 MUST 拒絕（`FLATTEN_CONFIRMATION_INVALID`），層級不變並產生 `KILL_SWITCH_FLATTEN_REJECTED` 事件。L3 MUST NOT 由系統自動觸發。

#### Scenario: 有效期內確認
- **WHEN** `kill_switch_flatten_confirm_ttl_ms = 10000`，t0 呼叫 `requestFlatten`，t0 + 4000 以該確認碼呼叫 `confirmFlatten`
- **THEN** 層級升為 `L3_FLATTEN`，產生 `KILL_SWITCH_ACTIVATED`（`to = 'L3_FLATTEN'`）

#### Scenario: 確認逾時
- **WHEN** 同上但於 t0 + 10001 才確認
- **THEN** 回傳 `FLATTEN_CONFIRMATION_INVALID`，層級不變，產生 `KILL_SWITCH_FLATTEN_REJECTED`

#### Scenario: 只按一次不會平倉
- **WHEN** 只呼叫 `requestFlatten` 而未確認
- **THEN** 沒有任何 `EMERGENCY_CLOSE` 訂單被建立

### Requirement: L3 平掉所有部位
L3 生效時系統 SHALL 先執行 L2 的全部行為，再對每一筆持有非零部位且狀態為 `HEDGED`、`PARTIALLY_HEDGED` 或 `LEG_IMBALANCE` 的 Trade 啟動規格書 §15 緊急流程（新的 `reduce_only` `EMERGENCY_CLOSE` 訂單，Cancel ≠ Close），`close_reason = 'KILL_SWITCH'`。已在 `EXIT_PENDING` 或 `EMERGENCY_EXIT` 的 Trade MUST 保留既有出場 / 緊急平倉單，不重複下單。鎖定區間內的平倉 SHALL 依 `funding-settlement-rules` 將受影響腿的資金費標為 `NOT_ELIGIBLE`。

#### Scenario: 平掉持倉中的交易
- **WHEN** L3 生效時有 2 筆 `HEDGED` Trade 與 1 筆 `EXIT_PENDING` Trade
- **THEN** 2 筆 HEDGED Trade 各建立 2 張 `EMERGENCY_CLOSE` 訂單並轉 `EMERGENCY_EXIT`；`EXIT_PENDING` Trade 不新增訂單

#### Scenario: 鎖定區間內平倉失去資金費資格
- **WHEN** L3 於 T + 5s 生效（`lock_end = T + 15s`），某 HEDGED Trade 兩腿被緊急平倉
- **THEN** 兩腿的 `FundingSettlement` 為 `NOT_ELIGIBLE`

### Requirement: 自動觸發對應層級
系統 SHALL 自動觸發下列層級（`source = 'AUTO'`）：`trading_exchanges` 中任一交易所產生 `EXCHANGE_DISCONNECTED` → `L1_STOP_ENTRY`（reason `EXCHANGE_DISCONNECTED`）；任一交易所的行情持續過舊（`STALE_MARKET_DATA` 狀態）達 `auto_kill_stale_duration_ms` → `L1_STOP_ENTRY`（reason `STALE_MARKET_DATA`）；`reconciliation` 產生 `RECONCILIATION_ERROR` → `L1_STOP_ENTRY`（reason `RECONCILIATION_ERROR`），並要求將受影響 Trade 轉 `FAILED` 待人工處理（規格書 §26.2、技術書 §31）。自動觸發 MUST NOT 高於 L1；目前層級已 ≥ L1 時層級不變，但 SHALL 產生 `KILL_SWITCH_TRIGGERED` 事件記錄來源與原因。

#### Scenario: 斷線觸發 L1
- **WHEN** 層級為 `NONE`，Bybit 產生 `EXCHANGE_DISCONNECTED`
- **THEN** 層級變為 `L1_STOP_ENTRY`、`source = 'AUTO'`、`reason = 'EXCHANGE_DISCONNECTED'`

#### Scenario: 短暫過舊不觸發
- **WHEN** `auto_kill_stale_duration_ms = 10000`，Binance 行情過舊 6 秒後恢復
- **THEN** 層級維持 `NONE`（該期間的新進場仍由 Pre-Trade `DATA_FRESHNESS` 阻擋）

#### Scenario: 持續過舊觸發 L1
- **WHEN** Binance 行情持續過舊 10 秒
- **THEN** 層級變為 `L1_STOP_ENTRY`、`reason = 'STALE_MARKET_DATA'`

#### Scenario: 對帳錯誤
- **WHEN** Trade A 產生 `RECONCILIATION_ERROR`（Order 顯示成交 1,000、Position 顯示 900）
- **THEN** 層級變為 `L1_STOP_ENTRY`，Trade A 轉 `FAILED`（reason `RECONCILIATION_ERROR`），且在人工確認前 `ENTRY_GATE` 同時因 `TRADE_FAILED_PENDING_REVIEW` 為 FAIL

#### Scenario: 已啟動時的自動觸發
- **WHEN** 層級為 `L2_CANCEL_ENTRY` 時收到 `EXCHANGE_DISCONNECTED`
- **THEN** 層級維持 L2，產生一筆 `KILL_SWITCH_TRIGGERED` 事件

### Requirement: 只能手動解除
（KS-6，design.md Open Question 3：非 C-16 原題的延伸，✅ 2026-10-03 已決議採推薦方案，不會再變動）Kill Switch SHALL 只能由操作者手動解除回 `NONE`，並產生 `KILL_SWITCH_RELEASED` 事件（含 `from`、`actor`、`reason`）。L2 / L3 引發的撤單或緊急平倉仍在進行中時，解除 MUST 被拒絕（`KILL_SWITCH_CLEANUP_IN_PROGRESS`）。自動觸發的來源恢復正常 MUST NOT 自動解除。

#### Scenario: 連線恢復不自動解除
- **WHEN** 因 Bybit 斷線自動進入 L1，30 秒後 Bybit 恢復 `CONNECTED`
- **THEN** 層級維持 `L1_STOP_ENTRY`

#### Scenario: 緊急平倉未完成時拒絕解除
- **WHEN** 層級為 L3，仍有 1 筆 Trade 在 `EMERGENCY_EXIT`，操作者要求解除
- **THEN** 回傳 `KILL_SWITCH_CLEANUP_IN_PROGRESS`，層級不變

### Requirement: Kill Switch 狀態可由事件重建
Kill Switch 的目前層級 SHALL 由事件庫中的 `KILL_SWITCH_ACTIVATED` / `KILL_SWITCH_RELEASED` 事件重建；Runtime 重新啟動（技術書 §39）時 MUST 在 ARM Paper Execution 之前恢復層級。

#### Scenario: 重啟後仍停止進場
- **WHEN** 層級為 `L1_STOP_ENTRY` 時 Runtime 重啟
- **THEN** 重啟後第一次 Pre-Trade 評估的 `ENTRY_GATE` 為 FAIL、`reason_code = 'KILL_SWITCH_ACTIVE'`

### Requirement: Scenario S11 Kill Switch
Scenario Test S11（技術書 §42，錄製資料、固定 seed）SHALL 在同一時間點同時存在 `ENTRY_PENDING`（單腿已成交）、`HEDGED`、`EXIT_PENDING` 三筆 Trade 時依序啟動 L1、L2、L3，並斷言每一層的行為、所有 `KILL_SWITCH_*` 事件、所有實體的 `created_at` / `updated_at` 與事件時間單調不減。

#### Scenario: 逐層啟動
- **WHEN** 以 seed 7 建立上述三筆 Trade 後依序啟動 L1、L2、L3（L3 於 5 秒內確認）
- **THEN** L1 後無新 Trade；L2 後 ENTRY_PENDING Trade 走緊急平倉且 EXIT_PENDING 的出場單未被撤；L3 後 HEDGED Trade 轉 `EMERGENCY_EXIT`；最終三筆 Trade 皆 `CLOSED`，事件庫有 3 筆 `KILL_SWITCH_ACTIVATED`
