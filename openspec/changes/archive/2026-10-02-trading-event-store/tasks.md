> 前置：`setup-vitest`、`trading-schema-types` 已完成；`paper-trading-event-loop` 的 `Clock` / `VirtualClock`（task 2.2）已可用。分支 `feature-trading-event-store`（來自 `develop`）。
> 每項先寫失敗測試再實作（fail-then-pass）；所有測試使用記憶體或暫存目錄 DB 與 `VirtualClock`；每項結束 lint / build / test 全綠。

## 1. 基礎

- [x] 1.1 Spike + `SqliteDriver`：`NodeSqliteDriver`（WAL、foreign_keys、`transaction` 回滾 / 拒絕 async、`backupTo`）與 driver 契約測試，確認 Vitest 可載入 `node:sqlite`；`package.json` 加 `engines.node >=22.13`、`.gitignore` 加 `data/`
- [x] 1.2 Migration 框架（`migrate` / `rollback`、`schema_migrations`、每檔一 transaction）＋ round-trip 與失敗回復測試
- [x] 1.3 啟動前備份（檔名格式、integrity_check、失敗拒絕啟動、新安裝不備份、同毫秒後綴）

## 2. 資料表與 Repository

- [x] 2.1 `001_initial`：技術書 §29 全部資料表、§30 外鍵、索引、`trading_events` append-only 觸發器；外鍵與 NOT NULL 測試
- [x] 2.2 `rowMapping` + repositories：全部實體無損往返（含巢狀 legs、JSON 欄位、可選欄位、布林）；無 delete 方法的檢查測試

## 3. Event Store

- [x] 3.1 `EventStore.append`：validator + `assertNoCredentials`、`seq`、`recorded_at` 由 Clock 產生、更新 / 刪除被觸發器拒絕
- [x] 3.2 `replay` 與 `rebuildProjections`：以技術書 §43 完整成功交易、§44 未成交交易的事件序列驗證重建列與原列相等

## 4. 寫入架構

- [x] 4.1 `EventQueue`：非阻塞 publish、consumer 隔離、批次 flush（Clock 排程）、重試退避、overflow 不丟 DB 事件、UI 丟最舊計數、`getStatus()`、`drain()`
- [x] 4.2 `Ledger` 同步交易：`reserveCapitalAndCreateTrade`、`releaseCapital`、`applyOrderTransition`、`applyFill`；`INSUFFICIENT_CAPITAL`、中途失敗全數回滾、帳本事件只送 UI 不重寫
- [x] 4.3 `assertTraceability` 測試輔助（缺時間戳、狀態與最後事件不符、缺事件、事件時間逆序）＋ 正反例測試

## 5. 收尾

- [x] 5.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate trading-event-store --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄
