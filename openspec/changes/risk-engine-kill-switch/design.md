## Context

- **現況**：v0.1 風控在研究原型 `src/engine/dryRunEngine.ts:155-237`，9 項檢查中 r2 / r5 / r7 / r9 為常數 PASS，r1 門檻依交易所名稱三元式、r6 以 `volume_24h × 0.02` 冒充深度；唯一 FAIL 來源是 `forceLegImbalance`（HANDOFF P7、Q-08）。`RiskStatusReport` / `RiskCheckItem` 型別在 `src/types/systemSpec.ts:112-128`，規格書 §2.1 決議「保留型別，三階段呼叫」。
- **上位規格**：規格書 §22（三階段清單）、§23（Kill Switch，⚠️ C-16）、§14 / §15（hedge ratio 門檻與緊急流程）、§25（時間戳）、§26（狀態機）；技術書 §8（資料年齡）、§11（Pre-Flight）、§12（資金保留）、§31（對帳 → STOP ENTRY）、§32（Runtime Health）、§33（Kill Switch 三動作，⚠️ C-16）、§37（failure injection）、§38（設定）、§42（S09–S12）。
- **已存在的 change**：`paper-trading-event-loop` 定義場次階段（ARM 為最終進場決策點）、`entry_deadline` / `hedged_by` / 鎖定區間、Opportunity 失效規則、`trading-clock` 的時鐘健康判定與 `CLOCK_UNRELIABLE`。本 change 引用、不重複定義。
- **限制**：HANDOFF §3 Invariants——不下真實單（#1）；憑證不進事件 payload（#2，`actor` 欄位只放操作者識別）；檢查邏輯不得依交易所名稱分支（#3，所有門檻來自設定、所有交易所差異來自注入的輸入）；費率一律小數（#5）；Cancel ≠ Close（#6，Kill Switch 的平倉一律是新的 `reduce_only` `EMERGENCY_CLOSE` 訂單）。規格書 §25：每個持久化實體有 `created_at` / `updated_at`，每次狀態轉換產生 TradingEvent。
- **✅ C-16 已決議（2026-10-02）**：Decision 6、7 的推薦方案已由使用者確認採用，無需修改，可直接依下方 §6–§7 開工（group 4 不再 blocked）。

## Goals / Non-Goals

**Goals:**

- 三階段 Risk Engine 的 28 個檢查項目：每一項有公式、門檻來源、`reason_code`、FAIL 情境與自動化測試。
- 純函式評估器：輸入快照 + 設定 → 結果，可在 VirtualClock 與錄製資料下重現（Paper 與 Backtest 共用）。
- 與 event-loop 的呼叫契約（ARM、PRE_FLIGHT、ENTRY、持倉期間）。
- ~~把 C-16 的五個子問題整理成可選擇的選項並附推薦，供使用者決議~~ ✅ 2026-10-02 使用者已採用推薦方案，Kill Switch 規格按本檔 §6–§7 開工即可。

**Non-Goals:**

- 替使用者決定 C-19（hedge ratio 基準已由規格書 §14 / §34 另行決議為 QUANTITY，本 change 不重複處理）。
- Trade / Order / Opportunity 狀態機本體、§14 門檻的狀態轉換、補單、§15 下單流程（`paper-execution`、`opportunity-lifecycle`）。
- 資金保留原子操作與 hedge ratio 計算（`position-accounting`）；成本 / 滑價估算（`cost-model`）；斷線、資料過舊與對帳的**偵測**（`runtime-health`、`market-data-stream`、`reconciliation`）；Kill Switch 按鈕 UI（`paper-trading-ui`）。
- 修改研究原型 `dryRunEngine.ts`（階段 ② 凍結）。

## Decisions

### 1. 模組與介面：純函式評估器 + 薄的協調層

