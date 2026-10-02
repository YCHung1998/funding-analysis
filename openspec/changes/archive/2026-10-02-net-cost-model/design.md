## Context

- **現況（研究原型）**：
  - `src/engine/arbitrageEngine.ts:122-147` 進出場價已含滑價，`:186-200` 又以 `totalSlippage` 相減，腿別 `:217,234` 同樣重複（Q-05）。`ExecutionSimulator` 與 `SensitivityMatrix`、`mockMarketData` 都使用此引擎。
  - `server.ts:294-298`（`setup-vitest` 抽出後位於 `server/liveScanMath.ts` 的 `computeLiveScanNetPnl` / `findBestPair`，並有特性測試）以 Binance 24h 量三級常數 × 4 當滑價、`fixedFeeDragPct = 0.0020`、`meets_threshold: maxSpread >= 0.0020`、`:337` 以毛 spread 排序；`:264-285` 以毛 spread 選 best pair（Q-06、P4、P9）。
  - `src/components/FunnelScannerView.tsx:199,250` 在前端以 `pairSpread − fee_drag_pct − est_slippage_pct` 重算淨值。
  - `src/engine/dryRunEngine.ts:125-146` 寫死 0.05% 費率、資金費 = 名目 × 費率（凍結模組，C-04）。
  - `src/types/schema.ts:11` 已有 `FeeTierConfig`，但沒有任何程式使用。
- **決策依據**：✅ C-13（Net = Funding + Price − Fees；Slippage 僅歸因）、✅ C-17（單腿名目、ROI 分母雙腿合計）、✅ C-09（本 change = 開工順序第 3 項）、規格書 §17 / §18 / §20、技術書 §14 / §22–§25。
- **下游**：`position-funding-pnl`（Position / TradeResult 用本 change 的公式）、`paper-trading-event-loop`（ARM 呼叫預測費率風險重算、`funding-settlement-rules` 的已結算金額）、`paper-execution-engine`（模擬撮合用逐檔吃單與 Fee Engine）。
- **限制**：HANDOFF §3 Invariants（不下真實單、策略層無交易所分支、費率存小數、不假設 8h）；本 change 只產生純函式與研究端修正。

## Goals / Non-Goals

**Goals:**

- 建立 Runtime 與研究端**共用的唯一一套**成本公式：手續費、滑價、滑價歸因、Net 組合、資金費金額、Expected Net PnL、淨 spread 排序 / 門檻、預測費率風險重算。
- 每一個公式先寫失敗測試再實作，並用 spec 中的具體數字鎖住（技術書 §42 Unit Test：Funding、Fee、Slippage、PnL）。
- 修掉研究端 Q-05 重複扣除與 Q-06 以毛 spread 判斷的錯誤，並讓 live-scan / 前端過渡到新口徑。

**Non-Goals:**

- WebSocket 盤口、Position / TradeResult、ARM 排程、私有端點讀取 VIP 費率、預測誤差折扣、結算窗口放大係數、OKX mark 來源修正、hedge ratio 基準（C-19）。詳見 proposal Non-goals。

## Decisions

### 1. 純函式模組放在 `runtime/src/accounting/`，研究端直接 import

```
runtime/src/accounting/
├── feeConfig.ts        FeeTierConfig、預設表、載入驗證、fee_config_version
├── feeEngine.ts        estimateFee / feeForFill
├── slippageEngine.ts   walkBook / topOfBook / withBuffer
├── pnlFormula.ts       composeNetPnl / slippageAttribution（C-13 唯一實作）
├── fundingMath.ts      fundingCashflow（mark × qty × rate）
└── expectedNet.ts      estimateExpectedNet / netSpread / selectBestPair / rankByNet / evaluatePredictedRateRisk
```

