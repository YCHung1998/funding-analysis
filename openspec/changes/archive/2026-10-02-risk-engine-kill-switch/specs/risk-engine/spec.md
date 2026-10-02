## ADDED Requirements

### Requirement: 風控檢查項目由真實輸入計算，輸入缺失不得 PASS
Risk Engine SHALL 以一份有固定順序的檢查定義表（check registry）描述每一個檢查項目：`check_code`（穩定的英文代碼，例 `CAPITAL`）、`name`、`stage`（`PRE_TRADE` / `ENTRY` / `POSITION`）、`critical`、門檻所用的 `PaperTradingConfig` 欄位、FAIL 時的 `reason_code`。每一項的狀態（`PASS` / `WARN` / `FAIL`）MUST 只由評估當下注入的輸入快照與設定計算，不得使用常數或寫死值；任一必要輸入缺失（`undefined`、`NaN`、來源回報不可用）時，該項 MUST 為 `FAIL`、`value = 'UNKNOWN'`、`reason_code = 'INPUT_MISSING'`。檢查邏輯 MUST NOT 依交易所名稱分支（Invariant #3）。

#### Scenario: 輸入缺失時為 FAIL 而非 PASS
- **WHEN** Pre-Trade 評估時 Bybit 腿的盤口快照為 `undefined`
- **THEN** `ORDERBOOK_DEPTH` 項目狀態為 `FAIL`、`value = 'UNKNOWN'`、`reason_code = 'INPUT_MISSING'`，整體結果不得為 PASS

#### Scenario: 相同輸入得到相同結果
- **WHEN** 以同一份輸入快照與同一個 `config_version` 評估兩次
- **THEN** 兩次產生的每一項 `status`、`value`、`reason_code` 完全相同

### Requirement: 評估結果彙總為 RiskStatusReport
每次評估 SHALL 產生一份 `RiskStatusReport`（沿用 `src/types/systemSpec.ts` 的欄位；v0.2 型別由 `trading-schema` 提供）與一個階段動作 `action`：
- `PRE_TRADE`：任一項 `FAIL` → `overall_status = 'ABORT'`、`action_recommendation = 'ABORT_PRE_FLIGHT'`、`action = 'BLOCK'`；否則 `overall_status = 'PASS'`、`action_recommendation = 'PROCEED_TRADE'`、`action = 'ALLOW'`。`WARN` MUST NOT 阻擋。
- `ENTRY` / `POSITION`：取所有 FAIL 項目中最嚴重的動作，嚴重度 `EMERGENCY_EXIT` > `HALT_ENTRY` > `CONTINUE`；`EMERGENCY_EXIT` 對應 `overall_status = 'EMERGENCY_EXIT'`、`action_recommendation = 'EMERGENCY_CLOSE_FILLED_LEG'`、`leg_imbalance_detected` 在 `LEG_IMBALANCE` 或 `POSITION_IMBALANCE` 為 FAIL 時為 `true`；`HALT_ENTRY` 對應 `overall_status = 'ABORT'`、`action_recommendation = 'ABORT_PRE_FLIGHT'`；`CONTINUE` 對應 `PASS` / `PROCEED_TRADE`。
`failed_reasons` MUST 依檢查定義表的順序列出所有 FAIL 項目的 `reason_code`（Pre-Trade 順序：CAPITAL、MAX_POSITIONS、MAX_NOTIONAL_PER_LEG、MAX_LEVERAGE、MIN_FUNDING_SPREAD、EXPECTED_NET_PNL、MAX_SLIPPAGE、ORDERBOOK_DEPTH、EXCHANGE_CONNECTIVITY、API_LATENCY、FUNDING_TIME_ALIGNMENT、EXISTING_EXPOSURE、DATA_FRESHNESS、CLOCK_RELIABILITY、ENTRY_GATE）。

#### Scenario: 一項 FAIL 即阻擋
- **WHEN** Pre-Trade 15 項中 14 項 PASS、`MAX_SLIPPAGE` 為 FAIL
- **THEN** `overall_status = 'ABORT'`、`action = 'BLOCK'`、`failed_reasons = ['MAX_SLIPPAGE_EXCEEDED']`

#### Scenario: WARN 不阻擋
- **WHEN** Pre-Trade 中 `API_LATENCY` 為 WARN、其餘皆 PASS
- **THEN** `overall_status = 'PASS'`、`action = 'ALLOW'`

#### Scenario: 多個 Entry FAIL 取最嚴重動作
- **WHEN** Entry 評估中 `PRICE_DEVIATION`（HALT_ENTRY）與 `LEG_IMBALANCE`（EMERGENCY_EXIT）同時 FAIL
- **THEN** `action = 'EMERGENCY_EXIT'`、`overall_status = 'EMERGENCY_EXIT'`、`leg_imbalance_detected = true`