```
runtime/src/risk/
├── checks/registry.ts     # 28 個檢查定義（check_id、code、stage、config 欄位、reason_code）
├── preTradeRisk.ts        # evaluatePreTrade(ctx: PreTradeContext, cfg): RiskEvaluation
├── executionRisk.ts       # evaluateEntry(ctx: EntryContext, cfg): RiskEvaluation
├── positionRisk.ts        # evaluatePosition(ctx: PositionContext, cfg): RiskEvaluation
├── riskReport.ts          # RiskEvaluation → RiskStatusReport、risk_checks rows、TradingEvents
├── riskCoordinator.ts     # 訂閱事件、組 ctx、呼叫評估器、寫入、發出動作請求
└── killSwitch.ts          # ⚠️ 待 C-16
```

```typescript
interface RiskEvaluation {
  stage: 'PRE_TRADE' | 'ENTRY' | 'POSITION';
  evaluated_at: number;                 // Clock.now()
  config_version: string;
  items: RiskCheckResult[];             // 每項：check_id、check_code、status、value、threshold、reason_code、inputs
  action: 'ALLOW' | 'BLOCK' | 'CONTINUE' | 'HALT_ENTRY' | 'EMERGENCY_EXIT';
  report: RiskStatusReport;             // 沿用 src/types/systemSpec.ts（v0.2 由 trading-schema 提供）
}
```

- **為什麼純函式**：評估器不讀時間、不讀 DB、不打 API——所有輸入（行情快照、`data_age_ms`、時鐘健康、帳戶資金、既有 Trade、連線狀態、合約狀態、成本估算）都由 `riskCoordinator` 從各 capability 注入。好處：每項 FAIL 都能用一個小的 ctx 物件寫成單元測試（解 P7），Backtest 可直接重播。
- **替代方案**：每項檢查自己去查資料來源（v0.1 風格）→ 難以測試、容易出現寫死值，否決。

### 2. 結果模型與輸入缺失

- 狀態沿用 `RiskCheckItem.status` 的 `PASS | WARN | FAIL`；輸入缺失 → `FAIL` + `value = 'UNKNOWN'` + `reason_code = 'INPUT_MISSING'`（Q-08 解方 2 要求「不得 PASS」；不新增 `UNKNOWN` 狀態，避免改動舊型別）。
- **動作彙總**：Pre-Trade 任一 FAIL → `BLOCK`；Entry / Position 取最嚴重（`EMERGENCY_EXIT` > `HALT_ENTRY` > `CONTINUE`）。
- **對舊型別的映射**（舊 enum 只有 3 個值）：`BLOCK` / `HALT_ENTRY` → `overall_status = 'ABORT'`、`action_recommendation = 'ABORT_PRE_FLIGHT'`；`EMERGENCY_EXIT` → `'EMERGENCY_EXIT'` / `'EMERGENCY_CLOSE_FILLED_LEG'`。細分的動作放在 `RiskEvaluation.action`；是否擴充 enum 見 Open Questions。
- `RiskCheckItem.category`（`Connection | Execution | Market | Capital`）在 registry 中為每項指定，研究 UI 可繼續顯示。

### 3. 檢查清單與設定

**Pre-Trade（15 項，全部 CRITICAL；ARM 全跑，PRE_FLIGHT 重跑標 ★ 的 6 項）**

