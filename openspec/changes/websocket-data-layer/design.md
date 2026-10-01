## Context

- **現況**：`server.ts:57-117` 在每個 cache miss 的請求路徑上以 `Promise.all` 同步打 7 個全市場 REST 端點，快取 5 s、無 single-flight（BE-01）、`.catch(() => [])` 吞錯並快取殘缺結果（BE-02）、不讀限流標頭（BE-03，實測觸發 Binance / OKX / Bitget 429）、倒數在快取中凍結且新鮮度只有秒級（BE-04）、最慢上游閘住回應且 keep-alive 4 s < TTL 5 s（BE-05）、整包 686 KB 回傳（BE-08），前端每 10 s 下載整包只取 1 筆（FE-02）、掃描頁為一次性快照（FE-03）。
- **已決議**：C-05（部分）資料層為 WebSocket 事件驅動；C-09 開工順序第 4 項；`paper-trading-event-loop` 的 **D-5 兩層資料取得**（design Decision 7）：全市場層（WATCH）= Binance 全市場推播、Bybit 批次 REST 每 N 秒、Pionex / Bitget / OKX 低頻 REST；入圍層（SHORTLIST → CONFIRM）= 只對入圍幣種訂閱逐筆 ticker 與盤口深度。理由：公開 API 無使用費，主要成本是限流 / IP 封鎖、頻寬（Binance 全市場約 3–7 GB/天）、CPU（Bybit 全訂閱約 7,000 則/秒）與維護。
- **既有介面**：`trading-clock`（`Clock.now / exchangeNow / toLocal / offset / at / after / cancel`、`RealClock` 每所 offset、`data_age_ms = local_received − toLocal(ex, exchange_timestamp)`、`runtime/src/` 禁用 `Date.now` / `setTimeout`）；`settlement-session`（階段 `WATCH → SHORTLIST → ARM → ENTRY → LOCK → CONFIRM → DONE / SKIPPED`）；`opportunity-lifecycle`（`STALE_MARKET_DATA` 否決原因）；`instrument-registry`（`subscribableSymbols`、`onChange`、`updateFundingSchedule`、`PublicRestClient` / `UpstreamError`）。本 change 使用它們，不重新定義。
- **限制**：Invariant #1–#5；規格書 §25（雙時間戳、每次狀態轉換一筆 TradingEvent）；`main` 必須隨時可運作；不得 `npm install` 新依賴除非使用者同意（本 design 以不新增依賴為前提）。

## Goals / Non-Goals

**Goals:**

- 以 D-5 兩層策略取得 5 所行情，請求路徑與上游抓取完全脫鉤。
- 每所的失敗、限流、資料年齡都明確可見，絕不以空資料冒充成功。
- 提供 Paper Runtime 所需的新鮮度判斷（`STALE_MARKET_DATA`）與入圍合約的逐筆盤口。
- 提供 `trading-clock` 校正所需的伺服器時間樣本。
- 研究端 live-scan 立即受益（BE-01～BE-05 的伺服器端問題）。

**Non-Goals:**

- 時鐘偏差計算、場次排程、Risk 阻擋、滑價模型、前端改版、HTTP 壓縮、行情持久化（見 proposal Non-goals）。

## Decisions

### 1. 模組配置與依賴方向

```
runtime/src/
├── adapters/<exchange>/marketData.ts   ← feed 描述、訊息解析、限流規則表、心跳規格、伺服器時間端點（交易所差異只在這裡）
└── market/
    ├── marketDataService.ts            ← 兩層協調：全市場層 feed、promote / release 參照計數、註冊表 onChange
    ├── orderBookService.ts             ← SNAPSHOT_STREAM / DELTA_STREAM、序號完整性、RESYNCING
    ├── fundingService.ts               ← 把時程轉交 instrument-registry.updateFundingSchedule
    ├── stream/wsConnection.ts          ← 單條連線狀態機、心跳、閒置偵測、退避重連
    ├── stream/connectionPool.ts        ← 主題分片、先建後拆輪替
    ├── state/marketState.ts            ← 最新值表（instrument_id → MarketDataEvent）、最後成功資料
    ├── state/freshness.ts              ← data_age_ms、門檻、STALE / RECOVERED 轉換
    ├── http/guardedRestClient.ts       ← PublicRestClient 實作：single-flight、限流、斷路器、退避
    ├── http/rateLimiter.ts
    ├── sourceStatus.ts
    └── serverTime.ts                   ← queryServerTime（給 trading-clock）
```

