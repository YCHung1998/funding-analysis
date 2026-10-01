## ADDED Requirements

### Requirement: 單次執行的測試指令
專案 SHALL 提供 `npm test`，以 `vitest run` 單次執行全部納入的測試後結束（不進入 watch 模式）；任何測試失敗時行程 MUST 以非 0 結束碼退出。另 SHALL 提供 `npm run test:watch` 供開發時使用。

#### Scenario: 全部通過時結束碼為 0
- **WHEN** 所有測試皆通過並執行 `npm test`
- **THEN** 指令在執行完畢後自行結束，結束碼為 0

#### Scenario: 有測試失敗時結束碼非 0
- **WHEN** 任一測試斷言失敗並執行 `npm test`
- **THEN** 指令輸出失敗測試名稱並以非 0 結束碼退出

### Requirement: 測試檔納入規則
vitest 設定 SHALL 只納入符合 `src/**/*.test.ts`、`server/**/*.test.ts`、`runtime/**/*.test.ts`、`test/**/*.test.ts` 的檔案，並 MUST 排除 `node_modules/**` 與 `dist/**`。上述任一目錄不存在（例如 `runtime/` 尚未建立）時，`npm test` MUST NOT 因此失敗。

#### Scenario: runtime 測試自動納入
- **WHEN** 後續 change 新增 `runtime/src/clock/virtualClock.test.ts` 或 `runtime/test/scenarios/s01.test.ts`
- **THEN** 不需修改 vitest 設定，`npm test` 即執行該檔案

#### Scenario: runtime 目錄不存在
- **WHEN** repo 中沒有 `runtime/` 目錄並執行 `npm test`
- **THEN** 其餘納入的測試照常執行，結束碼不因缺少目錄而非 0

#### Scenario: 設定中宣告的納入樣式
- **WHEN** `test/infrastructure.test.ts` 讀取 vitest 設定的 `test.include`
- **THEN** 它包含 `runtime/**/*.test.ts`、`src/**/*.test.ts`、`server/**/*.test.ts`、`test/**/*.test.ts` 四個樣式

### Requirement: 本機 CI 等價檢查
專案 SHALL 提供 `npm run check`，依序執行 `npm run lint`、`npm run build`、`npm test`；任一步失敗 MUST 立即停止並以非 0 結束碼退出。此指令即技術書 §51.2 合併門檻與規格書 §2.1「每步三綠」的本機檢查方式。

#### Scenario: lint 失敗時不再執行後續步驟
- **WHEN** 程式碼有 TypeScript 型別錯誤並執行 `npm run check`
- **THEN** 指令在 lint 步驟失敗並以非 0 結束碼退出，不執行 build 與 test

#### Scenario: 三步全過
- **WHEN** lint、build、test 皆通過並執行 `npm run check`
- **THEN** 結束碼為 0

### Requirement: 測試檔納入型別檢查
測試檔 MUST 能通過 `npm run lint`（`tsc --noEmit`）；測試 SHALL 以 `import { describe, it, expect, vi } from 'vitest'` 明確匯入 API，MUST NOT 依賴 vitest globals。

#### Scenario: 測試中的型別錯誤被 lint 抓到
- **WHEN** 某個 `*.test.ts` 把字串傳給型別為 `number` 的參數並執行 `npm run lint`
- **THEN** lint 失敗並指出該測試檔

### Requirement: 測試離線執行
測試 MUST NOT 發出真實網路請求。測試環境 SHALL 在 setup 檔中把全域 `fetch` 取代為會拋出錯誤的替身；需要上游資料的測試 MUST 使用檔案內的固定 fixture。

#### Scenario: 呼叫 fetch 立即失敗
- **WHEN** 任何測試在未自行 mock 的情況下呼叫 `fetch('https://fapi.binance.com/fapi/v1/premiumIndex')`
- **THEN** 呼叫拋出錯誤，訊息指出測試中禁止網路請求，且不產生任何對外連線

### Requirement: 測試結果具決定性
被測程式讀取 `Date.now()` 的測試 MUST 以 `vi.useFakeTimers()` 與 `vi.setSystemTime()` 固定時間，並在測試結束時 `vi.useRealTimers()` 還原；以參數接受時間的函式 MUST 傳入固定時間。測試結果 MUST NOT 依賴執行當下的時間、本機時區或執行順序。

#### Scenario: 缺少時間欄位時使用固定系統時間
- **WHEN** 系統時間固定為 `2026-01-01T07:30:00Z`，且以缺少 `time` 欄位的 Binance raw ticker 呼叫 `mapBinanceToCommon`
- **THEN** 回傳的 `event_time` 等於 `Date.UTC(2026, 0, 1, 7, 30, 0)`