| ID | check_code | 公式 / 條件（FAIL） | 門檻欄位（預設） | reason_code | v0.1 對應 |
|----|-----------|--------------------|-----------------|-------------|----------|
| PT01 | CAPITAL | required（§7 Capital Allocation）> available（§12 扣除保留） | — | INSUFFICIENT_CAPITAL | r7（寫死 $5,000） |
| PT02 | MAX_POSITIONS | 非終態 Trade 數 ≥ 上限（全域 / 場次） | `max_positions`、`max_positions_per_session` | MAX_POSITIONS | — |
| PT03 | MAX_NOTIONAL_PER_LEG | 單腿目標名目 > 上限 | `max_notional_per_leg_usdt` | MAX_NOTIONAL_EXCEEDED | — |
| PT04 | MAX_LEVERAGE | leverage > 設定上限或合約上限 | `max_leverage` | MAX_LEVERAGE_EXCEEDED | — |
| PT05 | MIN_FUNDING_SPREAD | `short_rate − long_rate` < 門檻（小數） | `minimum_funding_spread_pct` | BELOW_MIN_SPREAD | r8 |
| PT06 | EXPECTED_NET_PNL | cost-model 重算淨利 < 門檻 | `minimum_expected_net_pnl_usdt` | BELOW_MIN_NET_PNL | r8 |
| PT07 | MAX_SLIPPAGE | 任一腿 walk-the-book 滑價 > 門檻 | `max_slippage_pct` | MAX_SLIPPAGE_EXCEEDED | — |
| PT08 | ORDERBOOK_DEPTH | 滑價範圍內可成交名目 < 單腿名目 × 覆蓋倍數 | `depth_coverage_ratio`（**新**，3） | INSUFFICIENT_DEPTH | r6（24h 量 × 2%） |
| PT09 ★ | EXCHANGE_CONNECTIVITY | 交易所非 CONNECTED / 合約非 TRADING | — | EXCHANGE_DISCONNECTED / INSTRUMENT_NOT_TRADING | r2、r3、r9 |
| PT10 ★ | API_LATENCY | 最近 20 筆中位數 > max（WARN > warn） | `max_api_latency_ms`（**新**，500）、`warn_api_latency_ms`（**新**，200） | API_LATENCY_HIGH | r1（120 ms 三元式） |
| PT11 ★ | FUNDING_TIME_ALIGNMENT | settlement-session 資格判斷不合格；`now ≥ entry_deadline` | `funding_alignment_tolerance_ms` | FUNDING_NOT_ALIGNED / FUNDING_INTERVAL_TOO_SHORT / EXCHANGE_NOT_TRADABLE / ENTRY_WINDOW_CLOSED | — |
| PT12 | EXISTING_EXPOSURE | 同幣種有非終態 Trade；單一交易所名目合計超限 | `max_exchange_notional_usdt`（**新**，3,000） | EXISTING_EXPOSURE / EXCHANGE_EXPOSURE_LIMIT | — |
| PT13 ★ | DATA_FRESHNESS | 任一輸入校正後 `data_age_ms` > 門檻 | `data_stale_threshold_ms` | STALE_MARKET_DATA | — |
| PT14 ★ | CLOCK_RELIABILITY | 任一腿 `errorMs` > 上限或校正過期 | `clock_max_error_ms`、`clock_calibration_max_age_ms`（trading-clock） | CLOCK_UNRELIABLE | — |
| PT15 ★ | ENTRY_GATE | 閘門被任一來源關閉 | — | TRADE_FAILED_PENDING_REVIEW / KILL_SWITCH_ACTIVE | — |

**Entry（7 項，`ENTRY_PENDING` / `PARTIALLY_HEDGED`）**

| ID | check_code | FAIL 條件 | 門檻欄位（預設） | 動作 |
|----|-----------|----------|-----------------|------|
| EN01 | PRICE_DEVIATION | 任一腿 mid 偏離 `target_entry_price` > 門檻 | `max_entry_price_deviation_pct`（**新**，0.003） | HALT_ENTRY |
| EN02 | FUNDING_RATE_CHANGE | spread 翻轉或縮小 > 容忍值 | `rate_change_tolerance`（event-loop，0.0002） | HALT_ENTRY |
| EN03 | ORDER_TIMEOUT | 進場單 `ORDER_TIMEOUT` / `ORDER_ACK_TIMEOUT` | `max_order_lifetime_ms`、`ack_timeout_ms` | HALT_ENTRY |
| EN04 | PARTIAL_FILL | PARTIALLY_HEDGED 持續 ≥ 上限（之前 WARN） | `partial_hedge_max_duration_ms`（5,000） | EMERGENCY_EXIT |
| EN05 | LEG_IMBALANCE | 進場單終態時 `hedge_ratio < imbalance_below` | `hedge_ratio_imbalance_below`（0.90） | EMERGENCY_EXIT |
| EN06 | EXCHANGE_CONNECTION | 任一腿非 CONNECTED | — | HALT_ENTRY |
| EN07 | MARKET_VOLATILITY | 視窗內 `(max − min) / min` > 門檻 | `volatility_window_ms`（**新**，5,000，與 §14.1 σ_repair 同窗）、`max_entry_volatility_pct`（**新**，0.005） | HALT_ENTRY |