- **為什麼**：技術書 §4 已把 Fee / Slippage / PnL 放在 `accounting/`；規格書 §2.1 規則 3 要求新邏輯不得依賴舊型別，但舊程式可以使用新模組。成本公式若在 `server.ts`、`src/engine/`、Runtime 各寫一份，就會重演 Q-05（兩處口徑不同）。
- **約束**：這些檔案 MUST 不引用 Node API（`fs`、`process` 等）與任何 I/O，也不讀時鐘；以一個測試掃描 import 清單把關，確保 Vite（前端）與 `tsx`（`server.ts`）都能直接 import。
- **`FeeTierConfig`**：移到 `runtime/src/accounting/feeConfig.ts`（新增 `source: 'DEFAULT_ESTIMATE' | 'CONFIG' | 'ACCOUNT_API'`），`src/types/schema.ts` 改為 re-export（舊 → 新方向，符合 §2.1）。
- **替代方案**：(a) 放在 `src/engine/` 讓 Runtime 反向 import → 違反 C-07（Runtime 與研究原型分開）與 §2.1 規則 3，否決。(b) 另開 npm workspace 套件 → 需要改 `package.json` 與安裝流程，對目前規模過重，否決。

### 2. Fee Engine：資料驅動、無交易所分支

- 查表鍵 = `(exchange, tier_name)`；`liquidity`：`MAKER` → maker、`TAKER` / `SIMULATED` → taker（保守；Paper 撮合目前都是模擬吃單）。
- 預設表取自 Q-06 的 VIP0 費率（Binance / OKX / Pionex 0.02% / 0.05%、Bybit 0.02% / 0.055%、Bitget 0.02% / 0.06%），**全部來自第三方或非費率頁**，標示 `DEFAULT_ESTIMATE`；UI 顯示時要能看出是估計值（Invariant #7、技術書 §52「缺少 key → 使用預設手續費並標示為估計值」）。
- 驗證範圍 `[−0.001, 0.01]`：擋掉「0.05 當 0.05%」的百分比誤填（Invariant #5），同時允許 maker rebate。
- 查不到交易所 → `FEE_TIER_MISSING`，**不**默默補 0.0005（否則等於把寫死值藏進查表）。
- `fee_config_version` = 費率表內容的穩定雜湊；寫入每次估計結果，之後隨 `PaperTradingConfig.config_version` 進入 `Trade.config_version`（規格書 §14.3 第 5 點）。
- **靜態檢查**：一個 vitest 測試掃描 `runtime/src/strategy/`、`runtime/src/scanner/` 與 `server.ts` 淨值段落，出現手續費字面值（`0.0005`、`0.00055`、`0.0006`、`0.0020`）即失敗。`server.ts` 本體不在掃描範圍。
- **提供給撮合的介面**：`feeEngine` 另匯出 `FeeRateSource` 實作（`getTakerFeeRate(exchange, symbol)` / `getMakerFeeRate(exchange, symbol)`），對應 `paper-execution-engine` design 中的費率介面。
- **替代方案**：`FEE_TABLE` 寫在程式常數（Q-06 解方 1 原文）→ 改 VIP 需改程式、無版本，否決；改為設定檔 + 預設表。

### 3. Slippage Engine：逐檔吃單 + safety buffer，退回模型明確標示

- 參考價 = mid `(best_bid + best_ask) / 2`；因此滑價包含半價差（小單的主要成本，Q-05）。
- `walkBook(side, quantity, book)`：BUY 吃 asks 由低到高、SELL 吃 bids 由高到低；回傳 `expected_avg_price`、`expected_slippage_pct`、`expected_slippage_usdt`、`fillable_quantity`、`depth_sufficient`。這也是 `paper-execution-engine` 模擬市價單成交的同一個函式（技術書 §14），確保「預估」與「模擬成交」同一口徑。
- 盤口數量以**基礎資產數量**輸入；合約張數 × 乘數的換算由呼叫端依 `instrument-registry` 完成（見「跨 change 假設」）。
- `slippage_safety_buffer_pct`（新設定，預設 0.0001 = 1 bp，待 Paper 校準）加在盤口滑價之上；成本估計一律使用含 buffer 值。
- 退回順序：`ORDERBOOK` → `TOP_OF_BOOK`（半價差 + buffer）→ `UNAVAILABLE`（Runtime 判不合格）。`LEGACY_VOLUME_TIER` 只允許研究端 `server.ts` 過渡使用並標示。
- **出場滑價**：出場在 T+30s 才發生，無法預知當時盤口；以「當下對手方向盤口」作為代理（進場 BUY 的腿，出場用 bids 估計 SELL）。結算窗口的價差放大（Q-05 解方 3）列入 Open Questions。
- **替代方案**：平方根衝擊模型 `k·σ·sqrt(Q/V)` → 需要校準參數，留作深度不可得時的後備（未來）；三級常數 → 即 P4 本身，否決。