- 對應技術書 §4 的 `market/marketDataService`、`orderBookService`、`fundingService`。
- 依賴方向：`market/` → `adapters/`（描述與解析）、`market/instruments`（註冊表）、`trading-clock`（Clock）、`EventSink`。策略 / 引擎層只讀 `marketDataService` 的查詢 API。
- **替代方案**：把行情層放在 `server.ts` → Runtime 無法重用，且 C-06 規定 Runtime 是獨立 process；否決。

### 2. Adapter feed 描述（引擎無交易所分支）

```typescript
interface MarketDataAdapter {
  exchange: ExchangeId;
  fullMarket: Array<StreamFeedSpec | PollFeedSpec>;      // 全市場層，可多個（例：Binance 串流 + 24h 量輪詢）
  shortlist?: { topicsFor(native_symbol: string): string[]; book: { mode: 'SNAPSHOT_STREAM' | 'DELTA_STREAM'; depth: number } };
  ws?: {
    url: string;
    heartbeat: { client_ping_interval_ms?: number; ping_payload?: string; idle_timeout_ms: number };
    max_topics_per_connection?: number;
    max_connection_lifetime_ms?: number;
    buildSubscribe(topics: string[]): string; buildUnsubscribe(topics: string[]): string;
    parse(raw: string, local_received: number): ParsedMessage[];   // ticker / book snapshot / book delta / ack / pong
  };
  rest: {
    envelopeError(body: unknown): string | null;                   // OKX code、Bybit retCode、Bitget code
    snapshotOrderBook(native_symbol: string, depth: number): RestRequest;
  };
  rateLimits: RateLimitRule[];
  serverTime: { request: RestRequest; parse(body: unknown): number };
}
```

- `shortlist` 只有 `trading_exchanges` 的 adapter 需要實作（目前 Binance、Bybit；OKX 未來加入時補上，引擎不改）。

### 3. 各所預設 feed（D-5 落地）

| 交易所 | 全市場層 | 入圍層（ticker + 盤口） | 心跳 / 連線 | 依據 / 查證 |
|--------|---------|------------------------|------------|------------|
| Binance | `STREAM` `!markPrice@arr`（`s`、`E`、`p` mark、`i` index、`r` 費率、`T` 下次結算）；`POLL` `GET /fapi/v1/ticker/24hr` 每 60 s（`quoteVolume`，權重 40 → 約 40/分，預算 1.7%） | `<symbol>@bookTicker` + `<symbol>@depth20@100ms`（`SNAPSHOT_STREAM`）；REST `GET /fapi/v1/depth` 備援 | 伺服器 ping frame、客戶端需回 pong；連線壽命 24 h（先建後拆輪替）；單連線主題上限 | BE-04 實測：`wss://fstream.binance.com/market/ws/!markPrice@arr` 每 0.4–2.4 s 一則、744 symbol / 約 81 KB；舊路徑 `/ws/` 在實測中 0 則訊息，原因未查證 → URL 由設定提供、實作時以官方文件為準。bookTicker / depth 主題名稱、24 h 壽命、單連線上限、ping/pong 規則：未查證 |
| Bybit | `POLL` `GET /v5/market/tickers?category=linear` 每 10 s（一次取得 bid1 / ask1 / mark / index / `fundingRate` / `nextFundingTime` / `fundingIntervalHour` / `turnover24h`；gzip 約 170 KB） | `tickers.{symbol}`（100 ms）+ `orderbook.50.{symbol}`（`DELTA_STREAM`，快照 + 增量） | 客戶端每 20 s `{"op":"ping"}`（官方：「we recommend that you send the ping heartbeat packet every 20 seconds」，BE-04） | 100 ms 推播為官方引述 + 實測（BE-04）；orderbook 深度檔位與序號欄位語意、單次訂閱參數上限：未查證 |
| OKX | `POLL` 每 30 s：`GET /api/v5/market/tickers?instType=SWAP`（bid / ask / last / `volCcy24h`）+ `GET /api/v5/public/funding-rate?instId=ANY`（`fundingRate`、`fundingTime`、`nextFundingTime`）+ mark price 端點 | —（未來加入 trading_exchanges 時補） | — | funding-rate 限流 10 次 / 2 s（IP + instId）、tickers 20 次 / 2 s（BE-03 官方引述）；funding-rate 推播本身 30–90 s 一次（BE-04）。mark price 端點 `GET /api/v5/public/mark-price?instType=SWAP`：未查證（研究原型目前以 `last` 代替 mark，本 change 改為取 mark，取不到則 `mark_price = null`） |
| Bitget | `POLL` 每 30 s：`GET /api/v2/mix/market/tickers?productType=USDT-FUTURES`（`markPrice`、`bidPr`、`askPr`、`fundingRate`、`usdtVolume`、`ts`）+ `GET /api/v2/mix/market/current-fund-rate`（`nextUpdate`、`fundingRateInterval`） | — | — | current-fund-rate 欄位為 Q-02 實測；Bitget 限流數值：未查證（規則表先採保守的每秒 10 次並標示未查證） |
| Pionex | `POLL` 每 30 s：`GET /api/v1/market/indexes`（`nextFundingRate`、`markPrice`、`nextFundingTime`）+ `GET /api/v1/market/tickers?type=PERP`（`amount` 24h 成交額） | — | — | 所有端點共用每秒 10 次、429 封鎖 60 s（BE-03 官方引述）；tickers?type=PERP 為 2026-09-30 實測 |