**Position（6 項，`HEDGED` / `EXIT_PENDING`；FAIL 一律 EMERGENCY_EXIT）**

| ID | check_code | FAIL 條件（WARN） | 門檻欄位（預設） |
|----|-----------|------------------|-----------------|
| PO01 | POSITION_IMBALANCE | `hedge_ratio < imbalance_below`（< `hedged_min` 為 WARN） | 同 §14 |
| PO02 | MARK_PRICE_MOVEMENT | 任一腿未實現虧損 / 保證金 ≥ 門檻 | `max_leg_margin_loss_ratio`（**新**，0.5） |
| PO03 | BASIS_DIVERGENCE | `|basis_now − basis_entry|` > 門檻（> 一半為 WARN） | `max_basis_divergence_pct`（**新**，0.005） |
| PO04 | FUNDING_CHANGE | `now < hedged_by` 且預期資金費 < −平倉成本（之後只 WARN） | — |
| PO05 | HOLDING_TIME | 進場完成後 > 上限 | `max_holding_time_ms`（**新**，600,000） |
| PO06 | EXIT_CONDITION | EXIT_PENDING 超過 `emergency_exit_timeout_ms` 未完成 | `emergency_exit_timeout_ms` |

- 評估頻率：`entry_risk_interval_ms`（**新**，250）、`position_risk_interval_ms`（**新**，1,000），外加事件觸發。
- **為什麼 EN04 / EN05 / PO01 也在風控**：規格書 §22 把 Partial fill、Leg imbalance、Position imbalance 列為風控項目；本 change 只產生「判斷 + 動作請求」，§14.2 的狀態轉換、補單與 §15 下單都在 `paper-execution`，避免兩處各寫一套狀態機。
- **新設定欄位**加入 `PaperTradingConfig`（技術書 §38），任何修改產生新 `config_version`；預設值為起始值，之後以 Paper 資料校準（同規格書 §14.3 的方法）。
- **替代方案**：沿用 v0.1 的 9 項 → 不涵蓋 §22 清單且有 4 項無法 FAIL，否決。

### 4. 紀錄與事件

- `risk_checks`（技術書 §29）：Pre-Trade 每項一筆；Entry / Position 在階段開始、狀態改變、階段結束時寫入（避免每 250 ms 寫 7 筆的寫入放大，同時保留每一次變化）。列型別採 `trading-schema-types` 已定義的 `RiskCheck`（不新增欄位）：`check_id` = `check_code`、`reason` = `reason_code`、`critical` 來自定義表；`stage` 對應為 ARM → `TRADE_CREATION`、PRE_FLIGHT → `ORDER_SUBMISSION`、持續檢查 → `ENTRY` / `POSITION`（`OPPORTUNITY` 保留給掃描層，本 change 不使用）。FAIL 項目的輸入快照放在 `RISK_CHECK_FAILED` 事件 payload，不得含憑證。
- 事件：`RISK_CHECK_STARTED` / `RISK_CHECK_PASSED` / `RISK_CHECK_FAILED`（技術書 §26 已列）。Opportunity 與 Trade 的狀態轉換事件由其擁有者（`opportunity-lifecycle`、`paper-execution`）發出；本 change 只提供 reason。
- 時間一律取自 `Clock`，事件帶 `clock_offset_ms`（規格書 §25 第 4 點）。

### 5. 與 event-loop 的關係（不重複定義）

```
settlement-session ARM ──▶ opportunity-lifecycle（失效 / SPREAD_FLIPPED）──▶ risk-engine Pre-Trade 15 項
                                                                        ├─ ALLOW → SELECTED → position-accounting 保留資金 → Trade CREATED
                                                                        └─ BLOCK → REJECTED（rejection_reason = 第一個 FAIL）
Trade PRE_FLIGHT ──▶ risk-engine 重跑 6 項 ──▶ FAIL → ABORTED + 釋放資金
ENTRY_PENDING / PARTIALLY_HEDGED ──▶ Entry 7 項 ──▶ HALT_ENTRY / EMERGENCY_EXIT 請求 → paper-execution
HEDGED / EXIT_PENDING ──▶ Position 6 項 ──▶ EMERGENCY_EXIT 請求 → paper-execution
```

