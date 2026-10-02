## Why

目前所有「預期淨利」都建立在錯誤的成本口徑上：研究引擎把滑價扣兩次（Q-05，1000U 多扣約 1.2 USDT）、即時掃描以 Binance 24h 量三級常數代替盤口（HANDOFF P4）、手續費一律寫死 0.05%（P9、Q-06）、以毛 spread 排序與判門檻、跨所價差完全不進入預期 PnL、資金費以固定名目本金而非 `mark price × 數量` 計算（Q-07），預測費率也被當成已鎖定的收益（Q-04）。Paper Runtime 的 Opportunity 篩選、ARM 決策與 PnL 定案都要依賴同一套成本公式，依技術書 §50.1（✅ C-09）第 3 項，必須在 WebSocket 資料層與 Paper Runtime 之前，先把成本模型改為淨值口徑並用測試鎖住。

分支：`feature-net-cost-model`（來自 `develop`）。

## What Changes

- **手續費設定化（Fee Engine）**：以 `FeeTierConfig` 建立每所 × 帳戶等級 × maker/taker 的費率表（小數），附 `fee_config_version`；提供 `estimateFee` / `feeForFill`；策略與掃描層只能取得 `estimated_fee`，不得寫死 0.05%（技術書 §24、HANDOFF P9 / B9、Q-06）。
- **盤口深度滑價（Slippage Engine）**：逐檔吃單（walk-the-book）求預估成交均價與滑價（例：技術書 §14 的 250 單位 → 均價 100.006），第一階段 = Orderbook + 可設定 safety buffer（規格書 §17、技術書 §25）；只有 bid1/ask1 時退回 `TOP_OF_BOOK` 半價差模型並標示；深度不足回報 `INSUFFICIENT_DEPTH`，不以常數填補（HANDOFF P4、Q-05）。
- **C-13 淨值公式鎖定**：`Net PnL = Funding + Price − Fees − Other Costs`；Slippage 只作歸因（`slippage_attribution_usdt`，已含在 Price PnL），提供 `composeNetPnl` 與 `slippageAttribution` 兩個唯一實作（規格書 §20、技術書 §22）。
- **資金費金額公式**：`cashflow = −side_sign × quantity × mark_price × rate`（LONG = +1、SHORT = −1；正費率 LONG 付、SHORT 收），數量為基礎資產數量，不再使用固定名目本金（規格書 §18、技術書 §23、Q-07）。
- **預期淨利（Expected Net PnL）**：`expected_net = expected_funding + expected_price_pnl − expected_fees − basis_risk_charge`，其中 `expected_price_pnl = expected_basis_pnl + expected_slippage_attribution`（滑價只出現一次）；跨所價差（entry basis）與 basis 風險折價納入（Q-07）。
- **以淨 spread 選對、排序與判門檻**：`net_spread_pct = expected_net_pnl_usdt / target_notional_per_leg_usdt`；best pair 依淨值選擇；門檻改用 `minimum_expected_net_pnl_usdt` 與 `minimum_net_spread_pct`；毛 spread 僅作顯示（Q-06）。
- **預測費率風險（Q-04 計算部分）**：提供 `evaluatePredictedRateRisk`，以最新預測費率重算淨值並回傳 `SPREAD_FLIPPED` / `BELOW_MIN_NET_PNL`；T-60s ARM 何時呼叫由 `paper-trading-event-loop` 負責。
- **修正研究端 Q-05 重複扣除**：`src/engine/arbitrageEngine.ts` 的 `net_pnl` 與腿別 `net_pnl` 不再減 `total_slippage`（先由 `setup-vitest` 的特性測試鎖住舊值 ≈ −2.40，再改為 ≈ −1.20）；`ExecutionSimulator` 手續費依腿別交易所對應（Q-06 第 3 點）並加上 §20.1 的滑價提示。
- **研究端過渡**：live-scan 計算（`setup-vitest` 已自 `server.ts` 抽出至 `server/liveScanMath.ts` 的 `findBestPair`、`computeLiveScanNetPnl`）改呼叫成本模型（每所費率、top-of-book 滑價、淨值選對 / 排序、`meets_threshold` 改為淨值判定），新增 `net_spread_pct`、`pair_net_spreads`、`slippage_model`、`entry_basis_pct`、`fee_config_version` 欄位；前端 `FunnelScannerView` 改用伺服器回傳的淨值、不再自行以 `fee_drag_pct` 重算。**BREAKING（研究 API 語意）**：`best_pair`、排序與 `meets_threshold` 由毛 spread 改為淨值口徑；`spread` 欄位保留為毛 spread。