- 取代 `instrument-registry` 過渡期在 `server.ts` 的資金費時程刷新迴圈：上表的全市場層資料已包含各所下次結算時間，由 `fundingService` 轉交註冊表。Binance `fundingInfo`（週期）維持在註冊表的 metadata 刷新中。
- 全部間隔可設定；Bybit 10 s 的取捨見 Open Questions。

### 4. 兩層協調（`marketDataService`）

```
instrument-registry ──subscribableSymbols / onChange──▶ 全市場層 feed（每所 STREAM 或 POLL）
                                                            │
settlement-session ──SHORTLIST: promote(S, ids)──────────▶ 入圍層：ticker + depth 訂閱（參照計數）
                   ──DONE / SKIPPED: release(S)──────────▶ 取消訂閱（計數歸零時）
                                                            ▼
                                             marketState（最新值 + 最後成功資料）
                                                            │
                          getTicker / getOrderBook / getFreshness / sourceStatus / onEvent
```

- 入圍層的觸發來源是 `settlement-session` 的階段事件（SHORTLIST 開始 → `promote`；DONE / SKIPPED → `release`）。場次在 ARM 放棄某合約時可呼叫 `release` 的子集版本 `releaseInstruments(S, ids)`。
- 全市場層在整個 Runtime 生命週期都存在（研究掃描與場次 WATCH 共用）；入圍層只在場次存在期間存在。
- 研究端 `server.ts` 沒有場次，不使用入圍層。

### 5. 新鮮度：以各所自己的時鐘量測

- 查詢時點：`data_age_ms = clock.exchangeNow(ex) − exchange_timestamp`。收到當下與 `trading-clock` 的 `local_received − toLocal(ex, exchange_timestamp)` 相等（`toLocal` 為 `exchangeNow` 的反函數），因此本 change 沿用其定義、不另立公式；另把收到當下的值存為 `receive_latency_ms` 以供延遲統計。
- 為什麼不用「本地收到後經過多久」：斷線時本地時間持續前進，兩種算法都會變大；但以交易所時間量測可以同時涵蓋「交易所端延遲推送」與「本機時鐘偏差」（BE-07 實測本機慢 57–62 ms，技術書 §8 註記）。
- 門檻：入圍層用 `data_stale_threshold_ms`（技術書 §38 既有設定）；全市場層用 `watch_stale_threshold_ms`（預設輪詢間隔 × 3，串流 10 s）。`timestamp_source = 'LOCAL'` 的資料在入圍層一律視為 stale（無法量測就不能拿來交易）。
- 新鮮度檢查以 `Clock.after` 每 500 ms 排程；只在狀態改變時發事件。