- 規格書 §22 的三個呼叫點（Opportunity → Trade Creation → Order Submission）對應 ARM（完整 Pre-Trade）→ PRE_FLIGHT（重跑）→ Entry / Position（持續）。
- 與 event-loop 共用、由本 change 執行判斷的代碼：`MAX_POSITIONS`（settlement-session 上限）、`BELOW_MIN_NET_PNL`（opportunity-lifecycle ARM 規則）、`STALE_MARKET_DATA`、`CLOCK_UNRELIABLE`（trading-clock「阻擋新進場」）。event-loop 的規則文字不變，實作上呼叫本 change 的檢查，不寫第二份。
- 由 event-loop 判斷、本 change 只引用：`SPREAD_FLIPPED`、Opportunity 失效、場次資格、`ENTRY_DEADLINE_PASSED`、`NOT_HEDGED_BEFORE_WINDOW`、`LOCK_WINDOW`、`exit_at`。
- **hedge ratio**：本 change 只讀 `position-accounting` 提供的數值與 §14 兩條門檻；**C-19（名目或數量）未決**，決議不影響本 change 的程式結構，只影響輸入值（見 Open Questions）。

### 6. ✅ C-16 決策（2026-10-02 已決議：全部採推薦方案）

規格書 §23 描述為單一連鎖流程（停止 → 撤單 → 評估 → 必要時平倉）；技術書 §33 為三個獨立動作且第一階段只停止新交易。以下為 §34 C-16 的五個子問題與決議結果（皆為推薦方案）。

**(1) 按一次到底做到哪一層？**

| 選項 | 內容 | 優點 | 缺點 |
|------|------|------|------|
| A | §23 單一連鎖：一鍵 = 停止 + 撤單 + 評估 + 必要時平倉 | 操作最簡單 | 「必要時」需要系統判斷，誤觸代價高（把好部位平掉、付兩次手續費） |
| B | 技術書 §33 三個獨立按鈕，彼此不相依 | 彈性最大 | 可能只按「撤單」而沒停止進場，下一個場次又開新倉；組合狀態多 |
| **C（推薦）** | **三層分級，高層包含低層**：預設按鈕 = L1 STOP ENTRY；L2 CANCEL ENTRY；L3 FLATTEN | 預設最安全、狀態只有 4 種、不會出現「撤了單但仍在進場」 | 要平倉需多一步 |

**(2) 撤單時出場單 / 緊急平倉單要不要一起撤？**

| 選項 | 內容 | 評估 |
|------|------|------|
| A | 所有未成交單都撤 | 會把正在關閉的部位留在市場上，與 Kill Switch 目的相反 |
| **B（推薦）** | **只撤 `purpose = 'ENTRY'`，絕不撤 `EXIT` / `EMERGENCY_CLOSE`** | 撤單只會減少風險；對應 Invariant #6 Cancel ≠ Close |
| C | 設定檔決定 | 多一個會被設錯的開關 |

**(3) ENTRY_PENDING / PARTIALLY_HEDGED 的 Trade 撤掉進場單後變單腿，要不要自動走緊急平倉？**

| 選項 | 內容 | 評估 |
|------|------|------|
| **A（推薦）** | **自動依 §14 分類：0 成交 → ABORTED；≥ hedged_min → HEDGED 照常出場；其餘 → LEG_IMBALANCE → §15 自動緊急平倉** | 與一般單腿失敗走同一條已測試的路徑；裸部位不會等人 |
| B | 保留單腿等待人工 | 裸部位暴露時間不確定，違反 §15「系統不能 WAIT」 |
| C | 先嘗試補足落後腿再停止 | 補足 = 送新進場單，與「撤進場單」矛盾 |

附帶：L1（只停止新交易）時，進行中 Trade 的**補足單**仍允許（補足是修補既有部位，不是新交易）；L1 時尚未送單的 `CREATED` / `PRE_FLIGHT` Trade 視同新交易，轉 `ABORTED` 並釋放資金。

**(4) 平倉是自動還是需人工確認？**

