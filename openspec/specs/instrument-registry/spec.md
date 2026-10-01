# instrument-registry Specification

## Purpose
交易所 × 合約註冊表：以 `instrument_key`（`BASE/QUOTE:SETTLE`）與價格倍數統一各所合約身分，追蹤合約類型、狀態、規格與資金費時程（不以「+ 週期」推算），並以配對規則（同 key、可配對類型、皆交易中、結算時間對齊、價格守門）決定兩腿能否組成套利。由 change `instrument-registry`（2026-10-01）建立。

## Requirements
### Requirement: Instrument record
系統 SHALL 為每個「交易所 × 原生合約」維護一筆 `Instrument`，以 `instrument_id = <exchange>:<native_symbol>` 為唯一鍵，欄位至少包含：`exchange`、`native_symbol`、`instrument_key`、`base_asset`、`quote_asset`、`settle_asset`、`listed_base_asset`、`price_multiplier`、`qty_unit_in_base`、`contract_type`、`native_contract_type`、`status`、`native_status`、`tick_size`、`qty_step`、`min_qty`、`min_notional`（無則 `null`）、`funding`（見資金費時程需求）、`created_at`、`updated_at`、`status_changed_at`、`last_seen_at`。所有時間 MUST 為 UTC epoch 毫秒 `number`（規格書 §25）；`created_at` 在第一次登錄後 MUST NOT 改變。

#### Scenario: First registration sets timestamps
- **WHEN** Binance `BTCUSDT` 在 `now = 1000` 首次出現在 metadata 快照中
- **THEN** 註冊表產生 `instrument_id = 'Binance:BTCUSDT'`，`created_at = updated_at = last_seen_at = 1000`

#### Scenario: Refresh updates only mutable timestamps
- **WHEN** 同一合約在 `now = 5000` 的刷新中規格未變
- **THEN** `created_at` 仍為 1000、`last_seen_at = 5000`，且 `updated_at` 維持 1000（無欄位變動不更新）

### Requirement: Canonical instrument key and multiplier
系統 SHALL 以 `instrument_key = <base_asset>/<quote_asset>:<settle_asset>` 作為跨交易所統一 ID（規格書 §5 `Opportunity.symbol`），其中 `base_asset` 為去除倍數後的標的資產。倍數 MUST 優先取自交易所 metadata（例：OKX `ctVal` / `ctMult`）；只有 metadata 未提供時才解析 `listed_base_asset` 的數字前綴，且前綴只接受白名單（`1000`、`10000`、`100000`、`1000000`、`1M`）並可被 `multiplier_overrides` 設定覆寫。`price_multiplier` 定義為「交易所報價所代表的標的數量」（標準化價格 = 報價 ÷ `price_multiplier`）；`qty_unit_in_base` 定義為「下單數量 1 單位所代表的標的數量」。系統 MUST NOT 以字串去尾（`replace('USDT','')` 類邏輯）推導 base。

#### Scenario: Linear contracts share one key across exchanges
- **WHEN** 註冊 Pionex `BTC_USDT_PERP`（baseCurrency BTC、quoteCurrency USDT）、Binance `BTCUSDT`、OKX `BTC-USDT-SWAP`
- **THEN** 三者的 `instrument_key` 皆為 `BTC/USDT:USDT`

#### Scenario: Reverse-quoted Pionex contract does not collapse into BTC
- **WHEN** 註冊 Pionex `USDT_BTC_PERP`（baseCurrency USDT、quoteCurrency BTC）
- **THEN** 其 `base_asset = 'USDT'`、`quote_asset = 'BTC'`、`contract_type = 'INVERSE_PERPETUAL'`，`instrument_key` 不等於 `BTC/USDT:USDT`，且與任何 `BTC/USDT:USDT` 合約配對皆回傳 `KEY_MISMATCH`

#### Scenario: 1000x prefix resolved to multiplier
- **WHEN** 註冊 Binance `1000PEPEUSDT`（baseAsset `1000PEPE`、quoteAsset USDT）
- **THEN** `listed_base_asset = '1000PEPE'`、`base_asset = 'PEPE'`、`price_multiplier = 1000`、`qty_unit_in_base = 1000`、`instrument_key = 'PEPE/USDT:USDT'`

