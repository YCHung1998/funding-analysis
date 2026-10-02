> 前置：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-execution-engine`、`paper-trading-event-loop` 已完成；`market-data-stream`、`risk-engine`、`position-accounting` 狀態以 fake 替代。分支 `feature-runtime-health-reconciliation`（來自 `develop`）。
> 每項先寫失敗測試再實作（fail-then-pass）；全部使用 `VirtualClock`、暫存 DB，不打任何 API；每項結束 lint / build / test 全綠。

## 1. 儲存

- [x] 1.1 `003_runtime_health`（`runtime_health`、`reconciliation_runs`，可逆）＋ round-trip 測試 — 檔名/version 由 `002` 改為 `003`（`002_position_accounting_fields` 已佔用；`migrate.ts` 純以 `Migration.version` 排序，與檔名無關，見 design.md Implementation Notes）。證據：`runtime/src/storage/migrations/003_runtime_health.ts`、`runtime/src/storage/migrations/003_runtime_health.test.ts`（6 tests：建表、`runtime_health` 單列 upsert、單列 CHECK 約束拒絕第二個 id、`reconciliation_runs` 多列、up→down→up round trip 與 001/002 不受影響、完整 rollback 清空）。

## 2. 對帳

- [ ] 2.1 `checks.ts` Order / Fill / Position / Trade / Projection 檢查（技術書 §31 的 1000 vs 900 例子先寫失敗測試）
- [ ] 2.2 Capital 檢查與資金保留原子性測試（連續超額保留、保留中途故障回滾、事件配對）
- [ ] 2.3 `reconciler.ts` + `entryHalt.ts`：Clock 排程、一致快照、`reconciliation_runs`、`RECONCILIATION_ERROR`、Trade → FAILED、`EntryHaltLatch`（重啟後仍生效、只能以 `ENTRY_HALT_CLEARED` 解除）、去重、不撤單不平倉

## 3. Runtime Health

- [ ] 3.1 `healthModel.ts`：元件狀態、推導規則、`entry_allowed` 與 `entry_block_reasons`（stale、halt、scan-only 所斷線不影響）
- [ ] 3.2 `healthPublisher.ts` + `server.ts` 唯讀 `GET /api/paper/health`（2026-10-03 由 `/api/runtime/health` 改名，配合已合併的 `paper-trading-ui` 前端路徑，見 proposal.md）、`GET /api/runtime/reconciliation/latest`：失聯回 `UNREACHABLE`、server 寫入失敗、回應不含憑證

## 4. 啟動與恢復

- [ ] 4.1 `main.ts` 12 步啟動流程與 `RUNTIME_STARTUP_STEP` / `RUNTIME_ARMED` / `RUNTIME_DISARMED`；致命 / 降級 / 提示三種失敗模式（含 Withdraw 權限拒絕啟動、缺憑證公開模式）；`package.json` 加 `runtime` script
- [ ] 4.2 `recovery.ts` 重啟恢復：投影比對、未終態訂單以合法轉換關閉、進場中 Trade → FAILED + 停止進場、HEDGED / EXIT_PENDING 交給 session
- [ ] 4.3 Scenario：重啟於進場中 / 持倉中、對帳錯誤停止進場、S10 交易所斷線反映在 Health、`server.ts` 重啟不影響 Runtime；每個結尾 `assertTraceability`

## 5. 收尾

- [ ] 5.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate runtime-health-reconciliation --strict` 全數通過並附輸出；實際啟動 `npm run runtime` 與 `npm run dev` 後打 `/api/paper/health` 記錄結果；更新 HANDOFF §7 交接紀錄
