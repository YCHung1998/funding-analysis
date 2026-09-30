> 前置：`setup-vitest`、`instrument-registry`、`paper-trading-event-loop`（`trading-clock`）皆已合併（design 跨 change 假設 B1、B2）。分支 `feature-websocket-data-layer`（來自 `develop`）。
> 每個狀態機 / 公式任務先寫失敗測試再實作（fail-then-pass）；測試一律使用 VirtualClock、假 WebSocket、假 REST 與錄製訊息 fixture，不連真實網路；每個任務結束時 `npm run lint`、`npm run build`、`npm test` 皆綠。

## 1. 基礎：型別、REST 防護、狀態回報

- [ ] 1.1 型別與契約：`MarketDataEvent`（雙時間戳、`timestamp_source`、`tier`）、`MarketDataAdapter` feed 描述、`SourceStatus`、事件類型；假 WebSocket / 假 REST 測試替身；擴充「`runtime/src/market/` 不得出現交易所名稱字面值與 `Date.now` / `setTimeout` / `setInterval`」自動檢查
- [ ] 1.2 `GuardedRestClient`（實作 `PublicRestClient`）：single-flight、錯誤分類（含信封錯誤、429 body 不當資料）、限流規則表與標頭用量、軟上限拉長輪詢、超限延後、斷路器（`OPEN` / `HALF_OPEN` / `CLOSED`、`Retry-After` 取大值）、暫時性錯誤退避；每個 spec Scenario 先寫失敗測試
- [ ] 1.3 `SourceStatus` 狀態轉換與 `SOURCE_STATUS_CHANGED` 事件、最後成功資料保留與超齡移除；`queryServerTime`（5 所端點、不做 single-flight、計入限流）與給 `trading-clock` 的 `ServerTimeSource` 轉接

## 2. 串流與行情狀態

- [ ] 2.1 `wsConnection` / `connectionPool`：狀態機與 `FEED_STATE_CHANGED` / `EXCHANGE_DISCONNECTED`、應用層心跳與閒置逾時、指數退避（可注入 jitter）與穩定後歸零、重連後重送訂閱並觸發回補、主題分片、先建後拆輪替
- [ ] 2.2 `marketState` + `freshness`：正規化寫入（缺欄位為 `null`、較新 `exchange_timestamp` 才覆寫）、`data_age_ms = exchangeNow(ex) − exchange_timestamp`、`receive_latency_ms`、兩層門檻、`STALE_MARKET_DATA` / `MARKET_DATA_RECOVERED`（每段只發一次，`INSTRUMENT` / `FEED` 範圍）；`fundingService` 轉交 `updateFundingSchedule`
- [ ] 2.3 `orderBookService`：`SNAPSHOT_STREAM` / `DELTA_STREAM`、`WARMING_UP`、序號缺口與交叉盤口 → `RESYNCING` + REST 快照 + `ORDER_BOOK_RESYNC`、重複增量忽略

## 3. 交易所 adapter

- [ ] 3.1 Binance：`!markPrice@arr` 解析、24h 量輪詢、入圍主題（bookTicker、depth）與 REST 深度快照、限流規則（權重標頭、418）、伺服器時間；以一次實際連線驗證 WS 路徑與 pong 行為並記錄結果（不支援時停下回報，design Open Question 2）
- [ ] 3.2 Bybit：批次 tickers `POLL`（含 `nextFundingTime`、`fundingIntervalHour`、`turnover24h`）、入圍 `tickers.{symbol}` 與 `orderbook.50.{symbol}`（`DELTA_STREAM` 序號轉換）、每 20 s ping、限流規則（403 冷卻 10 分鐘）
- [ ] 3.3 OKX、Bitget、Pionex 掃描用 `POLL` adapter（tickers + 資金費時程 + 24h 成交額 + mark price；OKX mark price 端點先查證，取不到為 `null`）、各自限流規則（Bitget 保守值並標未查證）、信封錯誤處理

## 4. 兩層協調與研究端過渡

- [ ] 4.1 `marketDataService`：全市場層依 `subscribableSymbols` 啟動並跟隨 `onChange`（含 `SHORTLIST_SUBSCRIPTION_DROPPED`）、啟動快照、每所獨立輪詢迴圈；`promote` / `release` / `releaseInstruments`（僅 `trading_exchanges`、參照計數、快照前 `WARMING_UP`）
- [ ] 4.2 `server.ts` 嵌入行情服務（`RealClock` 以 `queryServerTime` 校正）：live-scan 只讀記憶體狀態（以 `version` 記憶化）、`sources` / `data_as_of`、每次回應重算 `time_to_settlement_sec`、`?symbol=`、未就緒 503；移除 `instrument-registry` 過渡期的時程刷新迴圈與舊 REST 抓取段；更新 `src/services/liveMarketService.ts` 型別；測試：50 併發請求上游呼叫數 = 0、某所斷路器開啟時其餘照常

## 5. 收尾

- [ ] 5.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate websocket-data-layer --strict` 全數通過並附輸出；`npm run dev` 後實測：live-scan 配對數與各所 `sources`、連續 10 分鐘 Binance `X-MBX-USED-WEIGHT-1M` 峰值、拔網路 30 s 後自動恢復與 stale 事件；更新技術書 §6–§8 實作註記、HANDOFF §4.1 資料流、`assets/ARCHITECTURE.md`，最後新增 HANDOFF §7 交接紀錄