#### Scenario: 重複執行結果相同
- **WHEN** 連續兩次執行 `npm test`
- **THEN** 兩次的通過 / 失敗結果完全一致

### Requirement: Coverage 報告（僅報告）
專案 SHALL 提供 `npm run test:coverage`，以 v8 provider 產生文字摘要與 HTML 報告，統計範圍為 `src/engine/**`、`src/adapters/**`、`server/**`、`runtime/src/**`，輸出至已被 git 忽略的 `coverage/`。本 change MUST NOT 設定 coverage 門檻，且 `npm test` 與 `npm run check` MUST NOT 執行 coverage。

#### Scenario: 產生 coverage 報告
- **WHEN** 執行 `npm run test:coverage`
- **THEN** 終端機顯示各檔案的行 / 分支覆蓋率，並產生 `coverage/index.html`

#### Scenario: 覆蓋率低不會讓指令失敗
- **WHEN** 某檔案覆蓋率為 0% 並執行 `npm run test:coverage`
- **THEN** 只要測試全數通過，結束碼即為 0

### Requirement: server.ts 純計算最小抽出
`extractBaseSymbol`、最佳配對與 spread 計算、live-scan Expected Net PnL 計算、結算時間 / 週期彙整 SHALL 從 `server.ts` 原樣搬至 `server/liveScanMath.ts` 並具名匯出；`server.ts` MUST 改為 import 這些函式且不保留重複實作。抽出後的模組 MUST 可在不啟動 Express / Vite、不讀取 `.env` 的情況下被 import，且 `/api/market/live-scan` 的回應欄位與計算結果 MUST 與抽出前相同。

#### Scenario: import 模組沒有副作用
- **WHEN** 測試 import `server/liveScanMath.ts`
- **THEN** 不會監聽任何 port、不會建立 Vite server、不會呼叫 `fetch`

#### Scenario: server.ts 不再保留舊實作
- **WHEN** 在 `server.ts` 中搜尋 `function extractBaseSymbol`
- **THEN** 找不到定義，只存在從 `./server/liveScanMath` 的 import

### Requirement: 已知 bug 的特性測試標註規則
鎖住已知錯誤行為的測試 MUST 在 `it(...)` 名稱中包含對應的 issue ID（例如 `[Q-05]`、`[Q-01]`）與「現況」字樣，並以註解寫出修正後的預期值（若 issue 已給出）。修正該 issue 的 change MUST 在同一 PR 中修改該測試，MUST NOT 以 `vitest -u` 或刪除測試的方式使其通過而不說明。

#### Scenario: Q-05 測試名稱可被搜尋
- **WHEN** 開發者執行 `grep -rn "\[Q-05\]" src server`
- **THEN** 找到鎖住滑價重複扣除現況的測試，其註解寫明修正後 `net_pnl ≈ −1.20`

### Requirement: 研究引擎特性測試
`src/engine/arbitrageEngine.ts` 的 `enrichKlineBar`、`estimateSlippageRate`、`simulateExecutionExperiment` SHALL 有特性測試，鎖住目前的數值輸出（浮點比較使用 `toBeCloseTo`，精度至少 9 位小數），包含 Q-05 滑價重複扣除的現況。

#### Scenario: [Q-05] 滑價被扣兩次（現況）
- **WHEN** 兩腿 `funding_rate` 皆為 0.0001、`mark_price` 皆為 100、T 棒 `return_pct = 0`、`custom_entry_slippage = 0.0003`、兩所 taker fee 皆為 0、notional 1000，呼叫 `simulateExecutionExperiment`
- **THEN** `price_pnl ≈ −1.200000108`、`total_slippage = 1.2`、`net_pnl ≈ −2.400000108`（修正後預期 ≈ −1.20）

#### Scenario: 費率相同時 Pionex 做空
- **WHEN** Pionex 與 Binance 的 `funding_rate` 相等
- **THEN** `pionex_leg.side = 'SHORT'`、`binance_leg.side = 'LONG'`

#### Scenario: 結算時間字串格式
- **WHEN** Pionex 紀錄的 `funding_time = Date.UTC(2026, 0, 1, 8)`、`symbol = 'BTCUSDT'`
- **THEN** `funding_time_str = '2026-01-01 08:00:00 UTC'`、`id = 'BTCUSDT-1767254400000'`

#### Scenario: 滑價下限 1 bp
- **WHEN** 呼叫 `estimateSlippageRate(0, 1, 100, 100, 100)`
- **THEN** 回傳 0.0001

