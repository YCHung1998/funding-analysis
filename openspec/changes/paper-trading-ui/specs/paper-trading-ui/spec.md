## ADDED Requirements

### Requirement: Paper Trading 分頁以 lazy load 掛載
研究 UI SHALL 提供 `ActiveTab = 'paper'` 的 Paper Trading 分頁，Header 標籤為 `Paper Trading`。該分頁元件 MUST 以 `React.lazy` 動態載入並包在 `Suspense` 內（FE-06），預設分頁（`funnel`）載入時 MUST NOT 請求 Paper Trading 的 chunk。`HelpModal` SHALL 提供 `paper` 條目，說明本分頁是 Observer / Controller、資料來源與 `Net = Funding + Price − Fees`。

#### Scenario: 預設分頁不載入 Paper chunk
- **WHEN** 使用者開啟首頁（`funnel` 分頁）且未點擊 Paper Trading
- **THEN** 網路請求中沒有 Paper Trading 分頁的 JS chunk，且 `npm run build` 產物中 Paper Trading 為獨立 chunk

#### Scenario: 切換到 Paper 分頁顯示載入中再顯示內容
- **WHEN** 使用者點擊 Header 的 `Paper Trading` 標籤
- **THEN** 先顯示 Suspense fallback，chunk 載入後顯示 Account、Trades、Runtime Health 區塊

#### Scenario: Paper 分頁的說明
- **WHEN** 使用者在 Paper 分頁點擊 Header 的「使用說明 (?)」
- **THEN** HelpModal 顯示 `paper` 條目，內含「UI 不決定交易狀態」與 `Net = Funding + Price − Fees`

### Requirement: 既有 Dry-Run 與 Execution Simulator 分頁明確標示為非 Paper
Header 中 `dryrun` 分頁標籤 SHALL 附 `FROZEN` 標示，`simulator` 分頁標籤 SHALL 附 `MOCK` 標示（規格書 §1.1、README §4），兩者的元件行為 MUST NOT 被本 change 修改；Paper Trading 分頁 MUST NOT 讀取或匯入 `dryRunEngine`、`mockMarketData`、`arbitrageEngine` 的任何資料。

#### Scenario: 凍結分頁標示
- **WHEN** Header 渲染完成
- **THEN** `M6/M7. Dry-Run & Risk Console` 標籤旁顯示 `FROZEN`，`M5. 60s Execution Flow` 標籤旁顯示 `MOCK`

#### Scenario: Paper 分頁不依賴 dry-run 引擎
- **WHEN** 以靜態檢查掃描 `src/features/paperTrading/` 的 import
- **THEN** 不存在對 `src/engine/dryRunEngine`、`src/data/mockMarketData`、`src/engine/arbitrageEngine` 的 import

### Requirement: UI 只觀察 Runtime 狀態，不計算也不決定交易狀態
Paper Trading 分頁的所有狀態、金額、Hedge Ratio、Funding、PnL、ROI、Duration SHALL 直接取自 `server.ts` 唯讀 API 回傳的 Runtime 資料並只做格式化；UI MUST NOT 依 WebSocket 事件自行推導或覆寫 Trade / Leg / Order / FundingSettlement 的狀態欄位。收到與某 Trade 相關的事件時，UI SHALL 重新向 API 取得該 Trade 的快照。費率 SHALL 以小數接收，只在顯示時 ×100（Invariant #5）。

#### Scenario: 事件不直接改寫狀態
- **WHEN** WebSocket 收到 `TRADE_STATUS_CHANGED`（`to = 'HEDGED'`），但尚未取得新的 Trade 快照
- **THEN** Current Trades 該列仍顯示快照中的舊狀態，並觸發一次該 Trade 的重新查詢；新快照回來後才顯示 `HEDGED`

#### Scenario: 費率顯示換算
- **WHEN** API 回傳 `funding_rate = 0.0001`
- **THEN** 畫面顯示 `0.0100%`，且元件內沒有把 0.01 當作小數傳遞的程式路徑

### Requirement: Account 區
Account 區 SHALL 顯示 AccountSnapshot 的 `Total Capital`、`Available Capital`、`Allocated Capital`、`Current Positions`、`Max Positions`（規格書 §27）與快照時間 `snapshot_at`。快照時間超過 `account_stale_after_ms`（預設 10 000 ms）時 SHALL 以 `STALE` 標示並淡化數值。