### 6. WebSocket 傳輸：Node 內建 `WebSocket`

- repo 實際執行環境為 Node v26（`node --version`），內建 WHATWG `WebSocket` 客戶端，**不需新增 `ws` 依賴**。
- 限制：WHATWG API 無法主動送 protocol-level ping frame；Bybit / OKX 使用應用層 ping（JSON / 文字），不受影響；Binance 由伺服器送 ping frame、客戶端須回 pong——Node 內建實作是否自動回 pong：**未查證**，實作第一個 Binance 任務時以實際連線驗證，若不支援則回報使用者決定是否加入 `ws` 依賴（Open Question 2）。
- 以介面 `WebSocketFactory` 注入，測試使用假 WebSocket（可控制開啟、訊息、關閉、錯誤），不連真實網路。

### 7. REST：`GuardedRestClient` 的組成

```
request ─▶ circuit breaker（OPEN → 立即 RATE_LIMITED）
        ─▶ single-flight（key = exchange + url；serverTime 例外）
        ─▶ rate limiter（規則表 + 標頭用量；超過上限 → 延後到視窗重置）
        ─▶ fetch（timeout）─▶ 分類：2xx+信封 OK / HTTP / TIMEOUT / NETWORK / PARSE / API_ERROR / RATE_LIMITED
        ─▶ 更新 SourceStatus、限流用量、斷路器；非 2xx 記結構化 log
```

- single-flight 以 `Map<key, Promise>` 在 `finally` 清除（BE-01 解方 1，Go `singleflight` 語意）。
- 限流規則表（官方數值見 BE-03）：Binance 2400 權重 / 分（標頭 `X-MBX-USED-WEIGHT-1M`；429 後持續請求會被 418 封鎖）；Bybit 600 次 / 5 s / IP（403 → 至少 10 分鐘）；OKX tickers 20 次 / 2 s、funding-rate 10 次 / 2 s；Pionex 全端點每秒 10 次（429 → 封 60 s）；Bitget 未查證（保守值）。
- 預算軟上限 0.7：輪詢間隔加倍直到 < 0.5（遲滯，避免抖動）。
- 暫時性錯誤退避與重連退避共用同一個 `Backoff` 工具（可注入亂數，測試固定 jitter）。
- BE-05 的「最慢上游閘住回應」由「每所獨立輪詢迴圈 + 請求路徑只讀記憶體」在結構上消除；keep-alive 連線重用需要 `undici` Agent（新依賴），列為 Open Question 3。輪詢間隔 ≥ 10 s 下每次重新握手的成本（約 50–100 ms / 所，BE-05 實測）不影響請求延遲。

### 8. 研究端 `server.ts` 過渡（嵌入式）

1. `server.ts` 在程序內建立 `RealClock`（`trading-clock`）、`GuardedRestClient`、`InstrumentRegistry`、`MarketDataService`；`RealClock` 的校正以本 change 的 `queryServerTime` 為樣本來源。
2. `/api/market/live-scan` 只讀 `marketState` + 註冊表 `matchPair`（`instrument-registry` 已提供的聚合函式改為接受記憶體狀態輸入）；聚合結果以行情狀態 `version` 做記憶化，至多每 `scan_recompute_min_interval_ms`（預設 1,000）重算一次（聚合 CPU 13–22 ms，BE-05）。
3. 回應：既有欄位全保留（`cached: true`、`cache_age_ms` = 各所資料年齡最大值、`fetch_latency_ms` 改為聚合耗時）；新增 `sources`、`data_as_of`；`time_to_settlement_sec` 每次回應重算（BE-04 解方 2，也讓 FE-03 的倒數在每次刷新時正確）；`?symbol=` 單一合約（FE-02 伺服器端，回應從約 686 KB 降到約 1 KB 等級）。
4. **為什麼嵌入而非等 Runtime process**：Paper Runtime 屬技術書 §50.1 第 5 項，尚未存在；嵌入可立即修正研究端的 BE-01～BE-05。Runtime process 建立後，由該 change 決定 `server.ts` 改為讀取 Runtime 發布的行情快照（C-06「`server.ts` 只讀 / 轉發」），避免同一 IP 上兩份訂閱重複消耗限流預算（Risks）。

