## Why

技術書 §31 要求 Paper Engine 定期自我驗證 Orders vs Fills vs Positions vs Capital，不一致時產生 `RECONCILIATION_ERROR` 並停止新進場，「而不是默默繼續交易」；§12 要求資金保留是原子操作；§32 要求 Dashboard 顯示 Runtime Health；§39 定義啟動流程；✅ C-06 要求 Runtime 是獨立 process、瀏覽器與 `server.ts` 重啟不影響交易（技術書 §48.4）。沒有這些，Runtime 崩潰或資料錯亂時無法被發現或安全恢復。

分支：`feature-runtime-health-reconciliation`（來自 `develop`）。

## What Changes

- 定期對帳（Clock 排程，預設每 5 000 ms，且於啟動、ARM 前各一次）：Order ↔ Fill、Order 狀態 ↔ 成交量、Leg 部位 ↔ Fill 淨量、Trade 狀態 ↔ 部位、Capital 保留 ↔ 未結束 Trade、投影狀態 ↔ 最後事件。
- 不一致 → `RECONCILIATION_ERROR` 事件（去重）、相關 Trade → `FAILED`（reason `RECONCILIATION_ERROR`）、經 `EntryHaltPort` 請求停止新進場。
- Capital Reservation 原子性檢查（技術書 §12）：超額保留被拒、中途失敗全數回滾、每筆 Trade 都有對應 `CAPITAL_RESERVED`，終態 Trade 都有 `CAPITAL_RELEASED`。
- Runtime Health 模型（技術書 §32、§52）：Engine、各交易所連線、Market Data、Scanner、Risk、Paper Execution、Database、Clock、Credentials、Last Event，加上 `entry_allowed` 與阻擋原因。
- Health 發佈：Runtime 定期寫入 SQLite `runtime_health`；`server.ts` 以**唯讀**連線提供 `GET /api/paper/health`（2026-10-03 修正：原規劃 `/api/runtime/health`，與 `paper-trading-ui/design.md` 契約表 A-4 及已合併的 `paperApi.ts` 不一致，改為配合既有前端路徑；`paper-trading-ui` 零異動）、`GET /api/runtime/reconciliation/latest`（內部/維運用，非 UI 契約，維持原命名）；Runtime 失聯時回 `ENGINE: UNREACHABLE`。
- Runtime 啟動流程（技術書 §39）與重啟後從 Event Store 恢復狀態（未完成訂單、進場中 Trade、持倉中 Trade、帳本）。

## Non-goals

- 不實作 Kill Switch 本體（C-16 已決議三層分級，實作屬 `risk-engine-kill-switch` group 4）；本 change 只提供「對帳失敗時請求停止新進場」的 `EntryHaltPort` 與暫用的最小 latch，**不**撤單、**不**自動平倉。
- 不實作前端畫面（屬 `paper-trading-ui`）、不提供任何控制類 POST 端點。
- 不實作 `GET /api/paper/events`（A-9 全域事件補抓）、`WebSocket /ws/paper`（A-10）；2026-10-03 確認：`paper-trading-ui/design.md` 原本假設這兩項由本 change 提供，但本 change 的 Decision 3 明確否決了開 HTTP/WebSocket 給 server 的替代方案，兩份文件互相矛盾、事件串流實際上沒有任何 change 認領——已決定改由負責 `/api/paper/account`、`/trades`、`/trades/:id`、`/trades/:id/events` 的新 change（trade-data 讀取 API，尚待 propose）一併提供，理由：新 change 本來就要處理 EventStore 讀取與分頁慣例，順路做掉比回頭重開本 change 的 Decision 3 便宜。
- 不實作市場資料連線、Scanner、Risk Engine 本身（只讀它們的狀態）。
- 不定義場次排程恢復（屬 `settlement-session`）；本 change 只把恢復的 Trade 交給它。
- 不新增任何真實下單端點（Invariant #1）；不在任何 API / 事件中輸出憑證（Invariant #2）。

## Capabilities

### New Capabilities

- `reconciliation`: 對帳檢查項、排程、不一致處理（事件、Trade FAILED、停止新進場請求、去重）、資金保留原子性檢查、`reconciliation_runs` 紀錄。
- `runtime-health`: Health 元件狀態模型與推導規則、SQLite 發佈與 `server.ts` 唯讀 API、啟動流程（§39）、重啟恢復。

### Modified Capabilities

（無）

## Impact

- **新增程式**：`runtime/src/reconciliation/`、`runtime/src/health/`、`runtime/src/main.ts`（啟動流程）、`runtime/src/storage/migrations/002_runtime_health.ts`（可逆）。
- **修改程式**：`server.ts` 新增兩個唯讀 GET 路由（以 `node:sqlite` `readOnly` 開啟 DB），不改既有路由。
- **設定**：`package.json` 新增 `runtime` script（`tsx runtime/src/main.ts`）；`PaperTradingConfig` 新增 `reconciliation_interval_ms`、`health_publish_interval_ms`、`reconciliation_qty_epsilon`、`reconciliation_usdt_epsilon`。
- **依賴**：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-execution-engine`、`paper-trading-event-loop`（`Clock` 健康、`settlement-session`）；讀取 `position-accounting`（positions）、`market-data-stream`（連線 / 資料年齡）、`risk-engine`（Risk 狀態）的狀態介面；`kill-switch`（`risk-engine-kill-switch` group 4，C-16 已決議）日後實作 `EntryHaltPort`。
- **對應**：規格書 §12、§26.2（FAILED）、§31 Failure / Traceability、§33；技術書 §3、§12、§31、§32、§35、§39、§48.3、§48.4、§52；✅ C-06、C-08、C-16；Invariant #1、#2。