#### Scenario: 顯示帳戶數值
- **WHEN** API 回傳 `total_capital_usdt = 10000`、`available_capital_usdt = 9092`、`allocated_capital_usdt = 908`、`current_positions = 2`、`max_positions = 5`
- **THEN** Account 區顯示這五個值，Positions 顯示為 `2 / 5`

#### Scenario: 帳戶快照過舊
- **WHEN** 目前時間減 `snapshot_at` 大於 10 000 ms
- **THEN** Account 區顯示 `STALE` 標籤與最後更新時間

### Requirement: 狀態代碼以英文顯示並由單一術語表提供中文說明
凡顯示 Opportunity / Trade / Leg / Order / FundingSettlement 狀態、TradingEvent 類型、Runtime Health 狀態之處，SHALL 使用共用 `StatusCode` 元件：只顯示英文代碼，旁邊有 `?` 按鈕，點擊後顯示中文名稱（`zh`）與一句話定義（`definition_zh`）（C-15）。資料 MUST 只來自 `runtime/src/types/glossary.ts` 匯出的術語表；`src/features/paperTrading/` 與本 change 新增的共用元件內 MUST NOT 另外定義狀態代碼的中文名稱或定義（既有凍結分頁的舊說明文字不在此限）。術語表查無代碼時 SHALL 顯示代碼與「術語表缺少此代碼」提示。

#### Scenario: 點擊問號顯示中文定義
- **WHEN** 使用者點擊 `PARTIALLY_HEDGED` 旁的 `?`
- **THEN** 彈出內容顯示「部分對沖」與術語表中該代碼的 `definition_zh`，且預設畫面上只看得到 `PARTIALLY_HEDGED`

#### Scenario: 術語表涵蓋 UI 可能顯示的所有代碼
- **WHEN** 測試列舉 `TradeStatus`、`LegStatus`、`OrderState`、`settlement_status`、`OpportunityStatus`、`TradingEventType` 與 Health 狀態的所有值
- **THEN** 每個值在術語表中都有條目，否則測試失敗

#### Scenario: UI 不得有第二份術語表
- **WHEN** 測試讀取術語表所有 `zh` 值，並掃描 `src/features/paperTrading/` 的原始碼字面值
- **THEN** 沒有任何字串字面值與這些中文名稱完全相同（例如 `'部分對沖'`）

#### Scenario: 未知代碼
- **WHEN** `StatusCode` 收到術語表沒有的代碼 `FOO_BAR`
- **THEN** 顯示 `FOO_BAR` 與「術語表缺少此代碼」，不拋出錯誤

### Requirement: Current Trades 列表
Current Trades SHALL 列出所有未達終態的 Trade（`CREATED`、`PRE_FLIGHT`、`ENTRY_PENDING`、`PARTIALLY_HEDGED`、`LEG_IMBALANCE`、`HEDGED`、`EXIT_PENDING`、`EMERGENCY_EXIT`），欄位為 Trade ID、Symbol、Long Exchange、Short Exchange、Notional per Leg、Leverage、Status、Hedge Ratio、Unrealized PnL、Funding Expected（規格書 §27）。`LEG_IMBALANCE` 與 `EMERGENCY_EXIT` 的列 SHALL 以警示樣式突顯。點擊任一列 SHALL 開啟該 Trade 的 Trade Detail。

#### Scenario: 顯示進行中交易欄位
- **WHEN** API 回傳一筆 `status = 'HEDGED'`、`hedge_ratio = 0.995`、`target_notional_per_leg_usdt = 1000` 的 Trade
- **THEN** 該列顯示 Notional per Leg `1,000`、Hedge Ratio `99.5%`、Status `HEDGED` 附 `?`

#### Scenario: 失衡交易突顯
- **WHEN** 一筆 Trade 的狀態為 `LEG_IMBALANCE`
- **THEN** 該列以警示樣式顯示，並排在同一排序鍵下的正常交易之前

#### Scenario: 開啟 Trade Detail
- **WHEN** 使用者點擊某列
- **THEN** 顯示該 `trade_id` 的 Trade Detail