| 選項 | 內容 | 評估 |
|------|------|------|
| A | L3 一鍵即平倉 | 誤觸無法挽回 |
| **B（推薦）** | **L3 需兩段式確認（Runtime 發一次性確認碼，10 秒內確認），確認後自動送出所有緊急平倉單；(3) 的單腿緊急平倉屬 §15 系統行為，不需確認** | 防誤觸；確認由 Runtime 強制，UI 無法繞過（技術書 §48.3） |
| C | 每筆 Trade 各自人工確認 | 多筆部位時太慢 |

**(5) 系統自動觸發時各對應哪一層？**

| 觸發來源 | 選項 A（推薦） | 選項 B | 選項 C |
|---------|---------------|--------|--------|
| 交易所斷線 `EXCHANGE_DISCONNECTED` | **L1** | L2 | L1 |
| 資料持續過舊（≥ `auto_kill_stale_duration_ms`，預設 10 s） | **L1** | L2 | 不觸發（只靠 Pre-Trade 逐筆阻擋） |
| `RECONCILIATION_ERROR` | **L1 + 受影響 Trade → FAILED 待人工**（技術書 §31、規格書 §26.2） | L2 + FAILED | L3 |
| `CLOCK_UNRELIABLE` | **不觸發**（由 Pre-Trade 逐筆阻擋） | L1 | L1 |

- 推薦理由：自動觸發只停止新交易，不主動動部位——斷線時送撤單 / 平倉單本身就不可靠；對帳錯誤代表帳本不可信，此時自動平倉可能依錯誤數量下單，應交人處理。L3 永不自動。
- 推薦方案的延伸（非 C-16 原題，另列 Open Question KS-6）：解除只能手動、清理中拒絕解除、來源恢復不自動解除。

### 7. Kill Switch 實作要點（✅ C-16 已決議，依本方案開工）

- 狀態：`NONE | L1_STOP_ENTRY | L2_CANCEL_ENTRY | L3_FLATTEN`，只升不降，手動解除回 `NONE`。狀態不另建表，由 `KILL_SWITCH_ACTIVATED` / `KILL_SWITCH_RELEASED` 事件重建（event-sourced），Runtime 啟動時在 ARM Paper Execution 前恢復。
- 事件：`KILL_SWITCH_ACTIVATED`、`KILL_SWITCH_RELEASED`、`KILL_SWITCH_TRIGGERED`（已啟動時的自動觸發）、`KILL_SWITCH_FLATTEN_REQUESTED`、`KILL_SWITCH_FLATTEN_REJECTED`、`KILL_SWITCH_CANCEL_FAILED`（取代技術書 §26 的 `KILL_SWITCH_*` 佔位）。
- 與 Risk Engine 的接點只有一個：向 `ENTRY_GATE` 注入 `KILL_SWITCH_ACTIVE` 來源。撤單 / 緊急平倉透過 `paper-execution` 的指令介面，Kill Switch 不直接改 Order / Trade 狀態。
- 新設定：`auto_kill_stale_duration_ms`（10,000）、`kill_switch_flatten_confirm_ttl_ms`（10,000）、`kill_switch_cancel_retry_max`（3）、`kill_switch_cancel_retry_interval_ms`（500）。
- `close_reason`：因 Kill Switch 而結束的 Trade 用 `'KILL_SWITCH'`（規格書 §6 已有此值），即使經由 §15 緊急流程，以便統計區分。

### 8. 跨 change 假設（介面依規格書 §5–§21 與技術書假設；對方 change 定稿後若不同，於 apply 時對齊）