### 4. C-13 的公式邊界：滑價只能出現在 Price PnL 裡

```
Net PnL = Funding PnL + Price PnL − Fees − Other Costs          （composeNetPnl，不接受滑價參數）
Price PnL（實際均價） = Price PnL（參考價） + slippage_attribution （恆等式，測試鎖住）
slippage_attribution = Σ −side_sign × (avg_fill − reference) × qty  （負值 = 成本）
```

- `composeNetPnl` 的參數型別**沒有**滑價欄位，從型別層面阻止重複扣除；`slippage_attribution_usdt` 只能由 `slippageAttribution` 產生，並只用於顯示 / 歸因（規格書 §20.1 的 UI 提示）。
- **Expected（事前）也套用同一結構**：`expected_price_pnl = expected_basis_pnl + expected_slippage_attribution`，再進入 `composeNetPnl`；也就是事前估計時滑價以「負的 Price PnL 子項」出現一次，而不是另外一個扣項。這讓事前估計、事後結果、UI 瀑布圖三者結構一致。
- **替代方案**：事前以 mark 計價、滑價列為獨立成本（Q-05 解方 1 (i)）→ 數值相同，但會出現「事前有 slippage 扣項、事後沒有」的兩套結構，UI 容易誤加總，否決。

### 5. 資金費金額：`−side_sign × base_quantity × mark_price × rate`

- 依 Binance FAQ「Funding Amount = Nominal Value of Positions × Funding Rate」，名目 = mark price × 數量（Q-07）。LONG `side_sign = +1`、SHORT `−1`；正費率 LONG 付、SHORT 收，與 `funding-settlement-rules`（"positive rate: LONG pays, SHORT receives"）一致。
- 本 change 只提供函式；**預期**金額（ARM 時以預測費率 × 當下 mark）由本 capability 使用，**已結算**金額（T 時 mark × 持倉數量 × 已結算費率）由 `funding-settlement-rules` / `position-funding-pnl` 呼叫同一函式。
- 單位：`base_quantity` 為基礎資產數量（已乘合約乘數）。

### 6. Expected Net PnL 與 basis

```
quantity_leg              = floor_to_step(target_notional_per_leg / reference_price_leg, qty_step_leg)
expected_funding          = Σ fundingCashflow(side, quantity_leg, mark_leg, predicted_rate_leg)
expected_fees             = Σ(4 筆) notional_fill × fee_rate(exchange, tier, liquidity_assumption)
expected_slippage_attr    = Σ(4 筆) slippageAttribution(…含 buffer)
entry_basis_pct           = (mid_short − mid_long) / mid_long
expected_basis_pnl        = NONE: 0 | ADVERSE_ONLY: min(0, entry_basis_pct) × notional | FULL: entry_basis_pct × notional
expected_price_pnl        = expected_basis_pnl + expected_slippage_attr
basis_risk_charge         = basis_risk_z × basis_sigma_pct × notional                   （Other Costs）
expected_net_pnl          = composeNetPnl(expected_funding, expected_price_pnl, expected_fees, basis_risk_charge)
net_spread_pct            = expected_net_pnl / target_notional_per_leg
```

