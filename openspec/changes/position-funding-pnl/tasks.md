> 前置：`setup-vitest`、`net-cost-model`、`trading-schema-types`、`trading-event-store` 已完成；`paper-trading-event-loop` 的 `funding-settlement-rules` 狀態機已存在（或與本 change 並行時依 design Decision 1 收斂）。分支 `feature-position-funding-pnl`（來自 `develop`）。
> 每個公式 / 帳務任務先寫失敗測試（使用 spec 情境中的數字）再實作；所有時間用 VirtualClock，Fill 以固定 fixture 產生，不打任何交易所 API。每個任務結束時 lint / build / test 皆綠。

## 1. Position（position-accounting）

- [ ] 1.1 `PaperPosition` 補充欄位（提交給 `trading-schema-types`）與純函式 `positionManager.applyFill` 開倉：`Fill.quantity × contract_multiplier` 換算、Fill 分類（entry / exit order ids）、加權平均與逐筆累加（30 / 20 / 50 → 100.03）、無 Fill 不建倉、`fill_id` 冪等、TradeLeg 實際欄位回寫
- [ ] 1.2 平倉與實現 PnL（LONG 60 / 40 → +23.00、avg exit 100.26；SHORT +10.00）、手續費與滑價歸因累加（呼叫 `cost-model.slippageAttribution`）、`RECONCILIATION_ERROR`（`UNKNOWN_ORDER`、`POSITION_OVERCLOSE`、`UNSUPPORTED_FEE_ASSET`）
- [ ] 1.3 `unrealizedPnl`（+9.94 / −10.00）、Position 時間戳、`status` OPEN / CLOSED 與 `POSITION_OPENED` / `POSITION_CLOSED` 事件（經 `Ledger.applyFill` 原子寫入）、重播一致性測試

## 2. Hedge ratio 與 imbalance（position-accounting）

- [ ] 2.1 `hedgeRatio`：`NOTIONAL` / `QUANTITY` 可切換（預設 `NOTIONAL`，C-19 未決）、0.30 / 0.995025 vs 1.0 / 合約乘數案例、`notional_ratio` / `quantity_ratio` 同時回傳、`classifyHedge`（邊界 0.99、0.90、tier 覆寫）；與 `paper-execution-engine` 的 `hedgeRatio.ts` 收斂為單一實作（該 change 改為 import，或本 change 沿用其實作並補測試），不重複發 `HEDGE_RATIO_CHANGED`
- [ ] 2.2 Leg imbalance 量測：`leg_imbalance_usdt`、`max_leg_imbalance_usdt`、`max_leg_imbalance_duration_ms`（補足案例 1000 / 800 ms、緊急平倉案例 1000 / 5,200 ms）

## 3. FundingSettlement 金額（pnl-engine）

- [ ] 3.1 `fundingAmount` hook：EXPECTED（+1.80）、ELIGIBLE 以實際數量重算（+1.791）、SETTLED 寫入 `actual_cashflow_usdt` / `position_notional` / `settled_funding_rate` / 覆寫 `funding_rate`（+1.00、快照 +0.501）、NOT_ELIGIBLE = 0、MISSED 空值；全部呼叫 `cost-model.fundingCashflow`
- [ ] 3.2 與 `funding-settlement-rules` 狀態機串接：金額與狀態轉換同一交易、金額放入同一筆事件 payload、不產生第二筆事件；若狀態機已自帶現金流計算，改為呼叫 `fundingAmount` 並保留其 +1.0 USDT 測試
- [ ] 3.3 Q-08：單腿失敗只計實際 funding（鎖定區間前緊急平倉 → 0、net −3.00；裸腿跨結算 → −0.50）；研究端 `dryRunEngine.ts:145` 先補失敗測試 `leg_long === 0` 再修正

## 4. TradeResult（pnl-engine）

- [ ] 4.1 `tradeResultAssembler`：price / fee / slippage attribution / funding 加總、`net = composeNetPnl(...)`（S01 −0.50、非 −0.90）、ROI（C-17：−0.02499 / −0.11013、單腿 −0.30、零成交 0）、`final_status` / `result_reason`、durations、leg imbalance 欄位；確認 `trading-schema` 的 `TradeResult` 含 `funding_confirmed`
- [ ] 4.2 暫定與定案：終態建立（`funding_confirmed = false`）、每次結算更新重算（2.00 → 1.90）、全部終態後 `finalized_at` 與 `funding_confirmed`、MISSED 標記 `FUNDING_MISSED_MANUAL_REVIEW`、單一 `TRADE_COMPLETED` 事件、定案後不可自動修改
- [ ] 4.3 帳務情境測試（`runtime/test/scenarios/`）：S01 完整成功（技術書 §43）、零成交 ABORTED（§44）、單腿失敗 EMERGENCY_EXIT（§45 / S03 / S12）的 Position → FundingSettlement → TradeResult 全鏈；斷言所有實體有 `created_at` / `updated_at`、事件時間單調不減（技術書 §42）

## 5. 收尾

- [ ] 5.1 更新文件（規格書 §14 註明 `hedge_ratio_basis` 切換設定但 C-19 仍待決、§21 欄位計算方式；技術書 §20–§23、§38 新設定欄位）；執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate position-funding-pnl --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄
