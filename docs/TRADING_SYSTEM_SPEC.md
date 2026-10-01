# Crypto Funding Arbitrage — Trading System Specification v0.2

| 欄位 | 值 |
|------|----|
| Status | **Draft**（C-01～C-15、C-17、C-18 已決議；C-16、C-19 待決，見 [§34](#34-決策紀錄)） |
| Previous Version | v0.1 = 現有 7 模組研究 / Dry-run 規格（`src/spec/arbitrageSpecV01.ts`、`src/types/*.ts`）（C-02） |
| Current Target | Paper Trading / Automated Simulation |
| Scan Exchanges | Pionex、Binance、Bybit、Bitget、OKX（5 所全部持續掃描）（C-01） |
| Paper Trading Exchanges | **Binance、Bybit**；未來加入 OKX（C-01） |
| Research Prototype | `funding-analysis`（本 repo） |
| 開發遵循文件 | [`PAPER_TRADING_TECH_SPEC.md`](PAPER_TRADING_TECH_SPEC.md) |
| 最後更新 | 2026-09-30 |

> **閱讀方式**
> - 本文件是「要做成什麼」（What）；技術書是「怎麼做」（How）。兩者衝突時以本文件為準，並回報到 §34。
> - `⚠️ 待決 C-xx` = 尚未決定，**決定前不得依該段實作**。`✅ C-xx` = 已決議，決議內容見 §34。
> - `📎 整合註記` = 與現有 prototype / issue 的對應關係，非新需求。
> - [`assets/HANDOFF.md`](../assets/HANDOFF.md) §3 的 Invariants 繼續有效（#1、#2 已依 C-08 修訂，見 §33）。

---

## 0. 本版與 v0.1 的關鍵差異（Why v0.2）

本版不重新發明 Schema，而是把既有研究型 Schema **升級成支援 Paper Trading Lifecycle 的交易 Schema**：

1. `TradeResult` 不再只描述「已完成的交易」，必須完整保存 **Signal → Order → ACK → Partial Fill → Fill/Cancel/Reject → Position → Close**。
2. **未成交也是交易結果**，不能因為沒有 PnL 就消失。
3. `funding_pnl = notional × spread` 不能直接當成真實結果；必須記錄兩個交易所各自的 funding eligibility、實際 settlement、funding cashflow。
4. 必須區分 **Notional**（合約倉位價值）、**Margin**（實際佔用保證金）、**Capital Allocation**（系統為該交易保留的資金）。
5. 雙邊套利不能只存在一個 `trade_result`；需要 **Trade → Legs → Orders → Fills → Position** 的階層。
6. Paper Trading Engine 要刻意模擬「現實世界會失敗的情況」，否則 Paper Trading 沒有驗證價值。
7. **所有實體與狀態轉換都必須有時間戳**（v0.1 沒有記錄，v0.2 為硬性規則，見 §25）。

---

## 1. 系統定位

本系統的目標不是單純「找出資金費率最高的幣」，而是建立一個可以：

> **自動發現 Funding Arbitrage Opportunity → 計算交易成本 → 進行風控 → 建立雙邊交易 → 模擬真實成交 → 管理部位 → 完成退出 → 計算實際結果 → 完整保存交易紀錄**

的 Paper Trading System。第一階段所有交易均為：

```text
LIVE MARKET DATA → REAL-TIME STRATEGY → REAL-TIME RISK ENGINE
                 → PAPER EXECUTION → VIRTUAL POSITION → VIRTUAL PnL
```

**系統不得使用真實下單 API**（HANDOFF Invariant #1）。

### 1.1 專案階段（✅ C-04）

| 階段 | 內容 | 進入條件 | 狀態 |
|------|------|---------|------|
| ① Research | 5 所即時掃描、結算窗口分析、獲利邊界 | — | 🟡 掃描可用，歷史資料為 mock |
| ② Dry-run | 現有劇本式流程展示（`dryRunEngine`），不再擴充功能 | — | 🟠 凍結，僅修 bug |
| ③ Paper Trading | 本規格：即時行情 + 模擬撮合 + 完整交易紀錄，Binance × Bybit | 前置工作完成（技術書 §50.1） | ⬜ 未開始 |
| ④ Backtest vs Paper 驗證 | 同一 Schema 的歷史回測與 Paper 結果比對、失敗分析、成交品質分析、風控驗證 | Paper 通過 §31 全部 Acceptance Criteria | ⬜ |
| ⑤ Small Capital Live | 小資金實盤 | ④ 通過 + 使用者明確批准 + Live Execution Adapter 另立 change | ⛔ 未經批准不得開始 |

---

## 2. 現有 Prototype 基礎與模組切分（✅ C-03）

**決議**：在主要功能不變的前提下，改用技術書 §4 的模組切分（Scanner / Opportunity / Risk / Trading / Execution / Accounting / Telemetry / Storage），以取得更好的可控性與開發管理。v0.1 的 M1–M7 保留為研究原型的歷史名稱。Paper Trading Runtime 與研究原型**分開存放**（✅ C-07，`runtime/`，見技術書 §4）。

| v0.1 模組 | 既有位置 | v0.2 去向 |
|----------|---------|----------|
| M1 Data Adapter | `src/adapters/*.ts`（純 mapping，server 未使用，HANDOFF P10） | `runtime/src/adapters/` + `market/`（`ExchangeAdapter` 介面，技術書 §5） |
| M2 Historical Data | `schema.ts` `SettlementWindowBar`、`mockMarketData.ts` | 研究 UI 保留；Backtest 資料來源（階段 ④）走 `storage/marketDataRepository` |
| M3 Funnel Scanner | `server.ts` live-scan、`src/engine/funnelScanner.ts` | `runtime/src/scanner/` → 產出 `Opportunity`（§5） |
| M4 Strategy Engine | `src/engine/arbitrageEngine.ts` | `strategy/`（決策）+ `accounting/`（Fee / Slippage / PnL） |
| M5 Execution & Latency | `dryRunEngine.ts`、`ExecutionSimulator.tsx`、`OrderLatencyMetrics` | `execution/`（Paper Execution）+ `trading/` + `telemetry/`；dry-run **不再加功能** |
| M6 Risk Engine | `systemSpec.ts` `RiskStatusReport`（9 項） | `risk/`（三階段，§22）+ Kill Switch（§23） |
| M7 Visualization & Console | `src/components/*` | 研究 UI 保留；Paper Trading UI 為 Runtime 的 observer（技術書 §34、§48.3） |

### 2.1 v0.1 → v0.2 型別對照與漸進遷移（✅ C-11）

**決議**：漸進式遷移，**每一步都必須讓全部測試通過**；新 Schema 為唯一來源，舊型別標 `@deprecated` 直到沒有引用後刪除。

| v0.1 型別 | 問題 | v0.2 對應 |
|----------|------|----------|
| `FunnelCandidate`（5 所欄位平鋪） | 違反「新增交易所只改 adapter」；HANDOFF P10；無時間戳 | `Opportunity`（§5） |
| `ArbitrageTradeResult`（`pionex_leg` / `binance_leg`） | 以 Pionex×Binance 為中心；只描述完成的交易 | `Trade` + `TradeLeg` + `TradeResult`（§6、§8、§21） |
| `SimulatedOrderLeg` | Order 與 Fill 混在一起；無 partial fill | `PaperOrder` + `Fill`（§10、§11） |
| `OrderState` | 無 SUBMITTED / ACK / CANCEL_REQUESTED | `OrderState`（§9） |
| `PositionState` | 綁在單一 trade 上 | `TradeStatus` + `LegStatus`（§26） |
| `TradeLegResult.funding_pnl` | `notional × rate` 直接當收益 | `FundingSettlement`（§18） |
| `RiskStatusReport` | 只有盤前一次檢查 | 保留型別，三階段呼叫（§22） |
| `TimelineMilestone` | 相對 T 的字串偏移，非絕對時間 | 由 `TradingEvent`（絕對時間戳）推導（技術書 §27） |

**遷移規則**（每一條都是 PR 審查項）：

1. **先鎖行為再搬**：搬移某個型別 / 函式前，先為現有行為寫特性測試（characterization test），確認綠燈後才開始改。
2. **一次只搬一個型別**：同一個 PR 不同時改兩個舊型別的引用。
3. **雙寫過渡期**：研究 UI 需要時可用 adapter 把新型別轉成舊型別顯示，但**不得反向**（新邏輯不得依賴舊型別）。
4. **每步三綠**：`npm run lint`、`npm run build`、`npm test` 全過才可 merge 回 `develop`（技術書 §51）。
5. **補時間戳**：舊型別沒有時間戳的，遷移時一律依 §25 補上；無法取得原始時間的歷史資料標 `timestamp_source: 'UNKNOWN'`，不得以遷移當下時間冒充。

---

## 3. Architecture

```text
┌────────────────────────────────────────────┐
│                 USER LEVEL                 │
│ Capital / Max Positions / Risk Limits      │
│ Leverage Limit / Position Size             │
│ Paper Trading ON           [ 掃幣 ]        │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│               MARKET DATA                  │
│ 掃描：5 所 WS / REST                        │
│ 交易：Binance、Bybit（未來 OKX）             │
│ Price / Bid / Ask / Depth                  │
│ Funding Rate / Funding Time / Interval     │
│ Volume / Open Interest / Exchange Status   │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│               SCANNER                      │
│ Candidate Discovery / Funding Spread       │
│ Liquidity / Price Difference / Est. Cost   │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│             OPPORTUNITY ENGINE             │
│ Gross Funding / Fee / Slippage             │
│ Basis & Price Risk / Execution Risk        │
│ Expected Net PnL                           │
│ 只有兩腿都在 trading_exchanges 才可 SELECTED │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│                RISK ENGINE                 │
│ Capital / Max Positions / Max Notional     │
│ Leverage / Slippage Limit / Liquidity      │
│ API Health / Leg Imbalance / Kill Switch   │
└───────────────────┬────────────────────────┘
              PASS / BLOCK
                    ▼
┌────────────────────────────────────────────┐
│           PAPER EXECUTION ENGINE           │
│ Order Creation / Queue / Simulated Match   │
│ Partial Fill / Fill / Cancel / Reject      │
│ Timeout                                    │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│              POSITION ENGINE               │
│ Long Leg / Short Leg / Hedge Balance       │
│ Funding Settlement / Unrealized / Realized │
│ Exit                                       │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│          TRADE RECORD / ANALYTICS          │
│ Signal / Order / Fill / Position / Funding │
│ Fees / Slippage / PnL / Latency / Failure  │
│ Full Timeline                              │
└────────────────────────────────────────────┘
```

**掃描範圍 vs 交易範圍**（✅ C-01）：Scanner 對 5 所全部產生 Opportunity（研究與統計用途，照樣記錄）；只有 `long_exchange` 與 `short_exchange` 都屬於 `trading_exchanges`（目前 `['Binance', 'Bybit']`）的 Opportunity 才能進入 `SELECTED` 並建立 Trade，其餘標 `REJECTED`、`rejection_reason = 'EXCHANGE_NOT_TRADABLE'`。加入 OKX = 設定檔加一項 + 補 OKX adapter 與其 funding 規則，策略層不改（Invariant #3）。

📎 Market Data 正確性前提 = issue 索引方向 ①（Instrument Registry）與 ②（WebSocket 資料層）。開發順序 ✅ C-09，見技術書 §50.1。

---

## 4. Trading Hierarchy

**v0.2 最重要的 Schema 改變。**

```text
TradingSession
    ├── Opportunity
    └── Trade
          ├── Leg A → Orders → Fills
          └── Leg B → Orders → Fills
```

```text
Opportunity → Trade → TradeLeg → Order → Fill → Position → FundingSettlement → CloseOrder → TradeResult
```

---

## 5. Opportunity（✅ C-10）

Opportunity 表示「系統當下認為這是一個可能值得交易的套利機會」。**它不是交易本身。** 兩腿的結算時間與週期**分開記錄**，並必須通過對齊檢查（Q-02、Invariant #4）。

```typescript
interface Opportunity {
    opportunity_id: string;
    symbol: string;                  // Instrument Registry 的統一 ID，非字串去尾（Q-01）

    created_at: number;              // §25 #1；建立時 = detected_at
    detected_at: number;             // §25 時間戳規則
    expires_at: number;              // 安全上限（opportunity_max_age_ms）；實際失效依技術書 §10 失效規則
    updated_at: number;

    long_exchange: ExchangeId;
    short_exchange: ExchangeId;

    long_funding_rate: number;       // 小數（Invariant #5）；預測值
    short_funding_rate: number;
    funding_spread: number;          // 單次結算費率差（兩腿同時結算時才成立）

    long_funding_time: number;       // 該腿下一次結算時刻（交易所回傳）
    short_funding_time: number;
    long_funding_interval_hours: number;   // 交易所回傳，不得預設 8
    short_funding_interval_hours: number;
    funding_time_diff_ms: number;    // |long_funding_time − short_funding_time|
    funding_aligned: boolean;        // funding_time_diff_ms ≤ funding_alignment_tolerance_ms

    long_price: number;
    short_price: number;
    price_difference_pct: number;

    estimated_fee_pct: number;       // = expected_fees_usdt / 單腿目標名目（runtime/src/accounting/expectedNet.ts）
    estimated_slippage_pct: number;
    estimated_funding_pnl: number;
    estimated_net_pnl: number;

    liquidity_score: number;
    strategy_version: string;

    status: OpportunityStatus;       // §26.1
    rejection_reason?: string;       // 例：FUNDING_NOT_ALIGNED、EXCHANGE_NOT_TRADABLE、EXPIRED
}
```

`funding_aligned = false` 的 Opportunity 不得 `SELECTED`（`rejection_reason = 'FUNDING_NOT_ALIGNED'`）。`funding_alignment_tolerance_ms` 為設定值，預設 60,000（技術書 §38）。

---

## 6. Trade（✅ C-12、C-15、C-17、C-18）

Trade 表示「系統已經決定要執行一組雙邊套利交易」。

```typescript
interface Trade {
    trade_id: string;
    opportunity_id: string;

    strategy_id: string;
    strategy_version: string;
    config_version: string;          // 當下 PaperTradingConfig 的版本（門檻調整可追溯，§14.3）

    symbol: string;

    mode: 'PAPER' | 'BACKTEST';      // ✅ C-18；'LIVE' 保留，未經批准不得加入

    created_at: number;
    updated_at: number;
    entry_started_at?: number;
    entry_completed_at?: number;
    exit_started_at?: number;
    exit_completed_at?: number;

    status: TradeStatus;             // §26.2
    close_reason?: 'NORMAL_EXIT' | 'EMERGENCY_EXIT' | 'KILL_SWITCH';

    target_notional_per_leg_usdt: number;   // ✅ C-17：單腿目標名目，見 §7
    leverage: number;
    allocated_margin_usdt: number;
    allocated_capital_usdt: number;

    legs: TradeLeg[];

    expected_pnl_usdt: number;
    realized_pnl_usdt?: number;

    risk_status: RiskStatusReport;   // 沿用 src/types/systemSpec.ts
}
```

---

## 7. Notional / Margin / Capital 必須分離（✅ C-17）

| 名稱 | 定義 | 範例（單腿 1,000 USDT、5x） |
|------|------|------|
| **Leg Notional**（單腿名目） | `Quantity × Execution Price`，每一腿各自計算 | 1,000 |
| **Target Notional per Leg** | 系統對每一腿下單的目標名目；`Trade.target_notional_per_leg_usdt` | 1,000 |
| **Gross Notional**（雙腿合計） | `Long Leg Notional + Short Leg Notional` | 2,000 |
| **Margin** | `Σ(Leg Notional / Leverage)`，兩所各自佔用 | 200 + 200 = 400 |
| **Capital Allocation** | `Required Margin + Fee Reserve + Slippage Reserve + Emergency Reserve` | 例：400 + 2 + 2 + 50 = 454 |

因此 `Capital Allocation ≠ Margin`、`Capital Allocation ≠ Notional`。

**ROI 分母**：

```text
roi_on_notional_pct = net_pnl / (actual_long_notional + actual_short_notional) × 100   // Gross Notional
roi_on_capital_pct  = net_pnl / allocated_capital_usdt × 100
```

📎 與舊 `ArbitrageTradeResult.roi_on_notional_pct = net / (2 × notional)` 一致（兩腿等額時）。取代 `dryRunEngine.ts` 寫死的 `$5,000` 保證金（HANDOFF P7）。`PaperTradingConfig.max_notional_per_trade` 更名為 `max_notional_per_leg_usdt`。

---

## 8. Trade Leg

每一邊都是獨立交易。

```typescript
interface TradeLeg {
    leg_id: string;
    trade_id: string;

    exchange: ExchangeId;
    symbol: string;

    direction: 'LONG' | 'SHORT';
    order_side: 'BUY' | 'SELL';

    leverage: number;

    target_notional_usdt: number;
    target_quantity: number;
    actual_notional_usdt?: number;
    actual_quantity?: number;

    margin_allocated_usdt: number;

    target_entry_price: number;
    average_entry_price?: number;
    average_exit_price?: number;

    entry_order_ids: string[];
    exit_order_ids: string[];

    status: LegStatus;               // §26.3

    created_at: number;
    updated_at: number;
    entry_started_at?: number;
    entry_completed_at?: number;
    exit_started_at?: number;
    exit_completed_at?: number;
}
```

---

## 9. Order Lifecycle（✅ C-14）

**原則**：Order 狀態只描述「這張單在交易所的狀態」；「平倉」是 Position 的事，靠**另一張 close order** 完成（Invariant #6 Cancel ≠ Close），所以 Order 沒有 `CLOSED`。Timeout 是**事件**（`ORDER_TIMEOUT`），不是狀態。

```text
CREATED ──► SUBMITTED ──► ACKNOWLEDGED ──► PARTIALLY_FILLED ──► FILLED
               │               │                  │
               │               ├─► REJECTED        │
               ▼               │                  │
            REJECTED           └──────┬───────────┘
                                      │ ORDER_TIMEOUT 事件 / 主動撤單
                                      ▼
                               CANCEL_REQUESTED ──► CANCELED
                                      │
                                      ├─► FILLED（撤單送達前已全部成交）
                                      └─► 回到原狀態 + ORDER_CANCEL_REJECTED 事件（撤單失敗，S06）

ACKNOWLEDGED / PARTIALLY_FILLED ──► EXPIRED（交易所端 time-in-force 到期，如 IOC 剩餘量）
```

| 狀態 | 中文 | 終態 | 說明 |
|------|------|------|------|
| `CREATED` | 已建立 | | 系統內建立，尚未送出 |
| `SUBMITTED` | 已送出 | | 已送往（模擬）交易所，等待 ACK |
| `ACKNOWLEDGED` | 已確認 | | 交易所確認收單，尚未成交 |
| `PARTIALLY_FILLED` | 部分成交 | | 有成交但未滿 |
| `FILLED` | 完全成交 | ✔ | |
| `CANCEL_REQUESTED` | 撤單中 | | 已送出撤單，等待撤單 ACK |
| `CANCELED` | 已撤單 | ✔ | 可能帶有部分成交量（`filled_quantity > 0`） |
| `REJECTED` | 已拒絕 | ✔ | 必填 `rejection_reason` |
| `EXPIRED` | 已過期 | ✔ | 交易所端依 time-in-force 取消 |

| 事件（非狀態） | 中文 | 觸發 |
|---------------|------|------|
| `ORDER_TIMEOUT` | 訂單逾時 | 超過 `max_order_lifetime_ms` 未達終態；記 `timeout_reason`、接著進 `CANCEL_REQUESTED` |
| `ORDER_ACK_TIMEOUT` | ACK 逾時 | `SUBMITTED` 超過 `ack_timeout_ms` 未收到 ACK；以 `getOrder` 查詢後轉為實際狀態（Paper 由模擬器決定） |
| `ORDER_CANCEL_REJECTED` | 撤單失敗 | 撤單被拒或逾時；狀態回到撤單前，記 `cancel_reject_reason` |

---

## 10. Order Schema（✅ C-14）

```typescript
type OrderState =
    | 'CREATED' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'PARTIALLY_FILLED' | 'FILLED'
    | 'CANCEL_REQUESTED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

interface PaperOrder {
    order_id: string;
    client_order_id: string;

    trade_id: string;
    leg_id: string;
    purpose: 'ENTRY' | 'EXIT' | 'EMERGENCY_CLOSE';

    exchange: ExchangeId;
    symbol: string;

    order_type: 'MARKET' | 'LIMIT';
    side: 'BUY' | 'SELL';
    position_side: 'LONG' | 'SHORT';
    reduce_only: boolean;            // EXIT / EMERGENCY_CLOSE 必為 true

    requested_quantity: number;
    requested_notional_usdt: number;
    requested_price?: number;
    reference_price: number;

    order_state: OrderState;

    created_at: number;
    updated_at: number;
    submit_time?: number;
    ack_time?: number;
    first_fill_time?: number;
    final_fill_time?: number;
    cancel_request_time?: number;
    cancel_ack_time?: number;
    terminal_time?: number;          // 進入終態的時間

    filled_quantity: number;         // 原 requested_quantity_filled
    remaining_quantity: number;      // requested_quantity − filled_quantity
    average_fill_price?: number;

    estimated_fee_usdt: number;
    actual_fee_usdt?: number;

    estimated_slippage_pct: number;
    actual_slippage_pct?: number;

    rejection_reason?: string;
    timeout_reason?: string;
    cancel_reject_reason?: string;
}
```

---

## 11. Fill Schema

Order 與 Fill 必須分離，因為一張 Order 可以 `100 contracts → 30 → 20 → 50 filled`。

```typescript
interface Fill {
    fill_id: string;
    order_id: string;
    trade_id: string;
    leg_id: string;

    exchange: ExchangeId;
    timestamp: number;               // 成交時間（模擬撮合時間）
    recorded_at: number;             // 寫入時間
    created_at: number;              // §25 #1；= recorded_at（Fill 不可變）
    updated_at: number;              // = recorded_at

    quantity: number;
    price: number;
    notional_usdt: number;

    fee_usdt: number;
    fee_asset: string;

    liquidity: 'MAKER' | 'TAKER' | 'SIMULATED';

    slippage_from_reference_pct: number;
}
```

---

## 12. 必須記錄「沒有成交」

這是 Paper Trading 的硬性要求。

```text
Order #123
Submit:      15:31:02.153
ACK:         15:31:02.198
Target:      BTCUSDT 1000 USDT
Event:       ORDER_TIMEOUT（15:31:02.953）
Filled:      0
Cancel:      15:31:02.953
Cancel ACK:  15:31:03.021   → order_state = CANCELED
```

最終：`Trade Status = ABORTED`、`Reason = ENTRY_TIMEOUT`、`Filled Notional = 0`。

**這筆交易不能從 database 消失。**

---

## 13. Partial Fill（✅ C-12）

雙邊交易最重要的風險之一：

```text
Binance  1000U → FILLED
Bybit    1000U → 300U FILLED

Hedge Ratio = 300 / 1000 = 30%   → 低於 imbalance 門檻（預設 90%）→ LEG_IMBALANCE
```

若 Bybit 成交 950U（95%），介於兩門檻之間 → `PARTIALLY_HEDGED`，進入 §14.2 的修補流程。無論哪一種，都**不是** `HEDGED`。

---

## 14. Leg Imbalance 與兩條門檻（✅ C-12）

```text
hedge_ratio = min(long_notional, short_notional) / max(long_notional, short_notional)
```

> ⚠️ 待決 C-19：以 notional 計算時，兩所價差會讓「數量完全相同」的兩腿也小於 100%（價差 0.5% → 99.5%）。對沖的本質是數量（delta）相等，建議改用「合約乘數換算後的基礎資產數量」計算。決議前先用 notional，但 §14.1 的預設值已預留此誤差。

| hedge_ratio | 狀態 | 中文 |
|-------------|------|------|
| `≥ hedged_min`（預設 0.99） | `HEDGED` | 已對沖 |
| `imbalance_below ≤ ratio < hedged_min`（預設 0.90～0.99） | `PARTIALLY_HEDGED` | 部分對沖 |
| `< imbalance_below`（預設 < 0.90） | `LEG_IMBALANCE` | 單腿失敗 / 失衡 |

設定欄位：`hedge_ratio_hedged_min`、`hedge_ratio_imbalance_below`、`partial_hedge_max_duration_ms`（技術書 §38）。

### 14.1 怎麼設定、為什麼

`1 − hedge_ratio` = **沒有被對沖的裸部位比例**。這部分會直接承受價格波動，兩條門檻就是在回答兩個不同問題：

**① `hedge_ratio_hedged_min`（上門檻）——「多小的差距可以忽略？」**

- 為什麼不是 100%：兩所的最小下單單位（step size）不同、數量需四捨五入、兩所價差也會讓 notional 不相等（C-19）。這些是**結構性、無法消除**的差距，若設 100% 幾乎每筆都會卡在 PARTIALLY_HEDGED。
- 設定方式：取「可接受的結構性誤差」的上限：

  ```text
  hedged_min ≈ 1 − ( max(step_A × price, step_B × price) / leg_notional + 預期跨所價差 )
  ```

  例：單腿 1,000U、兩所 step 對應約 2U、跨所價差約 0.3% → `1 − (0.002 + 0.003) = 0.995`；預設 0.99 留一點緩衝。
- 單腿名目越小，step 誤差佔比越大 → 小名目時要調低，或提高名目。

**② `hedge_ratio_imbalance_below`（下門檻）——「裸部位大到要立刻止血的界線？」**

- 概念：在修補所需的時間內，裸部位可能的虧損，不應吃掉預期利潤的太大比例：

  ```text
  (1 − h) × leg_notional × σ_repair  ≤  k × expected_net_pnl
  ⇒  imbalance_below = 1 − k × expected_net_pnl / (leg_notional × σ_repair)
  ```

  - `σ_repair`：修補期間（例如 `partial_hedge_max_duration_ms` = 5 秒）的價格波動幅度，依幣種波動度估計
  - `k`：可容忍吃掉預期淨利的比例（例如 0.5 = 最多吃掉一半）
- 例：單腿 1,000U、預期淨利 1.0U、山寨幣 5 秒波動 0.3%、k = 0.5 → `1 − 0.5 / 3 = 0.83`。預設 0.90 比此例更保守。
- 高波動幣種 σ 大 → 門檻應**更高**（更早止血）；預期淨利大 → 可以稍低。

**③ `partial_hedge_max_duration_ms`——「部分對沖最多容忍多久？」**

- PARTIALLY_HEDGED 不是可以停留的狀態：系統在此期間嘗試補足落後的一腿（重送剩餘量）；超過時間仍未達 `hedged_min`，視同 LEG_IMBALANCE 走緊急流程（§15）。
- 預設 5,000 ms；這個時間也是公式 ② 中 `σ_repair` 的時間窗，兩者要一起調。

### 14.2 狀態行為

| 狀態 | 系統行為 |
|------|---------|
| HEDGED | 正常持倉，等待結算與退出 |
| PARTIALLY_HEDGED | 對落後腿重送剩餘量；計時 `partial_hedge_max_duration_ms`；期間不接受新 Trade 佔用同一幣種 |
| LEG_IMBALANCE | 立即 §15：撤掉所有未成交掛單 → 緊急平掉已成交部位 |

### 14.3 怎麼調整

1. **用 Paper 資料校準，不憑感覺**：每筆 Trade 都記錄 `max_leg_imbalance_usdt`、`max_leg_imbalance_duration_ms`、修補成本；定期看分布。
2. **大量 PARTIALLY_HEDGED 卡在上門檻** → 多半是 step / 價差誤差 → 調低 `hedged_min` 或提高單腿名目，而不是放寬下門檻。
3. **大量 LEG_IMBALANCE** → 多半是盤口太薄 → 先降低單腿名目或提高流動性門檻，而不是調低 `imbalance_below`。
4. **依波動度分級**：高 / 中 / 低波動幣種可各有一組門檻（設定檔以 symbol tier 覆寫）。
5. **每次調整都要可追溯**：門檻屬於 `PaperTradingConfig`，任何修改產生新的 `config_version`，記在 `Trade.config_version`，以便比較調整前後的結果。

---

## 15. Emergency Execution

如果 `Long = FILLED`、`Short = REJECTED`，系統不能 `WAIT`，必須：

```text
LEG_IMBALANCE → CANCEL remaining pending orders → EMERGENCY CLOSE filled leg（reduce-only close order）→ Record result
```

Trade 進入 `EMERGENCY_EXIT`，部位歸零後轉 `CLOSED`、`close_reason = 'EMERGENCY_EXIT'`，`TradeResult.final_status = 'EMERGENCY_EXIT'`。

📎 Q-08：單腿失敗的 Trade **不會**收到對沖的 funding；若裸腿在結算時刻仍持倉，只記那一腿實際的 FundingSettlement（可能是付出）。

---

## 16. Execution Price

每一腿的 **Entry** 與 **Exit** 都必須記錄：Reference Price、Target Price、First Fill Price、Average Fill Price、Last Fill Price、Quantity、Notional。

---

## 17. Slippage

```text
Entry Slippage = Actual Average Fill Price − Reference Execution Price
Exit Slippage  = 同理
```

Paper Engine 必須支援：Fixed、Percentage、Orderbook、Depth-Based、Randomized、Historical Replay Slippage。

**第一階段：Orderbook Slippage + Configurable Safety Buffer。**

📎 取代 `server.ts:295` 依成交量三級常數的滑價（HANDOFF P4、Q-05）。

**已實作（2026-10-01，`net-cost-model`，`runtime/src/accounting/slippageEngine.ts`）**——估計來源依序：

1. `ORDERBOOK`：逐檔吃單（walk-the-book）求平均成交價。
2. `TOP_OF_BOOK`：只有最佳買賣價時以半價差估計。
3. `UNAVAILABLE`：沒有盤口 → Runtime 判為不合格（不得以預設值代替）。

`slippage_safety_buffer_pct` 加在估計值上；**待定**（佔位 0，建議 1 bp，Paper 期間校準）。研究端即時掃描尚無盤口，暫以 `LEGACY_VOLUME_TIER`（量能三級）作為明確標示的過渡來源，待 `websocket-data-layer` 提供盤口後移除。

---

## 18. Funding Settlement

不能直接假設 `Funding PnL = Notional × Funding Spread`，必須拆成 Leg A 與 Leg B：

```typescript
interface FundingSettlement {
    funding_id: string;
    trade_id: string;
    leg_id: string;

    exchange: ExchangeId;
    symbol: string;

    funding_time: number;
    position_notional: number;       // 結算時 mark price × 持倉數量（Q-07）
    funding_rate: number;            // 預測值；結算後以已結算費率覆寫（Q-04）
    settled_funding_rate?: number;
    position_side: 'LONG' | 'SHORT';

    expected_cashflow_usdt: number;
    actual_cashflow_usdt?: number;

    settlement_status: 'EXPECTED' | 'ELIGIBLE' | 'SETTLED' | 'NOT_ELIGIBLE' | 'MISSED';

    mark_price_source?: 'SETTLEMENT_RECORD' | 'SNAPSHOT';  // Binance 已結算紀錄含 markPrice；Bybit 用 T 時 MarketState 快照
    settled_rate_published_at?: number;  // 公開端點出現已結算費率的時間
    publication_delay_ms?: number;       // settled_rate_published_at − T（量測用，決定逾時與「待入帳」顯示）

    created_at: number;
    updated_at: number;
    settlement_timestamp?: number;
}
```

| settlement_status | 中文 |
|-------------------|------|
| `EXPECTED` | 預期中：ARM 時建立（預測費率 × 預估名目） |
| `ELIGIBLE` | 符合資格：`lock_end` 時確認該腿在鎖定區間內全程持倉 |
| `SETTLED` | 已結算：公開端點出現 `fundingTime == T` 的已結算費率；金額 = 結算時 mark price × 持倉數量 × 已結算費率 |
| `NOT_ELIGIBLE` | 不符資格：鎖定區間內任一時刻未持倉（例如緊急平倉）；確定這一期沒有資金費 |
| `MISSED` | 錯過：超過 `settlement_confirm_timeout_ms`（預設 10 分鐘）仍查不到已結算費率，需人工檢查 |

---

## 19. Funding Eligibility

📎 各交易所資金費率機制官方文件（結算時間偏差、費率計算方式）：[`REFERENCES.md`](REFERENCES.md)。

```text
Position Open Time → Funding Timestamp → Position Eligibility → Funding Settlement
```

不能只看到 Funding Time 就直接產生收益。**各交易所的 settlement 規則由 Exchange Adapter 定義**（Invariant #3）。

📎 Binance 官方 FAQ「實際劃轉有 15 秒偏差」、Bybit「結算前後 5 秒內開平倉不保證計入」皆已查證（[`REFERENCES.md`](REFERENCES.md)）。

### 19.1 交易所結算規則表（✅ C-05，由 Adapter 提供，策略層無分支）

| 交易所 | 不確定區間（前 / 後） | 已結算費率來源（公開） | 週期來源 |
|--------|---------------------|----------------------|---------|
| Binance | 15s / 15s（官方未說方向，保守取雙向） | `GET /fapi/v1/fundingRate`（含 `fundingTime`、`fundingRate`、`markPrice`） | `GET /fapi/v1/fundingInfo`，缺值 = 8h（Binance 文件定義的預設） |
| Bybit | 5s / 5s | `GET /v5/market/funding/history`（無 mark price） | instruments-info `fundingInterval` / tickers |
| OKX（未來） | 0s / 60s（「fee assessment may take up to a minute」） | `settFundingRate` / funding-rate-history | `nextFundingTime − fundingTime` |

配對的保護區間 = 兩腿不確定區間的最大值；實際換算時每腿用**自己交易所的區間、在自己交易所的時鐘上**計算，再取保守值（T 之前取最早、T 之後取最晚；2026-10-01 決議）。例：Binance × Bybit 的 `hedged_by` = min(Binance 時鐘 T−15s, Bybit 時鐘 T−5s)，實際即 T−15s。加入 OKX 後含 OKX 的配對 `exit_at` 自動變成 T+75s，不需改策略。

### 19.2 結單規範：安心平倉 vs 正式入帳（✅ C-05 / E-1、E-2）

- **安心平倉（時間條件）**：兩腿在 `[T − guard_before, T + guard_after]` 全程持倉，這一期的收付權利即已確定，平倉早晚不影響結果。因此到 `exit_at`（預設 T+30s）即送出平倉單，**不等待入帳確認**——等待只增加持倉風險，不增加收益。
- **正式入帳（確認條件）**：依 §18 `settlement_status` 推進；`EXPECTED → ELIGIBLE → SETTLED / NOT_ELIGIBLE / MISSED`。
- **損益定案**：Trade 在部位歸零時轉 `CLOSED`，此時 `TradeResult.funding_confirmed = false`（UI：「已平倉 · 待入帳」）；兩腿都到達終態後寫入 `finalized_at`。`funding_confirmed = true` 的條件是每一腿都是 `SETTLED` 或 `NOT_ELIGIBLE`（金額已知）；任一腿 `MISSED` → `funding_confirmed = false` 並標記人工檢查。UI 標示「推定結算（依公開已結算費率）」。
- **量測**：每次記錄 `publication_delay_ms`，供調整逾時與進入 Live 前評估是否改為「等確認才平倉」。

### 19.3 合約週期限制（✅ C-05 / D-7）

- 只交易週期 **≥ 2 小時**的合約；同一幣種相鄰場次因此不會重疊（WATCH 30 分鐘 < 2 小時）。
- ⚠️ **1 小時合約注意**：Bybit / OKX 在費率觸及上下限時會**自動把結算頻率改為每小時**。ARM 與 `hedged_by` 前各重新讀取一次週期；任一腿變成 < 2h 或兩腿結算時間不再對齊 → Opportunity `REJECTED` / 進入緊急處理。

---

## 20. PnL Model（✅ C-13）

```text
Net PnL = Funding PnL + Price PnL − Trading Fees − Other Costs

Funding PnL = Leg A Funding Cashflow + Leg B Funding Cashflow
Price PnL   = Long Leg Price PnL + Short Leg Price PnL    // 以「實際平均成交價」計算
```

**Slippage 不再從 Net PnL 扣除**：Price PnL 用的是實際成交價，滑價已經包含在內，再扣一次就是 Q-05 的重複扣除 bug。Slippage 只作為**歸因（attribution）**：說明 Price PnL 中有多少是因為成交價偏離參考價造成的。

```text
slippage_attribution_usdt = Σ 每腿 (實際均價 − 參考價) 對 PnL 的影響（負值 = 成本）
Price PnL = 以參考價計算的 Price PnL + slippage_attribution_usdt
```

### 20.1 UI 防呆提示（✅ C-13）

凡顯示 Slippage 的地方（Trade Detail、Completed Trades、損益瀑布圖），必須：

- 以不同樣式（例如灰色 / 括號 / 斜體）顯示，並標註 **「已含在 Price PnL 中，不另外扣除」**
- 損益瀑布圖中 Slippage 為 Price PnL 的**子項**，不是與 Price PnL 並列的獨立扣項
- 在 `?` 說明中解釋：`Net = Funding + Price − Fees`；自行加總時不要再減 Slippage

### 20.2 預期淨利與實際淨利同一結構（✅ `net-cost-model`）

```text
expected_net = expected_funding + expected_price − expected_fees − basis_risk_charge
expected_price = expected_basis_pnl + expected_slippage_attribution
```

- 實作：`runtime/src/accounting/expectedNet.ts` `estimateExpectedNet`；實際淨利用同一個 `composeNetPnl`（型別上沒有 slippage 參數，避免重複扣除）。
- `expected_basis_pnl`：兩所進場價差（`entry_basis_pct`）的保守估計，預設只計不利的一側（`ADVERSE_ONLY`）。
- `basis_risk_charge = basis_risk_z × basis_sigma_pct × 名目`；`basis_sigma_pct` **待定**（佔位 0，需歷史資料 B7 校準）。
- 研究端 live-scan 的百分比欄位（`fee_drag_pct`、`est_slippage_pct`、`expected_net_pnl_pct`）一律以**單腿目標名目**為分母，`spread − fee − slippage + 不利價差 = 淨值`（測試把關）。

---

## 21. Trade Result

```typescript
interface TradeResult {
    trade_id: string;
    symbol: string;
    mode: 'PAPER' | 'BACKTEST';

    created_at: number;                    // §25 #1；Trade 進入終態時建立（暫定結果）
    updated_at: number;                    // 每次結算更新時重寫

    long_exchange: ExchangeId;
    short_exchange: ExchangeId;

    target_notional_per_leg_usdt: number;
    actual_long_notional_usdt: number;
    actual_short_notional_usdt: number;
    leverage: number;

    entry_duration_ms: number;
    exit_duration_ms: number;
    total_trade_duration_ms: number;

    funding_pnl_usdt: number;
    price_pnl_usdt: number;                // 已含滑價
    fee_usdt: number;                      // 手續費總額（正值 = 成本）
    slippage_attribution_usdt: number;     // 僅歸因，已含在 price_pnl_usdt，不參與 net 計算
    net_pnl_usdt: number;                  // funding + price − fee − other

    roi_on_capital_pct: number;            // net / allocated_capital
    roi_on_notional_pct: number;           // net / (actual_long + actual_short)

    max_leg_imbalance_usdt: number;
    max_leg_imbalance_duration_ms: number;

    final_status: 'PROFIT' | 'LOSS' | 'BREAK_EVEN' | 'ABORTED' | 'FAILED' | 'EMERGENCY_EXIT';
    result_reason: string;

    funding_confirmed: boolean;            // ✅ C-05：兩腿皆 SETTLED / NOT_ELIGIBLE 才為 true（§19.2）
    finalized_at?: number;                 // 兩腿結算皆到達終態後才寫入（平倉當下為空 =「待入帳」）
}
```

📎 原 `fee_pnl_usdt` → `fee_usdt`、`slippage_pnl_usdt` → `slippage_attribution_usdt`，避免名稱暗示「要加進 PnL」。

---

## 22. Risk Engine

Risk Engine 必須在 **Opportunity → Trade Creation → Order Submission** 三個階段都執行。

**Pre-Trade Risk**：Account Available Capital、Max Position、Max Notional per Leg、Max Leverage、Minimum Funding Spread、Expected Net PnL、Maximum Slippage、Order Book Depth、Exchange Connectivity、API Latency、Funding Time & Alignment（§5）、Existing Exposure、Data Freshness。

**Entry Risk**（持續檢查）：Price deviation、Funding rate change、Order timeout、Partial fill、Leg imbalance（§14）、Exchange connection、Market volatility。

**Position Risk**：Position imbalance、Mark price movement、Basis divergence、Funding change、Holding time、Exit condition。

📎 v0.1 的 r5 / r7 / r9 永遠 PASS（HANDOFF P7）；v0.2 每一項都必須由真實輸入計算，且每一項都要有觸發 FAIL 的測試。

### 22.1 檢查項目對照表（`runtime/src/risk/checks/registry.ts`，28 項）

任一必要輸入缺失（`undefined` / `null` / `NaN` / `±Infinity` / 空陣列）時該項為 `FAIL`、`value = 'UNKNOWN'`、`reason_code = 'INPUT_MISSING'`；評估時間 `now` 無效時該階段全部 FAIL。門檻與預設值見技術書 §38；`reason_code` 字面值見 `runtime/src/risk/{preTradeRisk,executionRisk,positionRisk}.ts`。

| # | 階段 | check_code | 名稱 | 類別 | critical |
|---|------|-----------|------|------|----------|
| 1 | PRE_TRADE | `CAPITAL` | Capital | Capital | ✅ |
| 2 | PRE_TRADE | `MAX_POSITIONS` | Max Positions | Capital | ✅ |
| 3 | PRE_TRADE | `MAX_NOTIONAL_PER_LEG` | Max Notional Per Leg | Capital | ✅ |
| 4 | PRE_TRADE | `MAX_LEVERAGE` | Max Leverage | Capital | ✅ |
| 5 | PRE_TRADE | `MIN_FUNDING_SPREAD` | Min Funding Spread | Market | ✅ |
| 6 | PRE_TRADE | `EXPECTED_NET_PNL` | Expected Net PnL | Market | ✅ |
| 7 | PRE_TRADE | `MAX_SLIPPAGE` | Max Slippage | Execution | ✅ |
| 8 | PRE_TRADE | `ORDERBOOK_DEPTH` | Orderbook Depth | Execution | ✅ |
| 9 | PRE_TRADE | `EXCHANGE_CONNECTIVITY` | Exchange Connectivity | Connection | ✅ |
| 10 | PRE_TRADE | `API_LATENCY` | API Latency | Connection | ✅ |
| 11 | PRE_TRADE | `FUNDING_TIME_ALIGNMENT` | Funding Time Alignment | Market | ✅ |
| 12 | PRE_TRADE | `EXISTING_EXPOSURE` | Existing Exposure | Capital | ✅ |
| 13 | PRE_TRADE | `DATA_FRESHNESS` | Data Freshness | Connection | ✅ |
| 14 | PRE_TRADE | `CLOCK_RELIABILITY` | Clock Reliability | Connection | ✅ |
| 15 | PRE_TRADE | `ENTRY_GATE` | Entry Gate | Execution | ✅ |
| 16 | ENTRY | `PRICE_DEVIATION` | Price Deviation | Market | ✅ |
| 17 | ENTRY | `FUNDING_RATE_CHANGE` | Funding Rate Change | Market | ✅ |
| 18 | ENTRY | `ORDER_TIMEOUT` | Order Timeout | Execution | ✅ |
| 19 | ENTRY | `PARTIAL_FILL` | Partial Fill | Execution | ✅ |
| 20 | ENTRY | `LEG_IMBALANCE` | Leg Imbalance | Execution | ✅ |
| 21 | ENTRY | `EXCHANGE_CONNECTION` | Exchange Connection | Connection | ✅ |
| 22 | ENTRY | `MARKET_VOLATILITY` | Market Volatility | Market | ✅ |
| 23 | POSITION | `POSITION_IMBALANCE` | Position Imbalance | Execution | ✅ |
| 24 | POSITION | `MARK_PRICE_MOVEMENT` | Mark Price Movement | Market | ✅ |
| 25 | POSITION | `BASIS_DIVERGENCE` | Basis Divergence | Market | ✅ |
| 26 | POSITION | `FUNDING_CHANGE` | Funding Change | Market | ✅ |
| 27 | POSITION | `HOLDING_TIME` | Holding Time | Execution | ✅ |
| 28 | POSITION | `EXIT_CONDITION` | Exit Condition | Execution | ✅ |

---

## 23. Kill Switch

> ⚠️ 待決 C-16：本段（單一連鎖流程）與技術書 §33（三個獨立動作）的差異，詳細說明見 §34 C-16 列。決議前不得實作。

原始描述：必須存在全域 **KILL SWITCH**，啟動後：

```text
停止新 Trade → 取消所有 Pending Entry Orders → 評估 Existing Positions → 必要時 Emergency Close
```

Paper Trading 必須先驗證 Kill Switch。

---

## 24. Execution Timeline

每一筆 Trade 必須產生 Timeline（由 `TradingEvent` 的**絕對時間戳**推導；UI 可另外顯示相對 T 的偏移）：

```text
15:31:00.000  SCAN
15:31:00.021  OPPORTUNITY DETECTED
15:31:00.028  RISK CHECK
15:31:00.034  RISK PASS
15:31:00.040  CREATE ORDER A
15:31:00.041  CREATE ORDER B
15:31:00.060  ORDER A ACK
15:31:00.063  ORDER B ACK
15:31:00.071  ORDER A PARTIAL FILL
15:31:00.084  ORDER A FILLED
15:31:00.091  ORDER B FILLED
15:31:00.095  HEDGE COMPLETE
...
15:32:00.100  EXIT SIGNAL
15:32:00.120  CLOSE ORDER A
15:32:00.125  CLOSE ORDER B
15:32:00.160  BOTH CLOSED
15:32:00.170  TRADE COMPLETE
```

---

## 25. Telemetry 與時間戳硬性規則（✅ C-11 附註）

v0.1 沒有系統性記錄時間戳；v0.2 起以下為**硬性規則**，違反 = PR 不接受：

1. **每一個持久化實體**（Opportunity、Trade、TradeLeg、PaperOrder、Fill、FundingSettlement、TradeResult、RiskCheck、AccountSnapshot）都有 `created_at` 與 `updated_at`（終態實體另有 `terminal_time` / `finalized_at`）。
2. **每一次狀態轉換**都產生一筆 `TradingEvent`（含 `timestamp`、前狀態、後狀態、原因），狀態欄位只是最新值的快取；歷史以事件為準。
3. **格式**：Unix epoch **毫秒**、UTC、`number`；不得存字串時間或本地時區。
4. **雙時間戳**：來自交易所的資料同時保存 `exchange_timestamp` 與 `local_received_timestamp`；系統產生的時間使用與交易所校正後的時鐘（BE-07），並記錄當下的 `clock_offset_ms`。
5. **不得以寫入時間冒充事件時間**：兩者不同時分別記錄（例如 `Fill.timestamp` vs `Fill.recorded_at`）。
6. **研究資料也要記**：Scanner 產生的 Opportunity（包含被否決、過期的）一律保存 `detected_at`，供日後回測比對。

Order 時間戳至少：`submit_time`、`ack_time`、`first_fill_time`、`final_fill_time`、`cancel_request_time`、`cancel_ack_time`。

衍生指標：API latency（`ack − submit`）、Fill latency（`final_fill − ack`）、Cancel latency（`cancel_ack − cancel_request`）、Entry duration、Exit duration、Total trade duration（沿用 v0.1 `OrderLatencyMetrics` 定義）。

---

## 26. State Machines（✅ C-15）

**UI 規則**：狀態一律以**英文**代碼顯示；旁邊的 `?` 點擊後顯示**中文名稱與一句話定義**。英文代碼、中文名稱與定義集中在單一術語表（技術書 §27.1），UI 與文件共用，不得各自寫一份。

### 26.1 Opportunity Status

```text
DETECTED ──► QUALIFIED ──► SELECTED（→ 建立 Trade）
    │            │
    ├────────────┴──► REJECTED（附 rejection_reason）
    └────────────────► EXPIRED（超過 expires_at）
```

| 狀態 | 中文 | 定義 |
|------|------|------|
| `DETECTED` | 已偵測 | Scanner 發現費率差，尚未評估成本 |
| `QUALIFIED` | 已合格 | 扣除成本後仍符合門檻 |
| `SELECTED` | 已選中 | 通過 Pre-Trade Risk，將建立 Trade |
| `REJECTED` | 已否決 | 未通過篩選或風控，必須記錄原因 |
| `EXPIRED` | 已過期 | 超過 TTL 未被選中 |

### 26.2 Trade Status

```text
CREATED ──► PRE_FLIGHT ──► ENTRY_PENDING ──► HEDGED ──► EXIT_PENDING ──► CLOSED
               │                │    ▲          │
               ▼                │    │ 補足      │ （Position Risk 觸發）
            ABORTED             ▼    │          ▼
         （含 0 成交逾時）    PARTIALLY_HEDGED   EMERGENCY_EXIT ──► CLOSED
                                │                      ▲         (close_reason = EMERGENCY_EXIT)
                                ▼ 超時 / 低於下門檻      │
                           LEG_IMBALANCE ──────────────┘

任一狀態 ──► FAILED（系統錯誤、Reconciliation Error；需人工處理）
```

| 狀態 | 中文 | 定義 | 終態 |
|------|------|------|------|
| `CREATED` | 已建立 | 已保留資金、建立 Trade 紀錄 | |
| `PRE_FLIGHT` | 下單前檢查 | Order Submission 階段風控 | |
| `ENTRY_PENDING` | 進場中 | 兩腿訂單已送出，等待成交 | |
| `PARTIALLY_HEDGED` | 部分對沖 | 兩腿都有成交，hedge ratio 介於兩門檻之間，正在補足 | |
| `LEG_IMBALANCE` | 單腿失衡 | hedge ratio 低於下門檻，或部分對沖超時 | |
| `HEDGED` | 已對沖 | 兩腿成交且 hedge ratio ≥ 上門檻，持倉中 | |
| `EXIT_PENDING` | 出場中 | 已送出兩腿平倉單 | |
| `EMERGENCY_EXIT` | 緊急平倉中 | 撤掉掛單並平掉已成交部位 | |
| `CLOSED` | 已結束 | 兩腿部位歸零；看 `close_reason` 區分正常 / 緊急 / Kill Switch | ✔ |
| `ABORTED` | 已放棄 | 未產生任何部位就結束（風控否決、0 成交逾時） | ✔ |
| `FAILED` | 系統失敗 | 無法自動處理的錯誤，停止新交易並待人工確認 | ✔ |

📎 原 v0.2 草稿的 `OPEN` 移除（與 `HEDGED` 重複）；`DETECTED` / `QUALIFIED` 屬於 Opportunity，不屬於 Trade。

### 26.3 Leg Status

| 狀態 | 中文 | 定義 |
|------|------|------|
| `PENDING` | 待進場 | 尚未送單 |
| `OPENING` | 開倉中 | 進場單已送出 |
| `PARTIAL` | 部分開倉 | 有成交但未達目標數量 |
| `OPEN` | 已開倉 | 達到目標數量（Leg 層級，與 Trade 的 HEDGED 不同） |
| `CLOSING` | 平倉中 | 平倉單已送出 |
| `CLOSED` | 已平倉 | 部位歸零 |
| `FAILED` | 失敗 | 未能開倉（0 成交）或無法平倉 |

```text
PENDING ──► OPENING ──────────► OPEN ──► CLOSING ──► CLOSED
   │           │                 ▲          ▲  └────► FAILED（無法平倉）
   │           ├──► PARTIAL ─────┘          │
   │           │       └────────────────────┘（部分成交後緊急平倉）
   │           └──► FAILED（0 成交）
   └──► FAILED（未送單即放棄）
```

✅ 2026-10-01 決議：允許的轉換為 `PENDING→OPENING|FAILED`、`OPENING→PARTIAL|OPEN|FAILED`、`PARTIAL→OPEN|CLOSING`、`OPEN→CLOSING`、`CLOSING→CLOSED|FAILED`（`runtime/src/types/status.ts` `LEG_TRANSITIONS`）。

---

### 26.4 Settlement Session Phase（✅ C-05）

每個候選結算時刻 T 一個場次；時間點由技術書 §38 設定與 §19.1 規則表計算，每腿以自己交易所的時鐘換算後取保守值（技術書 §8.1）。

```text
 T-30m        T-5m        T-60s   T-45s        T-25s   T-15s     T      T+15s  T+30s
   │            │           │       │            │       │       │        │      │
 WATCH ──▶ SHORTLIST ──▶ ARM ──▶ ENTRY ─────────────▶ LOCK ─────────────▶ CONFIRM ──▶ DONE
                                    │  最後送單 ─┘       │  禁止減倉       │  平倉
                                    │                   └ 必須已 HEDGED    └ 不等入帳
（任一階段無合格機會 / 被否決 → SKIPPED）
```

| 狀態 | 中文 | 定義 |
|------|------|------|
| `WATCH` | 觀察中 | T-30m 起，全市場層追蹤候選 |
| `SHORTLIST` | 入圍 | T-5m，入圍幣種改訂閱逐筆行情與盤口，強制校正時鐘 |
| `ARM` | 備戰 | T-60s，重新讀取兩腿費率與週期、重算淨值、保留資金；最後的進場決策點 |
| `ENTRY` | 進場中 | `entry_open`～`entry_deadline`（預設 T-45s～T-25s）可送出新進場單 |
| `LOCK` | 鎖定 | `hedged_by`～`lock_end`（預設 T-15s～T+15s）禁止減倉；`hedged_by` 時未 HEDGED → `LEG_IMBALANCE` |
| `CONFIRM` | 平倉與入帳確認 | `exit_at`（預設 T+30s）送出平倉單，之後等待已結算費率 |
| `DONE` | 完成 | 入帳定案（§19.2）後由 Trade 層標記 |
| `SKIPPED` | 跳過 | 本場次沒有合格機會或被否決 |

每次轉換產生 `SESSION_PHASE_CHANGED` 事件（§25）。

## 27. Frontend Required Information

**Account**：Total Capital、Available Capital、Allocated Capital、Current Positions、Maximum Positions。

**Current Trades**：Trade ID、Symbol、Long Exchange、Short Exchange、Notional per Leg、Leverage、Status、Hedge Ratio、Unrealized PnL、Funding Expected。

**Completed Trades**：Trade Time、Symbol、Entry、Exit、Funding、Fees、Slippage（歸因樣式，§20.1）、Net PnL、Duration、Result。

必須同時顯示失敗 / 未成交 / Emergency Exit 的交易（技術書 §48.1）。所有狀態代碼旁有 `?`（§26）。

---

## 28. Trade Detail

點擊一筆交易後顯示 `TRADE #20260930-001`：

- **Strategy**：Strategy Version、Config Version、Opportunity ID、Detection Time、Funding Spread、Expected PnL
- **Position**：Long Exchange、Short Exchange、Leverage、Target Notional per Leg、Actual Notional（各腿 + Gross）、Margin、Capital Allocation
- **Entry**：Order Time、ACK Time、Fill Time、Target Price、Average Fill、Slippage（歸因）
- **Funding**：Funding Rate A、Funding Rate B、Funding Time A / B、Eligibility、Actual Funding
- **Exit**：Exit Order Time、Fill Time、Exit Price
- **Result**：Funding PnL、Price PnL（含滑價）、Fee、Net PnL、ROI；Slippage 以歸因樣式顯示
- **Timeline**：全部 `TradingEvent`，含未成交、撤單、拒絕

---

## 29. Research / Backtest Compatibility

Paper Trading 與 Backtest 共用：Opportunity、Trade、TradeLeg、Order、Fill、FundingSettlement、TradeResult Schema（`mode` 區分，✅ C-18）。

差別只在 **Market Data Source**：Backtest = Historical Data；Paper = Live Market Data。

---

## 30. 統一交易結果

```text
Backtest Trade                 Paper Trade
  ├── Opportunity                ├── Opportunity
  ├── Orders                     ├── Orders
  ├── Fills                      ├── Fills
  ├── Funding                    ├── Funding
  ├── Slippage                   ├── Slippage
  └── PnL                        └── PnL
```

未來直接比較 **Backtest Expected vs Paper Actual**，這是階段 ④ 的核心（§1.1）。

---

## 31. v0.2 Acceptance Criteria

**Normal**
- [ ] 雙邊正常成交
- [ ] 正確建立 Position
- [ ] 正確計算 Funding
- [ ] 正確平倉
- [ ] 正確計算 PnL（無重複扣除滑價）

**Partial Fill**
- [ ] 一邊 Partial Fill、另一邊 Full Fill
- [ ] 正確計算 Hedge Ratio
- [ ] 介於兩門檻 → PARTIALLY_HEDGED → 補足或超時轉 LEG_IMBALANCE
- [ ] 低於下門檻 → LEG_IMBALANCE → Emergency Exit

**Failure**
- [ ] Order Reject
- [ ] Order Timeout
- [ ] Order Cancel
- [ ] Cancel Failure
- [ ] No Fill
- [ ] Exchange Disconnect

**Risk**
- [ ] Max Position
- [ ] Max Capital
- [ ] Max Leverage
- [ ] Max Slippage
- [ ] Funding 不對齊時否決
- [ ] 非 trading_exchanges 的配對不得交易
- [ ] Kill Switch（待 C-16）
- [ ] Emergency Exit

**Traceability**
- [ ] 所有實體都有 `created_at` / `updated_at`（§25）
- [ ] 所有狀態轉換都有 `TradingEvent`
- [ ] 所有 Order、Fill 都有 timestamp
- [ ] 未成交 Order 仍然存在
- [ ] Cancel 有 timestamp
- [ ] Reject 有 reason
- [ ] 所有 Trade 可以 replay

每一項都必須有自動化測試（HANDOFF §5 DoD）；對應情境見技術書 §42（S01–S14）。

---

## 32. v0.2 Definition of Done

Paper Trading **不代表**「畫面上顯示一筆假的獲利交易」。

> **任何一個 Trade，不論成功、失敗、部分成交、完全未成交、單腿成交、取消、Emergency Exit，都能從 Opportunity 一路追蹤到 Order、Fill、Position、Funding、PnL 與最終 Result，且每一步都有時間戳。**

---

## 33. 憑證與環境變數（✅ C-08）

Paper Trading 需要各交易所的 API Key / Secret（用途：取得帳戶實際手續費等級、帳戶層級限流額度、驗證 key 權限；**不用於下單**）。

1. **只放在 `.env.local`**（已被 `.gitignore` 的 `.env*` 排除）；範本為 `.env.example`（只含空值，可提交）。
2. **只在 Runtime（Node 端）讀取**；不得傳到瀏覽器、不得出現在 Common Schema、`TradingEvent.payload`、log、錯誤訊息、匯出檔。
3. **權限**：Read ✅、Trading ❌（Paper 階段不需要）、Withdraw ❌；建議綁定 IP 白名單。
4. **程式碼層面**：`ExchangeAdapter` 只實作公開端點與唯讀私有端點；**任何下單 / 撤單的真實端點不得存在於程式碼中**，直到階段 ⑤ 另立 change 並經批准。
5. 研究 UI 的 Local Secret Vault（`localStorage` 明文，HANDOFF P12）不得被 Runtime 使用。

📎 HANDOFF Invariant #1、#2 同步修訂為上述內容。

---

## 34. 決策紀錄

### A. 與現有 repo / HANDOFF / issue 的衝突

| ID | 議題 | 決議（2026-09-30） |
|----|------|------|
| C-01 | 交易所範圍 | ✅ 5 所持續掃描；Paper Trading 只在 Binance、Bybit；未來加入 OKX（§3） |
| C-02 | 版本號 | ✅ 現有 7 模組規格改稱 v0.1，本文件為 v0.2 |
| C-03 | 模組切分 | ✅ 在主要功能不變下採用新切分（§2）；因變動較大，改用 `main` / `develop` / `feature-*` 分支流程與 rollback 機制（技術書 §51） |
| C-04 | 階段定義 | ✅ 五階段（§1.1） |
| C-05 | 進出場時機與事件迴圈 | ✅ **2026-10-01 決議**（OpenSpec change `paper-trading-event-loop`，D-1～D-8、E-1、E-2）：每筆 Trade 只做**單次結算**；以「結算場次」錨定 T（WATCH → SHORTLIST → ARM → ENTRY → LOCK → CONFIRM，窗口可設定）；Opportunity 改以失效規則取代固定 TTL；兩層資料取得（全市場 / 入圍）；入帳以公開已結算費率推定；只交易週期 ≥ 2h 的合約；時鐘可注入且每腿以自己交易所的時鐘判定；`exit_at` 即平倉、不等入帳（預設 T+30s）。細節見 §18、§19、§26.4、技術書 §8.1、§10、§23.1、§41 |
| C-06 | Runtime 位置 | ✅ 獨立 Node process；`server.ts` 只讀 SQLite / 轉發事件（技術書 §3） |
| C-07 | 目錄結構 | ✅ 與研究原型分開，採技術書 §4 架構放在 `runtime/`；未來有需求再調整 |
| C-08 | 憑證 | ✅ Paper 需要 API Key / Secret，放 `.env.local`、不得上傳（§33） |
| C-09 | 開發順序 | ✅ B0 測試 → ① Instrument Registry → ③ 淨值 PnL → ② WebSocket → Paper Runtime（技術書 §50.1） |
| C-10 | Opportunity 結算時間 | ✅ 兩腿分開記錄 + 對齊檢查（§5） |
| C-11 | 舊型別遷移 | ✅ 漸進遷移、每步測試全過（§2.1）；**所有實體必須記錄時間戳**（§25） |

### B. 兩份文件內部的矛盾

| ID | 議題 | 決議（2026-09-30） |
|----|------|------|
| C-12 | Hedge ratio 門檻 | ✅ 兩條門檻 + 部分對沖最長時間，設定方式 / 理由 / 調整方法見 §14.1–14.3 |
| C-13 | 滑價重複扣除 | ✅ Net = Funding + Price − Fees；Slippage 僅歸因，UI 必須提示（§20） |
| C-14 | Order 狀態 | ✅ 移除 CLOSED；Timeout 改為事件；補撤單失敗、ACK 逾時；`filled_quantity`（§9–10） |
| C-15 | Trade 狀態機 | ✅ 重新定義並附中文名稱；UI 英文為主、`?` 顯示中文（§26） |
| C-16 | Kill Switch | ⚠️ **待決**。問題：§23 的「按下 = 停止 + 撤單 + 評估 + 必要時平倉」是一個動作；技術書 §33 是三個獨立按鈕、預設只停止新交易。需要決定：(1) 按一次到底做到哪一層；(2) 撤單時「出場單 / 緊急平倉單」要不要一起撤（撤掉會讓部位留在市場上）；(3) 正在 ENTRY_PENDING / PARTIALLY_HEDGED 的 Trade，撤掉進場單後會變成單腿，要不要自動走緊急平倉；(4) 平倉是自動還是需人工確認；(5) 系統自動觸發（斷線、Reconciliation Error）時各對應哪一層 |
| C-17 | 名目定義 | ✅ 單腿名目；ROI 分母 = 雙腿實際名目合計（§7） |
| C-18 | Trade.mode | ✅ `'PAPER' \| 'BACKTEST'`，`'LIVE'` 保留 |

### C. 整理時新發現

| ID | 議題 | 狀態 |
|----|------|------|
| C-19 | `hedge_ratio` 以 notional 計算會受兩所價差影響（數量相同也 < 100%）；建議改用合約乘數換算後的基礎資產數量 | ⚠️ 待決（§14） |
