## Context

- 技術書 §31（對帳）、§12（資金保留原子性）、§32（Runtime Health）、§39（啟動流程）、§52（憑證狀態）、§48.3 / §48.4（UI 不是 Source of Truth、交易不依賴 UI）；✅ C-06：Runtime 獨立 process、SQLite 唯一寫入者、`server.ts` 唯讀並轉發。
- 上游：
  - `trading-schema`：型別、轉換表、`ENTRY_HALT_REQUESTED` / `ENTRY_HALT_CLEARED` / `RUNTIME_*` 事件碼、`AccountSnapshot`、`PaperPosition`。
  - `event-store`：`SqliteDriver`、migration 框架（本 change 加 `002`）、`EventStore.replay` / `rebuildProjections`、`Ledger`、`EventQueue.getStatus()`、備份。
  - `paper-execution`：`CREATED → SUBMITTED` 原子提交、Order / Trade 狀態推進、`ExecutionEngine` ARM / DISARM。
  - `trading-clock`：`Clock`、`CLOCK_UNRELIABLE` 狀態；`settlement-session`：接手恢復的持倉 Trade。
  - 狀態來源（以介面讀取，實作屬其他 change）：`market-data-stream`（連線、資料年齡）、`risk-engine`（ARMED）、`position-accounting`（`positions`）。
- ✅ C-16（2026-10-02 已決議）：子問題 (5) 決議 `RECONCILIATION_ERROR` → L1 + 受影響 Trade 轉 FAILED 待人工，與本 change 原本的保守假設一致，無需修改。本 change 只做「停止新進場」（技術書 §31「應同時觸發 STOP ENTRY」，屬 §33 第一層），不撤單、不平倉——實際升級到 L1（而非只是停止進場的最小 latch）屬 `risk-engine-kill-switch` group 4 的範圍，待其實作後對接。

## Goals / Non-Goals

**Goals:** 可自動發現的資料不一致；安全失敗（fail-safe）而非繼續交易；前端可唯讀看到 Runtime 健康狀態；可重啟並恢復。

**Non-Goals:** Kill Switch 分層、UI 畫面、控制端點、場次恢復細節、市場資料 / Scanner / Risk 的實作。

## Decisions

### 1. 對帳檢查項

| Check ID | 比對 | 來源 |
|----------|------|------|
| `ORDER_FILL_SUM` / `ORDER_AVG_PRICE` / `ORDER_REMAINING` | Order 欄位 vs Fills | §31 Orders vs Fills |
| `ORDER_STATE_QTY` / `ORDER_TERMINAL_TIME` / `ORDER_ORPHAN_CREATED` | 狀態 vs 成交量 / 時間 | C-14 |
| `POSITION_FILL_NET` | Position vs Σ 進場 Fill − Σ 平倉 Fill | §31 Fills vs Positions |
| `TRADE_CLOSED_NOT_FLAT` / `TRADE_HEDGED_FLAT` | Trade 狀態 vs 部位 | §26.2 |
| `CAPITAL_RESERVED_SUM` / `CAPITAL_AVAILABLE` / `CAPITAL_EVENT_PAIRING` | 帳本 vs 未結束 Trade / 事件 | §31 vs Capital、§12 |
| `PROJECTION_EVENT` | 投影列狀態 vs 最後轉換事件 | §25 #2 |

- 一致快照：整個 pass 在 `BEGIN`（read）…`COMMIT` 內讀取；因帳本類寫入（`trading-event-store` Decision 4）是同步 transaction，不會讀到「Fill 已寫、Position 未寫」的暫態，因此**不需要**寬限期即可判定錯誤。
- 容差：數量 `1e-9`、USDT `1e-6`（浮點誤差級），可設定；不以 step size 當容差（那會掩蓋真正的錯）。
- 效能：只檢查非終態 Trade + 最近 `reconciliation_lookback_ms`（預設 24 h）內結束的 Trade；啟動時做全量一次。
- **替代方案**：只在 Trade 結束時對帳 → 持倉期間的錯誤晚發現，否決；每筆寫入後對帳 → 與同步帳本重複且拖慢核心，否決。