### Requirement: 檢查結果寫入 risk_checks 並產生 TradingEvent
每次評估開始 SHALL 產生 `RISK_CHECK_STARTED` 事件，結束時產生 `RISK_CHECK_PASSED`（無 FAIL）或 `RISK_CHECK_FAILED`（payload 含 `stage`、`failed_reasons`、`action`、`opportunity_id` 或 `trade_id`）。`PRE_TRADE` 的每一項 MUST 各寫入一筆 `risk_checks`，欄位採 `trading-schema` 的 `RiskCheck`：`risk_check_id`、`opportunity_id`、`trade_id`（ARM 時尚無 Trade 則為空）、`stage`（ARM 評估 = `TRADE_CREATION`、PRE_FLIGHT 重跑 = `ORDER_SUBMISSION`、持續檢查 = `ENTRY` / `POSITION`）、`check_id`（= `check_code`）、`name`、`status`、`critical`、`value`、`threshold`、`reason`（= `reason_code`）、`config_version`、`created_at`（= 評估時間）、`updated_at`；FAIL 項目的輸入快照放在 `RISK_CHECK_FAILED` 事件 payload。`ENTRY` / `POSITION` 為持續檢查，MUST 在階段開始時寫入一次全部項目，之後只在某一項狀態改變時寫入該項，階段結束時再寫入一次全部項目。所有時間戳 MUST 為 epoch 毫秒並取自 `Clock`（`trading-clock`），事件 MUST 記錄 `clock_offset_ms`。

#### Scenario: 被否決的 Opportunity 仍可查到每一項
- **WHEN** 一筆 Opportunity 在 ARM 的 Pre-Trade 評估因 `STALE_MARKET_DATA` 被否決
- **THEN** `risk_checks` 中有 15 筆以該 `opportunity_id` 關聯的紀錄，其中 `DATA_FRESHNESS` 為 FAIL，且事件庫有一筆 `RISK_CHECK_FAILED`

#### Scenario: 持續檢查只在狀態改變時寫入
- **WHEN** 一筆 Trade 在 `ENTRY_PENDING` 期間被評估 20 次，只有第 12 次 `PRICE_DEVIATION` 由 PASS 變 FAIL
- **THEN** `risk_checks` 中該 Trade 的 ENTRY 紀錄為：開始時 7 筆 + 第 12 次 1 筆 + 階段結束 7 筆，共 15 筆

### Requirement: Pre-Trade CAPITAL — 可用資金
`CAPITAL` SHALL 在 `required_capital_usdt > available_capital_usdt` 時 FAIL，`reason_code = 'INSUFFICIENT_CAPITAL'`。`required_capital_usdt` 為規格書 §7 的 Capital Allocation（Required Margin + Fee Reserve + Slippage Reserve + Emergency Reserve），`available_capital_usdt` 為扣除所有已保留（§12，含尚未成交的 Trade）與已佔用資金後的餘額，兩者皆由 `position-accounting` 提供。

#### Scenario: 資金不足
- **WHEN** 單腿 1,000 USDT、5x（margin 200 + 200）、fee reserve 2、slippage reserve 2、emergency reserve 50（required = 454），而 available = 400（初始 10,000、已保留 9,600）
- **THEN** `CAPITAL` 為 FAIL、`reason_code = 'INSUFFICIENT_CAPITAL'`、`value = '454 / 400'`

#### Scenario: 資金足夠
- **WHEN** required = 454、available = 9,000
- **THEN** `CAPITAL` 為 PASS

### Requirement: Pre-Trade MAX_POSITIONS — 持倉數
`MAX_POSITIONS` SHALL 在「非終態 Trade 數（`CREATED` 起至 `CLOSED` / `ABORTED` / `FAILED` 之前，含已保留資金尚未成交者）≥ `max_positions`」或「同一場次非終態 Trade 數 ≥ `max_positions_per_session`（有設定時）」時 FAIL，`reason_code = 'MAX_POSITIONS'`（與 `settlement-session` 相同代碼；該 capability 的持倉上限由本項實作判斷）。

#### Scenario: 全域上限
- **WHEN** `max_positions = 3`，已有 2 筆 `HEDGED` 與 1 筆 `CREATED`
- **THEN** `MAX_POSITIONS` 為 FAIL

#### Scenario: 場次上限
- **WHEN** `max_positions = 5`、`max_positions_per_session = 1`，同一場次已有 1 筆 `ENTRY_PENDING`
- **THEN** `MAX_POSITIONS` 為 FAIL

### Requirement: Pre-Trade MAX_NOTIONAL_PER_LEG — 單腿名目上限
`MAX_NOTIONAL_PER_LEG` SHALL 在 `target_notional_per_leg_usdt > max_notional_per_leg_usdt` 時 FAIL，`reason_code = 'MAX_NOTIONAL_EXCEEDED'`（單腿定義見規格書 §7 / C-17）。

#### Scenario: 超過單腿上限
- **WHEN** `max_notional_per_leg_usdt = 1000`、`target_notional_per_leg_usdt = 1200`
- **THEN** `MAX_NOTIONAL_PER_LEG` 為 FAIL

### Requirement: Pre-Trade MAX_LEVERAGE — 槓桿
`MAX_LEVERAGE` SHALL 在 `leverage > max_leverage`，或 `leverage` 大於任一腿合約在 `instrument-registry` 回報的最大槓桿時 FAIL，`reason_code = 'MAX_LEVERAGE_EXCEEDED'`。

