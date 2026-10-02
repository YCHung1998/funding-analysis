> 前置：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-execution-engine`、
> `paper-trading-event-loop` 已完成；`paper-trading-ui` 已合併（`contracts.ts` 為回應形狀的 ground
> truth，實作前重讀一次，design.md Risk 已提醒可能已再變動）。分支 `feature-paper-trading-read-api`
> （來自 `develop`）。不依賴 `runtime-health-reconciliation`（讀取不同的表）。
> 每項先寫失敗測試再實作（fail-then-pass）；全部使用暫存 DB fixture（`trading-event-store` 的
> migration + repository 直接寫入測試資料），不打任何真實 API；每項結束 lint / build / test 全綠。

## 1. 讀取層

- [ ] 1.1 `server/paperReadLayer.ts`：`new DatabaseSync(dbPath, { readOnly: true })`、`getAccountSnapshot()`；DB / 表不存在時統一 503（契約測試：readOnly 連線執行 INSERT 會失敗）
- [ ] 1.2 `server/paperCursor.ts`：`encodeCursor` / `decodeCursor`（base64url JSON），格式錯誤回傳 `null`（由呼叫端轉 400）；round-trip 測試

## 2. Trades 端點

- [ ] 2.1 `getCurrentTrades()` + `GET /api/paper/trades?scope=current`：警示狀態優先排序（`LEG_IMBALANCE`/`EMERGENCY_EXIT`/`FAILED` 先）、群內 `created_at` 新到舊
- [ ] 2.2 `getCompletedTrades(filter, cursor, limit)` + `GET /api/paper/trades?scope=completed`：keyset 分頁（`finalized_at ?? updated_at` desc + `trade_id` tie-break）、`final_status` 篩選、並發插入下分頁穩定性測試、格式錯誤 cursor → 400
- [ ] 2.3 `getTradeDetail(tradeId)` + `GET /api/paper/trades/:trade_id`：open trade 無 `result`、closed trade 含 `result`、未知 id → 404

## 3. 事件端點

- [ ] 3.1 `getTradeEvents(tradeId, cursor, limit)` + `GET /api/paper/trades/:trade_id/events`：`seq` 升冪、keyset 分頁（重用 `paperCursor.ts`）、未知 trade_id → 404

## 4. 收尾

- [ ] 4.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate paper-trading-read-api --strict` 全數通過並附輸出；實際啟動並以 fixture DB 打四個端點記錄回應；更新 HANDOFF §7 交接紀錄（註明 A-5 已改採真實 `AccountSnapshot` 形狀，非 design.md 原始 A-5 文字）