### 2. 不一致處理

- 事件：`RECONCILIATION_ERROR`（`trade_id` 可為 `null`，依 `trading-schema` 規則）。
- Trade → `FAILED`（`isAllowedTransition` 允許任何非終態 → FAILED）。已終態的 Trade 只記事件 + 停止進場。
- 去重：記憶體中 `Set<check_id:entity_id>`（啟動時由最近未解決的 `RECONCILIATION_ERROR` 事件恢復）；mismatch 消失後移除。
- `EntryHaltPort`：
  ```typescript
  interface EntryHaltPort {
    requestHalt(r: { source: 'RECONCILIATION' | 'RUNTIME_RECOVERY' | 'DATABASE'; reason: string; trade_ids: string[] }): void;
    isHalted(): boolean;
    reasons(): HaltRequest[];
  }
  ```
  預設 `EntryHaltLatch`：寫 `ENTRY_HALT_REQUESTED`（同步帳本類，確保重啟後仍在），只有操作員動作（`ENTRY_HALT_CLEARED` 事件）能解除；解除的操作介面屬 `risk-engine-kill-switch` / `paper-trading-ui`。與 `risk-engine-kill-switch` 的接點：該 change 的 Risk Engine `ENTRY_GATE` 以「注入來源」接收 `ENTRY_HALT_REQUESTED`（其 design Open Question 9）；C-16 已決議由 Kill Switch 統一轉為 L1，待該 change group 4 落地後只需替換 `EntryHaltPort` 實作，本 change 行為不變。
- Database overflow（`EventQueue.getStatus().overflow`）也以 `source: 'DATABASE'` 請求停止進場。

### 3. Health 發佈：SQLite 單列

- Runtime 每 `health_publish_interval_ms` 與元件變化時 upsert `runtime_health(id=1)`；`server.ts` 以 `new DatabaseSync(path, { readOnly: true })` 讀取。
- 為什麼走 SQLite：C-06 已確定 `server.ts` 只讀 SQLite；不需新增 IPC / port，Runtime 與 server 各自重啟互不影響；失聯判斷只需比對 `updated_at`。
- `runtime_health` 是覆寫式單列，屬**狀態快取**而非交易實體，不產生 TradingEvent（Health 變化本身不是交易資料）；但 ARM / DISARM 與啟動步驟有事件（`RUNTIME_*`）。
- `updated_at` 使用 Runtime `Clock`；server 判斷失聯使用 server 本機時間（`server.ts` 不在 `runtime/src/`，不受 Clock 規則限制），閾值 3 倍間隔吸收兩者偏差。
- **替代方案**：Runtime 開 HTTP / WebSocket 給 server → 多一個連線與認證面，且事件串流通道屬 `paper-trading-ui`，本 change 不先定；否決。
- 回應只含狀態字串；`credentials` 只有 `PRESENT | MISSING | INVALID`，以 `assertNoCredentials` 檢查回應物件（Invariant #2）。

### 4. 啟動流程

```
1 Load Config → 2 Backup + Migrate → 3 Credentials → 4 Connect + Clock calibrate
→ 5 Validate Market Data → 6 Load Account Snapshot → 7 Recover from Event Store
→ 8 Reconcile → 9 Start Market Data → 10 Start Scanner → 11 Start Risk → 12 ARM Paper Execution
```

- 與技術書 §39 的差異：插入 2（技術書 §51.3 備份 / migration 必須在任何寫入前）、3（§52 權限驗證）、8（對帳通過才 ARM），並把 Clock 校正併入 4（`trading-clock`）。§39 原有步驟順序不變。
- 失敗分級：**致命**（1、2、3 的 Withdraw 權限）→ 非零結束；**降級**（5 逾時、8 mismatch）→ 持續運行、`DISARMED`，讓使用者在 UI 看到原因；**提示**（缺憑證）→ 公開資料模式。
- 啟動步驟全部經 Clock；各服務以 `Startable` 介面（`start(): Promise<void>`、`status()`）接入，本 change 以 fake 服務測試。

### 5. 重啟恢復

- Paper 撮合狀態在記憶體，重啟即消失 → 未終態訂單一律以合法轉換關閉（SUBMITTED → REJECTED；ACKNOWLEDGED / PARTIALLY_FILLED → CANCEL_REQUESTED → CANCELED），保留已成交量；這是模擬交易所的「重啟 = 撤掉所有掛單」語意。
- 進場中 / 失衡 / 緊急平倉中的 Trade → `FAILED` + 停止進場（需人工），**不**自動緊急平倉：C-16 已決議自動觸發只到 L1（不平倉），本 change 行為與決議一致，無需調整。
- `HEDGED` / `EXIT_PENDING` → 交給 `settlement-session` 重新排程（`exit_at` 已過則立即平倉，屬正常出場，不是 Kill Switch 行為）。
- 投影一致性：`rebuildProjections` 結果與現存列比對，差異走對帳 mismatch 流程。

### 6. 檔案

```
runtime/src/main.ts                              啟動流程
runtime/src/reconciliation/checks.ts             純函式檢查
runtime/src/reconciliation/reconciler.ts         排程、快照讀取、去重、處理
runtime/src/reconciliation/entryHalt.ts          EntryHaltPort + EntryHaltLatch
runtime/src/health/healthModel.ts                元件狀態、推導規則、entry_allowed
runtime/src/health/healthPublisher.ts            SQLite upsert
runtime/src/health/recovery.ts                   重啟恢復
runtime/src/storage/migrations/002_runtime_health.ts
server.ts                                        GET /api/runtime/health、/api/runtime/reconciliation/latest
```

## Risks / Trade-offs

- [重啟把進場中 Trade 標 FAILED 可能留下裸部位] → 刻意保守，與 C-16 已決議的「自動觸發只到 L1、不自動平倉」一致；停止進場 + UI 顯示 + HANDOFF 記錄人工處理步驟。
- [Health 單列覆寫無歷史] → 重要轉變已有 `RUNTIME_*` 與 `RECONCILIATION_ERROR` 事件；需要時日後加 health 歷史表。
- [server 與 Runtime 時鐘不同] → 失聯閾值 3 倍間隔；兩者同機執行，偏差可忽略。
- [SQLite 多 process 讀寫] → WAL 模式允許一寫多讀；server 唯讀連線不持有寫鎖。
- [上游狀態介面尚未實作] → fake 測試；整合時以 adapter 對接。

## Migration Plan

- `002_runtime_health` 可逆；`server.ts` 只新增 GET 路由。在 `feature-runtime-health-reconciliation` 開發，`--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`，資料層執行 `rollback(db, 1)` 或還原 `data/backup/`。
- develop → main 前依技術書 §51.2 實際啟動 `npm run dev` 並打 `/api/market/live-scan` 與 `/api/runtime/health`。

## Open Questions

1. ~~**⚠️ C-16 (5)**：Reconciliation Error、重啟時進場中 Trade，是否應自動撤單 / 緊急平倉？~~ ✅ 2026-10-02 已決議：不自動，只停止新進場並標 FAILED（與本 change 現行行為一致）。
2. **停止進場的解除**：由誰、以什麼操作解除（`ENTRY_HALT_CLEARED`）？是否需要先通過一次對帳？
3. **`FAILED` Trade 的保留資金**何時釋放（與 `paper-execution-engine` Open Question 5 相同）。
4. **啟動步驟調整**（Decision 4 插入 2、3、8）是否同意回寫技術書 §39？
5. **Health 元件值**：技術書 §32 只給範例值（RUNNING / CONNECTED / HEALTHY / ARMED），本 change 定義完整枚舉；`CLOCK`、`CREDENTIALS` 為依 event-loop 與 §52 新增。是否同意，並加入術語表 `HEALTH` 類別？
6. **重啟時 `HEDGED` Trade 的處理**需 `settlement-session` 提供「註冊既有 Trade」介面，event-loop change 目前未定義，需補。
