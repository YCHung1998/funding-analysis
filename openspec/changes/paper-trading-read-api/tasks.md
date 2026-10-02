> 前置：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-execution-engine`、
> `paper-trading-event-loop` 已完成；`paper-trading-ui` 已合併（`contracts.ts` 為回應形狀的 ground
> truth，實作前重讀一次，design.md Risk 已提醒可能已再變動）。分支 `feature-paper-trading-read-api`
> （來自 `develop`）。不依賴 `runtime-health-reconciliation`（讀取不同的表）。
> 每項先寫失敗測試再實作（fail-then-pass）；全部使用暫存 DB fixture（`trading-event-store` 的
> migration + repository 直接寫入測試資料），不打任何真實 API；每項結束 lint / build / test 全綠。

## 1. 讀取層

- [x] 1.1 `server/paperReadLayer.ts`：`new DatabaseSync(dbPath, { readOnly: true })`、`getAccountSnapshot()`；DB / 表不存在時統一 503（契約測試：readOnly 連線執行 INSERT 會失敗）。證據：`server/paperReadLayer.ts`（`openPaperDb`/`PaperReadLayerUnavailableError`/`getAccountSnapshot`：latest-by-`created_at`，無列或 DB 不存在皆拋 `PaperReadLayerUnavailableError`）、`server/paperReadLayer.test.ts`（5 tests：DB 不存在回 `undefined`、readOnly 連線 INSERT 確實拋錯（契約測試）、三列取 `created_at` 最大者、無列時拋錯、DB 不存在時 `getAccountSnapshot` 拋錯）、`server/test/paperDbFixture.ts`（溫層 fixture：temp-dir SQLite + 001-004 migrations + 真實 repository 寫入）。**實作筆記（genuine schema gap）**：`runtime/src/types/result.ts` 的 `TradeResult` 從未有對應資料表（`accounting/tradeResultAssembler.ts` 只在記憶體組裝；`assets/HANDOFF.md` 的 `position-funding-pnl` 條目明確把「何時寫入 DB」留給尚不存在的 Runtime 主迴圈）——design.md Migration Plan「no schema migration」的假設已過期（A-6/A-7 完全依賴這張表）。新增 `runtime/src/storage/migrations/004_trade_results.ts`（additive、reversible，欄位與 `TradeResult` 1:1，沿用 001-003 慣例）+ `004_trade_results.test.ts`（4 tests）解決；已記錄於 design.md Implementation Notes。
- [x] 1.2 `server/paperCursor.ts`：`encodeCursor` / `decodeCursor`（base64url JSON），格式錯誤回傳 `null`（由呼叫端轉 400）；round-trip 測試。證據：`server/paperCursor.ts`、`server/paperCursor.test.ts`（6 tests：複合鍵 round-trip、單欄位鍵 round-trip、輸出不含 `+`/`/`/`=`、格式錯誤字串回 `null`、合法 base64url 但非 JSON 回 `null`、空字串回 `null`）。

## 2. Trades 端點

- [ ] 2.1 `getCurrentTrades()` + `GET /api/paper/trades?scope=current`：警示狀態優先排序（`LEG_IMBALANCE`/`EMERGENCY_EXIT`/`FAILED` 先）、群內 `created_at` 新到舊
- [ ] 2.2 `getCompletedTrades(filter, cursor, limit)` + `GET /api/paper/trades?scope=completed`：keyset 分頁（`finalized_at ?? updated_at` desc + `trade_id` tie-break）、`final_status` 篩選、並發插入下分頁穩定性測試、格式錯誤 cursor → 400
- [ ] 2.3 `getTradeDetail(tradeId)` + `GET /api/paper/trades/:trade_id`：open trade 無 `result`、closed trade 含 `result`、未知 id → 404

## 3. 事件端點

- [ ] 3.1 `getTradeEvents(tradeId, cursor, limit)` + `GET /api/paper/trades/:trade_id/events`：`seq` 升冪、keyset 分頁（重用 `paperCursor.ts`）、未知 trade_id → 404

## 4. 收尾

- [ ] 4.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate paper-trading-read-api --strict` 全數通過並附輸出；實際啟動並以 fixture DB 打四個端點記錄回應；更新 HANDOFF §7 交接紀錄（註明 A-5 已改採真實 `AccountSnapshot` 形狀，非 design.md 原始 A-5 文字）