#### Scenario: Contract value taken from metadata
- **WHEN** 註冊 OKX `PEPE-USDT-SWAP`（`ctValCcy = PEPE`、`ctVal = 10000000`、`ctMult = 1`）
- **THEN** `base_asset = 'PEPE'`、`price_multiplier = 1`、`qty_unit_in_base = 10000000`

#### Scenario: Numeric-looking ticker is not a multiplier
- **WHEN** 註冊 baseAsset 為 `1INCH` 的合約
- **THEN** `base_asset = '1INCH'`、`price_multiplier = 1`

#### Scenario: Override wins over prefix parsing
- **WHEN** `multiplier_overrides` 設定 `Binance:1000XUSDT → { base_asset: '1000X', price_multiplier: 1 }`
- **THEN** 該合約 `base_asset = '1000X'`、`price_multiplier = 1`，且記錄 `multiplier_source = 'OVERRIDE'`

### Requirement: Contract type and status normalization
各交易所 adapter SHALL 把原生合約類型對應到 `contract_type ∈ {LINEAR_PERPETUAL, INVERSE_PERPETUAL, TRADFI_PERPETUAL, DATED_FUTURE, UNKNOWN}`，把原生狀態對應到 `status ∈ {TRADING, PRE_TRADING, HALTED, DELISTING, DELISTED, UNKNOWN}`，並同時保存原生值。無法識別的原生值 MUST 對應為 `UNKNOWN`（不可配對）並產生一筆 `INSTRUMENT_UNKNOWN_VALUE` 事件，MUST NOT 猜測為 `TRADING`。

#### Scenario: Binance settling contract is delisting
- **WHEN** Binance exchangeInfo 回傳 `STORJUSDT` 的 `status = 'SETTLING'`
- **THEN** 其 `status = 'DELISTING'`、`native_status = 'SETTLING'`

#### Scenario: TradFi perpetual is classified separately
- **WHEN** Binance 回傳 `contractType = 'TRADIFI_PERPETUAL'`，或 Bybit instruments-info 回傳 `symbolType = 'stock'`
- **THEN** 該合約 `contract_type = 'TRADFI_PERPETUAL'`

#### Scenario: Bybit delivering maps to delisting
- **WHEN** Bybit instruments-info 回傳 `status = 'Delivering'`
- **THEN** 該合約 `status = 'DELISTING'`

#### Scenario: Unknown native status
- **WHEN** 任一 adapter 收到未列在對照表中的原生狀態 `'Foo'`
- **THEN** 該合約 `status = 'UNKNOWN'`，且產生 `INSTRUMENT_UNKNOWN_VALUE` 事件，payload 含欄位名稱與原生值

### Requirement: Funding schedule from exchange data only
每筆 `Instrument.funding` SHALL 包含 `next_funding_time`、`funding_interval_hours`、`interval_source ∈ {EXCHANGE_FIELD, EXCHANGE_DOC_DEFAULT, DERIVED_FROM_TIMES, UNKNOWN}`、`schedule_status ∈ {VALID, STALE, MISSING}`、`exchange_timestamp`、`local_received_timestamp`、`updated_at`。週期與結算時間 MUST 來自交易所回傳值或官方文件明載的預設（Invariant #4）：Binance 未列於 `fundingInfo` 者為 8 小時並標 `EXCHANGE_DOC_DEFAULT`；OKX 以 `nextFundingTime − fundingTime` 推得並標 `DERIVED_FROM_TIMES`；無來源者 `funding_interval_hours = null`、`interval_source = 'UNKNOWN'`。當 `next_funding_time ≤ now` 且尚未收到新值時，`schedule_status` MUST 為 `STALE`；系統 MUST NOT 以「上次結算時間 + 週期」推算下次結算時間。缺少或為 0 的結算時間 MUST 標 `MISSING`。

#### Scenario: Binance interval from fundingInfo
- **WHEN** Binance `fundingInfo` 列出 `XUSDT` 的 `fundingIntervalHours = 4`
- **THEN** `XUSDT.funding.funding_interval_hours = 4`、`interval_source = 'EXCHANGE_FIELD'`