#### Scenario: 超過設定上限
- **WHEN** `max_leverage = 5`、Trade 的 `leverage = 10`
- **THEN** `MAX_LEVERAGE` 為 FAIL

#### Scenario: 超過合約上限
- **WHEN** `max_leverage = 5`、`leverage = 5`，但 short 腿合約的最大槓桿為 4
- **THEN** `MAX_LEVERAGE` 為 FAIL，`value` 指出是哪一腿

### Requirement: Pre-Trade MIN_FUNDING_SPREAD — 最低費率差
`MIN_FUNDING_SPREAD` SHALL 以小數比較（Invariant #5）：`funding_spread = short_funding_rate − long_funding_rate`（單次結算），在 `funding_spread < minimum_funding_spread_pct` 時 FAIL，`reason_code = 'BELOW_MIN_SPREAD'`。

#### Scenario: 費率差不足
- **WHEN** `long_funding_rate = 0.0001`、`short_funding_rate = 0.0004`（spread 0.0003）、`minimum_funding_spread_pct = 0.0005`
- **THEN** `MIN_FUNDING_SPREAD` 為 FAIL

#### Scenario: 方向相反
- **WHEN** `long_funding_rate = 0.0006`、`short_funding_rate = 0.0002`（spread −0.0004）
- **THEN** `MIN_FUNDING_SPREAD` 為 FAIL

### Requirement: Pre-Trade EXPECTED_NET_PNL — 預期淨利
`EXPECTED_NET_PNL` SHALL 在 `cost-model` 以 ARM 當下輸入重算的 `estimated_net_pnl_usdt < minimum_expected_net_pnl_usdt` 時 FAIL，`reason_code = 'BELOW_MIN_NET_PNL'`（與 `opportunity-lifecycle` ARM 規則同一代碼；該規則由本項實作判斷，不另寫一套）。

#### Scenario: 淨利低於門檻
- **WHEN** `estimated_net_pnl_usdt = 0.8`、`minimum_expected_net_pnl_usdt = 1.0`
- **THEN** `EXPECTED_NET_PNL` 為 FAIL

### Requirement: Pre-Trade MAX_SLIPPAGE — 最大滑價
`MAX_SLIPPAGE` SHALL 對每一腿以 `cost-model` 的盤口逐檔吃單（walk-the-book）估算目標數量的滑價，任一腿 `estimated_slippage > max_slippage_pct`（小數）時 FAIL，`reason_code = 'MAX_SLIPPAGE_EXCEEDED'`。

#### Scenario: 單腿滑價過大
- **WHEN** `max_slippage_pct = 0.001`，long 腿估算滑價 0.0004、short 腿 0.0012
- **THEN** `MAX_SLIPPAGE` 為 FAIL，`value` 標示 short 腿 0.0012

### Requirement: Pre-Trade ORDERBOOK_DEPTH — 盤口深度
`ORDERBOOK_DEPTH` SHALL 對每一腿計算「最佳價起 `max_slippage_pct` 範圍內、進場方向可成交的名目」，任一腿 `depth_usdt < target_notional_per_leg_usdt × depth_coverage_ratio` 時 FAIL，`reason_code = 'INSUFFICIENT_DEPTH'`。MUST NOT 以 24h 成交量推估深度（取代 v0.1 r6）。

#### Scenario: 深度不足
- **WHEN** `target_notional_per_leg_usdt = 1000`、`depth_coverage_ratio = 3`，short 腿範圍內可成交名目 2,400
- **THEN** `ORDERBOOK_DEPTH` 為 FAIL（2,400 < 3,000）

#### Scenario: 深度足夠
- **WHEN** 兩腿範圍內可成交名目分別為 5,200 與 3,100，門檻 3,000
- **THEN** `ORDERBOOK_DEPTH` 為 PASS

### Requirement: Pre-Trade EXCHANGE_CONNECTIVITY — 交易所連線與合約狀態
`EXCHANGE_CONNECTIVITY` SHALL 在任一腿交易所於 `runtime-health` 的狀態不是 `CONNECTED` 時 FAIL（`reason_code = 'EXCHANGE_DISCONNECTED'`），或任一腿合約在 `instrument-registry` 的狀態不是 `TRADING` 時 FAIL（`reason_code = 'INSTRUMENT_NOT_TRADING'`；取代 v0.1 永遠 PASS 的 r9）。

#### Scenario: 交易所斷線
- **WHEN** Bybit 的 runtime-health 狀態為 `DISCONNECTED`
- **THEN** `EXCHANGE_CONNECTIVITY` 為 FAIL、`reason_code = 'EXCHANGE_DISCONNECTED'`

#### Scenario: 合約已下架
- **WHEN** long 腿合約狀態為 `DELISTED`
- **THEN** `EXCHANGE_CONNECTIVITY` 為 FAIL、`reason_code = 'INSTRUMENT_NOT_TRADING'`

