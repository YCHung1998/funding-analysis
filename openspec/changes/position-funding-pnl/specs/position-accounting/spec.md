## ADDED Requirements

### Requirement: Position 只能由 Fill 推導
每一個 TradeLeg SHALL 對應一個 Position（儲存列型別為 `trading-schema` 的 `PaperPosition`），Position MUST 只由該腿的 Fill 推導（`Order → Fill → Position`，技術書 §20），MUST NOT 由 Order 直接建立。positionManager SHALL 為純函式 `applyFill(position, fill, order, leg) → { position, events }`，不自行寫入資料庫。每筆 Fill 的基礎資產數量 `fill_base_qty = Fill.quantity × contract_multiplier`（乘數來自 `instrument-registry`）；屬於 `TradeLeg.entry_order_ids` 的 Fill 為開倉：`base_quantity` 逐筆累加，`average_entry_price = Σ(fill_base_qty × fill_price) / Σ(fill_base_qty)`，`entry_notional_usdt = Σ Fill.notional_usdt`。`PaperPosition.quantity` SHALL 為未平倉的合約數量、`status` 於第一筆開倉 Fill 設為 `OPEN`、歸零時設為 `CLOSED`。所有 PnL 與 hedge ratio MUST 使用 `base_quantity`。

#### Scenario: 分批成交的加權平均（規格書 §11：30 → 20 → 50）
- **WHEN** LONG 腿（合約乘數 1）依序收到開倉 Fill：30 @ 100.00、20 @ 100.10、50 @ 100.02
- **THEN** `base_quantity = 100`、`entry_notional_usdt = 10003.00`、`average_entry_price = 100.03`、`status = 'OPEN'`

#### Scenario: 只有 Order 沒有 Fill
- **WHEN** 一張進場單 ACK 後逾時取消，沒有任何 Fill
- **THEN** 該腿 Position 的 `base_quantity = 0`，且不產生 `POSITION_OPENED` 事件

### Requirement: 出場 Fill 減倉並逐筆實現 Price PnL
屬於 `TradeLeg.exit_order_ids`（含緊急平倉單）的 Fill 為平倉：`base_quantity` 逐筆減少，`average_entry_price` MUST 維持不變；每筆實現 `realized_price_pnl`：LONG = `(fill_price − average_entry_price) × fill_quantity`、SHORT = `(average_entry_price − fill_price) × fill_quantity`；`average_exit_price` 為出場 Fill 的加權平均。價格一律為實際成交價（已含滑價，✅ C-13）。

#### Scenario: LONG 分兩次平倉
- **WHEN** LONG 100 @ 100.03 依序平倉 60 @ 100.50 與 40 @ 99.90
- **THEN** 實現 PnL 分別為 +28.20 與 −5.20，合計 `realized_price_pnl_usdt = 23.00`，`average_exit_price = 100.26`，`base_quantity = 0`、`status = 'CLOSED'`

#### Scenario: SHORT 平倉
- **WHEN** SHORT 10 @ 100.00 平倉 10 @ 99.00
- **THEN** `realized_price_pnl_usdt = +10.00`

### Requirement: 套用 Fill 必須冪等、可重播
Position 更新 SHALL 以 `fill_id` 去重：同一 `fill_id` 第二次套用 MUST 被忽略且不改變任何數值、不產生事件。以 `(Fill.timestamp, fill_id)` 排序從頭重播全部 Fill 所得的 Position MUST 與逐筆即時更新的結果完全相同。

#### Scenario: 重複 Fill 不重複計算
- **WHEN** 開倉 Fill `f-1`（30 @ 100.00）被套用兩次
- **THEN** `base_quantity = 30`，只有一筆 `POSITION_OPENED` 事件

#### Scenario: 重播一致
- **WHEN** 對同一組 5 筆開倉 / 平倉 Fill 分別做逐筆更新與從頭重播
- **THEN** 兩者的 `base_quantity`、`average_entry_price`、`average_exit_price`、`realized_price_pnl_usdt`、`fees_usdt` 完全相等

### Requirement: 無法歸屬或超量平倉的 Fill 被拒絕
Fill 的 `order_id` 不屬於該腿的 `entry_order_ids` 或 `exit_order_ids`、平倉數量大於 `base_quantity`、或 `fee_asset` 不是 `USDT` 時，positionManager MUST 拒絕套用、Position 保持不變，並產生 `RECONCILIATION_ERROR` 事件（payload 含 `fill_id` 與原因 `UNKNOWN_ORDER`、`POSITION_OVERCLOSE` 或 `UNSUPPORTED_FEE_ASSET`）。