#### Scenario: Binance symbol absent from fundingInfo
- **WHEN** Binance `BTCUSDT` 不在 `fundingInfo` 清單中
- **THEN** `funding_interval_hours = 8`、`interval_source = 'EXCHANGE_DOC_DEFAULT'`

#### Scenario: OKX interval derived from times
- **WHEN** OKX funding-rate 回傳 `fundingTime = 1_700_000_000_000`、`nextFundingTime = 1_700_014_400_000`
- **THEN** `next_funding_time = 1_700_000_000_000`、`funding_interval_hours = 4`、`interval_source = 'DERIVED_FROM_TIMES'`

#### Scenario: Passed funding time becomes stale, not extrapolated
- **WHEN** 某合約 `next_funding_time = T`，`now = T + 1` 且尚未收到新的結算時間
- **THEN** `schedule_status = 'STALE'` 且 `next_funding_time` 仍為 T（不得變成 T + 週期）

#### Scenario: Zero funding time is missing
- **WHEN** Binance premiumIndex 回傳某合約 `nextFundingTime = 0`
- **THEN** `schedule_status = 'MISSING'`、`next_funding_time = null`

### Requirement: Funding schedule updates from market data
註冊表 SHALL 提供 `updateFundingSchedule(exchange, native_symbol, update, now)`，供行情層（REST 或串流）以含 `exchange_timestamp` 的資料更新 `next_funding_time` / `funding_interval_hours`。`exchange_timestamp` 早於現有值的更新 MUST 被忽略；週期變動 MUST 產生 `FUNDING_SCHEDULE_CHANGED` 事件（含舊值、新值）；對未登錄的合約更新 MUST 被拒絕並回傳 `UNKNOWN_INSTRUMENT`，不得隱式建立合約。

#### Scenario: Newer update applied
- **WHEN** 現有 `exchange_timestamp = 100`，收到 `exchange_timestamp = 200`、`next_funding_time = T2` 的更新
- **THEN** `next_funding_time = T2`、`schedule_status = 'VALID'`、`updated_at = now`

#### Scenario: Out-of-order update ignored
- **WHEN** 現有 `exchange_timestamp = 200`，收到 `exchange_timestamp = 150` 的更新
- **THEN** 資金費時程不變，且回傳結果標示 `IGNORED_OUT_OF_ORDER`

#### Scenario: Interval switch to hourly recorded
- **WHEN** Bybit 某合約週期由 8 變為 1（費率觸頂自動改每小時）
- **THEN** `funding_interval_hours = 1`，且產生 `FUNDING_SCHEDULE_CHANGED` 事件，payload 含 `from: 8`、`to: 1`

#### Scenario: Update for unregistered instrument rejected
- **WHEN** 對未登錄的 `Bybit:NEWUSDT` 呼叫 `updateFundingSchedule`
- **THEN** 回傳 `UNKNOWN_INSTRUMENT`，註冊表內容不變

### Requirement: Per-exchange refresh isolation
註冊表 SHALL 以每所各自的完整 metadata 快照刷新（啟動時一次，之後每 `instrument_refresh_interval_ms`，預設 3,600,000）。單一交易所刷新失敗 MUST NOT 影響其他交易所，MUST 保留該所上一次成功的資料並把該所來源狀態設為 `FAILED`（含錯誤類型、HTTP 狀態、時間），MUST NOT 回退到字串正規化或以空清單覆寫。成功快照中不再出現的合約 MUST 轉為 `DELISTED`（原因 `ABSENT_FROM_SOURCE`）。

#### Scenario: One exchange fails, others refresh
- **WHEN** 刷新時 OKX metadata 請求回傳 HTTP 429，其他 4 所成功
- **THEN** OKX 合約保持上一次內容、OKX 來源狀態為 `FAILED` 且 `http_status = 429`，其他 4 所合約已更新

#### Scenario: Failure never empties the registry
- **WHEN** 某所首次刷新成功登錄 700 筆，第二次刷新逾時
- **THEN** 該所仍有 700 筆合約，且來源狀態為 `FAILED`、`error_kind = 'TIMEOUT'`

#### Scenario: Contract missing from successful snapshot
- **WHEN** Binance 成功快照中不再包含先前登錄的 `OLDUSDT`
- **THEN** `OLDUSDT.status = 'DELISTED'`，並產生 `INSTRUMENT_STATUS_CHANGED` 事件，`reason = 'ABSENT_FROM_SOURCE'`