| 提供者 | 本 change 假設的介面 |
|--------|---------------------|
| `setup-vitest` / `test-infrastructure` | vitest 可跑 `runtime/**/*.test.ts`；Scenario Test 的錄製資料載入與固定 seed failure injection（技術書 §37） |
| `trading-schema`（`trading-schema-types`） | `RiskStatusReport` / `RiskCheckItem` 搬到 `runtime/src/types/risk.ts`、形狀不變；`RiskCheck`（`stage: 'OPPORTUNITY' \| 'TRADE_CREATION' \| 'ORDER_SUBMISSION' \| 'ENTRY' \| 'POSITION'`、`check_id`、`name`、`critical`、`reason?` …）；`TradingEvent.trade_id: string \| null` 與 `opportunity_id?`；事件碼 `ENTRY_HALT_REQUESTED`；新增事件碼須同時加術語表條目；`PaperTradingConfig`（可新增欄位並產生 `config_version`）、`Trade.risk_status`、`Trade.close_reason` 含 `'KILL_SWITCH'`、`Trade.reviewed_at`（FAILED 人工確認時間） |
| `event-store` | `risk_checks`（`trade_id` 可空）、`trading_events` 表；`replay()` 供 Kill Switch 重建狀態 |
| `trading-clock` | `Clock.now()`、`offset(ex) → { offsetMs, errorMs, calibratedAt }`、`data_age_ms` 校正公式、`clock_max_error_ms`、`clock_calibration_max_age_ms` |
| `settlement-session` | 場次時間表（`arm_at`、`entry_deadline`、`hedged_by`）、合約資格判斷函式、ARM 階段掛點 |
| `opportunity-lifecycle` | ARM 重算後的 Opportunity（含 `funding_spread`、兩腿 `funding_time` / 週期）；`REJECTED` / `SELECTED` 轉換由其執行並接受 `rejection_reason` |
| `funding-settlement-rules` | 鎖定區間內緊急平倉 → `NOT_ELIGIBLE` |
| `position-accounting` | `computeCapitalAllocation()`（§7）、`availableCapital()`、原子保留 / 釋放（§12）、`hedgeRatio(trade)`（基準待 C-19）、每腿未實現損益與保證金 |
| `cost-model` | `estimated_net_pnl_usdt`、每腿 walk-the-book 滑價與範圍內深度、`estimated_exit_cost_usdt` |
| `instrument-registry` | 每腿合約狀態（`TRADING` / `SETTLING` / `DELISTED` …）與最大槓桿 |
| `market-data-stream` | 兩腿 mid / mark price、盤口快照、預測費率，皆帶 `exchange_timestamp` / `local_received_timestamp`；`STALE_MARKET_DATA` 狀態與持續時間 |
| `runtime-health` | 每所連線狀態（`CONNECTED` / `DISCONNECTED`）、最近 20 筆 API 延遲樣本、`EXCHANGE_DISCONNECTED` 事件；可能發出帳戶層 `ENTRY_HALT_REQUESTED`（以 `ENTRY_GATE` 注入來源接收） |
| `reconciliation` | `RECONCILIATION_ERROR` 事件（含受影響 `trade_id`） |
| `paper-execution` | 指令介面：`cancelEntryOrders(tradeId)`、`rejectFurtherEntry(tradeId, reason)`、`startEmergencyExit(tradeId, closeReason)`、`abortTrade(tradeId, reason)`、`failTrade(tradeId, reason)`；§14 分類與 §15 流程由其執行 |
| `paper-trading-ui` | Kill Switch 按鈕、L3 兩段式確認畫面、`ENTRY_GATE` 狀態顯示；只送指令，不決定狀態 |

## Risks / Trade-offs

- [新門檻預設值憑經驗設定，可能過嚴（大量否決）或過鬆] → 全部可設定、有 `config_version`；每次否決都寫 `risk_checks`，Paper 期間以分布校準（同規格書 §14.3）。
- [輸入缺失即 FAIL，資料層不穩時會大量否決] → 這是刻意取捨（寧可不交易，現金為王）；`INPUT_MISSING` 單獨統計，用來發現資料層問題。
- [以名目計算的 hedge ratio 在兩所價差下低於 100%（C-19），PO01 可能誤判失衡] → `hedged_min = 0.99` 已預留價差誤差；PO01 只在低於 `imbalance_below`（0.90）才 FAIL，價差需達約 10% 才會誤觸。
- [Entry 評估 250 ms 一次 + 事件觸發，計算量] → 評估器為純函式、每次 7 項，CPU 成本可忽略；寫入只在狀態改變時發生。
- [Kill Switch 規格可能因 C-16 決議而改寫] → 獨立 capability 與獨立 tasks 群組（4.x），Risk Engine 不依賴 Kill Switch（只預留 `ENTRY_GATE` 注入點），可先實作與合併。
- [斷線時撤單 / 平倉請求本身可能失敗] → 推薦方案自動觸發只到 L1；L2 撤單失敗有重試與 `KILL_SWITCH_CANCEL_FAILED` 事件。
- [event-loop 與本 change 對同一代碼（MAX_POSITIONS 等）各寫一套] → Decision 5 明定判斷由本 change 執行、event-loop 呼叫；apply 時以測試確認只有一個實作。

