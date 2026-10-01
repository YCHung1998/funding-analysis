## ADDED Requirements

### Requirement: 手續費費率為設定值（FeeTierConfig）
系統 SHALL 以 `FeeTierConfig`（`exchange`、`tier_name`、`maker_fee`、`taker_fee`、`source`、`is_default_lowest`）組成的費率表提供每所 × 帳戶等級的 maker / taker 費率，費率 MUST 以小數儲存（Invariant #5）。費率表 SHALL 帶有 `fee_config_version`，任何修改都產生新版本。預設表 SHALL 為 Binance 0.0002 / 0.0005、Bybit 0.0002 / 0.00055、Bitget 0.0002 / 0.0006、OKX 0.0002 / 0.0005、Pionex 0.0002 / 0.0005（maker / taker），並標示 `source = 'DEFAULT_ESTIMATE'`。載入時 MUST 驗證每筆費率介於 −0.001 與 0.01 之間（允許 maker rebate 為負），超出範圍即拒絕載入。

#### Scenario: 百分比誤填被拒絕
- **WHEN** 設定檔把 Binance `taker_fee` 填為 `0.05`（意圖 0.05%）
- **THEN** 載入失敗，錯誤碼 `FEE_RATE_OUT_OF_RANGE`，訊息指出 `Binance.taker_fee`

#### Scenario: VIP 覆寫不需改程式
- **WHEN** 設定檔把 Binance 的等級改為 `VIP1`、`taker_fee = 0.00045`
- **THEN** 同一段程式對 Binance 1,000 USDT taker 的手續費估計由 0.50 變為 0.45 USDT，且 `fee_config_version` 與前一版不同

#### Scenario: 缺少交易所費率不得默默補預設
- **WHEN** 查詢一個不在費率表中的交易所
- **THEN** 丟出錯誤 `FEE_TIER_MISSING`，而不是回傳 0.0005

### Requirement: 手續費計算
Fee Engine SHALL 以 `fee_usdt = notional_usdt × rate(exchange, tier, liquidity)` 計算手續費，`fee_usdt` 為正值代表成本。`liquidity` 為 `MAKER` 時用 `maker_fee`、`TAKER` 時用 `taker_fee`；`SIMULATED` MUST 視為 `TAKER`（保守）。Fee Engine MUST NOT 依交易所名稱分支，差異只能來自費率表資料。

#### Scenario: 各所 taker 手續費
- **WHEN** 以預設費率表計算 1,000 USDT 名目的 taker 成交
- **THEN** Binance = 0.50 USDT、Bybit = 0.55 USDT、Bitget = 0.60 USDT

#### Scenario: Maker 與 SIMULATED
- **WHEN** 以預設費率表計算 Bybit 1,000 USDT 的 `MAKER` 成交與 `SIMULATED` 成交
- **THEN** 分別為 0.20 USDT 與 0.55 USDT

#### Scenario: 雙腿來回四筆手續費
- **WHEN** Bybit（long）× Bitget（short）各 1,000 USDT，進出場皆 taker
- **THEN** `expected_fees_usdt = 2.30`，即 0.23%（而非寫死的 0.20%）

### Requirement: 策略與掃描層不得寫死手續費
`runtime/src/strategy/`、`runtime/src/scanner/` 與研究端的淨值計算（`server/liveScanMath.ts`）MUST 只透過 Fee Engine 取得手續費估計；這些目錄中 MUST NOT 出現手續費常數字面值（例如 `0.0005`、`0.0020`）。此規則 SHALL 以自動化測試檢查原始碼。

#### Scenario: 靜態檢查抓到寫死費率
- **WHEN** `runtime/src/strategy/` 下的檔案出現 `const fee = 0.0005`
- **THEN** 靜態檢查測試失敗並列出檔名與行號

