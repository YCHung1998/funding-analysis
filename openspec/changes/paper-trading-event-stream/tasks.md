> 前置：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-trading-ui` 已合併。
> 軟依賴 `paper-trading-read-api`（共用 `server/paperReadLayer.ts`；若尚未套用，task 2.1 直接在本
> change 內新增 `getEventsAfter`，design.md Decision 3 已說明無行為差異）。硬依賴
> `runtime-health-reconciliation` 的 `runtime_health` 表（僅 health 推送路徑需要；design.md Decision
> 5 Risk 已說明表不存在時 event 推送路徑不受影響，先寫測試證明這點）。分支
> `feature-paper-trading-event-stream`（來自 `develop`）。
> 每項先寫失敗測試再實作（fail-then-pass）；全部使用暫存 DB fixture 與可控輪詢時鐘（注入
> interval，不依賴真實 `setTimeout` 等待），不打任何真實 API；每項結束 lint / build / test 全綠。

## 1. 基礎設施

- [ ] 1.1 Spike：確認 Vite dev middleware 模式下 WebSocket upgrade 可直通或需顯式掛載（design.md Open
      Question 1）；記錄結論於本 task 的 Evidence，供後續 task 依循
- [ ] 1.2 `server/paperEventTailer.ts`：輪詢 `trading_events`（`seq > last_broadcast_seq`）與
      `runtime_health`（`updated_at` 變化）、`runtime_health` 表不存在時 event 路徑不受影響的測試

## 2. REST 補抓端點

- [ ] 2.1 `getEventsAfter(afterSeq, limit)` + `GET /api/paper/events?after_seq=&limit=`：無
      `next_cursor`、預設 `after_seq=0`、`limit=500`

## 3. WebSocket Gateway

- [ ] 3.1 `server/paperWsGateway.ts`：連線時送 `hello`（含當前最大 `seq`）、新事件轉發 `{type:'event'}`、
      health 變化轉發 `{type:'health'}`、忽略任何入站應用層訊息
- [ ] 3.2 Backpressure：每連線上限 1000 筆佇列、超過即關閉該連線且不影響其他連線；關閉後重連 + A-9
      補抓涵蓋所有遺漏事件的端對端測試

## 4. 收尾

- [ ] 4.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate paper-trading-event-stream --strict`
      全數通過並附輸出；以 fixture DB + 真實 `ws` 客戶端手動連線驗證 hello/event/health 三種訊息；更新
      HANDOFF §7 交接紀錄（註明 Open Question 1 的 spike 結論、`runtime_health` 依賴現況）
