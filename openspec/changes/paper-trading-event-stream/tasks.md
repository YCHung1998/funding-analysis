> 前置：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-trading-ui` 已合併。
> 軟依賴 `paper-trading-read-api`（共用 `server/paperReadLayer.ts`；若尚未套用，task 2.1 直接在本
> change 內新增 `getEventsAfter`，design.md Decision 3 已說明無行為差異）。硬依賴
> `runtime-health-reconciliation` 的 `runtime_health` 表（僅 health 推送路徑需要；design.md Decision
> 5 Risk 已說明表不存在時 event 推送路徑不受影響，先寫測試證明這點）。分支
> `feature-paper-trading-event-stream`（來自 `develop`）。
> 每項先寫失敗測試再實作（fail-then-pass）；全部使用暫存 DB fixture 與可控輪詢時鐘（注入
> interval，不依賴真實 `setTimeout` 等待），不打任何真實 API；每項結束 lint / build / test 全綠。

## 1. 基礎設施

- [x] 1.1 Spike：確認 Vite dev middleware 模式下 WebSocket upgrade 可直通或需顯式掛載（design.md Open
      Question 1）；記錄結論於本 task 的 Evidence，供後續 task 依循。**結論（Evidence）**：讀
      `node_modules/vite/dist/node/chunks/node.js`（`_createServer`/`createWebSocketServer`）原始碼確認：
      `middlewareMode: true` 時，`httpServer` 變數被設為 `null`（`const httpServer = middlewareMode ? null
      : await resolveHttpServer(...)`），因此傳給 `createWebSocketServer(httpServer, ...)` 的 `server` 參數
      為 `null`；`wsServer = wsCustomServer || (!wsPort || wsPort === config.server.port) && server` 的結果
      因 `server` 為假值而為假，走 `else` 分支——Vite 自己另外 `createServer(route)` 建立一個**完全獨立**的
      內部 HTTP server 來處理 HMR 的 WebSocket upgrade（預設 port 24678），完全不會對 `app.listen()` 建出
      的那個 http.Server 註冊 `'upgrade'` 監聽器。以實際腳本驗證（`express` + `createViteServer({ server: {
      middlewareMode: true } })` + 自行在 `httpServer.on('upgrade', ...)` 掛一個 `ws` 的
      `WebSocketServer({ noServer: true })`，連到 `/ws/paper`）：客戶端確實收到我們自己送出的訊息
      （`{"type":"hello","last_seq":0}`），證明 Vite 的 dev middleware **不會**攔截或處理掛在共用
      httpServer 上的 WebSocket upgrade——`server.ts` 必須（且可以安全地）自行在 `app.listen()` 回傳的
      http.Server 上掛 `'upgrade'` 監聽器來實作 `/ws/paper`，不會與 Vite HMR 衝突（兩者是不同的 server
      實例）。production 模式（無 Vite）本來就沒有這層疑慮。**附帶**：新增 `ws`/`@types/ws` 為正式依賴
      （`package.json`：`ws@^8.22.0`、`@types/ws@^8.18.2`，與 `package-lock.json` 既有的傳遞依賴版本一致）
      ——這是 task 3.1 WebSocket gateway 的必要套件，task 1.1 commit 一併加入。
- [x] 1.2 `server/paperEventTailer.ts`：輪詢 `trading_events`（`seq > last_broadcast_seq`）與
      `runtime_health`（`updated_at` 變化）、`runtime_health` 表不存在時 event 路徑不受影響的測試。證據：
      `server/paperEventTailer.ts`（`PaperEventTailer.pollOnce()`：每次 tick 用注入的 `openReader()` 開一個
      新連線（沿用 `openPaperDb` 的 per-tick 開關慣例，非長駐 handle）、`pollEvents` 重用
      `getEventsAfter`（task 2.1）查 `seq > lastSeq`、`pollHealth` 用 `readRuntimeHealthRow` +
      `buildHealthApiPayload`（重用 `runtime/src/health/healthPublisher.ts`，未重寫邏輯）；兩者各自包
      try/catch，`runtime_health` 表不存在時只有 health 半邊靜默跳過（`onError` 回呼可觀察到）、event
      半邊完全不受影響；DB 檔案不存在時 `pollOnce()` 整體 no-op，不丟例外；另附 `getCurrentMaxSeq(reader)`
      供 task 3.1 的 `hello` 之用）、`server/paperEventTailer.test.ts`（6 tests：事件依 `seq >
      last_broadcast_seq` 推播且正確推進 watermark（含「沒有新列不重複推播」與「只推播真正新增的那筆」）、
      health 在 `updated_at` 改變時恰好推播一次（含「未變化不重複」與「再次改變後再推播一次」）、
      **`runtime_health` 表不存在時 event 路徑不受影響**（只 migration001，無 003；斷言 `received` 正常
      收到事件、`healthCalled` 為 false、`onError` 收到 `{scope:'health'}`、且 `pollOnce()` 不丟例外）、
      DB 檔案不存在時 `pollOnce()` 不丟例外且兩個回呼都不被呼叫、`getCurrentMaxSeq` 空表回 0 與正確回傳目前
      最大 seq）。本次新增 `getEventsAfter` 到既有 `server/paperReadLayer.ts`（見 task 2.1 commit 一併說明
      ——因 2.1 的 REST 端點與 1.2 的輪詢共用同一個查詢/列對映，先在 1.2 寫測試驅動出 `getEventsAfter` 的
      介面，2.1 commit 補齊 REST 路由本身）。

## 2. REST 補抓端點

- [ ] 2.1 `getEventsAfter(afterSeq, limit)` + `GET /api/paper/events?after_seq=&limit=`：無
      `next_cursor`、預設 `after_seq=0`、`limit=500`

## 3. WebSocket Gateway

- [ ] 3.1 `server/paperWsGateway.ts`：連線時送 `hello`（含當前最大 `seq`）、新事件轉發 `{type:'event'}`、
      health 變化轉發 `{type:'health'}`、忽略任何入站應用層訊息
- [ ] 3.2 Backpressure：每連線上限 1000 筆佇列、超過即關閉該連線且不影響其他連線；關閉後重連 + A-9
      補抓涵蓋所有遺漏事件的端對端測試