### Requirement: Pre-Trade API_LATENCY — API 延遲
`API_LATENCY` SHALL 取每一腿交易所最近 20 筆延遲樣本（`runtime-health` 提供）的中位數：任一腿 > `max_api_latency_ms` 時 FAIL（`reason_code = 'API_LATENCY_HIGH'`）；介於 `warn_api_latency_ms` 與 `max_api_latency_ms` 之間時 WARN。延遲門檻 MUST 來自設定，不得依交易所名稱給值（取代 v0.1 的三元式）。

#### Scenario: 延遲過高
- **WHEN** `max_api_latency_ms = 500`、`warn_api_latency_ms = 200`，Bybit 中位數 650 ms
- **THEN** `API_LATENCY` 為 FAIL

#### Scenario: 延遲偏高只警告
- **WHEN** Binance 中位數 250 ms、Bybit 120 ms，門檻同上
- **THEN** `API_LATENCY` 為 WARN

### Requirement: Pre-Trade FUNDING_TIME_ALIGNMENT — 結算時間與對齊
`FUNDING_TIME_ALIGNMENT` SHALL 以 ARM 當下重新讀取的兩腿 `funding_time` 與週期，呼叫 `settlement-session` 的合約資格判斷（不另寫一套），不合格時 FAIL 並沿用其代碼（`FUNDING_NOT_ALIGNED`、`FUNDING_INTERVAL_TOO_SHORT`、`EXCHANGE_NOT_TRADABLE`）；另在 `now ≥ entry_deadline`（`settlement-session` 時間表）時 FAIL，`reason_code = 'ENTRY_WINDOW_CLOSED'`。

#### Scenario: 結算時間不對齊
- **WHEN** long 腿 `funding_time = T`、short 腿 `funding_time = T + 120000`、`funding_alignment_tolerance_ms = 60000`
- **THEN** `FUNDING_TIME_ALIGNMENT` 為 FAIL、`reason_code = 'FUNDING_NOT_ALIGNED'`

#### Scenario: 進場窗口已過
- **WHEN** Binance × Bybit 配對（`entry_deadline = T − 25s`）在 `T − 20s` 評估
- **THEN** `FUNDING_TIME_ALIGNMENT` 為 FAIL、`reason_code = 'ENTRY_WINDOW_CLOSED'`

### Requirement: Pre-Trade EXISTING_EXPOSURE — 既有曝險
`EXISTING_EXPOSURE` SHALL 在同一 `symbol` 已有非終態 Trade 時 FAIL（`reason_code = 'EXISTING_EXPOSURE'`；對應規格書 §14.2「PARTIALLY_HEDGED 期間不接受新 Trade 佔用同一幣種」），或任一腿交易所的「既有非終態 Trade 在該所的單腿名目合計 + 本筆單腿名目 > `max_exchange_notional_usdt`」時 FAIL（`reason_code = 'EXCHANGE_EXPOSURE_LIMIT'`）。

#### Scenario: 同幣種已有部位
- **WHEN** `ETHUSDT` 已有一筆 `PARTIALLY_HEDGED` Trade，新 Opportunity 同為 `ETHUSDT`
- **THEN** `EXISTING_EXPOSURE` 為 FAIL、`reason_code = 'EXISTING_EXPOSURE'`

#### Scenario: 單一交易所曝險超限
- **WHEN** `max_exchange_notional_usdt = 3000`，Bybit 上既有非終態 Trade 單腿名目合計 2,500，新 Trade 單腿 1,000
- **THEN** `EXISTING_EXPOSURE` 為 FAIL、`reason_code = 'EXCHANGE_EXPOSURE_LIMIT'`

### Requirement: Pre-Trade DATA_FRESHNESS — 資料新鮮度
`DATA_FRESHNESS` SHALL 對評估所用的每一筆輸入（兩腿 ticker / mark price、盤口、預測費率）取 `trading-clock` 定義的時鐘校正後 `data_age_ms`，任一筆 `data_age_ms > data_stale_threshold_ms` 時 FAIL，`reason_code = 'STALE_MARKET_DATA'`（技術書 §8）。

#### Scenario: 盤口過舊
- **WHEN** `data_stale_threshold_ms = 2000`，short 腿盤口的 `data_age_ms = 3500`
- **THEN** `DATA_FRESHNESS` 為 FAIL，`value` 標示該筆輸入與 3,500 ms

#### Scenario: 以校正後時間判斷
- **WHEN** 本機比 Bybit 慢 60 ms、Bybit 訊息 `exchange_timestamp` 為 10,000、本機收到時間 11,950（校正前 1,950 ms，校正後 2,010 ms）、門檻 2,000
- **THEN** `DATA_FRESHNESS` 為 FAIL

### Requirement: Pre-Trade CLOCK_RELIABILITY — 時鐘可靠度
`CLOCK_RELIABILITY` SHALL 讀取 `trading-clock` 對每一腿交易所回報的 `offset(ex)`，任一腿 `errorMs > clock_max_error_ms` 或 `now − calibratedAt > clock_calibration_max_age_ms` 時 FAIL，`reason_code = 'CLOCK_UNRELIABLE'`。時鐘健康的判定規則屬於 `trading-clock`；本項是其「阻擋新進場」要求的執行點。

