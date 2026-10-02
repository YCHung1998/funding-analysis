## ADDED Requirements

### Requirement: Guarded REST client with single-flight
系統 SHALL 提供 `GuardedRestClient`，實作 `instrument-registry` 定義的 `PublicRestClient` 介面，所有行情層與註冊表的 REST 讀取 MUST 經由它。對同一 `(exchange, url)` 的併發請求 MUST 合併為一次上游呼叫（single-flight），所有等待者取得同一結果或同一錯誤；該次呼叫結束後的新請求 MUST 發出新的上游呼叫。

#### Scenario: Concurrent identical requests coalesce
- **WHEN** 50 個呼叫端在同一次上游回應前併發請求 Bybit `GET /v5/market/tickers?category=linear`
- **THEN** 上游恰好被呼叫 1 次，50 個呼叫端取得同一份資料

#### Scenario: Shared failure
- **WHEN** 上述合併中的上游呼叫逾時
- **THEN** 50 個呼叫端都收到同一個 `UpstreamError`（`kind = 'TIMEOUT'`）

#### Scenario: New request after settle
- **WHEN** 第一次呼叫已完成後又有新的相同請求
- **THEN** 發出第 2 次上游呼叫

### Requirement: Explicit error classification
`GuardedRestClient` SHALL 把每一次失敗分類為 `UpstreamError.kind ∈ {HTTP, TIMEOUT, NETWORK, PARSE, API_ERROR, RATE_LIMITED}` 並附 `exchange`、`http_status?`、`retry_after_ms?`、`latency_ms`；非 2xx、交易所信封錯誤碼（由 adapter 判定）、JSON 解析失敗 MUST throw，MUST NOT 以空陣列或預設物件取代（BE-02）。每次上游非 2xx MUST 產生一行結構化 log（`exchange`、`url` 路徑、`http_status`、`latency_ms`），log 與錯誤訊息 MUST NOT 含憑證（Invariant #2）。

#### Scenario: OKX 429 body not treated as data
- **WHEN** OKX 回應 HTTP 429 與 `{"code":"50011"}`
- **THEN** 呼叫端收到 `UpstreamError`，`kind = 'RATE_LIMITED'`、`http_status = 429`

#### Scenario: Envelope error on HTTP 200
- **WHEN** Bybit 回應 HTTP 200 但 `retCode = 10006`
- **THEN** 呼叫端收到 `UpstreamError`，`kind = 'API_ERROR'`

### Requirement: Per-exchange source status
系統 SHALL 為每所維護 `SourceStatus`：`state ∈ {INITIALIZING, HEALTHY, DEGRADED, FAILED, RATE_LIMITED}`、`last_success_at`、`last_error`（`kind`、`http_status`、`at`）、`consecutive_failures`、`data_age_ms`、`instrument_count`、`rate_limit`（`used`、`limit`、`window_ms`、`circuit`）、`created_at`、`updated_at`。規則：最近一次成功且串流 / 輪詢正常 → `HEALTHY`；有失敗但仍有未超齡的最後成功資料 → `DEGRADED`；斷路器開啟 → `RATE_LIMITED`；無可用資料 → `FAILED`。每次 `state` 轉換 MUST 產生 `SOURCE_STATUS_CHANGED` 事件（`from`、`to`、`reason`）。

#### Scenario: Failure with usable cache degrades
- **WHEN** Bitget 上一次成功在 20 s 前，本次輪詢逾時，`max_last_known_good_age_ms = 300000`
- **THEN** Bitget `state` 由 `HEALTHY` 轉為 `DEGRADED`，並產生一筆 `SOURCE_STATUS_CHANGED`

#### Scenario: Recovery back to healthy
- **WHEN** Bitget 下一次輪詢成功
- **THEN** `state` 轉回 `HEALTHY`、`consecutive_failures = 0`

### Requirement: Last-known-good data is never overwritten by failures
失敗或殘缺的回應 MUST NOT 覆寫該所最後一次成功的資料；最後成功資料 SHALL 持續提供並依 `market-data-stream` 的新鮮度規則標示 stale，超過 `max_last_known_good_age_ms`（預設 300,000）後 MUST 自行情狀態移除，該所 `state` 轉為 `FAILED`。