- **為什麼 basis 用 mid**：`ask_long / bid_short − 1`（Q-07 解方 1 原式）包含兩腿半價差，已被滑價計入，再用會重複；以 mid 計算只保留「兩所價格本身的差」。
- **為什麼預設 `ADVERSE_ONLY`**：一組 delta-neutral 部位的價格損益 = `quantity × (basis_entry − basis_exit)`；entry basis 對我們不利時（short 所比 long 所便宜）若在出場前收斂就會實現虧損，有利時卻不保證收斂（He et al.：「perpetuals are not guaranteed to converge」）。保守地只計不利的一側；`FULL` / `NONE` 保留給日後以 Paper 數據校準（Open Question）。
- **Basis 風險折價**：`basis_risk_z`（預設 1.0）× `basis_sigma_pct`（持倉期間兩腿相對報酬差的標準差；預設 0.0005 為暫定值，可依 `symbol_tier_overrides` 覆寫）× 單腿名目，放在 §20 公式的 Other Costs，並在拆解中獨立列出。
- **每腿數量**：依 ✅ C-17 以「單腿目標名目 / 該腿參考價」換算，因此兩腿數量可能略有差異；以數量對齊（Q-07 解方 2）屬 C-19 範疇，不在本 change 決定。
- **輸出**：`ExpectedNetResult` = 上述所有欄位 + `qualified` + `reason?`（`SLIPPAGE_UNAVAILABLE`、`INSUFFICIENT_DEPTH`、`BELOW_MIN_NET_PNL`、`BELOW_MIN_NET_SPREAD`）+ `fee_config_version` + `cost_model_version` + 每腿 `slippage_model`、`mark_price_source`。對應到 Opportunity 的 `estimated_fee_pct`、`estimated_slippage_pct`、`estimated_funding_pnl`、`estimated_net_pnl`（規格書 §5），寫入由 `opportunity-lifecycle` 負責。

### 7. 淨 spread 選對 / 排序 / 門檻

- `selectBestPair(symbolQuotes)`：對同一幣種所有配對（由 `instrument-registry` 確認可配對、`settlement-session` 確認對齊與週期）計算 Expected Net，取 `net_spread_pct` 最大者；毛 spread 只放在輸出供顯示。
- `rankByNet(candidates)`：`net_spread_pct` 由大到小，平手時以 `expected_net_pnl_usdt` 再比，最後以 symbol 字母序（確定性）。
- 門檻：`expected_net_pnl_usdt ≥ minimum_expected_net_pnl_usdt` **且** `net_spread_pct ≥ minimum_net_spread_pct`。技術書 §38 的 `minimum_funding_spread_pct` 改名為 `minimum_net_spread_pct`（語意改為淨值；文件更新列在 tasks）。

### 8. 預測費率風險（Q-04 計算部分）

- `evaluatePredictedRateRisk(evaluated: ExpectedNetInput, latest: ExpectedNetInput, config)` → `{ result: 'OK' | 'SPREAD_FLIPPED' | 'BELOW_MIN_NET_PNL', recomputed: ExpectedNetResult }`。
- 判定順序：先方向（翻轉代表兩腿都可能付費，是最嚴重的情況），再淨值門檻。原因碼沿用 `opportunity-lifecycle` 的 ARM 規則，不新增碼。
- 純函式、不讀時鐘、不打 API；ARM（T-60s）重新讀取費率後呼叫它是 `paper-trading-event-loop` 的責任。

### 9. 研究端過渡（`server.ts` / 前端）