#### Scenario: 時鐘誤差過大
- **WHEN** `clock_max_error_ms = 500`，Bybit 的 `errorMs = 800`
- **THEN** `CLOCK_RELIABILITY` 為 FAIL、`reason_code = 'CLOCK_UNRELIABLE'`

#### Scenario: 校正過期
- **WHEN** `clock_calibration_max_age_ms = 180000`，Binance 最後一次校正在 200,000 ms 前
- **THEN** `CLOCK_RELIABILITY` 為 FAIL

### Requirement: Pre-Trade ENTRY_GATE — 系統停止進場閘門
`ENTRY_GATE` SHALL 在進場閘門被任一來源關閉時 FAIL，`reason_code` 取該來源的代碼。本 change 定義的來源：存在 `status = 'FAILED'` 且尚未標記人工確認（`reviewed_at` 為空）的 Trade → `TRADE_FAILED_PENDING_REVIEW`（規格書 §26.2「停止新交易並待人工確認」）。閘門 MUST 接受其他來源以注入方式加入（例：`runtime-health` / `reconciliation` 的 `ENTRY_HALT_REQUESTED`、`kill-switch` 的 `KILL_SWITCH_ACTIVE`），每個來源各自開啟 / 關閉，任一來源開啟即 FAIL。

#### Scenario: 有未確認的 FAILED Trade
- **WHEN** 一筆 Trade 因 `RECONCILIATION_ERROR` 轉為 `FAILED` 且 `reviewed_at` 為空
- **THEN** 之後所有 Pre-Trade 評估的 `ENTRY_GATE` 為 FAIL、`reason_code = 'TRADE_FAILED_PENDING_REVIEW'`

#### Scenario: 注入來源關閉閘門
- **WHEN** 閘門注入來源 `ENTRY_HALT_REQUESTED`（reason `RECONCILIATION_ERROR`）為開啟
- **THEN** Pre-Trade 評估的 `ENTRY_GATE` 為 FAIL、`reason_code = 'RECONCILIATION_ERROR'`

#### Scenario: 人工確認後恢復
- **WHEN** 該 FAILED Trade 被寫入 `reviewed_at`，且沒有其他閘門來源
- **THEN** 下一次 Pre-Trade 評估的 `ENTRY_GATE` 為 PASS

### Requirement: ARM 與 PRE_FLIGHT 呼叫 Pre-Trade Risk
在 `settlement-session` 的 ARM 階段，當 `opportunity-lifecycle` 完成 ARM 重算後，系統 SHALL 對每一筆仍有效的 Opportunity 執行一次完整 Pre-Trade 評估（15 項）：`action = 'ALLOW'` 才可轉為 `SELECTED`、由 `position-accounting` 原子保留資金並建立 Trade，並將該份 `RiskStatusReport` 寫入 `Trade.risk_status`；`action = 'BLOCK'` 時 Opportunity MUST 轉為 `REJECTED`，`rejection_reason` 為 `failed_reasons` 的第一項，且不得保留任何資金。Trade 進入 `PRE_FLIGHT`（送單前）時 SHALL 再以最新輸入重跑 `EXCHANGE_CONNECTIVITY`、`API_LATENCY`、`FUNDING_TIME_ALIGNMENT`、`DATA_FRESHNESS`、`CLOCK_RELIABILITY`、`ENTRY_GATE` 六項；任一 FAIL → Trade 轉 `ABORTED`（reason 為該 `reason_code`）並釋放保留資金，不得送出任何訂單。

#### Scenario: ARM 通過建立 Trade
- **WHEN** ARM 時某 Opportunity 的 15 項全部 PASS
- **THEN** Opportunity 轉 `SELECTED`、建立一筆 `CREATED` Trade，其 `risk_status.overall_status = 'PASS'`

#### Scenario: ARM 否決不保留資金
- **WHEN** ARM 時 `CAPITAL` 與 `DATA_FRESHNESS` 皆 FAIL
- **THEN** Opportunity 轉 `REJECTED`、`rejection_reason = 'INSUFFICIENT_CAPITAL'`（定義表順序較前者），`available_capital_usdt` 不變，不建立 Trade

#### Scenario: PRE_FLIGHT 發現資料過舊
- **WHEN** Trade 在 ARM 通過，但進入 `PRE_FLIGHT` 時 long 腿 `data_age_ms = 4000`（門檻 2,000）
- **THEN** Trade 轉 `ABORTED`、reason `STALE_MARKET_DATA`，保留資金全數釋放，沒有任何 `ORDER_CREATED` 事件