#### Scenario: 超量平倉
- **WHEN** `base_quantity = 10` 時收到平倉 Fill 12 單位
- **THEN** Fill 不被套用、`base_quantity` 仍為 10，並產生 `RECONCILIATION_ERROR`（`POSITION_OVERCLOSE`）

### Requirement: 手續費與滑價歸因逐筆累加
Position SHALL 累加 `fees_usdt = Σ Fill.fee_usdt`（正值 = 成本）與 `slippage_attribution_usdt = Σ slippageAttribution(order_side, fill_quantity, fill_price, reference_price)`（`cost-model` 的唯一實作；負值 = 成本）。`reference_price` 取自該 Fill 所屬訂單的參考價。滑價歸因 MUST NOT 從 `realized_price_pnl_usdt` 再扣除。

#### Scenario: 進出場滑價歸因
- **WHEN** LONG 腿開倉 BUY 10 @ 100.01（參考價 100.00）、平倉 SELL 10 @ 100.19（參考價 100.20），兩筆 `fee_usdt` 各 0.50
- **THEN** `realized_price_pnl_usdt = 1.80`、`slippage_attribution_usdt = −0.20`、`fees_usdt = 1.00`

### Requirement: Unrealized PnL 以 mark price 計價
positionManager SHALL 提供 `unrealizedPnl(position, mark_price)`：LONG = `(mark_price − average_entry_price) × base_quantity`、SHORT = `(average_entry_price − mark_price) × base_quantity`；`base_quantity = 0` 時為 0。

#### Scenario: 多空未實現損益
- **WHEN** LONG 10 @ 100.006 與 SHORT 10 @ 100.00，mark price 皆為 101
- **THEN** LONG 未實現 = +9.94、SHORT 未實現 = −10.00

### Requirement: Hedge ratio 計算基準可切換（C-19 未決）
系統 SHALL 以 `hedge_ratio = min(long_value, short_value) / max(long_value, short_value)` 計算兩腿對沖比例，`long_value` / `short_value` 依設定 `hedge_ratio_basis` 決定：`NOTIONAL` = `base_quantity × average_entry_price`；`QUANTITY` = `base_quantity`（基礎資產數量，合約乘數已換算）。預設 MUST 為 `NOTIONAL`（規格書 §14「決議前先用 notional」）；本 capability MUST NOT 自行決定最終基準。`computeHedgeRatio` SHALL 同時回傳所選基準的 `hedge_ratio` 與兩種基準的 `notional_ratio`、`quantity_ratio`（供 C-19 評估）。兩腿皆為 0 時 `hedge_ratio = 0` 且 `has_exposure = false`。設定欄位名稱與值（`hedge_ratio_basis: 'NOTIONAL' | 'QUANTITY'`）MUST 與 `paper-execution` 共用同一個設定；切換基準屬 `PaperTradingConfig` 修改，SHALL 產生新的 `config_version`。

#### Scenario: 單腿部分成交（規格書 §13）
- **WHEN** Long 1,000 USDT 已成交、Short 300 USDT 已成交，兩腿均價相同
- **THEN** 兩種基準的 `hedge_ratio` 皆為 0.30

#### Scenario: 兩所價差下的兩種基準
- **WHEN** LONG 10 @ 100.00、SHORT 10 @ 100.50
- **THEN** `NOTIONAL` 基準 `hedge_ratio ≈ 0.995025`（±1e-6），`QUANTITY` 基準 `hedge_ratio = 1.0`；兩種設定下回傳的 `notional_ratio ≈ 0.995025`、`quantity_ratio = 1.0` 皆相同

#### Scenario: 合約乘數換算後比較數量
- **WHEN** `hedge_ratio_basis = 'QUANTITY'`，一腿為 10 張乘數 1,000 的合約（基礎數量 10,000），另一腿基礎數量 10,000
- **THEN** `hedge_ratio = 1.0`