### Requirement: Completed Trades 列表必須包含失敗與未成交交易
Completed Trades SHALL 列出所有終態 Trade（`CLOSED`、`ABORTED`、`FAILED`），包含 `close_reason = 'EMERGENCY_EXIT' | 'KILL_SWITCH'`、0 成交逾時、訂單被拒、撤單的交易（技術書 §48.1），欄位為 Trade Time、Symbol、Entry、Exit、Funding、Fees、Slippage（歸因樣式）、Net PnL、Duration、Result（`final_status`）（規格書 §27）。SHALL 提供依 `final_status` 分類的篩選（全部 / `PROFIT` / `LOSS` / `BREAK_EVEN` / `ABORTED` / `FAILED` / `EMERGENCY_EXIT`），預設「全部」。列表 MUST 以伺服器端游標分頁載入（每頁預設 50 筆，FE-04），任何時刻 DOM 中的資料列 MUST NOT 超過一頁的筆數。

#### Scenario: 失敗交易預設可見
- **WHEN** 資料中有 1 筆 `PROFIT`、1 筆 `ABORTED`（`result_reason = 'ENTRY_TIMEOUT'`、Filled Notional 0）、1 筆 `EMERGENCY_EXIT`
- **THEN** 預設篩選「全部」下三筆都顯示，且 `ABORTED` 列顯示 `result_reason`

#### Scenario: 依結果篩選
- **WHEN** 使用者選擇篩選 `EMERGENCY_EXIT`
- **THEN** 以 `final_status = 'EMERGENCY_EXIT'` 重新查詢 API，只顯示該類交易

#### Scenario: 分頁限制 DOM 列數
- **WHEN** Completed Trades 共有 803 筆
- **THEN** 初始只渲染 50 列並顯示「載入下一頁」；載入下一頁後列表仍最多保留一頁的列數

### Requirement: 資金費待入帳與定案顯示
對於 `status = 'CLOSED'` 且 `TradeResult.funding_confirmed = false` 的 Trade，Completed Trades 與 Trade Detail SHALL 顯示「已平倉 · 待入帳」；當 `funding_confirmed = true` 且 `finalized_at` 存在時 SHALL 改顯示「已定案」。兩種情況都 MUST 標示「推定結算（依公開已結算費率）」（`paper-trading-event-loop` design Decision 6）。任一腿 `settlement_status = 'MISSED'` 時 SHALL 顯示「需人工檢查」警示。待入帳的 Net PnL SHALL 以暫定樣式顯示。

#### Scenario: 已平倉待入帳
- **WHEN** 一筆 Trade `status = 'CLOSED'`、`funding_confirmed = false`
- **THEN** 列表顯示「已平倉 · 待入帳」、「推定結算（依公開已結算費率）」，Net PnL 以暫定樣式顯示

#### Scenario: 轉為已定案
- **WHEN** 同一筆 Trade 重新查詢後 `funding_confirmed = true` 且有 `finalized_at`
- **THEN** 顯示改為「已定案」，仍保留「推定結算（依公開已結算費率）」標示

#### Scenario: 結算缺失
- **WHEN** 任一腿 `settlement_status = 'MISSED'`
- **THEN** 顯示「需人工檢查」警示與該腿 `MISSED` 代碼

### Requirement: 滑價以歸因樣式顯示且不另外扣除
凡顯示 Slippage 之處（Completed Trades、Trade Detail Entry / Result、損益瀑布圖）SHALL 使用共用 `SlippageAttribution` 元件：以與一般金額不同的樣式（灰色、括號、斜體）顯示 `slippage_attribution_usdt`，並標註「已含在 Price PnL 中，不另外扣除」；其 `?` MUST 說明 `Net = Funding + Price − Fees`，自行加總時不要再減 Slippage（規格書 §20.1、C-13）。損益瀑布圖中 Slippage MUST 是 Price PnL 的子項，Net PnL 長條 MUST 等於 API 回傳的 `net_pnl_usdt`，UI MUST NOT 以 Slippage 參與加總。

#### Scenario: 歸因樣式與標註
- **WHEN** Completed Trades 顯示 `slippage_attribution_usdt = -1.2`
- **THEN** 該欄以括號斜體灰色顯示 `(-1.20)`，並可見「已含在 Price PnL 中，不另外扣除」

#### Scenario: 瀑布圖結構
- **WHEN** Trade Result 為 `funding_pnl_usdt = 3.0`、`price_pnl_usdt = -1.5`、`fee_usdt = 0.8`、`slippage_attribution_usdt = -1.2`、`net_pnl_usdt = 0.7`
- **THEN** 瀑布圖依序為 Funding `+3.00`、Price `-1.50`（其下縮排子項 Slippage `(-1.20)`）、Fees `-0.80`、Net `0.70`，不存在與 Price 並列的 Slippage 長條