### Requirement: Entry Risk 持續檢查與動作
Trade 處於 `ENTRY_PENDING` 或 `PARTIALLY_HEDGED` 時，系統 SHALL 在該 Trade 兩腿的每一筆行情事件、每一筆進場訂單事件，以及至少每 `entry_risk_interval_ms`（Clock 排程）執行 Entry 評估。動作語意：`HALT_ENTRY` = 該 Trade 不得再送出任何新的或補足用的進場單，並要求 `paper-execution` 撤銷其未終結的進場單（撤單後的 hedge ratio 分類與狀態轉換依規格書 §14 由 `paper-execution` 處理）；`EMERGENCY_EXIT` = 要求 `paper-execution` 依規格書 §15 啟動緊急流程。Risk Engine MUST NOT 自行改變 Trade / Order 狀態。

#### Scenario: HALT_ENTRY 只觸發撤進場單
- **WHEN** long 腿已成交 1,000 USDT、short 腿進場單仍在 `ACKNOWLEDGED`，Entry 評估結果為 `HALT_ENTRY`
- **THEN** Risk Engine 向 `paper-execution` 發出撤銷 short 腿進場單的請求，且之後該 Trade 的補單請求被拒絕（reason `RISK_HALT_ENTRY`）

### Requirement: Entry PRICE_DEVIATION — 價格偏離
`PRICE_DEVIATION` SHALL 在任一腿 `|mid − target_entry_price| / target_entry_price > max_entry_price_deviation_pct` 時 FAIL，`reason_code = 'PRICE_DEVIATION'`，動作 `HALT_ENTRY`。

#### Scenario: 價格偏離過大
- **WHEN** `max_entry_price_deviation_pct = 0.003`，short 腿 `target_entry_price = 100.00`、目前 mid = 100.40（偏離 0.004）
- **THEN** `PRICE_DEVIATION` 為 FAIL、動作 `HALT_ENTRY`

### Requirement: Entry FUNDING_RATE_CHANGE — 費率變動
`FUNDING_RATE_CHANGE` SHALL 在目前預測 spread 與 ARM 評估時的 spread 符號相反，或 `ARM spread − 目前 spread > rate_change_tolerance` 時 FAIL，`reason_code = 'FUNDING_RATE_CHANGED'`，動作 `HALT_ENTRY`。

#### Scenario: 費率差縮小超過容忍值
- **WHEN** `rate_change_tolerance = 0.0002`，ARM 時 spread 0.0010、目前 0.0007
- **THEN** `FUNDING_RATE_CHANGE` 為 FAIL

#### Scenario: 小幅變動不觸發
- **WHEN** ARM 時 spread 0.0010、目前 0.0009
- **THEN** `FUNDING_RATE_CHANGE` 為 PASS

### Requirement: Entry ORDER_TIMEOUT — 訂單逾時
`ORDER_TIMEOUT` SHALL 在該 Trade 任一進場單出現 `ORDER_TIMEOUT` 或 `ORDER_ACK_TIMEOUT` 事件時 FAIL，`reason_code = 'ORDER_TIMEOUT'`，動作 `HALT_ENTRY`（第一版不重新定價；兩腿皆 0 成交時最終為 `ABORTED` / `ENTRY_TIMEOUT`，由 `paper-execution` 依規格書 §12 處理）。

#### Scenario: 進場單逾時
- **WHEN** `max_order_lifetime_ms = 500`，Bybit 進場單送出 500 ms 後仍 0 成交並產生 `ORDER_TIMEOUT`
- **THEN** `ORDER_TIMEOUT` 為 FAIL、動作 `HALT_ENTRY`

### Requirement: Entry PARTIAL_FILL — 部分成交
`PARTIAL_FILL` SHALL 在 Trade 為 `PARTIALLY_HEDGED` 時為 WARN（`value` 為已持續時間），持續時間 ≥ `partial_hedge_max_duration_ms` 時 FAIL，`reason_code = 'PARTIAL_HEDGE_TIMEOUT'`，動作 `EMERGENCY_EXIT`。`funding-settlement-rules` 的 `hedged_by` 截止規則若先到，仍以該規則為準。

#### Scenario: 部分對沖超時
- **WHEN** `partial_hedge_max_duration_ms = 5000`，Trade 自 t0 起為 `PARTIALLY_HEDGED`，評估時間為 t0 + 5000
- **THEN** `PARTIAL_FILL` 為 FAIL、動作 `EMERGENCY_EXIT`

#### Scenario: 超時前只警告
- **WHEN** 同上但評估時間為 t0 + 3000
- **THEN** `PARTIAL_FILL` 為 WARN、`value = '3000ms'`

### Requirement: Entry LEG_IMBALANCE — 單腿失衡
`LEG_IMBALANCE` SHALL 在任一進場單到達終態（`FILLED` / `CANCELED` / `REJECTED` / `EXPIRED`）時，以 `position-accounting` 提供的 `hedge_ratio`（計算基準待 C-19）判斷，`hedge_ratio < hedge_ratio_imbalance_below` 時 FAIL，`reason_code = 'LEG_IMBALANCE'`，動作 `EMERGENCY_EXIT`。兩腿皆 0 成交時 MUST NOT 判為 LEG_IMBALANCE。

#### Scenario: 一腿被拒
- **WHEN** long 腿 `FILLED` 1,000 USDT、short 腿進場單 `REJECTED`（0 成交）
- **THEN** `hedge_ratio = 0`、`LEG_IMBALANCE` 為 FAIL、動作 `EMERGENCY_EXIT`

