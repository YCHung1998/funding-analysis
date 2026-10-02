## ADDED Requirements

### Requirement: Full-market tier coverage from the instrument registry
行情服務 SHALL 為 `scan_exchanges` 中每一所建立全市場層資料來源，其涵蓋範圍 MUST 等於 `instrument-registry` 的 `subscribableSymbols(exchange)`。資料來源形式（串流 `STREAM` 或批次輪詢 `POLL`）與參數 MUST 由該所 adapter 的 feed 描述宣告，引擎不得依交易所名稱分支。預設描述 SHALL 為：Binance `STREAM`（全市場 mark price / 資金費推播）+ 24h 量 `POLL` 每 60 s；Bybit `POLL` 每 10 s（批次 tickers）；Pionex、Bitget、OKX `POLL` 每 30 s。所有輪詢間隔 MUST 可由設定覆寫。

#### Scenario: Only registry-subscribable symbols are tracked
- **WHEN** 註冊表中 Binance 有 740 個 `TRADING` 線性永續與 130 個 `DELISTING` 合約，而全市場推播訊息包含全部 870 個 symbol
- **THEN** 行情狀態只保存 740 個合約的資料，`DELISTING` 合約的訊息被忽略

#### Scenario: Poll feed interval from adapter descriptor
- **WHEN** 以預設設定於 t = 0 啟動，VirtualClock 前進至 t = 29 s，且每次輪詢都立即成功
- **THEN** Bybit 批次 tickers 請求恰好發出 3 次（t = 0、10 s、20 s），Pionex、Bitget、OKX 各自的 tickers 請求各發出 1 次

### Requirement: Full-market tier follows registry changes
行情服務 SHALL 訂閱註冊表的 `onChange`；新增為可訂閱的合約 MUST 在下一次輪詢或串流訊息時開始被追蹤，不再可訂閱的合約 MUST 立即自行情狀態移除，且若它在入圍層中則 MUST 取消其入圍訂閱並產生 `SHORTLIST_SUBSCRIPTION_DROPPED` 事件（`reason = 'INSTRUMENT_NOT_SUBSCRIBABLE'`）。

#### Scenario: Delisted instrument removed from state
- **WHEN** 註冊表通知 `Binance:STORJUSDT` 轉為 `DELISTING`
- **THEN** `getTicker('Binance:STORJUSDT')` 回傳 `NOT_TRACKED`，且後續推播中的 `STORJUSDT` 資料被忽略

#### Scenario: Shortlisted instrument becomes unsubscribable
- **WHEN** `Bybit:XUSDT` 已入圍，註冊表通知其轉為 `HALTED`
- **THEN** 其 ticker 與盤口訂閱被取消，並產生 `SHORTLIST_SUBSCRIPTION_DROPPED` 事件

### Requirement: Shortlist tier promotion and release
行情服務 SHALL 提供 `promote(session_id, instrument_ids)` 與 `release(session_id)`（D-5 入圍層，由 `settlement-session` 在 SHORTLIST 開始時與 DONE / SKIPPED 時呼叫）。`promote` MUST 只接受屬於 `trading_exchanges` 且可訂閱的合約，其餘回傳 `REJECTED_NOT_TRADING_EXCHANGE` 或 `REJECTED_NOT_SUBSCRIBABLE`；接受的合約 MUST 訂閱該所 adapter 宣告的逐筆 ticker 與盤口深度主題。同一合約被多個場次入圍時 MUST 以參照計數共用一份訂閱，只有最後一個場次 `release` 後才取消訂閱。入圍訂閱建立後，在收到第一份盤口快照（串流快照或 REST 快照）之前，該合約的盤口狀態 MUST 為 `WARMING_UP`，不得被視為新鮮。

#### Scenario: Promote subscribes ticker and depth
- **WHEN** 場次 S1 呼叫 `promote('S1', ['Binance:BTCUSDT', 'Bybit:BTCUSDT'])`
- **THEN** 兩所各送出一個包含該合約 ticker 與 depth 主題的訂閱請求，兩個合約盤口狀態為 `WARMING_UP` 直到收到快照

#### Scenario: Scan-only exchange rejected
- **WHEN** `promote('S1', ['Pionex:BTC_USDT_PERP'])` 且 `trading_exchanges = ['Binance', 'Bybit']`
- **THEN** 回傳 `REJECTED_NOT_TRADING_EXCHANGE`，不建立任何訂閱