#### Scenario: 問號說明公式
- **WHEN** 使用者點擊 Slippage 旁的 `?`
- **THEN** 顯示 `Net = Funding + Price − Fees` 與「自行加總時不要再減 Slippage」

### Requirement: Trade Detail
點擊交易後 SHALL 顯示 `TRADE #<trade_id>` 的 Trade Detail，分區如下（規格書 §28）：**Strategy**（Strategy Version、Config Version、Opportunity ID、Detection Time、Funding Spread、Expected PnL）；**Position**（Long / Short Exchange、Leverage、Target Notional per Leg、Actual Notional 各腿與 Gross、Margin、Capital Allocation，名詞依 C-17 分開顯示）；**Entry**（每腿 Order Time、ACK Time、Fill Time、Target Price、Average Fill、Slippage 歸因）；**Funding**（兩腿各自 Funding Rate、Funding Time、Interval、`settlement_status`、Eligibility、Actual Funding）；**Exit**（Exit Order Time、Fill Time、Exit Price）；**Result**（Funding PnL、Price PnL（含滑價）、Fee、Net PnL、ROI on Capital、ROI on Notional、Slippage 歸因、`final_status`、`result_reason`）。尚未發生的欄位 SHALL 顯示 `—`，MUST NOT 顯示 0。切換到另一筆 Trade 時，前一筆尚未回來的請求 MUST 被中止且其回應 MUST NOT 覆寫畫面。

#### Scenario: Gross 與單腿名目分開
- **WHEN** 兩腿實際名目為 1,000 與 998，Margin 400，Capital Allocation 454
- **THEN** Position 區分別顯示 Long `1,000`、Short `998`、Gross `1,998`、Margin `400`、Capital Allocation `454`

#### Scenario: 兩腿結算時間各自顯示
- **WHEN** Long 腿 `funding_time` 為 08:00:00.000、Short 腿為 08:00:00.000 且兩腿 interval 分別為 8h 與 4h
- **THEN** Funding 區分兩列顯示各腿的結算時間、interval 與 `settlement_status`，不合併成單一 T

#### Scenario: 未成交交易的缺值
- **WHEN** 開啟一筆 `ABORTED`、0 成交的 Trade
- **THEN** Average Fill、Exit Price 等欄位顯示 `—`，Result 顯示 `final_status = ABORTED` 與 `result_reason`

#### Scenario: 快速切換交易不被舊回應覆寫
- **WHEN** 使用者開啟 Trade A 後在 A 的請求回來前切換到 Trade B，且 A 的回應較晚抵達
- **THEN** A 的請求被 abort，畫面始終顯示 Trade B

### Requirement: Trade Timeline 顯示全部 TradingEvent
Trade Detail 的 Timeline SHALL 列出該 Trade 的全部 `TradingEvent`（含 `ORDER_TIMEOUT`、`ORDER_CANCEL_REQUESTED`、`ORDER_CANCELED`、`ORDER_CANCEL_REJECTED`、`ORDER_REJECTED`、`ORDER_EXPIRED`、`ORDER_ACK_TIMEOUT` 等未成交 / 撤單 / 拒絕事件），依 `timestamp` 升冪、同時間依伺服器序號排序；每列顯示絕對時間（UTC，毫秒）、相對 Trade 建立時間的偏移、`event_type`（`StatusCode`）、相關 leg / order / exchange 與 payload 摘要（規格書 §24）。`recorded_at` 與 `timestamp` 不同時 SHALL 同時顯示。事件數超過每頁上限（預設 200）時 SHALL 分頁載入。

#### Scenario: 未成交事件不被省略
- **WHEN** 一筆 Trade 的事件包含 `ORDER_SUBMITTED`、`ORDER_ACK`、`ORDER_TIMEOUT`、`ORDER_CANCEL_REQUESTED`、`ORDER_CANCELED`、`TRADE_STATUS_CHANGED(to=ABORTED)`
- **THEN** Timeline 依序顯示全部 6 筆

#### Scenario: 事件時間與寫入時間
- **WHEN** 一筆事件 `timestamp` 與 `recorded_at` 相差 35 ms
- **THEN** 該列同時顯示事件時間與寫入時間