### Requirement: 盤口深度逐檔吃單滑價
Slippage Engine SHALL 以逐檔吃單（walk-the-book）計算預估成交：BUY 從 asks 由低到高、SELL 從 bids 由高到低累加，直到滿足目標基礎資產數量。輸出 SHALL 包含 `expected_avg_price`、`reference_price`（= `(best_bid + best_ask) / 2`）、`expected_slippage_pct = |expected_avg_price − reference_price| / reference_price`、`expected_slippage_usdt = |expected_avg_price − reference_price| × quantity`、`fillable_quantity`、`depth_sufficient` 與 `model = 'ORDERBOOK'`。盤口數量 MUST 為基礎資產數量（合約乘數換算由呼叫端依 `instrument-registry` 完成）。

#### Scenario: BUY 逐檔吃單均價 100.006
- **WHEN** asks 為 `100.00 × 100`、`100.01 × 200`、`100.03 × 300`，best bid 為 `99.99`，BUY 數量 250
- **THEN** `expected_avg_price = 100.006`、`reference_price = 99.995`、`expected_slippage_usdt = 2.75`、`expected_slippage_pct ≈ 0.000110`（誤差 ±1e-6）、`depth_sufficient = true`

#### Scenario: SELL 逐檔吃單
- **WHEN** bids 為 `99.99 × 50`、`99.98 × 100`，best ask 為 `100.00`，SELL 數量 100
- **THEN** `expected_avg_price = 99.985`、`expected_slippage_usdt = 1.00`、`expected_slippage_pct ≈ 0.000100`（誤差 ±1e-6）

#### Scenario: 深度不足
- **WHEN** asks 合計只有 600，BUY 數量 700
- **THEN** `depth_sufficient = false`、`fillable_quantity = 600`、`reason = 'INSUFFICIENT_DEPTH'`，且不回傳以常數補足的均價

### Requirement: 可設定的 safety buffer
Slippage Engine SHALL 在盤口滑價之上加上 `slippage_safety_buffer_pct`（設定值，小數），輸出 `slippage_with_buffer_pct = expected_slippage_pct + slippage_safety_buffer_pct` 與 `slippage_with_buffer_usdt = slippage_with_buffer_pct × reference_price × quantity`。成本估計 MUST 使用含 buffer 的數值；buffer 為 0 時兩者相等。

#### Scenario: Buffer 疊加
- **WHEN** 上述 BUY 250 的案例，`slippage_safety_buffer_pct = 0.0001`
- **THEN** `slippage_with_buffer_pct ≈ 0.000210`（誤差 ±1e-6）、`slippage_with_buffer_usdt ≈ 5.25`（誤差 ±0.01）

### Requirement: 無完整盤口時的退回模型
只有 best bid / best ask、沒有深度時，Slippage Engine SHALL 以半價差 `(best_ask − best_bid) / 2 / reference_price` 加上 safety buffer 作為單筆滑價，並標示 `model = 'TOP_OF_BOOK'`。連 bid / ask 都沒有時 SHALL 回傳 `model = 'UNAVAILABLE'`；Runtime 的成本估計 MUST 因此判定不合格（`SLIPPAGE_UNAVAILABLE`），不得以成交量分級常數代替。只有研究端 live-scan（`server/liveScanMath.ts`）過渡期可使用 `model = 'LEGACY_VOLUME_TIER'`，且 MUST 在輸出中標示。

#### Scenario: 冷門合約半價差
- **WHEN** 兩腿都只有 top-of-book：bid `23.91`、ask `23.96`，buffer 為 0
- **THEN** 單筆滑價 ≈ 0.0010445，四筆合計 ≈ 0.004178 ≥ 0.004（Q-05 驗收：價差 > 0.2% 的合約四筆滑價 ≥ 0.4%）

#### Scenario: 無報價資料
- **WHEN** 某一腿沒有任何 bid / ask
- **THEN** 該腿 `model = 'UNAVAILABLE'`，Runtime 的 Expected Net PnL 結果為 `qualified = false`、`reason = 'SLIPPAGE_UNAVAILABLE'`

### Requirement: 滑價歸因（僅歸因）
系統 SHALL 以 `slippageAttribution(order_side, quantity, avg_fill_price, reference_price) = −side_sign × (avg_fill_price − reference_price) × quantity` 計算單筆滑價歸因（BUY 的 `side_sign = +1`、SELL = −1；負值 = 成本）。此函式為 `slippage_attribution_usdt` 的唯一實作，其結果 MUST NOT 參與 Net PnL 的相減。