### Requirement: 對沖分類函式
系統 SHALL 提供 `classifyHedge(hedge_ratio, thresholds)`：`hedge_ratio ≥ hedge_ratio_hedged_min` → `HEDGED`；`hedge_ratio_imbalance_below ≤ hedge_ratio < hedge_ratio_hedged_min` → `PARTIALLY_HEDGED`；`< hedge_ratio_imbalance_below` → `LEG_IMBALANCE`（✅ C-12，預設 0.99 / 0.90，套用 `symbol_tier_overrides`）。此函式只回傳分類；Trade 狀態轉換與其事件 MUST 由 Trade Manager 執行。

#### Scenario: 門檻分類
- **WHEN** 預設門檻下 `hedge_ratio` 分別為 0.995、0.99、0.95、0.90、0.30
- **THEN** 分類依序為 `HEDGED`、`HEDGED`、`PARTIALLY_HEDGED`、`PARTIALLY_HEDGED`、`LEG_IMBALANCE`

#### Scenario: Symbol tier 覆寫
- **WHEN** 某幣種 tier 覆寫 `hedge_ratio_imbalance_below = 0.95`，`hedge_ratio = 0.93`
- **THEN** 分類為 `LEG_IMBALANCE`

### Requirement: Leg imbalance 量測
positionManager SHALL 在每筆 Fill 套用後重算並保存：`leg_imbalance_usdt`（`NOTIONAL` 基準 = `|long_notional − short_notional|`；`QUANTITY` 基準 = `|long_quantity − short_quantity| × 較大腿的 average_entry_price`）、`max_leg_imbalance_usdt`（歷史最大值），以及 `max_leg_imbalance_duration_ms` = 「`hedge_ratio < hedge_ratio_hedged_min` 且任一腿 `base_quantity > 0`」的最長連續區間（以 Fill.timestamp 計）。

#### Scenario: 補足落後腿
- **WHEN** Long 1,000 USDT 於 t = 0 成交，Short 950 USDT 於 t = 300 ms 成交，Short 其餘 50 USDT 於 t = 800 ms 成交（均價相同）
- **THEN** `max_leg_imbalance_usdt = 1000`、`max_leg_imbalance_duration_ms = 800`

#### Scenario: 單腿失敗後緊急平倉
- **WHEN** Long 1,000 USDT 於 t = 0 成交、Short 始終未成交，Long 於 t = 5,200 ms 緊急平倉完成
- **THEN** `max_leg_imbalance_usdt = 1000`、`max_leg_imbalance_duration_ms = 5200`

### Requirement: Position 時間戳與事件
Position SHALL 具備 `created_at`、`updated_at`、`opened_at`（第一筆開倉 Fill 的 `timestamp`）、`closed_at`（歸零時最後一筆 Fill 的 `timestamp`）。第一筆開倉 Fill MUST 產生 `POSITION_OPENED`、`base_quantity` 由正歸零 MUST 產生 `POSITION_CLOSED`（對應 `status` 的 `OPEN` / `CLOSED` 轉換）。`HEDGE_RATIO_CHANGED` 由 `paper-execution` 的雙腿協調者以 `computeHedgeRatio` 的結果發出，positionManager MUST NOT 另外產生重複事件。事件的 `timestamp` MUST 為 Fill 的成交時間，`recorded_at` 為寫入時間（規格書 §25 第 5 點）；Position 更新與事件 MUST 透過 `event-store` 的 `Ledger.applyFill(fill, order, position, events)` 在同一交易中寫入。

#### Scenario: 開倉到平倉的事件序列
- **WHEN** 一腿收到開倉 Fill（t = 1,000）後收到全部平倉 Fill（t = 76,000）
- **THEN** 依序存在 `POSITION_OPENED`（timestamp 1,000）與 `POSITION_CLOSED`（timestamp 76,000），Position 的 `opened_at = 1000`、`closed_at = 76000`，且 `created_at`、`updated_at` 皆有值

#### Scenario: 不重複發出 hedge ratio 事件
- **WHEN** Short 腿成交使 `computeHedgeRatio` 的結果由 0 變為 0.95
- **THEN** `applyFill` 回傳的事件中不含 `HEDGE_RATIO_CHANGED`，且回傳的 Position 足以讓協調者算出 `hedge_ratio = 0.95`

#### Scenario: Position 與 Fill 原子寫入
- **WHEN** `Ledger.applyFill` 在寫入 position 列時失敗
- **THEN** Fill、Order 更新、Position 與 `POSITION_OPENED` 事件皆不存在（`event-store` 的原子性）