#### Scenario: 撤單失敗事件
- **WHEN** 事件包含 `ORDER_CANCEL_REJECTED` 且 payload 有 `cancel_reject_reason`
- **THEN** Timeline 顯示該事件與原因

### Requirement: Runtime Health 面板
Paper 分頁 SHALL 顯示 Runtime Health 面板，項目為 Engine、每個 paper trading 交易所（依 API 回傳的交易所清單渲染，MUST NOT 寫死交易所名稱分支）、Market Data、Scanner、Risk Engine、Paper Execution、Database、Last Event（技術書 §32），每個狀態以 `StatusCode` 顯示。Runtime 心跳 `runtime_heartbeat_at` 超過 `health_stale_after_ms`（預設 10 000 ms）或 API 無法連線時，面板 SHALL 顯示 `RUNTIME_UNREACHABLE` / `STALE`，並淡化最後已知值，MUST NOT 繼續顯示 `RUNNING`。

#### Scenario: 正常顯示
- **WHEN** Health API 回傳 Engine `RUNNING`、Binance `CONNECTED`、Bybit `CONNECTED`、Database `HEALTHY`、`last_event_at` 15:32:01.120
- **THEN** 面板逐項顯示這些代碼與 Last Event `15:32:01.120`

#### Scenario: 交易所清單由資料決定
- **WHEN** Health API 回傳的交易所包含 `OKX`
- **THEN** 面板多出一列 OKX，元件程式碼沒有變更

#### Scenario: Runtime 心跳過期
- **WHEN** `runtime_heartbeat_at` 距今 15 000 ms
- **THEN** Engine 顯示 `STALE`，其他項目淡化，不顯示 `RUNNING`

#### Scenario: server 無法連線
- **WHEN** Health API 請求失敗
- **THEN** 面板顯示 `RUNTIME_UNREACHABLE` 與最後成功時間，分頁其他區塊不崩潰

### Requirement: 即時事件串流
Paper 分頁 SHALL 透過 `server.ts` 的 WebSocket 接收 Runtime 事件並以 `HH:mm:ss.SSS [CATEGORY] 摘要` 格式顯示（技術書 §34）。串流 SHALL 顯示連線狀態（`CONNECTED` / `RECONNECTING` / `DISCONNECTED`），斷線後以指數退避重連，重連後 SHALL 依最後收到的序號向 API 補抓漏掉的事件，並以 `event_id` 去重。前端緩衝 MUST 有上限（預設 500 筆，只保留最新），渲染列數 MUST NOT 超過上限。瀏覽器關閉或 WebSocket 斷線 MUST NOT 影響 Runtime（前端不是交易流程的 dependency，技術書 §34、§48.4）；UI 對 WebSocket 只接收，MUST NOT 透過它送出任何交易指令。

#### Scenario: 事件格式
- **WHEN** 收到 `ORDER_FILL` 事件（Binance，fill 100%，timestamp 15:31:02.130）
- **THEN** 串流新增一列 `15:31:02.130 [FILL] Binance 100%`

#### Scenario: 斷線補抓與去重
- **WHEN** WebSocket 在序號 120 後斷線、重連後 API 回傳序號 121–125，且 WebSocket 又推送序號 125
- **THEN** 串流依序顯示 121–125 各一次，序號 125 不重複

#### Scenario: 緩衝上限
- **WHEN** 連續收到 800 筆事件
- **THEN** 串流只保留並渲染最新 500 筆

#### Scenario: 卸載時關閉連線
- **WHEN** 使用者離開 Paper 分頁
- **THEN** WebSocket 被關閉、重連計時器被清除，之後不再有 state 更新

### Requirement: 資料抓取不得有 stale closure 與亂序覆寫
Paper 分頁的所有輪詢與請求 SHALL 以 effect 管理並在 cleanup 時 `abort()` 進行中的請求、清除計時器；state updater MUST 為純函式（不得在 updater 內發請求）；回應寫入 state 前 MUST 比對請求時的鍵（例如 `trade_id`、篩選條件、請求序號），不相符則丟棄（FE-01）。在 React `StrictMode` 下，每個輪詢週期 MUST 只有一個有效請求寫入 state。