#### Scenario: 部分成交低於下門檻
- **WHEN** `hedge_ratio_imbalance_below = 0.90`，long 1,000 FILLED、short 進場單 `CANCELED` 且成交 300
- **THEN** `hedge_ratio = 0.30`、`LEG_IMBALANCE` 為 FAIL

#### Scenario: 兩腿都未成交
- **WHEN** 兩腿進場單皆 `CANCELED` 且成交量 0
- **THEN** `LEG_IMBALANCE` 為 PASS

### Requirement: Entry EXCHANGE_CONNECTION — 進場中連線
`EXCHANGE_CONNECTION` SHALL 在進場期間任一腿交易所於 `runtime-health` 不是 `CONNECTED` 時 FAIL，`reason_code = 'EXCHANGE_DISCONNECTED'`，動作 `HALT_ENTRY`。

#### Scenario: 進場中斷線
- **WHEN** Trade 為 `ENTRY_PENDING` 時收到 Binance `EXCHANGE_DISCONNECTED`
- **THEN** `EXCHANGE_CONNECTION` 為 FAIL、動作 `HALT_ENTRY`

### Requirement: Entry MARKET_VOLATILITY — 市場波動
`MARKET_VOLATILITY` SHALL 對每一腿計算最近 `volatility_window_ms` 內 mid price 的 `(max − min) / min`，任一腿 > `max_entry_volatility_pct` 時 FAIL，`reason_code = 'MARKET_VOLATILITY'`，動作 `HALT_ENTRY`。視窗內樣本少於 2 筆時 MUST 為 `INPUT_MISSING` FAIL。

#### Scenario: 短時間劇烈波動
- **WHEN** `volatility_window_ms = 5000`、`max_entry_volatility_pct = 0.005`，short 腿最近 5 秒 mid 最低 100.0、最高 100.6
- **THEN** `MARKET_VOLATILITY` 為 FAIL（0.006 > 0.005）

### Requirement: Position Risk 持續檢查
Trade 處於 `HEDGED` 或 `EXIT_PENDING` 時，系統 SHALL 在兩腿每一筆行情事件與至少每 `position_risk_interval_ms` 執行 Position 評估；FAIL 項目的動作為 `EMERGENCY_EXIT`（WARN 不動作）。緊急流程在鎖定區間內仍可執行，資金費資格依 `funding-settlement-rules` 標為 `NOT_ELIGIBLE`。

#### Scenario: HEDGED 期間觸發緊急平倉
- **WHEN** 一筆 `HEDGED` Trade 的 Position 評估有任一項 FAIL
- **THEN** Risk Engine 向 `paper-execution` 發出 `EMERGENCY_EXIT` 請求並產生 `RISK_CHECK_FAILED` 事件

### Requirement: Position POSITION_IMBALANCE — 部位失衡
`POSITION_IMBALANCE` SHALL 以 `position-accounting` 的 `hedge_ratio`：`< hedge_ratio_imbalance_below` 時 FAIL（`reason_code = 'POSITION_IMBALANCE'`），介於 `hedge_ratio_imbalance_below` 與 `hedge_ratio_hedged_min` 之間時 WARN。

#### Scenario: 持倉中失衡
- **WHEN** `hedge_ratio_imbalance_below = 0.90`，一筆 HEDGED Trade 的 `hedge_ratio` 降為 0.85
- **THEN** `POSITION_IMBALANCE` 為 FAIL、動作 `EMERGENCY_EXIT`

#### Scenario: 輕微失衡只警告
- **WHEN** `hedge_ratio = 0.95`、`hedged_min = 0.99`
- **THEN** `POSITION_IMBALANCE` 為 WARN

### Requirement: Position MARK_PRICE_MOVEMENT — Mark price 不利變動
`MARK_PRICE_MOVEMENT` SHALL 對每一腿以 mark price 計算未實現虧損佔該腿 `margin_allocated_usdt` 的比例，任一腿 ≥ `max_leg_margin_loss_ratio` 時 FAIL，`reason_code = 'MARK_PRICE_ADVERSE'`。

#### Scenario: 空單腿接近保證金耗盡
- **WHEN** `max_leg_margin_loss_ratio = 0.5`，short 腿數量 10、均價 100、5x、保證金 200，mark price 升至 110（未實現虧損 100）
- **THEN** `MARK_PRICE_MOVEMENT` 為 FAIL（100 / 200 = 0.5）

### Requirement: Position BASIS_DIVERGENCE — 基差分歧
`BASIS_DIVERGENCE` SHALL 計算 `basis = (mark_short − mark_long) / mark_long`，`|basis_now − basis_at_entry| > max_basis_divergence_pct` 時 FAIL（`reason_code = 'BASIS_DIVERGENCE'`），大於門檻一半時 WARN。`basis_at_entry` 以兩腿平均進場價計算（取代 v0.1 永遠 PASS 的 r5）。