#### Scenario: Reference counting across sessions
- **WHEN** 場次 S1 與 S2 都入圍 `Bybit:ETHUSDT`，S1 先 `release`
- **THEN** `Bybit:ETHUSDT` 的訂閱仍存在；S2 `release` 後才送出取消訂閱請求

### Requirement: Normalized market data with dual timestamps
每筆進入行情狀態的資料 SHALL 正規化為 `MarketDataEvent`（技術書 §8：`exchange`、`symbol`（`instrument_id`）、`exchange_timestamp`、`local_received_timestamp`、`sequence?`、`bid`、`ask`、`mark_price`、`index_price`、`funding_rate?`，另加 `next_funding_time?`、`volume_24h_quote?`、`tier`、`timestamp_source`）。`exchange_timestamp` MUST 取自訊息的交易所事件時間；訊息沒有時使用回應層級的伺服器時間（`timestamp_source = 'RESPONSE'`）；兩者皆無時 `timestamp_source = 'LOCAL'`。`local_received_timestamp` MUST 取自注入的 `Clock`。缺少的價格欄位 MUST 為 `null`，不得以其他欄位或預設值補值（BE-02、Q-03）。費率 MUST 以小數保存（Invariant #5）。

#### Scenario: Binance mark price stream normalized
- **WHEN** 收到 Binance 全市場推播中一筆 `{ s: 'BTCUSDT', E: 1700000000120, p: '83000.1', i: '82990.5', r: '0.00010000', T: 1700006400000 }`，本地接收時間 1700000000164
- **THEN** 產生 `exchange_timestamp = 1700000000120`、`local_received_timestamp = 1700000000164`、`mark_price = 83000.1`、`index_price = 82990.5`、`funding_rate = 0.0001`、`next_funding_time = 1700006400000`、`bid = null`、`ask = null`、`timestamp_source = 'EXCHANGE'`

#### Scenario: Missing field stays null
- **WHEN** 某所 ticker 回應缺少 `markPrice`
- **THEN** 該筆 `mark_price = null`，不得以 `last` 或 0 代替

### Requirement: Data freshness measured on the exchange clock
行情服務 SHALL 提供 `getFreshness(instrument_id)`，回傳 `data_age_ms`、`stale`、`tier`、`threshold_ms`。查詢時點的 `data_age_ms` MUST 為 `clock.exchangeNow(exchange) − exchange_timestamp`（以該所自己的時鐘量測；於收到當下等同 `trading-clock` 定義的 `local_received − toLocal(exchange, exchange_timestamp)`）。每筆資料 SHALL 另記錄收到當下的 `receive_latency_ms`。門檻：已入圍合約使用 `data_stale_threshold_ms`（`PaperTradingConfig`）；其餘使用 `watch_stale_threshold_ms`（預設為該所 feed 輪詢間隔 × 3，串流 feed 為 10,000）。`timestamp_source = 'LOCAL'` 的資料 MUST 對入圍層一律視為 `stale = true`。

#### Scenario: Age uses exchange clock offset
- **WHEN** Binance 時鐘偏差使 `clock.exchangeNow('Binance') = 10_000`，最新資料 `exchange_timestamp = 9_956`
- **THEN** `data_age_ms = 44`

#### Scenario: Shortlist threshold applies after promotion
- **WHEN** `data_stale_threshold_ms = 3000`、`watch_stale_threshold_ms = 30000`，已入圍合約的 `data_age_ms = 4000`
- **THEN** `stale = true`、`threshold_ms = 3000`

#### Scenario: Local-only timestamp is stale for shortlist
- **WHEN** 已入圍合約的最新資料 `timestamp_source = 'LOCAL'`
- **THEN** `getFreshness` 回傳 `stale = true`

### Requirement: Stale market data transitions emit events
行情服務 SHALL 以 `Clock` 排程定期（`freshness_check_interval_ms`，預設 500 ms）評估新鮮度。已入圍合約由新鮮轉為 stale 時 MUST 產生一筆 `STALE_MARKET_DATA` 事件（`scope = 'INSTRUMENT'`，payload 含 `data_age_ms`、`threshold_ms`、`tier`），恢復時產生一筆 `MARKET_DATA_RECOVERED`；全市場層以「該所 feed 最近一次更新」為單位評估（`scope = 'FEED'`）。同一狀態持續期間 MUST NOT 重複產生事件。stale 狀態 MUST 可被 Risk Engine 與 `opportunity-lifecycle` 查詢（阻擋新交易屬 `risk-engine`，不在本 capability）。