| 位置 | 變更 | 過渡期標示 |
|------|------|----------|
| `server/liveScanMath.ts`（`findBestPair`、`computeLiveScanNetPnl`；原 `server.ts:264-298`） | 每組配對呼叫 `estimateExpectedNet`；費率取預設費率表；滑價：有 bid/ask 的腿（Bybit `bid1Price`/`ask1Price`、Bitget、OKX tickers 已有）用 `TOP_OF_BOOK`，Binance 另以公開 `GET /fapi/v1/ticker/bookTicker`（單次全市場）取得 bid/ask；Pionex 等缺 bid/ask 的腿用 `LEGACY_VOLUME_TIER` | 候選帶 `slippage_estimated = true` |
| `server.ts:333,337`（或其抽出位置） | `best_pair` 依淨值、`sort` 依 `net_spread_pct`、`meets_threshold = expected_net_pnl_usdt ≥ research_min_net_pnl_usdt`（預設 0，Q-06 解方 1） | — |
| live-scan 回應 | 新增 `net_spread_pct`、`pair_net_spreads`、`slippage_model`（每腿）、`entry_basis_pct`、`fee_config_version`、`mark_price_source`（OKX = `LAST`）；保留 `spread`（毛）、`fee_drag_pct`（改為該配對實際手續費，標 `@deprecated`）、`est_slippage_pct`、`expected_net_pnl_pct/usdt`（改為淨值） | README §4 同步 |
| `src/types/systemSpec.ts`、`liveMarketService.ts` | `LiveMarketCandidate` / `FunnelCandidate` 補欄位 | — |
| `FunnelScannerView.tsx:199,250` | 不再自行重算；逐配對視圖讀 `pair_net_spreads[pairKey]`；預設排序改淨值；毛 spread 為次要欄位 | 估計值以灰色 / 斜體 |
| `ExecutionSimulator.tsx` | 手續費依腿別交易所對應（修 `longFee → pionex_taker_fee` 的錯置）；滑價欄位加「已含在 Price PnL 中，不另外扣除」（§20.1） | — |
| `arbitrageEngine.ts` | Q-05：`net = gross − fee`；`total_slippage` 保留為歸因；預設 `pionex_taker_fee` / `binance_taker_fee` 改由預設費率表取得 | — |
| `dryRunEngine.ts` | 只把 `0.0005` 換成預設費率表查詢（P9 bug fix；凍結模組不加功能） | — |

- **為什麼研究端也要改**：研究 UI 是使用者判斷「值不值得做」的入口；若 Runtime 用淨值而 UI 仍用毛 spread，兩邊排名不同，會誤導校準。
- **之後**：`websocket-data-layer` 完成後，live-scan 改讀 Runtime 的 market state 與盤口快照，`TOP_OF_BOOK` / `LEGACY_VOLUME_TIER` 由 `ORDERBOOK` 取代；公式不變。
- **替代方案**：研究端維持舊口徑、只在 Runtime 用新模型 → 兩套口徑並存正是 Q-05 / Q-06 的根源，否決。

### 10. 持久化與事件

- 本 change **不新增持久化實體、也不產生狀態轉換**，因此不直接產生 TradingEvent。成本拆解以 `cost_breakdown`（含 `fee_config_version`、`cost_model_version`）放入 `opportunity-lifecycle` 的 `OPPORTUNITY_QUALIFIED` / `OPPORTUNITY_REJECTED` 事件 payload，由該 capability 寫入（規格書 §25 第 2 點）。

## 跨 change 假設

1. **`setup-vitest`**（`test-infrastructure`）已提供 vitest、`npm test`、`src/engine/arbitrageEngine.test.ts`（含 `[Q-05]` 現況 `net_pnl ≈ −2.400000108`）與 `server/liveScanMath.test.ts`（`findBestPair`、`computeLiveScanNetPnl` 的 `[Q-05][P4]`、`[Q-06]` 現況）。本 change 修正時更新這些期望值並標註為刻意修正；若某案例不存在，tasks 1.1 先補上再修改。
2. **`runtime/` 骨架**：若 `paper-trading-event-loop`（tasks 2.1）尚未建立 `runtime/` 的 tsconfig / vitest include，本 change 建立最小骨架（只含 `runtime/src/accounting/`），先合併者建立、後合併者沿用。
3. **`instrument-registry`** 提供 `InstrumentSpec { exchange, symbol, contract_multiplier, qty_step, min_qty, tick_size }`；成本模型只使用 `qty_step`（名目 → 數量捨去），盤口數量由呼叫端乘上 `contract_multiplier` 轉為基礎資產數量。
4. **`market-data-stream`**（websocket-data-layer）之後提供 `OrderBookSnapshot { exchange, symbol, bids, asks, exchange_timestamp, local_received_timestamp }`；本 change 只定義輸入介面 `BookLevel { price, quantity }`（基礎資產數量），由資料層轉換。
5. **`trading-schema`** 的 `Opportunity`（規格書 §5）欄位 `estimated_fee_pct`、`estimated_slippage_pct`、`estimated_funding_pnl`、`estimated_net_pnl` 以本 change 的輸出填入；建議 `trading-schema` 另增 `entry_basis_pct`、`net_spread_pct`、`fee_config_version`（若不增，放在事件 payload）。
6. **`PaperTradingConfig`**（技術書 §38）新增：`fee_tiers`、`slippage_safety_buffer_pct`、`liquidity_assumption`、`basis_convergence_assumption`、`basis_risk_z`、`basis_sigma_pct`、`minimum_net_spread_pct`（取代 `minimum_funding_spread_pct`）；設定載入與版本化由 Runtime `config/` 負責，本 change 只提供欄位驗證函式。
7. **`paper-execution-engine`** 以本 change 的 `FeeRateSource` 取得費率；其 `execution/matching.ts` 目前自帶 walkBook。建議改為 import 本 change 的 `slippageEngine.walkBook`；若維持各自實作，兩者 MUST 通過同一組測試（技術書 §14 的 250 單位 → 100.006），避免預估與模擬成交口徑不同。該 change 的 `Fill.slippage_from_reference_pct` 為百分比且「正值 = 比參考價差」，與本 change 的 `slippageAttribution`（USDT、負值 = 成本）是不同欄位，歸因一律以 `reference_price` 與成交價重新計算。

