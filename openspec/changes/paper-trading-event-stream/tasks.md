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

- [x] 2.1 `getEventsAfter(afterSeq, limit)` + `GET /api/paper/events?after_seq=&limit=`：無
      `next_cursor`、預設 `after_seq=0`、`limit=500`。證據：`server/paperReadLayer.ts`（`getEventsAfter`：
      `SELECT * FROM trading_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`，重用既有的
      `TradingEventRow`/`rowToTradingEvent`/`selectAll`，回傳 `{ items }`，無 `next_cursor` 欄位——與
      `contracts.ts` 的 `GlobalEventsResponse` 完全一致，design.md Decision 3 明文的「四個分頁形狀回應中
      唯一沒有 cursor 欄位的」；函式本體已隨 task 1.2 commit 寫出（`paperEventTailer.ts` 的輪詢直接重用
      同一個查詢，design.md Decision 3「重用，不重寫查詢」），本 task 新增的是其測試與 REST 路由本身）、
      `server/paperReadLayer.eventsAfter.test.ts`（5 tests：`after_seq=5` 時回傳 seq 6-10、`after_seq`
      等於目前最大 seq 時回傳空陣列、`after_seq=0` 等同抓全部（up to limit）、`limit` 確實截斷筆數、跨
      多個 trade 的事件全域混合回傳且仍照 seq 升冪（驗證「全域事件補抓，不是單一 trade」））。
      **`server.ts`**：新增 `GET /api/paper/events?after_seq=&limit=` 路由（沿用既有四條 Paper Trading
      路由同一套 `openPaperReadDb`/`PaperReadLayerUnavailableError → 503` 慣例；`after_seq` 預設 `0`、
      `limit` 預設 `500`，皆用 `Number.parseInt` + `Number.isFinite` 防呆，仿照既有 `scope=completed` 的
      `limit` 解析寫法）。未修改既有 9 條路由的行為，未新增路由層級的獨立測試（與既有四條 Paper Trading
      路由同例——路由本身是薄包裝，邏輯都在 `paperReadLayer.ts` 的函式測試裡，手動驗證見 task 4.1）。

## 3. WebSocket Gateway

- [x] 3.1 `server/paperWsGateway.ts`：連線時送 `hello`（含當前最大 `seq`）、新事件轉發 `{type:'event'}`、
      health 變化轉發 `{type:'health'}`、忽略任何入站應用層訊息。證據：`server/paperWsGateway.ts`
      （`PaperWsGateway`：`handleConnection(socket, helloLastSeq)` 送出 `hello` 並登記連線、
      `broadcastEvent(seq, event)`/`broadcastHealth(health)` 轉發給所有連線（`paperEventTailer` 的
      `onEvents`/`onHealth` 回呼接到這兩個方法，見下方 `server.ts` 段落）、`socket.on('message', () =>
      {})` 完全忽略任何入站訊息（不解析、不回應，符合 A-10「server 只轉發，不保證送達」且
      `usePaperEventStream.ts` 從不送出任何應用層訊息）、`GatewaySocket` 介面只要求
      `send`/`close`/`on('message'|'close')`，測試用假 socket 即可驅動、不需真實網路或計時器）、
      `server/paperWsGateway.test.ts`（見 3.2，同一測試檔涵蓋 hello/event/health 轉發、入站訊息忽略、
      連線關閉後從登記表移除，與 backpressure）。**`server.ts`**：新增 `ws` 的
      `WebSocketServer({ noServer: true })`、在 `app.listen()` 回傳的 http.Server 上掛 `'upgrade'`
      監聽器，路徑比對 `/ws/paper`（task 1.1 spike 已證實這與 Vite dev middleware 的 HMR WebSocket
      互不衝突，兩者是不同的 server 實例；非 `/ws/paper` 的 upgrade 一律 `socket.destroy()`）；連線時
      開一個唯讀連線算當前最大 seq 當 `hello` 的 `last_seq`（用完即關閉，沿用既有 per-request 慣例）；
      啟動 `PaperEventTailer` 的輪詢（`setInterval(() => paperEventTailer.pollOnce(),
      EVENT_TAIL_POLL_INTERVAL_MS)`，預設 250ms、可用環境變數覆寫，design.md Decision 1）、
      `onEvents`/`onHealth` 接到 `paperWsGateway.broadcastEvent`/`broadcastHealth`；啟動時以
      `getCurrentMaxSeq` 算 `initialLastSeq`，避免伺服器重啟時把歷史事件全部重播給所有連線（design.md
      Decision 2：WS 只轉發「連線當下之後」的新事件，補抓交給 A-9）。未修改既有 9 條路由或 2 個
      health/reconciliation 路由的行為。
- [x] 3.2 Backpressure：每連線上限 1000 筆佇列、超過即關閉該連線且不影響其他連線；關閉後重連 + A-9
      補抓涵蓋所有遺漏事件的端對端測試。證據：`server/paperWsGateway.ts`（`deliver()`：用 `pending`
      計數器追蹤「已 `send()` 但 flush callback 尚未觸發」的訊息數，`pending >= queueLimit`（預設
      1000，可經 `PaperWsGatewayOptions`/環境變數 `EVENT_STREAM_QUEUE_LIMIT` 注入）時關閉該連線（WS
      code 1008 "Policy Violation"）而不送這筆訊息，其他連線不受影響——`broadcast()` 對連線集合的
      **快照**逐一呼叫 `deliver`，一個連線在迴圈中途被關閉不影響對其餘連線繼續 `deliver`）、
      `server/paperWsGateway.test.ts`（7 tests：hello 送出正確 `last_seq`、event 轉發給所有連線、
      health 轉發給所有連線、入站訊息被忽略（送訊息後無任何回呼觸發、連線不受影響）、連線關閉後從
      登記表移除且後續 broadcast 不丟例外、**慢速消費者（`flushMode:'never'` 的假 socket，send
      callback 永不觸發 → `pending` 只增不減）在佇列滿後被關閉、`fast` 連線同時收到全部 3 筆
      broadcast 不受影響**（`queueLimit: 3` 加速測試）、**端對端：慢速連線在佇列滿後被強制斷線，之後
      用它最後一次「真正收到」的 seq 呼叫 `getEventsAfter`（重用 task 2.1 的函式，等同真實
      reconnect 時打 `GET /api/paper/events?after_seq=`）補抓，斷言補抓回來的 `seq` 清單恰好等於斷線
      期間全部遺漏的事件，一筆不漏、一筆不多**（fixture DB 真實寫入 5 筆事件，`queueLimit: 2`
      加速斷線時機））。