## Non-goals

- 不實作 WebSocket 盤口訂閱（`market-data-stream`，websocket-data-layer）；本 change 的滑價引擎只吃「傳入的盤口快照」。研究端在過渡期只用 REST ticker 的 bid1/ask1。
- 不實作 Position / Fill 推導、TradeResult 組裝、FundingSettlement 寫入（`position-funding-pnl`）；本 change 只提供公式。
- 不實作 ARM 排程與 Opportunity 狀態轉換（`paper-trading-event-loop` 的 `opportunity-lifecycle`），只提供重算函式。
- 不呼叫任何私有端點讀取實際 VIP 費率（技術書 §52 允許唯讀，但另立 change）；不下任何訂單。
- 不建立「預測 vs 已結算」誤差折扣模型（Q-04 解方 3，需累積資料）、不做結算窗口價差放大係數（Q-05 解方 3，需 B7 歷史資料）。
- 不修正 OKX mark 取自 `last` 的問題（Q-07 第 4 點，屬資料層）；僅在輸出標示 `mark_price_source`。
- 不擴充 `dryRunEngine`（✅ C-04 凍結），只把寫死的 0.05% 改為讀取預設費率表（P9 bug fix）。
- 不處理 hedge ratio 計算基準（C-19 待決）。

## Capabilities

### New Capabilities

- `cost-model`: 手續費設定與計算、盤口深度滑價與 safety buffer、滑價歸因、C-13 淨值組合公式、資金費金額公式（mark price × 數量）、Expected Net PnL（含 basis）、淨 spread 選對 / 排序 / 門檻、預測費率風險重算。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability。引用但不修改：`test-infrastructure`、`instrument-registry`、`market-data-stream`、`trading-schema`、`opportunity-lifecycle`、`funding-settlement-rules`。）

## Impact

- **新增程式**：`runtime/src/accounting/feeEngine.ts`、`slippageEngine.ts`、`pnlFormula.ts`、`fundingMath.ts`、`expectedNet.ts`、`feeConfig.ts`（純函式、無 I/O、不引用 Node API，研究端 `server.ts` 與前端可直接 import）。
- **修改程式（研究端）**：`src/engine/arbitrageEngine.ts`（Q-05）、`src/components/ExecutionSimulator.tsx`、`src/components/FunnelScannerView.tsx`、`src/services/liveMarketService.ts`、`src/types/systemSpec.ts`（live-scan 欄位）、`src/types/schema.ts`（`FeeTierConfig` 改為 re-export）、`server/liveScanMath.ts`（`findBestPair`、`computeLiveScanNetPnl`）與 `server.ts`（Binance bookTicker 抓取、排序 / 輸出欄位）、`src/engine/dryRunEngine.ts`（只改費率來源）。
- **文件**：規格書 §5（Opportunity 成本欄位語意）、§17、§20；技術書 §24、§25、§38（新設定欄位）；`assets/HANDOFF.md` §4.2（P4、P9 狀態）、§6（B9）、§7；README §4 mock 表。
- **依賴**：`setup-vitest`（必要，含 `src/engine/arbitrageEngine.test.ts` 與 `server/liveScanMath.test.ts` 特性測試）、`instrument-registry`（合約乘數 / step size，用於名目 → 數量換算）。下游：`position-funding-pnl`、`paper-trading-event-loop`（ARM 重算）、`paper-execution-engine`（成交滑價與手續費）、`websocket-data-layer`（盤口快照來源）。
- **對應**：規格書 §5、§7、§17、§18、§20、§21、✅ C-09、✅ C-13、✅ C-17；技術書 §14、§22–§25、§38、§42；issue Q-04（計算部分）、Q-05、Q-06、Q-07；HANDOFF P4、P9、B9。