### 9. 事件

| 事件 | 觸發 |
|------|------|
| `FEED_STATE_CHANGED` | 連線狀態機每次轉換 |
| `EXCHANGE_DISCONNECTED` | `OPEN` 非預期中斷（技術書 §26 既有類型） |
| `STALE_MARKET_DATA` / `MARKET_DATA_RECOVERED` | 新鮮度轉換（前者為技術書 §26 既有類型） |
| `ORDER_BOOK_RESYNC` | 序號缺口、交叉盤口 |
| `SOURCE_STATUS_CHANGED` | 每所 `SourceStatus.state` 轉換 |
| `RATE_LIMIT_CIRCUIT_CHANGED` | 斷路器 `CLOSED / OPEN / HALF_OPEN` 轉換 |
| `SHORTLIST_SUBSCRIPTION_DROPPED` | 入圍合約因註冊表變動被取消 |

- 逐筆行情本身**不**產生 TradingEvent（每秒數千則，屬 `market_events` 表的範疇，由 `trading-schema-storage` 決定是否取樣落地）；狀態轉換才產生事件（規格書 §25 第 2 點）。
- `SourceStatus` 等狀態物件帶 `created_at` / `updated_at`。

### 10. 任務規模

- 12 項任務（含收尾），在 `~12` 的上限內，不拆分。曾考慮拆成 `websocket-data-layer-rest`（snapshot capability）與 `websocket-data-layer-stream`（stream capability），但兩者共用 adapter 描述與 `SourceStatus`，拆開會讓第一份 change 產生無人使用的程式碼，故維持一份。

## 跨 change 假設

| # | 假設 | 來源 / 若不成立 |
|---|------|----------------|
| B1 | `instrument-registry` 已合併，提供 `subscribableSymbols(exchange)`、`onChange(diff)`、`get` / `findByKey`、`updateFundingSchedule(exchange, native_symbol, update, now)`（回傳 `APPLIED` / `IGNORED_OUT_OF_ORDER` / `UNKNOWN_INSTRUMENT`）、`matchPair`、`PublicRestClient` / `UpstreamError`、live-scan 聚合函式 | 本 change 的硬性前置（C-09 順序亦如此） |
| B2 | `paper-trading-event-loop` 的 `trading-clock` 已合併，`Clock` 提供 `now`、`exchangeNow(ex)`、`toLocal(ex, t)`、`after`、`at`、`cancel`；`RealClock` 接受一個伺服器時間樣本來源（`ServerTimeSource.query(ex): Promise<ServerTimeSample>`，樣本欄位 `server_time`、`local_sent`、`local_received`）並自行計算 offset / `errorMs = RTT / 2` | 若 `RealClock` 以其他形式取得樣本，只調整本 change 的 `serverTime.ts` 轉接層，不改變樣本內容 |
| B3 | `settlement-session` 在 SHORTLIST 開始時呼叫 `promote(session_id, instrument_ids)`、在 DONE / SKIPPED 呼叫 `release(session_id)`；串接屬 Paper Runtime 主迴圈 change | 在串接之前，入圍層只以測試驗證；不影響研究端 |
| B4 | `opportunity-lifecycle` 與 `risk-engine` 以 `getFreshness(instrument_id).stale` 判斷 `STALE_MARKET_DATA`；`data_stale_threshold_ms` 使用技術書 §38 既有設定 | 本 change 只提供查詢與事件 |
| B5 | `TradingEvent` / `TradingEventType`（`trading-schema`，`runtime/src/types/event.ts`，change 目錄 `trading-schema-types`）：`trade_id` 為 `string \| null`（市場層事件填 `null`）；`TradingEventType` 為封閉聯集，須在擴充碼清單加入 `FEED_STATE_CHANGED`、`MARKET_DATA_RECOVERED`、`ORDER_BOOK_RESYNC`、`SOURCE_STATUS_CHANGED`、`RATE_LIMIT_CIRCUIT_CHANGED`、`SHORTLIST_SUBSCRIPTION_DROPPED`（`STALE_MARKET_DATA`、`EXCHANGE_DISCONNECTED` 已是技術書 §26 核心碼），並同時補 `glossary.ts` 條目 | 需與 `trading-schema-types` 協調；合併前以本地 `EventSink` 運作 |
| B6 | `PaperTradingConfig`（技術書 §38）新增欄位：`full_market_poll_ms`（每所）、`watch_stale_threshold_ms`、`freshness_check_interval_ms`、`reconnect_base_ms` / `reconnect_max_ms` / `reconnect_jitter_ratio`、`backoff_reset_after_ms`、`rotation_lead_ms`、`rate_limit_soft_ratio`、`max_last_known_good_age_ms`、`scan_recompute_min_interval_ms` | 設定型別屬 `trading-schema`；合併前以本模組的設定物件（含預設值）提供，合併後併入 |