#### Scenario: 基差擴大
- **WHEN** `max_basis_divergence_pct = 0.005`，進場基差 0.001、目前 0.007
- **THEN** `BASIS_DIVERGENCE` 為 FAIL（差 0.006）

#### Scenario: 基差小幅擴大
- **WHEN** 進場基差 0.001、目前 0.004（差 0.003），門檻 0.005
- **THEN** `BASIS_DIVERGENCE` 為 WARN

### Requirement: Position FUNDING_CHANGE — 持倉中費率翻轉
`FUNDING_CHANGE` SHALL 以目前預測費率、持倉數量與 mark price 重算本次結算的預期資金費現金流；在 `now < hedged_by` 且預期資金費 < −`estimated_exit_cost_usdt`（`cost-model` 提供）時 FAIL，`reason_code = 'FUNDING_FLIPPED'`；`now ≥ hedged_by` 時同一條件只記 WARN（鎖定區間內費率翻轉不構成緊急平倉理由）。

#### Scenario: 結算前費率翻轉
- **WHEN** `hedged_by = T − 15s`，在 T − 20s 重算預期資金費為 −1.5 USDT、平倉成本 1.0 USDT
- **THEN** `FUNDING_CHANGE` 為 FAIL、動作 `EMERGENCY_EXIT`

#### Scenario: 鎖定區間內只警告
- **WHEN** 同樣條件但評估時間為 T − 10s
- **THEN** `FUNDING_CHANGE` 為 WARN，不觸發緊急平倉

### Requirement: Position HOLDING_TIME — 持倉時間
`HOLDING_TIME` SHALL 在 `now − entry_completed_at > max_holding_time_ms` 且 Trade 未 `CLOSED` 時 FAIL，`reason_code = 'HOLDING_TIME_EXCEEDED'`（單次結算策略的安全上限）。

#### Scenario: 持倉過久
- **WHEN** `max_holding_time_ms = 600000`，Trade 於 t0 完成進場，評估時間 t0 + 600001 仍為 HEDGED
- **THEN** `HOLDING_TIME` 為 FAIL、動作 `EMERGENCY_EXIT`

### Requirement: Position EXIT_CONDITION — 退出停滯
`EXIT_CONDITION` SHALL 在 Trade 進入 `EXIT_PENDING` 超過 `emergency_exit_timeout_ms` 仍未兩腿 `CLOSED` 時 FAIL，`reason_code = 'EXIT_STALLED'`，動作 `EMERGENCY_EXIT`。正常退出時間（`exit_at`）由 `funding-settlement-rules` 決定，本項不重複判斷。

#### Scenario: 平倉單卡住
- **WHEN** `emergency_exit_timeout_ms = 5000`，Trade 於 T+30s 進入 `EXIT_PENDING`，T+35.001s 時 short 腿仍 `CLOSING`
- **THEN** `EXIT_CONDITION` 為 FAIL、動作 `EMERGENCY_EXIT`

### Requirement: 每一個檢查項目都有 FAIL 測試
檢查定義表中的每一個 `check_code`（Pre-Trade 15、Entry 7、Position 6，共 28 項）SHALL 至少有一個讓它 FAIL 的自動化測試與一個 `INPUT_MISSING` 測試；一個遍歷檢查定義表的測試 MUST 在任何 `check_code` 缺少 FAIL 測試時失敗（解決 HANDOFF P7「r5 / r7 / r9 永遠 PASS」）。

#### Scenario: 新增檢查未附 FAIL 測試
- **WHEN** 檢查定義表新增一個 `check_code`，但測試的 FAIL 情境清單沒有對應項目
- **THEN** 覆蓋率測試失敗並列出缺少 FAIL 測試的 `check_code`

### Requirement: Scenario S09 / S10 的風控部分
Scenario Test（技術書 §42，錄製資料 + 固定 seed 的 failure injection，技術書 §37）SHALL 驗證：S09 Stale Market Data 注入後，ARM 的 Opportunity 以 `STALE_MARKET_DATA` 被否決且無 Trade；S10 Exchange Disconnect 在 ENTRY_PENDING 時注入，Entry 評估產生 `HALT_ENTRY` 並產生 `RISK_CHECK_FAILED` 事件。每個 Scenario 結束時斷言所有 `risk_checks` 有 `created_at` / `updated_at`、事件時間單調不減（規格書 §25）。

#### Scenario: S09 資料過舊
- **WHEN** 以 seed 42 注入 Bybit 行情停止更新 3 秒（`data_stale_threshold_ms = 2000`），場次到達 ARM
- **THEN** 該場次所有含 Bybit 腿的 Opportunity 為 `REJECTED` / `STALE_MARKET_DATA`，沒有任何 Trade 被建立

#### Scenario: S10 進場中斷線
- **WHEN** 以 seed 42 在 Trade `ENTRY_PENDING` 時注入 Bybit 斷線
- **THEN** 事件庫依序出現 `EXCHANGE_DISCONNECTED`、`RISK_CHECK_FAILED`（`failed_reasons` 含 `EXCHANGE_DISCONNECTED`、`action = 'HALT_ENTRY'`）