#### Scenario: Partial failure keeps previous data
- **WHEN** OKX 第一次輪詢成功取得 467 筆，第二次輪詢回 429
- **THEN** 行情狀態中 OKX 仍為 467 筆（標示 stale 依門檻），`sources.OKX.state = 'RATE_LIMITED'`

#### Scenario: Expired cache removed
- **WHEN** OKX 最後一次成功已超過 `max_last_known_good_age_ms`
- **THEN** OKX 資料自行情狀態移除，`sources.OKX.state = 'FAILED'`，研究端 live-scan 不再以 OKX 配對

### Requirement: Rate-limit rules and budget
每所 adapter SHALL 宣告限流規則表（視窗、上限、計量單位為請求數或權重、每端點權重、用量標頭名稱、封鎖狀態碼與冷卻時間）。`GuardedRestClient` MUST 在每次回應後以標頭（例如 Binance `X-MBX-USED-WEIGHT-1M`）或本地計數更新用量；用量 ≥ `rate_limit_soft_ratio`（預設 0.7）時 MUST 把該所所有輪詢間隔加倍，直到用量 < 0.5 才恢復；會使用量超過上限的請求 MUST 延後到視窗重置後才送出，不得直接送出。

#### Scenario: Binance weight header drives budget
- **WHEN** Binance 回應標頭 `X-MBX-USED-WEIGHT-1M: 1700`，上限 2400
- **THEN** `sources.Binance.rate_limit.used = 1700`，且 Binance 24h 量輪詢間隔由 60 s 變為 120 s

#### Scenario: Request deferred instead of exceeding limit
- **WHEN** Pionex 規則為每秒 10 次，當前 1 秒視窗已送出 10 次
- **THEN** 第 11 次請求延後到下一個視窗才送出

### Requirement: Circuit breaker on rate-limit responses
收到 adapter 規則表中宣告的封鎖回應（Binance 429 / 418、Bybit 403、OKX 429、Pionex 429 等）時，系統 SHALL 將該所斷路器設為 `OPEN`，持續 `max(Retry-After, 規則冷卻時間)`；`OPEN` 期間對該所 MUST 發出 0 次上游請求並直接回傳 `RATE_LIMITED`；到期後轉 `HALF_OPEN` 只放行 1 個探測請求，成功則 `CLOSED`、失敗則以加倍冷卻重新 `OPEN`。每次斷路器狀態轉換 MUST 產生 `RATE_LIMIT_CIRCUIT_CHANGED` 事件。

#### Scenario: Bybit 403 opens circuit for 10 minutes
- **WHEN** Bybit 回應 HTTP 403，規則冷卻時間 600,000 ms
- **THEN** 之後 600 s 內 Bybit 上游請求數為 0，且產生 `CLOSED → OPEN` 的 `RATE_LIMIT_CIRCUIT_CHANGED` 事件

#### Scenario: Retry-After longer than rule cooldown
- **WHEN** Binance 回應 418 且 `Retry-After: 180`，規則冷卻時間 120 s
- **THEN** 斷路器維持 `OPEN` 180 s

#### Scenario: Half-open probe
- **WHEN** 冷卻到期後有 3 個待送請求
- **THEN** 只送出 1 個探測請求；成功後斷路器 `CLOSED`，其餘請求才送出

### Requirement: Transient error backoff and independent loops
逾時、網路錯誤、5xx SHALL 以每端點指數退避處理（`min(60 s, 1 s × 2^(n−1))`，可注入 jitter）。每所的輪詢迴圈 MUST 彼此獨立：某所變慢或失敗 MUST NOT 延遲其他所的更新（BE-05）；同一端點上一次輪詢未結束時 MUST NOT 啟動下一次（由 single-flight 與排程共同保證）。

#### Scenario: Slow exchange does not gate others
- **WHEN** Pionex 請求耗時 5 s 才回應，其他所 100 ms 內回應
- **THEN** 其他 4 所的行情在 Pionex 回應前已更新

#### Scenario: Transient backoff
- **WHEN** Bitget tickers 連續 3 次回 HTTP 502
- **THEN** 下一次重試分別等待 1 s、2 s、4 s（jitter = 0），且期間其他 Bitget 以外的迴圈照常運作

