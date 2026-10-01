## Context

- 技術書 §28 指定 SQLite；§29 / §30 列出資料表與關聯；§35 規定事件走 queue、交易核心不等 UI，但資金保留 / 部位變更要同步 commit；§51.3 規定啟動前備份、migration 可逆。✅ C-06：Runtime 是 SQLite 唯一寫入者，`server.ts` 唯讀。
- 型別由 `trading-schema-types` 提供；轉換事件 `payload.after` 帶完整實體快照（該 change design Decision 4），使 replay 可純由事件重建投影。
- 時間一律透過 `paper-trading-event-loop` 的 `Clock`（`trading-clock`）；本 change 內不得呼叫 `Date.now()` / `setTimeout`。
- 環境：本機 Node v26.3.0；已驗證 `require('node:sqlite')` 可載入、匯出 `DatabaseSync`、`StatementSync`、`backup`，無 ExperimentalWarning 輸出；`@types/node` 22.20.4 已含 `sqlite.d.ts`；`node_modules` 內無 `better-sqlite3`。

## Goals / Non-Goals

**Goals:** 可靠、可逆、可備份的持久層；事件為正式資料且可 replay；資金正確性寫入與 UI / 分析解耦。

**Non-Goals:** 對帳邏輯、Runtime Health、`server.ts` API、市場資料寫入內容、備份保留策略。

## Decisions

### 1. SQLite 函式庫：推薦 `node:sqlite`

| 面向 | `node:sqlite`（內建） | `better-sqlite3` |
|------|----------------------|------------------|
| 安裝 | 無；Node ≥ 22.13 免旗標 | 原生模組；新 Node 大版本（v26）常缺預編譯檔，需 node-gyp + Xcode CLT，在 `--legacy-peer-deps` 環境額外風險 |
| API | 同步 `DatabaseSync` / `StatementSync`；無 `transaction()` 輔助（自行 `BEGIN IMMEDIATE` / `COMMIT`） | 同步；有 `db.transaction()`、成熟 |
| 備份 | `backup(db, path)`（本機已確認存在） | `db.backup(path)` |
| 穩定度 | 較新（API 可能微調） | 多年生產使用 |
| 型別 | `@types/node` 已有 | 需 `@types/better-sqlite3` |

- **決定**：`node:sqlite`，以 `SqliteDriver` 介面隔離（`exec` / `prepare` / `transaction` / `backupTo` / `close`）。零依賴、無原生編譯、同步 API 讓「同一 transaction 內不可 await」成為天然保證。若日後遇到 API 變動或效能問題，只需新增 `BetterSqliteDriver`，其他程式不動。
- 同步 API 在單執行緒 Node 中：一個 `transaction(fn)` 執行期間不會有其他事件插入 → 資金保留天然原子；WAL 下單筆寫入為微秒至毫秒級，符合技術書 §36「correctness 優先於 latency」。
- **風險**：Vitest / Vite 對 `node:sqlite` 的解析（較舊版 Vite 的 builtin 清單未收錄 `node:sqlite`）→ task 1.1 以 spike 驗證；若失敗，在 vitest 設定將其列為 external。

### 2. Migration

- 檔案：`runtime/src/storage/migrations/001_initial.ts` … 每檔 `export const up/down`；`schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)`。
- 每個 migration 一個 transaction；`down` 必須完整移除 `up` 建立的物件（round-trip 測試比對 `sqlite_master.sql`）。
- 資料型別：時間 `INTEGER`（epoch ms）、金額 / 費率 / 數量 `REAL`（費率存小數，Invariant #5）、布林 `INTEGER 0/1`、巢狀物件 `TEXT`（JSON）。
- `trading_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, …)`；觸發器 `BEFORE UPDATE/DELETE ON trading_events → RAISE(ABORT, 'trading_events is append-only')`。
- `trading_events` 不設外鍵：事件是最終紀錄，不能因投影列尚未存在而遺失；一致性由 `assertTraceability` 與 `runtime-health-reconciliation` 檢查。
- `positions`、`pnl_snapshots` 欄位依 `trading-schema` 的 `PaperPosition` 與最小 PnL 快照（`trade_id`、`snapshot_time`、`funding_pnl_usdt`、`price_pnl_usdt`、`fee_usdt`、`unrealized_pnl_usdt`、`net_pnl_usdt`）；語意由 `position-funding-pnl` 決定，若需變更以新 migration 處理。
- `market_events`、`funding_rates` 依技術書 §8 `MarketDataEvent` 欄位（含 `exchange_timestamp`、`local_received_timestamp`、`sequence`）。

### 3. 備份

- `runtime/src/storage/backup.ts`：啟動流程第一個 I/O 步驟；檔名取 `clock.now()` 格式化 UTC `YYYYMMDDTHHmmssSSSZ`；使用 driver `backupTo`（線上一致性備份），完成後以唯讀開啟備份檔並執行 `PRAGMA integrity_check` 確認。
- 同毫秒重複啟動（測試情境）→ 檔名加 `-1`、`-2` 後綴，不覆蓋。
- `data/` 加入 `.gitignore`（SQLite 檔可能含帳戶資訊，不得提交）。

### 4. 同步 vs 非同步寫入分類