## Risks / Trade-offs

- [研究端嵌入式行情服務與未來 Runtime 在同一 IP 重複訂閱] → Runtime process change 必須把 `server.ts` 切換為讀取 Runtime 快照；在那之前只有一個 process 訂閱。
- [Binance WS 路徑疑似改版、Node 內建 WebSocket 的 pong 行為未查證] → URL 設定化；第一個 Binance 任務以實際連線驗證，失敗即回報使用者（可能需要 `ws` 依賴）。
- [Bybit 批次 tickers 每 10 s 約 170 KB（gzip），約 1.5 GB / 天] → 間隔可設定；入圍後改由 100 ms 串流提供，全市場層只需 WATCH 精度。
- [OKX mark price 端點未查證] → 取不到時 `mark_price = null`，不以 `last` 冒充；OKX 目前只在掃描範圍。
- [Bitget 限流數值未查證] → 保守規則 + 標頭解析 + 斷路器；觀察到 429 時自動退避。
- [最後成功資料在 5 分鐘內仍被研究掃描使用] → 以 `sources` 與 stale 標記明示；Paper 決策使用入圍層門檻（`data_stale_threshold_ms`），不會用到舊資料。
- [全市場推播 CPU / 記憶體] → Binance 約 744 筆 / 秒級、81 KB / 則，解析成本低（BE-05 實測 JSON.parse 合計 6.5 ms 等級）；Bybit 不做全市場訂閱（D-5）。
- [DELTA_STREAM 序號語意各所不同] → 由 adapter 轉成通用 `sequence` / `prev_sequence`；以錄製訊息 fixture 驗證，缺口一律重新同步（寧可短暫 `RESYNCING` 也不使用錯誤盤口）。

## Migration Plan

1. 在 `feature-websocket-data-layer`（來自 `develop`，前置 change 皆已合併）開發；新模組純新增。
2. 切換 `server.ts` 為最後步驟：切換前以現有測試（`instrument-registry` 的 live-scan 聚合測試）鎖住輸出；切換後同一 fixture 狀態下輸出一致，並實測 50 併發請求上游呼叫數 = 0。
3. `--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`，研究端即回到 `instrument-registry` 的 REST 版本。無持久化資料。

## Open Questions

1. Bybit 全市場批次 REST 間隔 N 預設 10 s 是否可接受（頻寬約 1.5 GB / 天 vs WATCH 階段新鮮度）？或改 30 s、在 SHORTLIST 前 5 分鐘縮短？
2. 若 Node 內建 `WebSocket` 無法正確回應 Binance 的 ping frame，是否同意加入 `ws` 依賴？
3. 是否同意加入 `undici` 依賴以設定 keep-alive / DNS 快取（BE-05 解方 1）與 `compression`（BE-08 解方 1）？本 change 預設不加。
4. `data_stale_threshold_ms`（入圍層）預設值？技術書 §38 只有欄位沒有數值；BE-04 驗收條件建議 T-60s～T 期間 p95 資料年齡 < 3 s，建議預設 3,000 ms。
5. 研究 UI 的 FE-02（頁面可見性暫停輪詢）與 FE-03（倒數由絕對時間推導、自動刷新）要不要另開一個小 change（例如 `research-ui-live-refresh`）？
