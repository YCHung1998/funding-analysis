## ADDED Requirements

### Requirement: FundingSettlement 預期金額
當 `funding-settlement-rules` 建立某腿的 `FundingSettlement`（`EXPECTED`）時，pnl-engine SHALL 以 `cost-model` 的 `fundingCashflow(position_side, TradeLeg.target_quantity, 當下 mark_price, 預測 funding_rate)` 計算 `expected_cashflow_usdt`；該腿轉為 `ELIGIBLE` 時 SHALL 以實際持倉數量與當下 mark price、最新預測費率重算 `expected_cashflow_usdt`。本 capability MUST NOT 決定何時建立或轉換狀態，只負責金額。

#### Scenario: EXPECTED 金額
- **WHEN** SHORT 腿 `target_quantity = 10`，建立時 mark price 100、預測費率 0.0018
- **THEN** `expected_cashflow_usdt = +1.80`

#### Scenario: ELIGIBLE 時以實際數量重算
- **WHEN** 同一腿實際持倉 9.95、轉 `ELIGIBLE` 時 mark price 100、預測費率 0.0018
- **THEN** `expected_cashflow_usdt = +1.791`

### Requirement: FundingSettlement 已結算金額寫入
當 `funding-settlement-rules` 將某腿轉為 `SETTLED` 時，pnl-engine SHALL 在同一交易中寫入：`actual_cashflow_usdt = fundingCashflow(position_side, T 時持倉數量, T 時 mark_price, 已結算費率)`、`position_notional = T 時 mark_price × T 時持倉數量`、`settled_funding_rate = 已結算費率`，並依規格書 §18 以已結算費率覆寫 `funding_rate`（原預測值保留於事件 payload 的 `predicted_funding_rate`）。該次狀態轉換的 `FUNDING_SETTLED` 事件 payload MUST 包含 `actual_cashflow_usdt`、`position_notional`、`settled_funding_rate`、`predicted_funding_rate`、`mark_price`、`mark_price_source`、持倉數量；pnl-engine MUST NOT 另外產生第二筆事件。`NOT_ELIGIBLE` 的腿 SHALL 寫入 `actual_cashflow_usdt = 0`；`MISSED` 的腿 `actual_cashflow_usdt` 保持空值。

#### Scenario: 結算後寫入金額（與 funding-settlement-rules 一致）
- **WHEN** SHORT 10 單位通過鎖定區間，已結算紀錄為費率 0.0010、mark price 100，原預測費率 0.0012
- **THEN** `actual_cashflow_usdt = +1.00`、`position_notional = 1000`、`settled_funding_rate = 0.0010`、`funding_rate = 0.0010`，`FUNDING_SETTLED` payload 含 `predicted_funding_rate = 0.0012`

#### Scenario: Mark price 使用快照
- **WHEN** 已結算來源沒有 mark price，改用 T 時 market state 快照 100.2，LONG 10 單位、已結算費率 −0.0005
- **THEN** `actual_cashflow_usdt = +0.501`，payload `mark_price_source = 'SNAPSHOT'`

#### Scenario: 不符資格
- **WHEN** 某腿轉為 `NOT_ELIGIBLE`
- **THEN** `actual_cashflow_usdt = 0`

### Requirement: 單腿失敗只計該腿實際 funding（Q-08）
Trade 的 `funding_pnl_usdt` SHALL 只加總各腿 FundingSettlement 的實際現金流：沒有 FundingSettlement 或為 `NOT_ELIGIBLE` 的腿計 0；未成交的腿 MUST NOT 被計入對沖 funding；裸腿若全程持倉通過鎖定區間而 `SETTLED`，SHALL 計入其實際現金流（可能為負）。緊急平倉 Fill 的價格、手續費、滑價歸因 MUST 全部計入該 Trade。

#### Scenario: 單腿成交後在鎖定區間前緊急平倉
- **WHEN** Short 腿被拒絕（0 成交），Long 腿 BUY 10 @ 100.00（參考價 99.99）後於 T−20s 緊急平倉 SELL 10 @ 99.80（參考價 99.85），兩筆手續費各 0.50，long 預測費率 −0.003
- **THEN** 兩腿 funding 皆為 0（不是 +3.00）、`price_pnl_usdt = −2.00`、`fee_usdt = 1.00`、`slippage_attribution_usdt = −0.60`、`net_pnl_usdt = −3.00`

#### Scenario: 裸腿持倉跨過結算
- **WHEN** Short 腿 0 成交，Long 腿 10 單位因緊急平倉失敗而全程持倉至 T+40s，已結算費率 +0.0005、T 時 mark price 100
- **THEN** Long 腿 funding = −0.50、Short 腿 = 0、`funding_pnl_usdt = −0.50`