#### Scenario: BUY 與 SELL 的歸因
- **WHEN** BUY 250 均價 100.006、參考價 99.995；SELL 100 均價 99.985、參考價 99.995
- **THEN** 歸因分別為 −2.75 與 −1.00 USDT

### Requirement: C-13 淨值組合公式
系統 SHALL 以 `composeNetPnl({ funding_pnl, price_pnl, fees, other_costs }) = funding_pnl + price_pnl − fees − other_costs` 作為 Net PnL 的唯一組合公式（✅ C-13）。`price_pnl` MUST 以實際（或預估）成交均價計算，因此已含滑價；公式 MUST NOT 接受或扣除滑價參數。以參考價計算的 Price PnL 加上滑價歸因 SHALL 等於以實際均價計算的 Price PnL。

#### Scenario: 滑價不被重複扣除
- **WHEN** LONG 10 單位，進場參考價 100、實際均價 100.05，出場參考價 100、實際均價 99.95，funding 0、fees 0
- **THEN** `price_pnl = −1.00`、`slippage_attribution_usdt = −1.00`、以參考價計算的 Price PnL = 0，且 `net_pnl = −1.00`（不是 −2.00）

#### Scenario: 含其他成本
- **WHEN** `funding_pnl = 2.00`、`price_pnl = −0.40`、`fees = 2.10`、`other_costs = 0.50`
- **THEN** `net_pnl = −1.00`

### Requirement: 資金費金額以 mark price × 數量計算
系統 SHALL 以 `fundingCashflow(position_side, base_quantity, mark_price, rate) = −side_sign × base_quantity × mark_price × rate` 計算單腿資金費現金流（LONG 的 `side_sign = +1`、SHORT = −1；正費率 LONG 付、SHORT 收），`base_quantity` 為基礎資產數量。此函式為 funding 金額的唯一實作（`funding-settlement-rules` 的已結算金額與本 capability 的預期金額皆 MUST 使用），MUST NOT 以固定名目本金 × 費率計算。

#### Scenario: 價格上漲後的資金費（Q-07）
- **WHEN** SHORT 10 單位（以 100 進場、名目 1,000 USDT），結算時 mark price 101，費率 0.0010
- **THEN** 現金流 = +1.01 USDT（不是 1,000 × 0.0010 = 1.00）

#### Scenario: 資金費正負號
- **WHEN** 數量 10、mark price 101：LONG 費率 +0.0005、LONG 費率 −0.0005、SHORT 費率 −0.0005
- **THEN** 現金流分別為 −0.505、+0.505、−0.505 USDT

#### Scenario: 與結算規則一致
- **WHEN** SHORT 10 單位、mark price 100、已結算費率 0.0010
- **THEN** 現金流 = +1.00 USDT（與 `funding-settlement-rules` 的 Settled after exit 情境相同）

### Requirement: Expected Net PnL（預期淨利）
成本模型 SHALL 對一組候選（long 腿、short 腿、`target_notional_per_leg_usdt`、預測費率、盤口 / 報價、mark price、費率表、設定）計算：
- 每腿數量 `quantity = floor_to_step(target_notional_per_leg_usdt / reference_price, qty_step)`（`qty_step` 來自 `instrument-registry`）；
- `expected_funding_usdt = Σ fundingCashflow(side, quantity, mark_price, predicted_rate)`，並標示 `rate_source = 'PREDICTED'`；
- `expected_fees_usdt` = 四筆成交（兩腿進場 + 出場）依 `liquidity_assumption`（預設 `TAKER`）計算；
- `expected_slippage_attribution_usdt` = 四筆成交含 buffer 的滑價歸因總和（出場以當下對手盤口作為代理）；
- `entry_basis_pct = (mid_short − mid_long) / mid_long`，`expected_basis_pnl_usdt` 依 `basis_convergence_assumption`（`NONE` = 0、`ADVERSE_ONLY` = `min(0, entry_basis_pct) × target_notional_per_leg_usdt`、`FULL` = `entry_basis_pct × target_notional_per_leg_usdt`；預設 `ADVERSE_ONLY`）；
- `expected_price_pnl_usdt = expected_basis_pnl_usdt + expected_slippage_attribution_usdt`；
- `basis_risk_charge_usdt = basis_risk_z × basis_sigma_pct × target_notional_per_leg_usdt`（Other Costs）；
- `expected_net_pnl_usdt = composeNetPnl(expected_funding_usdt, expected_price_pnl_usdt, expected_fees_usdt, basis_risk_charge_usdt)`。
滑價 MUST 只出現在 `expected_price_pnl_usdt` 一處。結果 SHALL 附完整成本拆解、`fee_config_version` 與 `cost_model_version`。