### Requirement: Ambiguous instruments are not pairable
同一交易所中，若兩筆以上 `status = 'TRADING'` 的合約具有相同 `instrument_key` 與 `contract_type`，系統 SHALL 將它們全部標記 `ambiguous = true`，並產生 `INSTRUMENT_AMBIGUOUS` 事件；被標記者 MUST NOT 參與配對，直到歧義消失或以 `multiplier_overrides` 解決。

#### Scenario: Duplicate key on one exchange
- **WHEN** 某所同時有 `PEPEUSDT`（price_multiplier 1）與 `1000PEPEUSDT`（price_multiplier 1000），兩者 `instrument_key` 皆為 `PEPE/USDT:USDT`
- **THEN** 兩者 `ambiguous = true`，配對該所 `PEPE/USDT:USDT` 時回傳 `AMBIGUOUS_INSTRUMENT`

### Requirement: Pair matching rule
系統 SHALL 提供 `matchPair(long, short, { now, funding_alignment_tolerance_ms, price_mismatch_tolerance_pct, prices? })`，只有在下列條件全部成立時回傳 `matched = true`，否則回傳 `matched = false` 與第一個不成立條件的 `reason`（依下列順序檢查）：
1. 兩腿為不同交易所（否則 `SAME_EXCHANGE`）；
2. 兩腿皆已登錄且未被標記歧義（否則 `UNKNOWN_INSTRUMENT` / `AMBIGUOUS_INSTRUMENT`）；
3. `instrument_key` 相同（否則 `KEY_MISMATCH`）；
4. 兩腿 `contract_type` 皆屬 `pairable_contract_types`（預設 `['LINEAR_PERPETUAL']`，否則 `CONTRACT_TYPE_NOT_PAIRABLE`）；
5. 兩腿 `status = 'TRADING'`（否則 `NOT_TRADING`）；
6. 兩腿 `funding.schedule_status = 'VALID'` 且 `next_funding_time > now`（否則 `FUNDING_TIME_MISSING`）；
7. `|long.next_funding_time − short.next_funding_time| ≤ funding_alignment_tolerance_ms`（C-10，預設 60,000；否則 `FUNDING_NOT_ALIGNED`）；
8. 若提供 `prices`：兩腿標準化價格（報價 ÷ `price_multiplier`）相對差 ≤ `price_mismatch_tolerance_pct`（否則 `PRICE_MISMATCH`）。
成功結果 MUST 包含 `instrument_key`、兩腿 `instrument_id`、`long_funding_time`、`short_funding_time`、`long_funding_interval_hours`、`short_funding_interval_hours`、`funding_time_diff_ms`、`funding_aligned = true`，欄位名稱與規格書 §5 `Opportunity` 一致。

#### Scenario: Aligned linear pair matches
- **WHEN** Binance `BTCUSDT` 與 Bybit `BTCUSDT` 皆 TRADING、LINEAR_PERPETUAL，`next_funding_time` 分別為 T 與 T + 500 ms
- **THEN** `matched = true`、`instrument_key = 'BTC/USDT:USDT'`、`funding_time_diff_ms = 500`、`funding_aligned = true`

#### Scenario: 4h leg and 8h leg at different times rejected
- **WHEN** Binance 4h 腿 `next_funding_time = T1`、OKX 8h 腿 `next_funding_time = T1 + 4h`
- **THEN** `matched = false`、`reason = 'FUNDING_NOT_ALIGNED'`

#### Scenario: Delisting leg rejected
- **WHEN** Binance `STORJUSDT` 為 `DELISTING`，與 Bybit `STORJUSDT`（TRADING）配對
- **THEN** `matched = false`、`reason = 'NOT_TRADING'`

#### Scenario: TradFi leg rejected
- **WHEN** 一腿 `contract_type = 'TRADFI_PERPETUAL'`
- **THEN** `matched = false`、`reason = 'CONTRACT_TYPE_NOT_PAIRABLE'`

#### Scenario: Missing funding time rejected
- **WHEN** 一腿 `schedule_status = 'MISSING'`（例如 Bitget 未取得 `nextUpdate`）
- **THEN** `matched = false`、`reason = 'FUNDING_TIME_MISSING'`