#### Scenario: 衝擊倍數上限 2.5
- **WHEN** 呼叫 `estimateSlippageRate(1, 10, 99, 101, 100)`
- **THEN** 回傳 ≈ 0.013（半價差 1% + 波動 1% × 0.12 × 2.5，換算為小數）

### Requirement: 符號正規化特性測試
`extractBaseSymbol` SHALL 有特性測試，鎖住一般合約與 Q-01 / P6 已知錯誤的現況輸出。

#### Scenario: 各所線性合約映射到同一 base
- **WHEN** 分別輸入 `BTCUSDT`、`BTC_USDT_PERP`、`BTC-USDT-SWAP`、`btcusdt`
- **THEN** 皆回傳 `BTC`

#### Scenario: [Q-01] 反向合約被併成 BTC（現況）
- **WHEN** 輸入 `USDT_BTC_PERP`
- **THEN** 回傳 `BTC`（修正後不得映射到 BTC 線性合約）

#### Scenario: [Q-01][P6] 倍數前綴被丟棄（現況）
- **WHEN** 分別輸入 `1000PEPEUSDT`、`10000SATSUSDT`、`1000000MOGUSDT`
- **THEN** 分別回傳 `PEPE`、`SATS`、`MOG`，不保留倍數資訊

#### Scenario: 非倍數的數字開頭不受影響
- **WHEN** 輸入 `1INCHUSDT`
- **THEN** 回傳 `1INCH`

### Requirement: 最佳配對與 spread 特性測試
抽出的最佳配對函式 SHALL 有特性測試，鎖住「兩兩配對取最大 |rateA − rateB|、費率低者做多」的現況，包括 Q-02 / P1 不同結算週期的費率直接相減。

#### Scenario: 取最大 spread 並決定多空
- **WHEN** 費率為 Pionex 0.001、Binance 0.0001、Bybit 0.0005，交易所順序為 `['Pionex','Binance','Bybit','Bitget','OKX']`
- **THEN** 最大 spread = 0.0009、做多 Binance、做空 Pionex，且 `pair_spreads` 含 `Pionex_Binance`、`Pionex_Bybit`、`Binance_Bybit` 三個鍵

#### Scenario: 少於兩所有費率時不產生配對
- **WHEN** 只有 Binance 有費率
- **THEN** 函式回傳「無配對」，對應 candidate 不被產生

#### Scenario: 所有費率相同時的預設配對
- **WHEN** Binance 與 Bybit 費率皆為 0.0001
- **THEN** 最大 spread = 0，做多為第一個有費率的交易所、做空為第二個

#### Scenario: [Q-02][P1] 不同週期費率直接相減（現況）
- **WHEN** Bybit 為 1h 週期費率 0.0005、Binance 為 8h 週期費率 0.0001
- **THEN** spread = 0.0004，未做週期換算

### Requirement: live-scan Expected Net PnL 特性測試
抽出的 Expected Net PnL 計算 SHALL 有特性測試，鎖住 Q-05(b) / P4 量能三級滑價常數與 Q-06 固定 0.20% 費用的現況。

#### Scenario: [Q-05][P4] 量能三級滑價（現況）
- **WHEN** 24h 量分別為 150,000,000、50,000,000、10,000,000
- **THEN** 4 腿總滑價分別為 0.0006、0.0012、0.002

#### Scenario: 量能級距邊界為嚴格大於
- **WHEN** 24h 量恰為 100,000,000
- **THEN** 4 腿總滑價為 0.0012

#### Scenario: [Q-06] 固定費用與淨值計算（現況）
- **WHEN** 最大 spread = 0.004、24h 量 = 150,000,000
- **THEN** `fee_drag_pct = 0.002`、`expected_net_pnl_pct ≈ 0.0014`、`expected_net_pnl_usdt ≈ 1.4`、`meets_threshold = true`

#### Scenario: 門檻判定包含等號
- **WHEN** 最大 spread = 0.002
- **THEN** `meets_threshold = true`

### Requirement: 結算時間彙整特性測試
抽出的結算時間 / 週期彙整函式 SHALL 有特性測試，鎖住 Q-02 / P2「取各所最早的未來結算時間」與缺值時假設 8 小時的現況。

#### Scenario: [Q-02][P2] 取最早的未來結算時間（現況）
- **WHEN** now = 0，各所 nextFundingTime 為 Binance 3,600,000、Bybit 1,800,000、Pionex −1
- **THEN** next_funding_time = 1,800,000、time_to_settlement_sec = 1800

#### Scenario: [Q-02] 無有效結算時間時假設 8 小時（現況，違反 Invariant 4）
- **WHEN** now = 0 且沒有任何大於 now 的 nextFundingTime
- **THEN** next_funding_time = 28,800,000