| 類別 | 寫入方式 | 實體 / 事件 |
|------|---------|------------|
| **帳本（同步）** | `Ledger` 方法，實體列 + 事件同一 transaction，commit 後才回傳 | 資金保留 / 釋放（`account_snapshots`）、`trades`、`trade_legs`、`orders`、`fills`、`positions`、`funding_settlements` 與其轉換事件 |
| **觀測（非同步）** | `EventQueue.publish` → `DatabaseWriter` 批次寫入 | `opportunities`、`risk_checks`、`market_events`、`funding_rates`、`pnl_snapshots`、`OPPORTUNITY_*`、`RISK_CHECK_*`、`SESSION_*`、`CLOCK_*`、`STALE_MARKET_DATA`、`RUNTIME_*` 等 |

- 為什麼 orders / fills 也同步：技術書 §35 例外只寫資金與部位，但 Fill 直接改變部位、Order 的 `filled_quantity` 與 Fill 必須一致，對帳（§31）比較的正是這三者；放同一 transaction 才不會出現「Fill 已寫、Position 未寫」的暫態被誤判為 `RECONCILIATION_ERROR`。
- 帳本事件 commit 後仍送 `UiBroadcaster`（標記 `persisted = true`，`DatabaseWriter` 略過），UI 能即時看到，但交易核心不等 UI。
- **替代方案**：全部事件走 queue、投影列也非同步 → 崩潰時可能遺失已成交的 Fill，違反 §36 優先級 1–3，否決。全部同步 → 市場資料量大時拖慢核心，否決。

### 5. Event Queue

- 記憶體內每個 consumer 一個 FIFO；`publish` 只做 push（O(1)）；flush 由 `clock.after(event_flush_interval_ms)` 排程。
- `DatabaseWriter` 批次寫入失敗：指數退避重試（100 ms 起、上限 5 s，經 Clock），期間事件保留在 buffer；`getStatus()` 回傳 `{ pending, overflow, lastFlushAt, lastError, consumerErrors, uiDropped }` 供 `runtime-health` 的 Database 狀態使用。
- overflow 時**不丟 DB 事件**（Traceability 優先），由 `runtime-health-reconciliation` 把 Database 標成 `DEGRADED` 並請求停止新進場；UI buffer 上限 1 000，滿了丟最舊並計數。
- 優雅關閉：`drain()` 同步 flush 所有 DB 事件後才關閉 DB。

### 6. Replay

- `replay()` 以 `seq` 排序（不以 `timestamp`，因不同交易所時鐘可能造成同毫秒 / 輕微逆序）；投影重建取每個實體最後一筆事件的 `payload.after`；建立型事件（`TRADE_CREATED`、`ORDER_CREATED`、`ORDER_FILL`/`ORDER_PARTIAL_FILL` 附 `payload.fill`、`CAPITAL_*` 附 `payload.snapshot`）提供初始列。
- 用途：Traceability 驗收（規格書 §31「所有 Trade 可以 replay」）、`runtime-health-reconciliation` 的重啟恢復與投影一致性檢查。

### 7. 檔案

```
runtime/src/storage/
├── driver.ts            SqliteDriver 介面 + NodeSqliteDriver
├── migrate.ts           migrate / rollback
├── migrations/001_initial.ts
├── backup.ts
├── rowMapping.ts        型別 ↔ 列
├── tradeRepository.ts   trades + trade_legs + risk_checks + opportunities
├── orderRepository.ts   orders + fills + positions + funding_settlements
├── accountRepository.ts account_snapshots + pnl_snapshots
├── marketDataRepository.ts
├── eventStore.ts        append / replay / rebuildProjections
└── ledger.ts            同步帳本交易
runtime/src/telemetry/eventQueue.ts
runtime/test/helpers/assertTraceability.ts
```

## Risks / Trade-offs

- [`node:sqlite` API 仍在演進] → 全部經 `SqliteDriver`；driver 契約測試保護；可切換 better-sqlite3。
- [Vitest 解析 `node:sqlite`] → task 1.1 spike 先驗證。
- [事件帶完整快照使 DB 變大] → Paper 量級可接受；日後以 migration 改差異格式。
- [同步寫入延遲] → WAL + prepared statements；若實測單筆 > 5 ms 再評估。
- [overflow 不丟事件可能耗盡記憶體] → overflow 立即觸發停止新進場，新事件來源（新 Trade）因此減少；上限與行為可設定。
- [備份檔無限增加] → 見 Open Questions。

## Migration Plan

- 全部新增檔案；`.gitignore` 加 `data/`、`package.json` 加 `engines`。在 `feature-trading-event-store` 開發，`--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`。Runtime 資料層 rollback：還原 `data/backup/<timestamp>.sqlite` 或執行 `rollback(db, version)`。

## Open Questions

1. **備份保留策略**：保留全部、保留最近 N 份、或依天數？本 change 保留全部。
2. **orders / fills 同步寫入**（Decision 4）超出技術書 §35 例外的字面範圍，是否同意回寫技術書 §35 註記？
3. **DB 路徑**：本 change 預設 `data/runtime.sqlite`（可由設定覆寫），是否同意？
4. **overflow 行為**：DB 事件不丟 + 停止新進場（Decision 5），是否同意？
