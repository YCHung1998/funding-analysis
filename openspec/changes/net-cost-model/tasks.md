> 前置：`setup-vitest` 已完成（技術書 §50.1 第 1 項）；`instrument-registry` 的 `qty_step` / `contract_multiplier` 可用（第 2 項）。分支 `feature-net-cost-model`（來自 `develop`）。
> 每個公式任務先寫失敗測試（使用 spec 情境中的數字）再實作；每個任務結束時 `npm run lint`、`npm run build`、`npm test` 皆綠（規格書 §2.1）。不打任何交易所 API。

## 1. 前置與骨架

- [x] 1.1 確認 `setup-vitest` 的 `src/engine/arbitrageEngine.test.ts`（`[Q-05]` 鎖住 `net_pnl ≈ −2.400000108`）與 `server/liveScanMath.test.ts`（`[Q-05][P4]`、`[Q-06]`）存在且綠燈（缺少則先補）；建立 `runtime/src/accounting/`（若 `runtime/` 骨架尚不存在則建立最小 tsconfig / vitest include），加入「accounting 模組不得 import Node API / I/O / 時鐘」的自動檢查測試

## 2. Fee Engine

- [x] 2.1 `feeConfig.ts`：`FeeTierConfig`（含 `source`）、預設費率表（`DEFAULT_ESTIMATE`）、載入驗證（`FEE_RATE_OUT_OF_RANGE`、`FEE_TIER_MISSING`）、`fee_config_version`；`src/types/schema.ts` 改為 re-export
- [x] 2.2 `feeEngine.ts`：`estimateFee` / `feeForFill`（MAKER / TAKER / SIMULATED→TAKER）、`FeeRateSource` 實作（供 `paper-execution-engine`）與「策略 / 掃描層不得出現手續費字面值」靜態檢查測試

## 3. Slippage Engine 與公式原語

- [x] 3.1 `slippageEngine.ts`：`walkBook`（BUY 250 → 100.006、SELL 100 → 99.985、深度不足 `INSUFFICIENT_DEPTH`）、safety buffer、`TOP_OF_BOOK` 退回（SONY 案例四筆 ≥ 0.4%）、`UNAVAILABLE`
- [x] 3.2 `pnlFormula.ts` + `fundingMath.ts`：`slippageAttribution`、`composeNetPnl`（型別不含滑價參數；「滑價不被重複扣除」案例 −1.00 而非 −2.00；參考價 PnL + 歸因 = 實際 PnL 恆等式）、`fundingCashflow`（+1.01、正負號三案例、與 `funding-settlement-rules` 的 +1.00 一致）

## 4. Expected Net PnL 與決策函式

- [x] 4.1 `expectedNet.ts` `estimateExpectedNet`：數量依 step 捨去、預期 funding、四筆手續費、含 buffer 滑價歸因、entry basis（NONE / ADVERSE_ONLY / FULL）、basis 風險折價、成本拆解與版本欄位（完整拆解 −0.50 案例）。註：`rate_source = 'PREDICTED'` 欄位未加入 `ExpectedNetResult`（非型別既有欄位、非 spec Scenario 斷言的硬性輸出）——若下游 `paper-trading-event-loop` 需要此標記請在該 change 補上，見報告「待確認」。
- [x] 4.2 `netSpread` / `selectBestPair` / `rankByNet` / 門檻判定（`meetsNetThreshold`；MEW −0.00022、P2 勝 P1、B 排在 A 前）與 `evaluatePredictedRateRisk`（`BELOW_MIN_NET_PNL` −1.10、`SPREAD_FLIPPED`）

## 5. 研究端修正與過渡

- [ ] 5.1 `arbitrageEngine.ts` Q-05 修正：先把特性測試期望改為 `≈ −1.20` 並確認紅燈，再改 `net = gross − fee`、腿別 net 同步、`total_slippage` 保留為歸因、預設費率改取費率表；`ExecutionSimulator` 手續費依腿別交易所對應並加 §20.1 滑價提示
- [ ] 5.2 `server/liveScanMath.ts`（`findBestPair`、`computeLiveScanNetPnl`）與 `server.ts` live-scan 改用成本模型：先把 `liveScanMath.test.ts` 的 `[Q-05][P4]` / `[Q-06]` 期望改為淨值口徑並確認紅燈，再實作（預設費率表、Binance bookTicker + 各所 top-of-book、`LEGACY_VOLUME_TIER` 標示、淨值選對 / 排序 / `meets_threshold`、新欄位）；以固定假回應的測試驗證「毛 spread 最大者不再排第一」；`systemSpec.ts` / `liveMarketService.ts` 型別補欄位
- [ ] 5.3 前端 `FunnelScannerView` 改讀伺服器淨值（`pair_net_spreads`、預設淨值排序、毛 spread 次要欄位、估計值樣式）；`dryRunEngine.ts` 費率改查預設表（P9 bug fix）；README §4 mock / 估計值表同步

## 6. 文件與收尾

- [ ] 6.1 更新文件：規格書 §5（成本欄位語意）、§17（第一階段模型與退回順序）、§20（Expected 同結構）；技術書 §24、§25、§38（新設定欄位、`minimum_funding_spread_pct` → `minimum_net_spread_pct`）；HANDOFF §4.2 P4 / P9 狀態、§6 B9；issue Q-05 / Q-06 驗收勾選
- [ ] 6.2 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate net-cost-model --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄（含 Q-05 修正前後數字）