#### Scenario: 完整淨值拆解
- **WHEN** Binance long 預測費率 −0.0002、Bybit short 預測費率 0.0018，兩腿 mid 與 mark 皆為 100，單腿 1,000 USDT，`qty_step = 0.001`，四筆含 buffer 滑價各 0.0001，basis 0，`basis_sigma_pct = 0`
- **THEN** 每腿數量 10、`expected_funding_usdt = 2.00`、`expected_fees_usdt = 2.10`、`expected_slippage_attribution_usdt = −0.40`、`expected_price_pnl_usdt = −0.40`、`expected_net_pnl_usdt = −0.50`（若重複扣滑價會得到 −0.90）

#### Scenario: 不利 basis 納入
- **WHEN** 同上但 funding / 滑價 / 手續費皆為 0，`mid_long = 100.0`、`mid_short = 99.8`，`basis_convergence_assumption = 'ADVERSE_ONLY'`
- **THEN** `entry_basis_pct = −0.002`、`expected_basis_pnl_usdt = −2.00`

#### Scenario: 有利 basis 在保守假設下不計入
- **WHEN** `mid_long = 100.0`、`mid_short = 100.2`，`basis_convergence_assumption = 'ADVERSE_ONLY'`
- **THEN** `entry_basis_pct = 0.002`、`expected_basis_pnl_usdt = 0`

#### Scenario: Basis 風險折價
- **WHEN** `basis_risk_z = 1.0`、`basis_sigma_pct = 0.0005`、單腿 1,000 USDT
- **THEN** `basis_risk_charge_usdt = 0.50`，並從 `expected_net_pnl_usdt` 中扣除

#### Scenario: 數量依 step size 無條件捨去
- **WHEN** 單腿 1,000 USDT、`reference_price = 99.995`、`qty_step = 0.001`
- **THEN** `quantity = 10.000`

### Requirement: 以淨 spread 選對、排序與判門檻
系統 SHALL 定義 `net_spread_pct = expected_net_pnl_usdt / target_notional_per_leg_usdt`，並以之：(1) 在同一幣種的所有交易所配對中選出 best pair；(2) 對候選排序（由大到小）；(3) 判定合格：`expected_net_pnl_usdt ≥ minimum_expected_net_pnl_usdt` 且 `net_spread_pct ≥ minimum_net_spread_pct`。毛 spread（`short_rate − long_rate`）SHALL 僅作顯示欄位，MUST NOT 用於選對、排序或門檻。

#### Scenario: 毛 spread 通過但淨值為負（Q-06 MEW）
- **WHEN** Bybit long × Bitget short，毛 spread 0.00208，滑價 0，basis 0，`minimum_expected_net_pnl_usdt = 0`
- **THEN** `net_spread_pct ≈ −0.00022`、`qualified = false`

#### Scenario: Best pair 依淨值而非毛 spread
- **WHEN** 同一幣種兩組配對：P1 Bybit long（−0.0004）× Bitget short（0.0020），毛 0.0024、來回手續費 0.0023；P2 Binance long（−0.0003）× OKX short（0.0020），毛 0.0023、來回手續費 0.0020；滑價與 basis 皆 0
- **THEN** P1 淨 0.0001、P2 淨 0.0003，選出 P2

#### Scenario: 排序依淨值
- **WHEN** 候選 A 毛 0.0030 淨 0.0002、候選 B 毛 0.0025 淨 0.0008
- **THEN** 排序結果 B 在 A 之前