#### Scenario: 週期取最小值，缺值為 8
- **WHEN** 各所週期為 Bybit 4、Binance 8；另一情境沒有任何週期
- **THEN** 前者 interval_hours = 4，後者 interval_hours = 8

### Requirement: Funnel Scanner 特性測試
`runFunnelScan` SHALL 以固定 `currentTime` 與 notional 1000 進行特性測試，鎖住排名、各級狀態與倒數（Q-08 寫死宇宙的現況）。

#### Scenario: [Q-08] 固定時間下的排名與選擇（現況）
- **WHEN** 以 `currentTime = Date.UTC(2026, 0, 1, 7, 30, 0)` 呼叫 `runFunnelScan`
- **THEN** 第 1 名為 `DOGEUSDT`（expected_net_pnl_pct ≈ 0.0004）、第 2 名為 `WIFUSDT`，`level2_top3` 依序為 `DOGEUSDT`、`WIFUSDT`，`level3_selected.symbol = 'DOGEUSDT'`

#### Scenario: 淨值為浮點殘差的候選不進入 Level 2
- **WHEN** 同上呼叫
- **THEN** `PEPEUSDT` 的 expected_net_pnl_pct 絕對值 < 1e-15 且不在 `level2_top3`

#### Scenario: spread 低於 0.10% 被淘汰
- **WHEN** 同上呼叫
- **THEN** `LINKUSDT`、`AVAXUSDT`、`ADAUSDT` 的 `funnel_stage = 'Eliminated'`，其餘為 `Level1_Top20`

#### Scenario: 結算倒數依週期對齊
- **WHEN** 同上呼叫
- **THEN** 1h、4h、8h 合約的 `time_to_settlement_sec` 皆為 1800

### Requirement: Dry-run 引擎特性測試
`executeDryRunSimulation` SHALL 在固定系統時間下對正常與 `forceLegImbalance = true` 兩情境進行特性測試，鎖住 `cost_table`、`telemetry`、`position_state`、`risk_report` 狀態與 `timeline` 各步驟的 `id` / `status`，包含 Q-08 / P7 的現況。

#### Scenario: 正常情境為平衡對沖
- **WHEN** 以 long / short 皆指定的候選、notional 1000、`forceLegImbalance = false` 呼叫
- **THEN** `position_state = 'BALANCED_HEDGED'`，`cost_table.entry_fee.total = 1`（兩腿各 0.5）

#### Scenario: [Q-08] 單腿失敗仍計多腿資金費（現況）
- **WHEN** 同一候選以 `forceLegImbalance = true` 呼叫
- **THEN** `position_state = 'LEG_IMBALANCE'`、`cost_table.funding_pnl.leg_short = 0`，且 `cost_table.funding_pnl.leg_long = −1000 × long_rate`（非 0）

#### Scenario: [Q-08][P7] 延遲依交易所名稱決定（現況）
- **WHEN** 做多 Binance、做空 Bybit
- **THEN** `telemetry.long_api_latency_ms = 22`、`telemetry.short_api_latency_ms = 34`

#### Scenario: 訂單編號使用固定系統時間
- **WHEN** 系統時間固定為 1,767,252,600,000
- **THEN** `long_order.client_order_id = 'DRY_LONG_1767252600000'`

### Requirement: Adapter mapping 特性測試
`mapBinanceToCommon`、`mapBybitToCommon`、`mapBitgetToCommon`、`mapOKXToCommon`、`mapPionexToCommon`、`parseCoinGlassIntelligence` SHALL 各以至少一份完整 fixture 與一份缺欄位 fixture 進行特性測試，以 `toEqual` 鎖住整筆輸出。

#### Scenario: 字串數值轉為小數
- **WHEN** Binance raw ticker 的 `lastFundingRate = "0.00010000"`
- **THEN** `funding_rate = 0.0001`（number，不乘 100）

#### Scenario: [Q-02] Binance 下次結算假設 8 小時（現況，違反 Invariant 4）
- **WHEN** Binance raw ticker 的 `nextFundingTime = 1767254400000`
- **THEN** `funding_time = 1767254400000`、`next_funding_time = 1767283200000`

#### Scenario: Bybit 使用回傳的結算週期
- **WHEN** Bybit raw ticker 的 `nextFundingTime = "1767254400000"`、`fundingIntervalHour = "4"`
- **THEN** `next_funding_time = 1767268800000`

#### Scenario: 缺欄位時的預設值
- **WHEN** Binance raw ticker 未提供 `volume` 與 `kline`
- **THEN** `volume = 500000000`、`kline_high = mark_price × 1.0007`