### Requirement: Snapshot on start, subscribe and recovery
系統 SHALL 以 REST 快照補齊串流無法提供的狀態：啟動時每所一次全市場快照（使串流開始前行情狀態已有資料）；入圍訂閱建立時一次盤口快照（`DELTA_STREAM` 模式下作為增量基準，或串流快照先到則免）；重連成功或盤口序號缺口後一次回補快照。回補完成前受影響合約 MUST 維持 stale / `RESYNCING`。快照與串流資料同一合約時，MUST 以 `exchange_timestamp`（或序號）較新者為準。

#### Scenario: Startup snapshot before first stream message
- **WHEN** 行情服務啟動，Binance 串流尚未收到訊息，Binance premiumIndex 快照已回應
- **THEN** `getTicker('Binance:BTCUSDT')` 回傳快照資料，`tier = 'FULL_MARKET'`

#### Scenario: Older snapshot does not overwrite newer stream data
- **WHEN** 串流資料 `exchange_timestamp = 2000` 已存在，之後到達的快照 `exchange_timestamp = 1500`
- **THEN** 行情狀態維持 2000 的資料

### Requirement: Exchange server time query for trading-clock
系統 SHALL 提供 `queryServerTime(exchange, localNow)`，回傳 `ServerTimeSample { exchange, server_time, local_sent, local_received }`，其中 `local_sent` / `local_received` 由呼叫端傳入的 `localNow()` 於送出前與收到後取得。端點由 adapter 宣告：Binance `GET /fapi/v1/time`、Bybit `GET /v5/market/time`、OKX `GET /api/v5/public/time`、Bitget `GET /api/v2/public/time`、Pionex 以輕量帶 symbol 的行情請求之回應 `timestamp`。此查詢 MUST 經過 `GuardedRestClient`（計入限流、斷路器開啟時回傳 `RATE_LIMITED`），MUST NOT 使用 single-flight 合併（每次樣本須有自己的往返時間）。偏差、誤差與參考時間軸的計算 MUST 由 `trading-clock` 負責，本 capability 不得計算或保存時鐘偏差。

#### Scenario: Sample carries local send and receive times
- **WHEN** `localNow()` 在送出前回傳 1000、收到回應後回傳 1040，Bybit 回應伺服器時間 1100
- **THEN** 回傳 `{ exchange: 'Bybit', server_time: 1100, local_sent: 1000, local_received: 1040 }`

#### Scenario: Server time requests are not coalesced
- **WHEN** 兩個呼叫端同時對 Binance 呼叫 `queryServerTime`
- **THEN** 上游被呼叫 2 次，各自回傳自己的 `local_sent` / `local_received`

### Requirement: Research live-scan served from in-memory market state
研究端 `server.ts` SHALL 在程序內啟動行情服務，`/api/market/live-scan` MUST 只讀取記憶體行情狀態與註冊表配對結果，請求路徑上 MUST NOT 發出任何上游請求。回應 MUST 保留既有欄位並新增 `sources`（每所 `SourceStatus` 的公開欄位）、`data_as_of`（每所最近一次成功更新的交易所時間）；每個候選的 `time_to_settlement_sec` MUST 於每次回應時以 `next_funding_time` 與當下時間重新計算；支援 `?symbol=<display symbol 或 instrument_key>` 只回傳該合約的候選。行情服務尚未完成第一次快照時 MUST 回 HTTP 503 `{ success: false, error: 'MARKET_DATA_NOT_READY', sources }`。

#### Scenario: No upstream calls on request path
- **WHEN** 行情服務已就緒，50 個併發請求打 `/api/market/live-scan`
- **THEN** 這些請求期間上游呼叫計數增加 0 次，50 個回應皆為 `success: true`

#### Scenario: Countdown recomputed per response
- **WHEN** 同一份行情狀態下，兩次請求相隔 3 s
- **THEN** 第二次回應中同一候選的 `time_to_settlement_sec` 比第一次少 3（±1）

#### Scenario: Single symbol filter
- **WHEN** 請求 `/api/market/live-scan?symbol=BTCUSDT`
- **THEN** `candidates` 只包含 `instrument_key = 'BTC/USDT:USDT'` 的候選

#### Scenario: Failed exchange visible in response
- **WHEN** OKX 斷路器開啟
- **THEN** 回應 `sources.OKX.state = 'RATE_LIMITED'`，且 `success` 仍為 `true`，其餘 4 所照常配對