#### Scenario: 1000x pair normalizes prices
- **WHEN** Binance `1000PEPEUSDT` 報價 0.004295（price_multiplier 1000）與 Bitget `PEPEUSDT` 報價 0.000004296（price_multiplier 1）配對，`price_mismatch_tolerance_pct = 0.02`
- **THEN** 標準化價格相對差 < 1%，`matched = true`

#### Scenario: Same ticker different asset rejected by price guard
- **WHEN** Binance `ONUSDT` 報價 0.1161 與 Bybit `ONUSDT` 報價 75.91 配對，且提供 `prices`
- **THEN** `matched = false`、`reason = 'PRICE_MISMATCH'`

### Requirement: Subscription and change notification interface
註冊表 SHALL 提供 `list(filter)`、`get(exchange, native_symbol)`、`findByKey(instrument_key)`、`subscribableSymbols(exchange)`（回傳 `status = 'TRADING'`、未歧義、`contract_type` 屬 `pairable_contract_types` 的原生 symbol）、`version()` 與 `onChange(listener)`。每次刷新或更新造成內容變動時 MUST 遞增 `version` 並以 diff（`added`、`removed`、`changed` 的 `instrument_id` 清單）通知所有 listener，供 `websocket-data-layer` 維護訂閱清單。

#### Scenario: Delisting removes symbol from subscription list
- **WHEN** Binance `STORJUSDT` 由 `TRADING` 轉為 `DELISTING`
- **THEN** `subscribableSymbols('Binance')` 不再包含 `STORJUSDT`，`version` 遞增，listener 收到的 diff 在 `changed` 中包含 `Binance:STORJUSDT`

#### Scenario: No-op refresh does not notify
- **WHEN** 刷新結果與現有內容完全相同
- **THEN** `version` 不變且 listener 未被呼叫

### Requirement: Registry transitions emit trading events
註冊表每一次狀態或規格轉換 SHALL 經注入的 `EventSink` 送出一筆 TradingEvent（技術書 §27 欄位，`payload` 含 `from`、`to`、`reason`），事件類型至少：`INSTRUMENT_LISTED`、`INSTRUMENT_STATUS_CHANGED`、`INSTRUMENT_SPEC_CHANGED`（`price_multiplier`、`qty_unit_in_base`、`tick_size`、`qty_step`、`min_qty`、`min_notional` 任一變動）、`FUNDING_SCHEDULE_CHANGED`、`INSTRUMENT_AMBIGUOUS`、`INSTRUMENT_UNKNOWN_VALUE`、`INSTRUMENT_SOURCE_STATUS_CHANGED`。事件 `timestamp` MUST 為轉換發生時的 `now`，`recorded_at` 為寫入時間，兩者分別記錄（規格書 §25 第 5 點）。`payload` MUST NOT 含任何憑證（Invariant #2）。

#### Scenario: Status change event
- **WHEN** Bybit `XUSDT` 在 `now = 7000` 由 `TRADING` 轉為 `DELISTING`
- **THEN** EventSink 收到一筆 `INSTRUMENT_STATUS_CHANGED`，`timestamp = 7000`、`exchange = 'Bybit'`、`symbol = 'XUSDT'`、`payload = { from: 'TRADING', to: 'DELISTING', reason: 'SOURCE_STATUS' }`

#### Scenario: Tick size change event
- **WHEN** 刷新後 Binance `BTCUSDT` 的 `tick_size` 由 0.1 變為 0.01
- **THEN** EventSink 收到一筆 `INSTRUMENT_SPEC_CHANGED`，payload 含 `field: 'tick_size'`、`from: 0.1`、`to: 0.01`

### Requirement: No exchange-name branching outside adapters
註冊表、配對與下單規格輔助程式（`runtime/src/market/instruments/`）MUST NOT 以交易所名稱做條件分支（Invariant #3）；所有交易所差異（端點、欄位對應、狀態對照、倍數來源、週期來源）MUST 只存在於 `runtime/src/adapters/<exchange>/`。