## Migration Plan

- 全部為 `runtime/src/risk/` 新增檔案與測試；不修改研究原型行為（`dryRunEngine.ts` 凍結，HANDOFF P7 在 Runtime 端標為已解，研究端保留並於 README / UI 維持 mock 標示）。
- 風控部分（tasks 1–3）可先於 `feature-risk-engine-kill-switch` 實作並 `--no-ff` merge 回 `develop`；Kill Switch（tasks 4）待 C-16 決議後，依決議修改 `kill-switch` spec 再實作——若屆時本分支已合併，另開 `feature-kill-switch` 承接剩餘 tasks。
- Rollback：`git revert -m 1 <merge-commit>`（技術書 §51.3）；新增設定欄位有預設值，舊設定檔可直接載入。

## Open Questions

1. **C-16（Kill Switch 五個子問題）**：見 Decision 6，待使用者決議；決議後更新規格書 §23 / §31 / §34、技術書 §26 / §33 與本 change 的 `kill-switch` spec、tasks 4.x。
2. **C-19（hedge ratio 以名目或數量計算）**：影響 EN05、PO01 與 L2 分類的輸入值；本 change 以 `position-accounting.hedgeRatio()` 抽象，決議後不需改動風控程式結構，但需補一組「兩所價差 1% 且數量相同」的測試。
3. **KS-6（C-16 延伸）Kill Switch 解除規則**：推薦「只能手動解除、清理中拒絕、來源恢復不自動解除」；替代方案為「斷線 / 資料過舊恢復健康 60 秒後自動解除 L1」。
4. **系統層事件的 `trade_id`**：`trading-schema-types` 已提議 `trade_id: string | null`，但允許 `null` 的事件清單不含 `RISK_CHECK_*`（ARM 時尚無 Trade）與 `KILL_SWITCH_*`；需請該 change 加入（`KILL_SWITCH_*` 於 C-16 決議後由 tasks 4.1 加入事件碼與術語表）。
9. **`ENTRY_HALT_REQUESTED` 與 Kill Switch 自動 L1 的分工**：`runtime-health-reconciliation` 預定發出帳戶層 `ENTRY_HALT_REQUESTED`；C-16 決議前由 `ENTRY_GATE` 注入來源直接接收（行為等同 L1 但不經 Kill Switch 狀態）；決議後是否改由 Kill Switch 統一轉為 `KILL_SWITCH_ACTIVATED`（source `AUTO`），避免兩套停止進場機制？
5. **`RiskStatusReport` enum 擴充**：舊型別的 `action_recommendation` 沒有 `HALT_ENTRY`，目前映射為 `ABORT_PRE_FLIGHT`；是否由 `trading-schema` 在 v0.2 新增 `HALT_ENTRY` 與 `stage` 欄位？
6. **`_pct` 欄位語意**：`minimum_funding_spread_pct`、`max_slippage_pct` 名稱含 `pct`，本 change 依 Invariant #5 一律以小數比較（0.001 = 0.1%）；是否更名為 `_decimal` 或維持並在術語表註明？
7. **FAILED Trade 的人工確認**：`ENTRY_GATE` 依賴 `Trade.reviewed_at`；確認的操作入口（UI / CLI）由哪個 change 提供？
8. **新門檻預設值**（`depth_coverage_ratio = 3`、`max_api_latency_ms = 500`、`max_exchange_notional_usdt = 3000`、`max_entry_volatility_pct = 0.5%`、`max_basis_divergence_pct = 0.5%`、`max_leg_margin_loss_ratio = 0.5`、`max_holding_time_ms = 10 min`）：請使用者確認起始值；HANDOFF §8 第 3 題（最低流動性門檻）仍待決，PT08 的覆蓋倍數與其相關。