#### Scenario: 研究端 dry-run 同步修正
- **WHEN** `runDryRun` 以 `forceLegImbalance = true`、`longRate = −0.003` 執行
- **THEN** `cost_table.funding_pnl.leg_long === 0`

### Requirement: TradeResult 損益組成（C-13）
TradeResult SHALL 由 Position 與 FundingSettlement 組裝：`price_pnl_usdt = Σ 各腿 realized_price_pnl_usdt`（實際均價，已含滑價）、`fee_usdt = Σ 各腿 fees_usdt`（正值 = 成本）、`slippage_attribution_usdt = Σ 各腿 slippage_attribution_usdt`（僅歸因）、`funding_pnl_usdt` 依 Q-08 規則加總、`net_pnl_usdt = composeNetPnl(funding_pnl_usdt, price_pnl_usdt, fee_usdt, other_costs_usdt)`（`cost-model` 唯一實作，`other_costs_usdt` 目前為 0）。`slippage_attribution_usdt` MUST NOT 參與 `net_pnl_usdt` 的計算。

#### Scenario: 完整成功交易（S01）
- **WHEN** Long Binance 開倉 10 @ 100.01（參考 100.00）、平倉 10 @ 100.19（參考 100.20）；Short Bybit 開倉 10 @ 100.09（參考 100.10）、平倉 10 @ 100.31（參考 100.30）；四筆手續費 0.50、0.50、0.55、0.55；兩腿 SETTLED：Long 費率 −0.0002、Short 費率 0.0018，T 時 mark price 皆 100
- **THEN** `price_pnl_usdt = −0.40`、`fee_usdt = 2.10`、`funding_pnl_usdt = 2.00`、`slippage_attribution_usdt = −0.40`、`net_pnl_usdt = −0.50`

#### Scenario: 滑價不被重複扣除
- **WHEN** 上述 S01 的 TradeResult
- **THEN** `net_pnl_usdt = funding_pnl_usdt + price_pnl_usdt − fee_usdt = −0.50`，而不是再減 `slippage_attribution_usdt` 的 −0.90

### Requirement: ROI 分母為雙腿實際名目合計（C-17）
TradeResult SHALL 以 `actual_long_notional_usdt` / `actual_short_notional_usdt` = 各腿開倉 Fill 的 `Σ(quantity × price)`，並計算 `roi_on_notional_pct = net_pnl_usdt / (actual_long_notional_usdt + actual_short_notional_usdt) × 100`、`roi_on_capital_pct = net_pnl_usdt / Trade.allocated_capital_usdt × 100`。分母為 0 時 ROI MUST 為 0（不得產生 NaN / Infinity）。

#### Scenario: S01 的 ROI
- **WHEN** S01 的 `actual_long_notional_usdt = 1000.10`、`actual_short_notional_usdt = 1000.90`、`allocated_capital_usdt = 454`
- **THEN** `roi_on_notional_pct ≈ −0.02499`（±0.00001）、`roi_on_capital_pct ≈ −0.11013`（±0.00001）

#### Scenario: 單腿失敗的分母
- **WHEN** 單腿失敗案例 `actual_long_notional_usdt = 1000`、`actual_short_notional_usdt = 0`、`net_pnl_usdt = −3.00`
- **THEN** `roi_on_notional_pct = −0.30`

#### Scenario: 零成交
- **WHEN** Trade 因 `ENTRY_TIMEOUT` 以 `ABORTED` 結束，兩腿皆無 Fill
- **THEN** 所有 PnL 欄位為 0、兩個 ROI 皆為 0、`final_status = 'ABORTED'`、`result_reason = 'ENTRY_TIMEOUT'`（技術書 §44）

### Requirement: final_status 與 result_reason
TradeResult SHALL 依序判定 `final_status`：Trade `status = 'ABORTED'` → `ABORTED`；`status = 'FAILED'` → `FAILED`；`close_reason = 'EMERGENCY_EXIT'` → `EMERGENCY_EXIT`；否則 `net_pnl_usdt > break_even_tolerance_usdt` → `PROFIT`、`< −break_even_tolerance_usdt` → `LOSS`、其餘 `BREAK_EVEN`（`break_even_tolerance_usdt` 為設定值，預設 0.01）。`result_reason` SHALL 取 Trade 的結束原因（`close_reason` 或 ABORTED / FAILED 原因）；有 `MISSED` 結算時 MUST 另附 `FUNDING_MISSED_MANUAL_REVIEW`。