#### Scenario: Single event per stale episode
- **WHEN** 已入圍的 `Bybit:BTCUSDT` 因斷線 10 s 未更新，`data_stale_threshold_ms = 3000`，期間新鮮度檢查執行 20 次
- **THEN** 只產生 1 筆 `STALE_MARKET_DATA`；收到新資料後產生 1 筆 `MARKET_DATA_RECOVERED`

#### Scenario: Feed-level stale for polling exchange
- **WHEN** OKX 輪詢連續失敗使該所最近一次成功更新距今 100 s，`watch_stale_threshold_ms = 90000`
- **THEN** 產生 1 筆 `STALE_MARKET_DATA`，`scope = 'FEED'`、`exchange = 'OKX'`

### Requirement: WebSocket connection lifecycle
每條 WebSocket 連線 SHALL 依狀態機 `IDLE → CONNECTING → OPEN → RECONNECT_WAIT → CONNECTING … → CLOSED` 運作，每次轉換 MUST 產生 `FEED_STATE_CHANGED` 事件（`from`、`to`、`reason`、`connection_id`）；由 `OPEN` 非預期中斷時 MUST 另產生 `EXCHANGE_DISCONNECTED` 事件（技術書 §26）。連線 MUST 在收到所有訂閱確認（或 adapter 宣告不需確認）後才轉為 `OPEN`。

#### Scenario: Connect and subscribe
- **WHEN** 假 WebSocket 完成握手並回覆訂閱確認
- **THEN** 依序產生 `IDLE → CONNECTING`、`CONNECTING → OPEN` 兩筆 `FEED_STATE_CHANGED`

#### Scenario: Unexpected close
- **WHEN** `OPEN` 狀態的連線被伺服器關閉（close code 1006）
- **THEN** 產生 `OPEN → RECONNECT_WAIT` 的 `FEED_STATE_CHANGED` 與一筆 `EXCHANGE_DISCONNECTED`

### Requirement: Heartbeat and idle detection
每條連線 SHALL 依 adapter 宣告的心跳規格運作：若宣告 `client_ping_interval_ms`，MUST 以該間隔送出 adapter 定義的應用層 ping（Bybit 預設每 20,000 ms 送 `{"op":"ping"}`）；若在 `idle_timeout_ms` 內未收到任何訊息（含 pong），MUST 視為連線失效、主動關閉並進入重連（`reason = 'IDLE_TIMEOUT'`）。

#### Scenario: Bybit ping every 20 seconds
- **WHEN** Bybit 連線 `OPEN` 後 VirtualClock 前進 60 s
- **THEN** 假 WebSocket 恰好收到 3 則 `{"op":"ping"}`

#### Scenario: Silent connection is recycled
- **WHEN** `idle_timeout_ms = 30000` 且連線 30 s 內沒有收到任何訊息
- **THEN** 連線被關閉並轉為 `RECONNECT_WAIT`，`reason = 'IDLE_TIMEOUT'`

### Requirement: Reconnect with exponential backoff and recovery
連線中斷後 SHALL 以指數退避重連：第 n 次嘗試等待 `min(reconnect_max_ms, reconnect_base_ms × 2^(n−1)) × (1 + jitter)`，`jitter` 均勻分布於 `[−reconnect_jitter_ratio, +reconnect_jitter_ratio]`（預設 base 1,000 ms、上限 60,000 ms、ratio 0.2；亂數來源可注入）。連線維持 `OPEN` 達 `backoff_reset_after_ms`（預設 60,000）後 n MUST 歸零。重連成功後 MUST 重送該連線全部訂閱，並對受影響合約觸發 REST 回補（`market-data-snapshot`）；回補完成前這些合約 MUST 維持 stale。

#### Scenario: Backoff sequence
- **WHEN** 亂數來源固定使 `jitter = 0`，連線連續失敗 8 次
- **THEN** 等待時間依序為 1 s、2 s、4 s、8 s、16 s、32 s、60 s、60 s

#### Scenario: Backoff resets after stable connection
- **WHEN** 第 3 次重連成功並維持 `OPEN` 61 s 後再次中斷
- **THEN** 下一次等待時間回到 1 s（× jitter）

#### Scenario: Resubscribe and backfill after reconnect
- **WHEN** 已入圍 `Binance:BTCUSDT` 的連線重連成功
- **THEN** 重新送出其 ticker 與 depth 訂閱，並發出一次盤口 REST 快照請求；快照套用前 `getFreshness('Binance:BTCUSDT').stale = true`

### Requirement: Connection rotation and topic sharding
若 adapter 宣告 `max_connection_lifetime_ms`，連線 SHALL 在到期前 `rotation_lead_ms`（預設 5 分鐘）建立新連線、完成訂閱後才關閉舊連線（先建後拆，期間不得出現資料空窗）。若 adapter 宣告 `max_topics_per_connection`，訂閱主題超過上限時 MUST 分散到多條連線。

#### Scenario: Make-before-break rotation
- **WHEN** 連線壽命上限 24 h，VirtualClock 前進到 23 h 55 m
- **THEN** 新連線先轉為 `OPEN`，之後舊連線才以 `reason = 'ROTATION'` 關閉，且期間該合約新鮮度未轉為 stale

#### Scenario: Topics sharded across connections
- **WHEN** `max_topics_per_connection = 200` 且需要訂閱 450 個主題
- **THEN** 建立 3 條連線，分別承載 200、200、50 個主題

### Requirement: Order book integrity
盤口服務 SHALL 支援 adapter 宣告的兩種模式：`SNAPSHOT_STREAM`（每則訊息為完整前 N 檔）與 `DELTA_STREAM`（快照 + 增量，附序號）。`DELTA_STREAM` 模式下，增量的 `prev_sequence` 與目前序號不連續時 MUST 將該盤口設為 `RESYNCING`、丟棄目前盤口、重新取得快照並產生 `ORDER_BOOK_RESYNC` 事件；序號小於等於目前序號的增量 MUST 被忽略。任一模式下出現 best bid ≥ best ask MUST 視同缺口處理。`RESYNCING` / `WARMING_UP` 期間 `getOrderBook` MUST 回傳該狀態而非舊盤口。

#### Scenario: Sequence gap triggers resync
- **WHEN** Bybit 盤口目前序號 100，收到 `prev_sequence = 102` 的增量
- **THEN** 盤口狀態為 `RESYNCING`、產生 `ORDER_BOOK_RESYNC` 事件，`getOrderBook` 回傳 `{ status: 'RESYNCING' }`，直到新快照套用

#### Scenario: Duplicate delta ignored
- **WHEN** 目前序號 100，收到 `sequence = 99` 的增量
- **THEN** 盤口不變且不觸發重新同步

#### Scenario: Crossed book rejected
- **WHEN** 套用增量後 best bid = 101、best ask = 100
- **THEN** 盤口轉為 `RESYNCING`

### Requirement: Funding schedule forwarded to the registry
行情資料中含有下次結算時間或結算週期時，行情服務 SHALL 呼叫 `instrument-registry` 的 `updateFundingSchedule(exchange, native_symbol, update, now)`，並傳入 `exchange_timestamp` 與 `local_received_timestamp`；註冊表回傳 `IGNORED_OUT_OF_ORDER` 或 `UNKNOWN_INSTRUMENT` 時 MUST NOT 視為錯誤中斷處理。

#### Scenario: Stream updates next funding time
- **WHEN** Binance 推播 `BTCUSDT` 的 `T = 1700006400000`、`E = 1700000000120`
- **THEN** 註冊表收到 `updateFundingSchedule('Binance', 'BTCUSDT', { next_funding_time: 1700006400000, exchange_timestamp: 1700000000120, ... })`

### Requirement: Clock-driven timing without exchange branching
`runtime/src/market/`（不含 `runtime/src/adapters/`）的所有計時、排程、時間戳 MUST 透過注入的 `trading-clock` `Clock`（`now`、`exchangeNow`、`after`、`cancel`），MUST NOT 直接呼叫 `Date.now()`、`setTimeout`、`setInterval`；且 MUST NOT 以交易所名稱字面值分支（Invariant #3）。

#### Scenario: Static check on market layer
- **WHEN** `runtime/src/market/` 下任一非測試原始檔包含 `Date.now(`、`setTimeout(`、`setInterval(` 或字串字面值 `'Binance'`、`'Bybit'`、`'OKX'`、`'Bitget'`、`'Pionex'`
- **THEN** 自動檢查測試失敗並列出檔名