## Risks / Trade-offs

- [預設費率來自第三方頁面，可能過時] → 標示 `DEFAULT_ESTIMATE`；之後以唯讀帳戶端點覆寫（另立 change）；費率表有版本，可追溯。
- [研究端數字「變好看」（Q-05 修正後 net 少扣約 1.2 USDT / 1000U）且排名大幅改變] → HANDOFF §7 與 UI 記錄修正前後差異；特性測試的舊值改動要在 PR 中明確標示為「刻意修正」。
- [top-of-book 低估厚單衝擊] → 研究端只做 1000U 級距估計；Runtime 必須有 `ORDERBOOK`，否則不合格。
- [`ADVERSE_ONLY` 過度保守，可能錯殺有利 basis 的機會] → 設定可切換，Paper 期間統計實際 basis 收斂率再調整。
- [`basis_sigma_pct` 暫定 0.0005 缺乏實證] → 依 symbol tier 覆寫；B7 歷史窗口資料到位後校準。
- [出場滑價以當下盤口代理，結算前後價差通常放大] → safety buffer 吸收一部分；Open Question 追蹤結算窗口放大係數。
- [Binance 新增 bookTicker 請求增加限流權重（BE-03）] → 單次全市場請求、沿用 live-scan 快取週期；失敗時該腿退回 `LEGACY_VOLUME_TIER` 並標示。

## Migration Plan

1. 在 `feature-net-cost-model`（來自 `develop`）開發；Runtime 模組為新增檔案，不影響既有行為。
2. 研究端修改依序、每步三綠（規格書 §2.1）：先確認特性測試 → 修 `arbitrageEngine`（更新特性測試期望值並標註）→ `server.ts` → 前端。
3. `--no-ff` merge 回 `develop`；rollback：`git revert -m 1 <merge-commit>`（技術書 §51.3）。研究 API 新欄位為加法，舊欄位保留，前端回滾不需資料遷移。

## Open Questions

1. 各所實際 VIP0 費率（Binance / Bybit 官方頁未能取得，Q-06）——何時以唯讀端點（例如 Binance `GET /fapi/v1/commissionRate`）驗證並覆寫？需另立 change。
2. `basis_convergence_assumption` 預設 `ADVERSE_ONLY` 與 `basis_sigma_pct = 0.0005` 是否可接受？建議 Paper 累積 2 週資料後校準。
3. `slippage_safety_buffer_pct` 預設 1 bp 是否可接受？
4. 結算窗口（T±1m）價差放大係數（Q-05 解方 3）與預測費率誤差折扣（Q-04 解方 3）何時納入——依賴 B7 歷史資料。
5. 研究端 `research_min_net_pnl_usdt` 預設 0（Q-06「net > 0」）是否要改為與 Runtime 相同的 `minimum_expected_net_pnl_usdt`？