#### Scenario: Static check rejects exchange literal in registry code
- **WHEN** `runtime/src/market/instruments/` 下任一非測試原始檔包含字串字面值 `'Binance'`、`'Bybit'`、`'OKX'`、`'Bitget'` 或 `'Pionex'`
- **THEN** 自動檢查測試失敗並列出檔名

### Requirement: Order specification helpers
系統 SHALL 提供純函式：`roundQtyDown(instrument, qty)`（向下取整到 `qty_step`）、`roundPrice(instrument, price, side)`（買單向下、賣單向上取整到 `tick_size`）、`checkOrderMinimums(instrument, qty, price)`（回傳 `OK`、`BELOW_MIN_QTY` 或 `BELOW_MIN_NOTIONAL`），並提供 `toBaseQty(instrument, qty) = qty × qty_unit_in_base` 以換算標的數量。浮點取整 MUST 以步進的小數位數做十進位處理，避免 `0.1 + 0.2` 類誤差。

#### Scenario: Quantity rounded down to step
- **WHEN** Binance `BTCUSDT`（`qty_step = 0.001`）請求數量 0.0129
- **THEN** `roundQtyDown` 回傳 0.012

#### Scenario: Below minimum notional
- **WHEN** Binance `BTCUSDT`（`min_notional = 50`）以價格 60000 下 0.0008 單位
- **THEN** `checkOrderMinimums` 回傳 `BELOW_MIN_QTY`（`min_qty = 0.001`）；以 0.001 單位、價格 40000 則回傳 `BELOW_MIN_NOTIONAL`

#### Scenario: Base quantity conversion
- **WHEN** OKX `PEPE-USDT-SWAP`（`qty_unit_in_base = 10000000`）數量 0.5
- **THEN** `toBaseQty` 回傳 5,000,000

### Requirement: Research server uses the registry during transition
研究端 `server.ts` SHALL 以註冊表取代 `extractBaseSymbol`：`/api/market/live-scan` MUST 以 `instrument_key` 聚合各所資料、只以 `matchPair` 成立的組合計算 `best_pair` 與 `pair_spreads`、每個候選的結算時間 / 週期取自該組兩腿（不再取 5 所最小值），24h 量 MUST 取自各腿交易所且缺值時該組被淘汰（移除 `|| 10000000`）。既有回應欄位 MUST 保留（向下相容），並新增 `instrument_key`、`long_funding_time`、`short_funding_time`、`long_funding_interval_hours`、`short_funding_interval_hours`、`funding_aligned`、`long_volume_24h`、`short_volume_24h`、`registry_sources`（每所註冊表來源狀態）。`/api/market/live-klines` MUST 以註冊表把輸入解析為各所原生 symbol，輸入不符 `^[A-Z0-9]{2,20}$` 或查無合約時回 HTTP 400，上游非 2xx 時在回應中逐所標示錯誤。

#### Scenario: Reverse contract no longer overrides BTC
- **WHEN** 以包含 Pionex `BTC_USDT_PERP`（rate +0.0000163）與 `USDT_BTC_PERP`（rate −0.0000330）的 fixture 執行 live-scan 聚合
- **THEN** `instrument_key = 'BTC/USDT:USDT'` 候選的 `pionex_rate = 0.0000163`

#### Scenario: Misaligned best pair excluded
- **WHEN** 某 `instrument_key` 只有 Binance（T1，4h）與 OKX（T1 + 4h，8h）兩腿
- **THEN** 該 key 不產生候選（或 `funding_aligned = false` 且不計入 `threshold_qualified_count`），不得以 min(T) 當作共同結算時間

#### Scenario: Missing volume eliminates instead of defaulting
- **WHEN** 某組的一腿交易所沒有 24h 量資料
- **THEN** 該組不出現在 `candidates`，且沒有任何候選的 `volume_24h` 等於 10,000,000 的預設值

#### Scenario: Klines resolves 1000x symbol per exchange
- **WHEN** 請求 `/api/market/live-klines?symbol=1000PEPEUSDT`
- **THEN** Binance 以 `1000PEPEUSDT`、Pionex 以 `PEPE_USDT_PERP` 查詢

#### Scenario: Invalid klines symbol rejected
- **WHEN** 請求 `/api/market/live-klines?symbol=BTCUSDT%26limit%3D1500`
- **THEN** 回應 HTTP 400，且未發出任何上游請求