#### Scenario: 篩選切換期間的舊回應
- **WHEN** Completed Trades 以篩選 `LOSS` 發出請求，回應前使用者改為 `ABORTED`，且 `LOSS` 的回應較晚抵達
- **THEN** `LOSS` 的請求被 abort 或其回應被丟棄，畫面只顯示 `ABORTED` 的結果

#### Scenario: StrictMode 下的輪詢
- **WHEN** 以 `StrictMode` 渲染 Paper 分頁並以 fake timers 推進一個 Health 輪詢週期
- **THEN** 只有一個 Health 回應被寫入 state，被丟棄的請求處於 aborted 狀態

### Requirement: mock 資料源必須標示
Paper 分頁 SHALL 支援 `live`（`server.ts` 唯讀 API）與 `mock`（本 change 內的 fixtures）兩種資料源，以 `VITE_PAPER_DATA_SOURCE` 選擇，預設 `live`。資料源為 `mock` 時，分頁頂端 MUST 常駐顯示 `MOCK DATA` 橫幅，且每個資料區塊標題旁 MUST 顯示 `MOCK` 標籤（HANDOFF Invariant #7）。mock fixtures MUST 以 `runtime/src/types/` 的型別宣告，並至少包含：正常獲利、0 成交逾時 `ABORTED`、訂單被拒、撤單失敗、`LEG_IMBALANCE → EMERGENCY_EXIT`、已平倉待入帳、`MISSED` 結算各一例。`live` 模式下 API 無法連線時 MUST NOT 自動退回 mock。

#### Scenario: mock 模式橫幅
- **WHEN** 以 `VITE_PAPER_DATA_SOURCE=mock` 開啟 Paper 分頁
- **THEN** 頂端顯示 `MOCK DATA` 橫幅，Account、Current Trades、Completed Trades、Runtime Health、事件串流標題旁皆有 `MOCK`

#### Scenario: live 失敗不偷換 mock
- **WHEN** 預設 `live` 模式下 API 全部回傳錯誤
- **THEN** 各區塊顯示錯誤 / `RUNTIME_UNREACHABLE` 狀態，畫面上沒有任何 mock 交易資料

#### Scenario: fixtures 涵蓋失敗情境
- **WHEN** 以 mock 模式開啟 Completed Trades 篩選「全部」
- **THEN** 可看到 `ABORTED`、`EMERGENCY_EXIT`、訂單被拒、撤單失敗、待入帳、`MISSED` 等案例

### Requirement: Kill Switch 控制區預留且停用（blocked-by C-16）
Paper 分頁 SHALL 預留 Kill Switch 控制區，顯示「⚠️ 待決 C-16：決議前不可操作」說明，其中的控制按鈕 MUST 為 disabled，點擊 MUST NOT 發出任何網路請求。控制通道 SHALL 僅以型別化 client 函式預留（指令經 `server.ts` 轉交 Runtime、由 Runtime 自行驗證，技術書 §3），本 change MUST NOT 有任何呼叫點；UI 對 Kill Switch 的狀態 MUST 只依 Runtime 回報的事件 / Health 顯示，MUST NOT 做樂觀更新。

#### Scenario: 按鈕停用且不送請求
- **WHEN** 使用者嘗試點擊 Kill Switch 按鈕
- **THEN** 按鈕為 disabled、顯示 C-16 說明，網路層沒有任何 `POST` 請求

#### Scenario: 無呼叫點
- **WHEN** 以靜態檢查搜尋控制通道 client 函式在 `src/` 中的呼叫
- **THEN** 除其定義與測試外沒有任何呼叫點

### Requirement: 前端不出現憑證也不寫入交易資料
Paper 分頁 MUST NOT 讀取、顯示或傳送任何交易所 API Key / Secret，MUST NOT 讀取 `LocalSecretsView` 的 `localStorage` 內容（Invariant #2、規格書 §33）；對 `server.ts` 的 Paper API 呼叫 SHALL 只使用 `GET`（Kill Switch 通道除外且目前停用）。Timeline 的 payload 顯示 SHALL 只呈現 API 回傳的欄位，不另外拼接任何本機資料。

#### Scenario: 只有 GET 請求
- **WHEN** 在 mock 以外的測試中攔截 Paper 分頁完整操作流程（開啟、篩選、分頁、開啟 Detail）的所有請求
- **THEN** 所有請求皆為 `GET`，且沒有請求讀取 `localStorage`