#### Scenario: 損益分類
- **WHEN** 正常出場的 `net_pnl_usdt` 分別為 0.25、0.004、−0.50
- **THEN** `final_status` 依序為 `PROFIT`、`BREAK_EVEN`、`LOSS`

#### Scenario: 緊急平倉優先於損益分類
- **WHEN** `close_reason = 'EMERGENCY_EXIT'` 且 `net_pnl_usdt = +0.30`
- **THEN** `final_status = 'EMERGENCY_EXIT'`

### Requirement: 暫定結果與定案（引用 funding-settlement-rules）
Trade 進入終態（`CLOSED`、`ABORTED`、`FAILED`）時，pnl-engine SHALL 建立 TradeResult，`funding_confirmed = false`、`finalized_at` 為空；暫定 `funding_pnl_usdt` = `SETTLED` 腿的 `actual_cashflow_usdt` + `EXPECTED` / `ELIGIBLE` 腿的 `expected_cashflow_usdt`。之後每次 FundingSettlement 金額或狀態更新 SHALL 重算並更新 `updated_at`。依 `funding-settlement-rules` 的定案規則，當每一腿皆為 `SETTLED`、`NOT_ELIGIBLE` 或 `MISSED` 時，SHALL 設定 `finalized_at`（= 最後一次轉換的時鐘時間）、`funding_confirmed = true` 當且僅當每一腿皆為 `SETTLED` 或 `NOT_ELIGIBLE`（`MISSED` 腿計 0），並產生一筆 `TRADE_COMPLETED` 事件。定案後 TradeResult MUST NOT 再被自動修改。

#### Scenario: 已平倉待入帳
- **WHEN** S01 於 T+31s 兩腿歸零，兩腿皆為 `ELIGIBLE`，預期金額 Long +0.20、Short +1.80
- **THEN** TradeResult 已建立，`funding_pnl_usdt = 2.00`（暫定）、`net_pnl_usdt = −0.50`、`funding_confirmed = false`、`finalized_at` 為空

#### Scenario: 一腿先結算
- **WHEN** Short 腿於 T+40s `SETTLED`，已結算費率 0.0017、mark price 100、數量 10；Long 仍 `ELIGIBLE`
- **THEN** `funding_pnl_usdt = 1.90`、`net_pnl_usdt = −0.60`、仍未定案

#### Scenario: 兩腿結算後定案
- **WHEN** Long 腿於 T+45s `SETTLED`，現金流 +0.20
- **THEN** `funding_pnl_usdt = 1.90`、`net_pnl_usdt = −0.60`、`funding_confirmed = true`、`finalized_at = T+45s`，且只產生一筆 `TRADE_COMPLETED`

#### Scenario: 一腿 MISSED
- **WHEN** Long 腿 `SETTLED`（+0.20），Short 腿 `MISSED`
- **THEN** `funding_pnl_usdt = 0.20`、`funding_confirmed = false`、`finalized_at` 已設定、`result_reason` 含 `FUNDING_MISSED_MANUAL_REVIEW`

### Requirement: 持續時間與 leg imbalance 欄位
TradeResult SHALL 填入 `entry_duration_ms = entry_completed_at − entry_started_at`、`exit_duration_ms = exit_completed_at − exit_started_at`、`total_trade_duration_ms = exit_completed_at − entry_started_at`（無出場時 = Trade 終態時間 − `created_at`；缺少的時間欄位對應 duration 為 0），以及由 position-accounting 提供的 `max_leg_imbalance_usdt`、`max_leg_imbalance_duration_ms`。

#### Scenario: S01 持續時間
- **WHEN** `entry_started_at = T−45,000`、`entry_completed_at = T−44,200`、`exit_started_at = T+30,000`、`exit_completed_at = T+30,400`
- **THEN** `entry_duration_ms = 800`、`exit_duration_ms = 400`、`total_trade_duration_ms = 75,400`

### Requirement: TradeResult 持久化與時間戳
TradeResult SHALL 具備 `created_at`、`updated_at` 與 `finalized_at`（定案後），以 `trading-schema` 的型別、經 `event-store` 的同步帳本方法寫入；TradeResult 的建立、更新與對應 TradingEvent MUST 在同一交易中寫入，所有時間取自注入的 Clock（`trading-clock`），MUST NOT 直接呼叫 `Date.now()`。

#### Scenario: 以虛擬時鐘寫入時間戳
- **WHEN** 虛擬時鐘為 1,790,784,031,000 時 Trade 轉 `CLOSED`
- **THEN** TradeResult 的 `created_at = updated_at = 1790784031000`，`finalized_at` 為空
