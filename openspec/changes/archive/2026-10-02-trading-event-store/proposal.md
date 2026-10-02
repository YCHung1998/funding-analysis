## Why

規格書 §12、§32、§31 Traceability 要求「任何 Trade（包含未成交、撤單、Emergency Exit）都能從 database 完整追蹤與 replay」，技術書 §26 要求事件是**可查詢的正式交易資料**而非 log、§35 要求交易核心不等待 UI 但資金保留 / 部位變更必須同步 commit、§51.3 要求啟動前自動備份與可逆 migration。目前 repo 沒有任何持久層；在 Paper Execution 開始產生 Order / Fill 之前，必須先有儲存與事件基礎。

> 本 change 是原 `trading-schema-storage` 拆分後的第二份（capability `event-store`）；型別來源見 `trading-schema-types`（capability `trading-schema`）。

分支：`feature-trading-event-store`（來自 `develop`）。

## What Changes

- SQLite 儲存（技術書 §28）：比較 `node:sqlite` 與 `better-sqlite3` 後推薦 `node:sqlite`（本機 Node v26 內建、免原生編譯），以薄 `SqliteDriver` 介面隔離。
- 可逆 migration 框架（`up` / `down`、`schema_migrations` 表），`001_initial` 建立技術書 §29 全部資料表與 §30 關聯、索引。
- 啟動前自動備份 `data/backup/<timestamp>.sqlite`，備份失敗則拒絕啟動 / 不執行 migration。
- Repository（`tradeRepository`、`orderRepository`、`marketDataRepository` 等，技術書 §4 `storage/`）：v0.2 型別 ↔ 資料列無損往返。
- Event Store：append-only（DB trigger 禁止 UPDATE / DELETE）、單調 `seq`、`recorded_at` 由寫入時的 Clock 產生且與事件 `timestamp` 分開、寫入前檢查憑證（Invariant #2）、依 `seq` replay 並可從事件重建所有投影表。
- Event Queue 寫入架構（技術書 §35）：非阻塞 `publish`，Database Writer / UI Broadcaster / Analytics Writer 互相隔離；UI 慢或失敗不影響交易核心與 DB 寫入；DB 事件不得靜默丟棄。
- 同步帳本交易（技術書 §35 註記、§12）：資金保留 / 釋放、Trade 建立、Order 狀態、Fill + Position 變更，連同其事件在**同一個 DB transaction** 同步 commit。
- 共用測試輔助 `assertTraceability(db)`：所有實體有 `created_at`/`updated_at`、每次狀態轉換都有事件、同一 Trade 事件時間單調不減（技術書 §42 時間戳測試）。

## Non-goals

- 不定義型別（屬 `trading-schema`）、不實作撮合 / 對帳 / Runtime Health（屬後續 change）。
- 不實作 `server.ts` 讀取 API 與前端事件推送通道（`runtime-health-reconciliation` 提供 health 唯讀 API；事件串流屬 `paper-trading-ui`）。
- 不寫入市場資料內容（`market_events`、`funding_rates` 只建表 + repository，寫入者為 `market-data-stream`）。
- 不導入 TimescaleDB / ClickHouse / Parquet（技術書 §28 未來項）。
- 備份保留策略（刪除舊備份）不在本 change，列 Open Question。
- 不新增任何真實下單端點（Invariant #1）。

## Capabilities

### New Capabilities

- `event-store`: SQLite 連線與 driver、可逆 migration、啟動前備份、§29 資料表與 §30 關聯、repository 往返、append-only Event Store 與 replay、非阻塞 Event Queue、同步帳本交易、可追溯性斷言輔助。

### Modified Capabilities

（無）

## Impact

- **新增程式**：`runtime/src/storage/`（driver、migrations、repositories、eventStore、ledger）、`runtime/src/telemetry/eventQueue.ts`（技術書 §4 `telemetry/eventLogger`）、`runtime/test/helpers/assertTraceability.ts`。
- **設定 / 檔案**：`.gitignore` 加入 `data/`；`package.json` `engines.node` 標註需 ≥ 22.13（`node:sqlite` 無旗標可用的版本；本機 v26.3.0 已驗證可載入且有 `backup()`）。
- **依賴**：`setup-vitest`、`trading-schema-types`（型別、`assertNoCredentials`、`makeTransitionEvent`）、`paper-trading-event-loop`（`Clock` 介面，`trading-clock`）。無新增 npm 套件。
- **下游**：`paper-execution-engine`、`runtime-health-reconciliation`、`position-funding-pnl`、`risk-engine-kill-switch`、`paper-trading-ui`。
- **對應**：規格書 §12、§25、§31 Traceability、§32；技術書 §12、§26–§30、§35、§36、§42、§43、§44、§51.3；✅ C-06（Runtime 唯一寫入者）、C-07、C-11；Invariant #1、#2。