### Requirement: 預測費率風險重算
系統 SHALL 提供 `evaluatePredictedRateRisk(evaluated, latest)`：以最新預測費率與行情重算 Expected Net PnL，並依序判定：(1) 最新 `short_rate − long_rate` 與評估時符號相反 → `SPREAD_FLIPPED`；(2) 重算的 `expected_net_pnl_usdt < minimum_expected_net_pnl_usdt` → `BELOW_MIN_NET_PNL`；否則 `OK`。原因碼 MUST 與 `opportunity-lifecycle` 相同；何時呼叫（ARM）由 `paper-trading-event-loop` 決定，本函式不讀取時鐘。

#### Scenario: Spread 在 ARM 前縮小（Q-04）
- **WHEN** Binance long × Bybit short、單腿 1,000 USDT、滑價與 basis 0，評估時 long 0.0000 / short 0.0025（淨 0.40），`minimum_expected_net_pnl_usdt = 0.20`，最新 short 費率變為 0.0010
- **THEN** 重算 `expected_net_pnl_usdt = −1.10`，結果 `BELOW_MIN_NET_PNL`

#### Scenario: Spread 翻轉
- **WHEN** 評估時 long 0.0000 / short 0.0025，最新 long 0.0012 / short 0.0002
- **THEN** 結果 `SPREAD_FLIPPED`

### Requirement: 研究引擎不得重複扣除滑價（Q-05）
`src/engine/arbitrageEngine.ts` 的 `simulateExecutionExperiment` SHALL 以 `net_pnl = gross_pnl − total_fee` 計算，腿別 `net_pnl = price_pnl + funding_pnl − entry_fee − exit_fee`；`total_slippage`、`entry_slippage`、`exit_slippage` SHALL 保留為歸因顯示欄位，MUST NOT 再從 net 扣除。修改前 MUST 先有 `setup-vitest` 的特性測試鎖住舊值。

#### Scenario: Q-05 驗收案例
- **WHEN** 兩腿費率相同（funding 0）、無價格漂移、`custom_entry_slippage = 0.0003`、兩腿手續費 0、單腿 1,000 USDT
- **THEN** `net_pnl ≈ −1.20`（±0.01；修正前為 ≈ −2.40），且 `total_slippage ≈ 1.20` 仍被回傳

#### Scenario: ExecutionSimulator 手續費依腿別對應（Q-06）
- **WHEN** Pionex 為 short 腿、使用者設定 short 端手續費 0.0006、long 端 0.0005
- **THEN** Pionex 腿的 `entry_fee = 0.60`（1,000 USDT），Binance 腿的 `entry_fee = 0.50`

### Requirement: 研究端 live-scan 使用成本模型
`/api/market/live-scan`（計算位於 `server/liveScanMath.ts`）SHALL 對每個幣種的每組配對呼叫成本模型（預設費率表、top-of-book 或標示過的 legacy 滑價、basis），並輸出 `net_spread_pct`、`pair_net_spreads`、`slippage_model`（每腿）、`entry_basis_pct`、`fee_config_version`；`best_pair`、排序與 `meets_threshold` MUST 依淨值口徑（`meets_threshold = expected_net_pnl_usdt ≥ research_min_net_pnl_usdt`，預設 0）。`spread` 欄位 SHALL 保留為毛 spread。前端 MUST 使用伺服器回傳的淨值，MUST NOT 以 `spread − fee_drag_pct − est_slippage_pct` 自行重算；凡顯示滑價處 MUST 依規格書 §20.1 標示「已含在 Price PnL 中，不另外扣除」。

#### Scenario: 毛 spread 最大者不再排第一
- **WHEN** live-scan 輸入中候選 X 毛 0.0030、淨 −0.0001，候選 Y 毛 0.0022、淨 0.0004
- **THEN** 回應中 Y 的 `rank` 小於 X，且 X 的 `meets_threshold = false`

#### Scenario: Legacy 滑價被標示
- **WHEN** 某腿的交易所回應沒有 bid / ask（例如 Pionex）
- **THEN** 該腿 `slippage_model = 'LEGACY_VOLUME_TIER'`，候選帶 `slippage_estimated = true`，前端以 mock / 估計樣式顯示（Invariant #7）
