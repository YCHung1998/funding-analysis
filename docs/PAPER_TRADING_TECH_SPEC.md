# Paper Trading Engine — Technical Development Specification v0.1

| 欄位 | 值 |
|------|----|
| Purpose | 開發可長時間自動運行的 Funding Arbitrage 模擬交易機器人 |
| Scan | Pionex、Binance、Bybit、Bitget、OKX（5 所）|
| Paper Trading Target | Binance + Bybit；未來加入 OKX（✅ C-01） |
| Mode | Paper Trading |
| Market Data | Live |
| Order Execution | Simulated |
| Real Order | **Disabled** |
| 上位規格 | [`TRADING_SYSTEM_SPEC.md`](TRADING_SYSTEM_SPEC.md) v0.2（衝突時以規格書為準） |
| 最後更新 | 2026-09-30 |

> **本文件是未來開發 Paper Trading Runtime 時必須遵循的技術書。**
> - `✅ C-xx` = 已決議、`⚠️ 待決 C-xx` = 未決議（**決定前不得依該段實作**），見規格書 [§34 決策紀錄](TRADING_SYSTEM_SPEC.md#34-決策紀錄)。
> - 開發流程（OpenSpec + 分支 + rollback）見 [§51](#51-開發流程openspec--分支--rollback)；憑證見 [§52](#52-憑證與環境變數)。
> - [`assets/HANDOFF.md`](../assets/HANDOFF.md) §3 Invariants 與 §5 DoD 全部適用：改公式 / 引擎必附自動化測試與 fail-then-pass 證據。

---

## 1. Development Objective

Paper Trading Engine 的目標不是單純模擬 `Buy → Sell → Profit`，而是模擬真正交易系統的：

```text
Market Data → Signal → Risk → Order → ACK → Fill → Position → Funding → Exit → PnL
```

**並且保留所有中間狀態。**

---

## 2. Core Principle

```text
Real Market Data
        ↓
Real Strategy
        ↓
Real Risk Engine
        ↓
Paper Execution
```

只有 **Execution Adapter** 與真實交易不同。因此未來 `PaperExecutionAdapter` 可以替換成 `BinanceExecutionAdapter` / `BybitExecutionAdapter`，而 Strategy / Risk / Position Engine **不應修改**。

---

## 3. Recommended Architecture

```text
                    ┌──────────────┐
                    │   Frontend   │
                    └──────┬───────┘
                    WebSocket/API
                           ▼
┌─────────────────────────────────────────┐
│             Trading Runtime             │
│  Scanner                                │
│     ↓                                   │
│  Opportunity Engine                     │
│     ↓                                   │
│  Risk Engine                            │
│     ↓                                   │
│  Trade Manager                          │
│     ↓                                   │
│  Execution Engine                       │
│     ↓                                   │
│  Position Manager                       │
│     ↓                                   │
│  PnL Engine                             │
└─────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌────────────────┐   ┌──────────────────┐
│ Market Data    │   │ Event / Database │
│ Binance /Bybit │   │ Trade / Order    │
└────────────────┘   │ Fill / Position  │
                     └──────────────────┘
```

**✅ C-06：Trading Runtime 是獨立的 Node process**（入口 `runtime/src/main.ts`，指令例如 `npm run runtime`）。

- 瀏覽器關閉、`server.ts` 重啟都不影響 Runtime（§48.4）。
- Runtime 是 SQLite 的**唯一寫入者**；`server.ts` 以唯讀方式查詢 SQLite，並把 Runtime 發出的事件轉發給前端（WebSocket）。
- 前端的控制指令（啟動 / 停止 / Kill Switch）經 `server.ts` 轉交 Runtime 的控制通道；Runtime 自行驗證後執行（UI 不是 Source of Truth，§48.3）。

---

## 4. Module Structure

**✅ C-07：放在 repo 根目錄的 `runtime/`，與研究原型（`src/`、`server.ts`）分開**；結構照下列架構，未來有需求再調整。

```text
runtime/src/
├── main.ts                 # 啟動流程（§39）
├── config/                 # PaperTradingConfig 載入、版本化（config_version）
├── types/                  # v0.2 Schema 單一來源（規格書 §5–§21）+ 術語表（§27.1）
├── adapters/
│   ├── binance/
│   └── bybit/
├── market/
│   ├── marketDataService
│   ├── orderBookService
│   └── fundingService
├── scanner/
│   └── fundingScanner
├── strategy/
│   └── fundingArbitrageStrategy
├── risk/
│   ├── preTradeRisk
│   ├── executionRisk
│   ├── positionRisk
│   └── killSwitch
├── trading/
│   ├── tradeManager
│   ├── orderManager
│   ├── fillEngine
│   ├── positionManager
│   └── fundingSettlement
├── execution/
│   ├── executionInterface
│   └── paperExecution
├── accounting/
│   ├── feeEngine
│   ├── slippageEngine
│   └── pnlEngine
├── telemetry/
│   ├── eventLogger
│   └── latencyTracker
└── storage/
    ├── tradeRepository
    ├── orderRepository
    └── marketDataRepository
```

- ✅ C-03：M1–M7 → 新模組的對照見規格書 §2。
- ✅ C-11：研究 UI 漸進改為 import `runtime/src/types/`；舊型別標 `@deprecated`，每一步都要測試全綠（規格書 §2.1）。
- 測試放在各模組旁（`*.test.ts`），Scenario Test 放 `runtime/test/scenarios/`（§42）。

---

## 5. Exchange Adapter Interface

Strategy 不允許直接呼叫 Binance / Bybit API。統一：

```typescript
interface ExchangeAdapter {
    getMarkets(): Promise<Market[]>;
    getFundingRate(symbol: string): Promise<FundingRate>;
    getOrderBook(symbol: string, depth: number): Promise<OrderBook>;
    getTicker(symbol: string): Promise<Ticker>;
    getAccount(): Promise<ExchangeAccountInfo>;  // ✅ C-08：唯讀私有端點，僅用於手續費等級 / 限流額度 / 權限檢查（2026-10-01 改名，避免與 §29 虛擬帳本 AccountSnapshot 撞名）
}
```

如果未來進 Live：

```typescript
interface ExecutionAdapter {
    submitOrder(request: OrderRequest): Promise<OrderAck>;
    cancelOrder(orderId: string): Promise<CancelAck>;
    getOrder(orderId: string): Promise<OrderState>;
    getPosition(symbol: string): Promise<Position>;
}
```

- Paper：`PaperExecutionAdapter`
- Live：`BinanceExecutionAdapter`、`BybitExecutionAdapter`（**未經使用者明確批准不得建立**，HANDOFF Invariant #1）

> ✅ C-08：`getAccount()` 使用 `.env.local` 的 API Key 呼叫**唯讀**端點（§52）。Paper 帳戶的資金、部位是**虛擬帳本**（`account_snapshots` 表），與真實帳戶餘額無關。`ExchangeAdapter` 不得包含任何真實下單 / 撤單方法。
> 📎 `getMarkets()` 應回傳 Instrument Registry 所需欄位（base、quote、合約乘數、狀態、資金費週期、下次結算時間），見 issue 索引方向 ①、Q-01、Q-02、Q-03。

---

## 6. Market Data

Paper Trading **不應使用假的市場價格**。

| 通道 | 用途 |
|------|------|
| Binance WebSocket / Bybit WebSocket | Continuous Market Data |
| REST | Initial Snapshot、Recovery、Reconciliation |

📎 整合註記：現有 `server.ts` 為 REST 輪詢 + 5s 快取；改造方向見 issue 索引方向 ②（BE-01～BE-05）。開發順序 ✅ C-09（§50.1）。掃描需訂閱 5 所；交易只需 Binance、Bybit 的盤口深度（✅ C-01）。

---

## 7. Required Market Data

至少：Ticker、Bid、Ask、Mark Price、Index Price、Funding Rate、Next Funding Time、Order Book、Volume、Open Interest、Exchange Timestamp、Local Receive Timestamp。

---

## 8. Market Data Timestamp

```typescript
interface MarketDataEvent {
    exchange: ExchangeId;
    symbol: string;
    exchange_timestamp: number;
    local_received_timestamp: number;
    sequence?: number;
    bid: number;
    ask: number;
    mark_price: number;
    index_price: number;
    funding_rate?: number;
}
```

必須可以計算 `data_age_ms`：

```text
Exchange Timestamp:  15:30:00.120
Local:               15:30:00.164
Data Age:            44ms
```

資料過舊 → `STALE_MARKET_DATA` → **Risk Engine 必須阻止新交易**。

📎 `data_age_ms` 必須先扣除本機與交易所的時鐘偏差（BE-07，實測本機慢 57–62 ms），否則門檻判斷失真。

### 8.1 時鐘（✅ C-05 / D-8，`runtime/src/clock/`）

```typescript
interface Clock {
  now(): number;                                         // 參考時間軸（預設 Binance），epoch ms
  exchangeNow(ex: ExchangeId): number;                   // 該交易所的時間
  toLocal(ex: ExchangeId, exchangeTime: number): number; // 交易所時間 → 本地排程時間
  offset(ex: ExchangeId): { offsetMs: number; errorMs: number; calibratedAt: number };
  reference(): ExchangeId;
  at(time: number, cb: () => void): TimerHandle;
  after(ms: number, cb: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}
```

- **每腿以自己交易所的時鐘判定資格**（T = 該交易所時間的整點）。決策截止時間各腿分別換算、加上該腿誤差，取保守值（T 之前的截止取最早、T 之後取最晚）；與配對是否包含參考交易所無關。
- **參考時間軸**（顯示、紀錄、重播）：`reference_clock_priority` 預設 `['Binance','Bybit','OKX']`；參考所斷線或校正過期時改用下一順位，事件記錄 `clock_reference`、`clock_offset_ms`。
- `RealClock`：`process.hrtime` 單調時鐘 + 每所 offset（查伺服器時間、取往返中點，`errorMs = RTT / 2`）；每 `clock_calibration_interval_ms`（60 s）校正一次，SHORTLIST 與 ARM 開始時強制校正。offset 跳動 > `clock_jump_threshold_ms`（100 ms）→ `CLOCK_OFFSET_JUMP`；任一交易腿 `errorMs > clock_max_error_ms`（500 ms）或校正過期 → Pre-Trade Risk 以 `CLOCK_UNRELIABLE` 阻擋新進場。
- `VirtualClock`：`advanceTo(t)` 依到期時間（同時到期依註冊順序）觸發，callback 內 `now()` 為該 callback 的到期時間；Paper 與 Backtest 共用同一套邏輯。
- 資料年齡：`data_age_ms = local_received − toLocal(ex, exchange_timestamp)`。
- `runtime/src/` 內除 `RealClock` 外禁止直接呼叫 `Date.now()` / `setTimeout` / `setInterval`（`runtime/test/architecture.test.ts` 把關）。

---

## 9. Scanner Runtime

Scanner **不負責下單**，它只產生 `Opportunity`：

```text
All Symbols
  ↓ Symbol Intersection
  ↓ Funding Spread Filter
  ↓ Liquidity Filter
  ↓ Orderbook Filter
  ↓ Cost Calculation
  ↓ Expected Net PnL
  ↓ Opportunity
```

📎 Symbol Intersection 必須以 Instrument Registry 配對（非字串去尾），缺資料 = 淘汰而非填預設值（Q-01、Q-03、HANDOFF P3）。排序使用**扣除成本後的淨 spread**（Q-06）。

---

## 10. Opportunity TTL

Opportunity 不能永久有效。✅ C-05（D-3）：以**失效規則**取代固定 TTL，任一條件成立即 `EXPIRED` 或 `REJECTED`（附原因）：

1. **換階段**：場次進入下一階段時，舊階段的評估結果作廢、須重新評估（SHORTLIST 的結果到 ARM 必須重算）。
2. **輸入變動超過容忍值**：任一腿費率變動 > `rate_change_tolerance`（預設 0.0002）、價差變動 > `price_change_tolerance_pct`（預設 0.1%）、盤口可成交量低於需求。
3. **資料過舊**：任一輸入的 `data_age_ms > data_stale_threshold_ms`。
4. **最長存活**：`now − detected_at > opportunity_max_age_ms`（安全上限，寫入 `expires_at`）。
5. **資格改變**：ARM 時重新讀取週期，任一腿 < 2h 或兩腿結算時間不再對齊 → `REJECTED`。

每筆 Opportunity 只屬於一個結算場次（規格書 §26.4）；ARM（T-60s）重新讀取的費率最接近最終值，是最後的進場決策點。

---

## 11. Pre-Flight

建立 Trade 前：`Opportunity → PreFlight`，檢查：

```text
✓ Account          ✓ Capital          ✓ Position Count    ✓ Position Limit
✓ Funding          ✓ Price            ✓ Orderbook         ✓ Slippage
✓ API Health       ✓ Data Freshness   ✓ Exchange Status   ✓ Existing Exposure
```

任何 Critical Fail → **BLOCK**，並寫入 `risk_checks` 與 `Opportunity.status = 'REJECTED'`（未交易也要可查）。

---

## 12. Capital Reservation

一旦 Trade 通過 Risk：

```text
Available Capital → Reserve Capital → Create Trade
```

**不能等到 Order 成交後才扣資金。**

```text
Capital:           10,000
Trade allocation:   1,000
Available:          9,000   ← 即使 Order 尚未成交，Reserved = 1,000
```

避免 Scanner 同時建立多筆 Trade 造成資金超額使用。保留與釋放必須是原子操作（同一 DB transaction）。

---

## 13. Order Simulation Model

```text
輸入：Order + Current Order Book + Market State
輸出：Fill / Partial Fill / Reject / Timeout
```

---

## 14. Market Order Simulation

Market BUY 從 **ASK** 開始吃單（SELL 從 BID）：

```text
Ask
100.00 × 100
100.01 × 200
100.03 × 300

Quantity = 250
→ 100 × 100.00
→ 150 × 100.01
→ Average Fill Price = (100×100.00 + 150×100.01) / 250 = 100.006
```

**不是 `Fill Price = Best Ask`。這是 Paper Trading 必須具備的核心。**

---

## 15. Partial Fill Simulation

```text
Available: 300
Requested: 1000
→ Filled: 300, Remaining: 700
→ Order: PARTIALLY_FILLED
```

接著依 Execution Policy：Wait / Retry / Cancel / Reprice / Emergency Hedge。

---

## 16. Order Timeout

每個 Order 必須有 `max_order_lifetime_ms`（例：500ms）。500ms 沒有到達終態 → 發出 `ORDER_TIMEOUT` **事件**（記 `timeout_reason`）→ Cancel（狀態進 `CANCEL_REQUESTED`）或 Reprice，由 Execution Policy 決定。

✅ C-14：TIMEOUT 是事件，不是狀態。另有 `ack_timeout_ms`（SUBMITTED 未收到 ACK）→ `ORDER_ACK_TIMEOUT` 事件 → 查詢訂單實際狀態。撤單失敗 → `ORDER_CANCEL_REJECTED` 事件，狀態回到撤單前（規格書 §9）。

---

## 17. Two-Leg Execution

雙邊交易不能假設 `A fill = B fill`：

```text
A submitted, B submitted
A filled, B partial
A = 1000, B = 600
→ Hedge Ratio = 60%
→ 低於 hedge_ratio_imbalance_below（預設 0.90）→ LEG_IMBALANCE → Emergency（§19）

A = 1000, B = 950 → 95% → PARTIALLY_HEDGED → 對 B 重送剩餘量，最多 partial_hedge_max_duration_ms
```

✅ C-12：兩條門檻的設定方式、理由與調整方法見規格書 §14.1–14.3。

---

## 18. Execution Policy

第一版建議：

```text
ENTRY
1. Submit both legs
2. Monitor ACK
3. Monitor Fill
4. Calculate Hedge Ratio
5. hedge_ratio < imbalance_below  → LEG_IMBALANCE:
       Cancel remaining orders → Emergency close filled leg(s)
6. imbalance_below ≤ ratio < hedged_min → PARTIALLY_HEDGED:
       Resubmit remaining qty on lagging leg
       Timer partial_hedge_max_duration_ms → 超時視同 LEG_IMBALANCE
7. ratio ≥ hedged_min → HEDGED
```

---

## 19. Emergency Close

```text
Long:  1000 filled
Short: 0 filled
Timeout
→ Cancel Short
→ Close Long
```

Paper Engine 必須產生 `EMERGENCY_EXIT`，**而不是假設交易失敗所以直接刪除 Trade**。Close Long 是一張新的 close order（Cancel ≠ Close，Invariant #6）。

---

## 20. Position Engine

Position 必須由 Fill 推導：

```text
錯誤：Order → directly create Position
正確：Order → Fill → Position
```

```text
100 BTC contracts filled
→ quantity = 100
→ average_entry = weighted_average(fill_prices)
```

---

## 21. Position Accounting

```text
new_position  = old_position + fill
average_price = Σ(fill_quantity × fill_price) / Σ(fill_quantity)
```

---

## 22. PnL Engine

```text
Long  PnL = (exit_price − entry_price) × quantity
Short PnL = (entry_price − exit_price) × quantity
```

`entry_price` / `exit_price` 使用**實際平均成交價**（已含滑價）。

```text
Net PnL = Funding PnL + Price PnL − Fees − Other Costs
```

✅ C-13：**不得再扣 Slippage**（Q-05 重複扣除）。Slippage 另外計算為 `slippage_attribution_usdt`（僅歸因），UI 須依規格書 §20.1 提示。Unit test 必須包含「滑價不被重複扣除」的案例。

---

## 23. Funding Engine

📎 各交易所資金費率機制官方文件（結算時間偏差、費率計算方式）：[`REFERENCES.md`](REFERENCES.md)。

Funding Engine 必須獨立。

```text
輸入：Position + Funding Rate + Funding Time + Exchange Rule
輸出：FundingSettlement
```

```text
Funding Event → Check Position → Check Eligibility → Calculate Funding
             → Settlement → Update Balance → Write Event
```

📎 金額 = 結算時 `mark price × 持倉數量 × 已結算費率`（Q-04、Q-07）；Exchange Rule（結算偏差、持倉判定時點）由 Adapter 提供（規格書 §19.1）。

### 23.1 入帳推定（✅ C-05 / D-6，`runtime/src/funding/`）

- 不依賴私有帳戶資料：以公開端點出現 `fundingTime == T` 的**已結算費率**推定入帳（Binance `fundingRate`、Bybit `funding/history`）。
- mark price：Binance 用已結算紀錄回傳的 `markPrice`（`mark_price_source = 'SETTLEMENT_RECORD'`）；Bybit 端點不含 mark price，用 MarketState 在 T 的快照（`'SNAPSHOT'`，快照缺失時金額標為估計值）。
- 執行閘門：`entry_deadline` 後不得送新進場單；`hedged_by` 時未達 HEDGED → `LEG_IMBALANCE`；`[hedged_by, lock_end]` 禁止減倉；`exit_at` 即平倉、不等確認。
- 狀態推進與損益定案見規格書 §18、§19.2；`settlement_confirm_timeout_ms`（預設 10 分鐘）後仍無已結算費率 → `MISSED`。

---

## 24. Fee Engine

Fee 必須根據 Exchange、Account Tier、Maker/Taker、Notional 計算。

**不要在 Strategy 裡寫死 `0.05%`**；Strategy 只能取得 `estimated_fee`。

📎 取代 HANDOFF P9、Q-06；費率設定沿用 `schema.ts` `FeeTierConfig`。

---

## 25. Slippage Engine

| 階段 | 模型 |
|------|------|
| 第一版 | Orderbook Depth |
| 第二階段 | Historical Execution Data |
| 第三階段 | Exchange-specific empirical model |

```text
輸入：Exchange, Symbol, Side, Quantity, Orderbook
輸出：Expected Average Fill, Expected Slippage
```

---

## 26. Event Sourcing

交易事件全部保存：

```text
OPPORTUNITY_DETECTED     OPPORTUNITY_QUALIFIED    OPPORTUNITY_SELECTED
OPPORTUNITY_REJECTED     OPPORTUNITY_EXPIRED
TRADE_CREATED            TRADE_STATUS_CHANGED
RISK_CHECK_STARTED       RISK_CHECK_PASSED        RISK_CHECK_FAILED
ORDER_CREATED            ORDER_SUBMITTED          ORDER_ACK
ORDER_ACK_TIMEOUT        ORDER_PARTIAL_FILL       ORDER_FILL
ORDER_TIMEOUT            ORDER_CANCEL_REQUESTED   ORDER_CANCELED
ORDER_CANCEL_REJECTED    ORDER_REJECTED           ORDER_EXPIRED
HEDGE_RATIO_CHANGED      LEG_IMBALANCE_DETECTED   EMERGENCY_EXIT_STARTED
POSITION_OPENED          FUNDING_SETTLED          EXIT_STARTED
POSITION_CLOSED          TRADE_COMPLETED
RECONCILIATION_ERROR     STALE_MARKET_DATA        EXCHANGE_DISCONNECTED
KILL_SWITCH_*（待 C-16）
```

擴充碼（✅ 2026-10-01 決議；程式單一來源 `runtime/src/types/event.ts` `TRADING_EVENT_TYPES`，中文定義見 `glossary.ts`）：

```text
# 狀態轉換 / 資金（trading-schema）
LEG_STATUS_CHANGED       FUNDING_STATUS_CHANGED
CAPITAL_RESERVED         CAPITAL_RELEASED
ENTRY_HALT_REQUESTED     ENTRY_HALT_CLEARED
RUNTIME_STARTUP_STEP     RUNTIME_ARMED            RUNTIME_DISARMED
# 時鐘 / 結算場次（paper-trading-event-loop）
SESSION_PHASE_CHANGED    CLOCK_REFERENCE_CHANGED  CLOCK_OFFSET_JUMP
# 合約註冊表（instrument-registry）
INSTRUMENT_LISTED        INSTRUMENT_STATUS_CHANGED       INSTRUMENT_SPEC_CHANGED
FUNDING_SCHEDULE_CHANGED INSTRUMENT_AMBIGUOUS            INSTRUMENT_UNKNOWN_VALUE
INSTRUMENT_SOURCE_STATUS_CHANGED
```

新增事件碼時必須同時加入 `TRADING_EVENT_TYPES` 與 `glossary.ts`（`glossary.test.ts` 檢查完整性）。

✅ C-11 / 規格書 §25：**每一次狀態轉換都必須有對應事件**；`TRADE_STATUS_CHANGED` 的 payload 含 `from`、`to`、`reason`。

這些事件**不要只寫成 Log**，應該是 **可查詢的正式交易資料**。

---

## 27. Event Schema

```typescript
interface TradingEvent {
    event_id: string;
    event_type: TradingEventType;
    timestamp: number;
    trade_id: string | null;            // 市場層 / 場次 / 時鐘 / 註冊表事件為 null（NO_TRADE_EVENT_TYPES）
    leg_id?: string;
    order_id?: string;
    position_id?: string;
    opportunity_id?: string;
    session_id?: string;                // 結算場次（規格書 §26.4）
    exchange?: ExchangeId;
    symbol?: string;
    payload: Record<string, unknown>;   // 不得包含任何 API 憑證（Invariant #2）
    recorded_at: number;                // 寫入時間（≠ timestamp 事件時間，規格書 §25）
    clock_offset_ms?: number;           // 當下本機與交易所的時鐘偏差
    clock_reference?: ExchangeId;       // 當下的參考時間軸交易所（§8.1）
}
```

### 27.1 術語表（✅ C-15）

所有狀態 / 事件代碼的**英文代碼、中文名稱、一句話定義**集中在 `runtime/src/types/glossary.ts`（單一來源），UI 的 `?` 提示與文件都從這裡取：

```typescript
interface GlossaryEntry {
    code: string;          // 'PARTIALLY_HEDGED'
    zh: string;            // '部分對沖'
    definition_zh: string; // '兩腿都有成交，hedge ratio 介於兩門檻之間，正在補足'
    category: 'OPPORTUNITY' | 'TRADE' | 'LEG' | 'ORDER' | 'FUNDING' | 'EVENT' | 'SESSION' | 'HEALTH';  // SESSION / HEALTH：2026-10-01 決議加入
}
```

UI 規則：平常只顯示英文代碼；點 `?` 顯示中文名稱與定義。內容以規格書 §9、§18、§26 的表格為準。

---

## 28. Database

第一版使用 **SQLite**：Local、Easy backup、Transaction support、適合 Paper Trading、不需要先架大型 Database。

未來大量 Market Data 再拆：TimescaleDB / ClickHouse / Parquet。

---

## 29. 建議資料表

```text
market_events           funding_rates
opportunities
trades                  trade_legs
orders                  fills
positions               funding_settlements
risk_checks
trading_events
account_snapshots       pnl_snapshots
```

---

## 30. Trade Database Relationship

```text
trades
  ├── trade_legs
  │      └── orders
  │             └── fills
  ├── funding_settlements
  ├── risk_checks
  └── trading_events
```

---

## 31. Reconciliation

Paper Trading Engine 必須定期自行驗證 **Orders vs Fills vs Positions vs Capital**。

```text
Order says:    1000 filled
Position says: 900
→ RECONCILIATION_ERROR
```

**而不是默默繼續交易**（應同時觸發 STOP ENTRY）。

---

## 32. Runtime Health

Dashboard 顯示：

```text
Engine:           RUNNING
Binance:          CONNECTED
Bybit:            CONNECTED
Market Data:      HEALTHY
Scanner:          RUNNING
Risk Engine:      ARMED
Paper Execution:  RUNNING
Database:         HEALTHY
Last Event:       15:32:01.120
```

---

## 33. Kill Switch

Kill Switch 第一階段 = **STOP NEW TRADES**，不要直接等於 CLOSE EVERYTHING。分三個動作：

| 動作 | 行為 |
|------|------|
| **STOP ENTRY** | 禁止建立新交易 |
| **CANCEL ORDERS** | 取消未成交掛單 |
| **EMERGENCY FLATTEN** | 平掉現有部位 |

三個動作分開。

> ⚠️ 待決 C-16：規格書 §23 描述為單一連鎖流程；需決定的 5 個子問題見規格書 §34 C-16。決議前不得實作。

---

## 34. Frontend Event Stream

前端可以接 WebSocket 顯示：

```text
15:31:02.100 [SCAN]     BTCUSDT opportunity
15:31:02.108 [RISK]     PASS
15:31:02.112 [ORDER]    Binance BUY
15:31:02.114 [ORDER]    Bybit SELL
15:31:02.130 [FILL]     Binance 100%
15:31:02.155 [FILL]     Bybit 100%
15:31:02.160 [POSITION] HEDGED
```

**但 Frontend 不得成為交易流程的 dependency。**

---

## 35. Logging Architecture

錯誤：

```text
Trading Engine
 ↓ await database.write()
 ↓ await websocket.broadcast()
 ↓ continue trading
```

正確：

```text
Trading Engine
      ├── Execution
      └── Event Queue
             ├── Database Writer
             ├── UI Broadcaster
             └── Analytics Writer
```

**交易核心不等待 UI。**

> 📎 例外：影響資金正確性的寫入（Capital Reservation、Position 變更）必須在交易核心內同步 commit，不能走非同步 queue（見 §12、§36 優先級 1–3）。

---

## 36. Performance Priority

```text
1. Risk correctness
2. Execution correctness
3. Position correctness
4. Data correctness
5. Traceability
6. Latency
7. UI
```

**UI 永遠不能排在 Execution 前面。**

---

## 37. Failure Injection

Paper Trading 必須能人工注入：

```text
API latency              Order rejection         Partial fill
No fill                  Cancel failure          Market spike
Funding change           Exchange disconnect     Stale data
Orderbook liquidity collapse
```

例：

```text
Bybit:
  ACK latency      = 350ms
  Fill probability = 60%
```

用來驗證系統是否真的能處理異常。隨機注入必須可設定 seed，確保可重現（對應 HANDOFF B8）。

---

## 38. Simulation Configuration

```typescript
interface PaperTradingConfig {
    initial_capital_usdt: number;
    max_positions: number;
    config_version: string;                  // 任何修改都產生新版本，寫入 Trade.config_version

    scan_exchanges: ExchangeId[];            // ✅ C-01：['Pionex','Binance','Bybit','Bitget','OKX']
    trading_exchanges: ExchangeId[];         // ✅ C-01：['Binance','Bybit']，未來加 'OKX'

    max_notional_per_leg_usdt: number;       // ✅ C-17：單腿
    max_leverage: number;
    max_slippage_pct: number;
    max_order_lifetime_ms: number;
    ack_timeout_ms: number;                  // ✅ C-14

    hedge_ratio_hedged_min: number;          // ✅ C-12：預設 0.99（規格書 §14.1 ①）
    hedge_ratio_imbalance_below: number;     // ✅ C-12：預設 0.90（規格書 §14.1 ②）
    partial_hedge_max_duration_ms: number;   // ✅ C-12：預設 5000（規格書 §14.1 ③）
    symbol_tier_overrides?: Record<string, Partial<PaperTradingConfig>>;  // 依波動度分級覆寫（§14.3）

    funding_alignment_tolerance_ms: number;  // ✅ C-10：預設 60000

    // ✅ C-05：結算場次時間表（規格書 §26.4）
    watch_lead_ms: number;                   // 預設 1_800_000（T-30m）
    shortlist_lead_ms: number;               // 預設 300_000（T-5m）
    arm_lead_ms: number;                     // 預設 60_000（T-60s）
    entry_open_lead_ms: number;              // 預設 45_000（T-45s）
    entry_buffer_ms: number;                 // 預設 5_000；entry_deadline = T − guard_before − partial_hedge_max_duration − entry_buffer
    exit_buffer_ms: number;                  // 預設 15_000（E-2）；exit_at = lock_end + exit_buffer
    min_funding_interval_hours: number;      // 預設 2（D-7）
    settlement_confirm_timeout_ms: number;   // 預設 600_000；逾時 → MISSED

    // ✅ C-05：Opportunity 失效（§10）
    rate_change_tolerance: number;           // 預設 0.0002
    price_change_tolerance_pct: number;      // 預設 0.001
    opportunity_max_age_ms: number;

    // ✅ C-05：時鐘（§8.1）
    reference_clock_priority: ExchangeId[];  // 預設 ['Binance','Bybit','OKX']
    clock_calibration_interval_ms: number;   // 預設 60_000
    clock_jump_threshold_ms: number;         // 預設 100
    clock_max_error_ms: number;              // 預設 500
    emergency_exit_timeout_ms: number;
    minimum_funding_spread_pct: number;
    minimum_expected_net_pnl_usdt: number;
    data_stale_threshold_ms: number;
    enable_partial_fill: boolean;
    enable_orderbook_slippage: boolean;
    enable_failure_injection: boolean;
}
```

---

## 39. Automated Runtime

```text
START
 ↓ Load Config
 ↓ Connect Exchanges
 ↓ Validate Market Data
 ↓ Load Account Snapshot
 ↓ Load Existing Paper Positions
 ↓ Start Market Data
 ↓ Start Scanner
 ↓ Start Risk Engine
 ↓ ARM Paper Execution
```

---

## 40. Main Loop（概念示意）

```text
while system_running:
    receive_market_data()
    update_market_state()
    update_funding()
    scanner.detect()

    for opportunity:
        if opportunity.expired:
            continue
        risk_result = risk.check(opportunity)
        if risk_result.fail:
            record_rejection()
            continue
        trade = trade_manager.create()
        execution_engine.execute(trade)
        position_manager.update()
        funding_engine.update()
        pnl_engine.update()
        telemetry.record()
```

**實際實作不應做成單一 blocking loop，而應拆成 event-driven services（§41）。**

---

## 41. Recommended Runtime Model

```text
Market Data Stream
        ▼
Market State
        ├──────────────→ Scanner
        └──────────────→ Position Monitor

Scanner → Opportunity Queue → Risk Engine → Execution Queue → Paper Execution

Execution Events → Position Engine → PnL Engine → Event Store
```

### 41.1 雙觸發來源 + 單一決策佇列（✅ C-05）

```text
  MarketState（行情事件，WS 推播）──┐
                                   ├──▶ Decision Actor（所有事件排入同一佇列，依序處理）
  Clock（時鐘事件，相對 T 排程）───┘        │
                                            ├─ SessionManager（結算場次）
                                            ├─ Opportunity 失效判斷
                                            ├─ Funding 入帳推定
                                            └─ Trade Manager / Risk / Execution
```

收益只在離散的 T 發生：行情決定「值不值得」，時鐘決定「能不能做」。會改變資金保留、場次、Trade 狀態的事件走同一佇列，消除競態；Node 單執行緒足夠。

### 41.2 兩層資料取得（✅ C-05 / D-5）

- **全市場層（WATCH）**：Binance 全市場推播；Bybit 批次 REST 每 N 秒；Pionex / Bitget / OKX 低頻 REST。
- **入圍層（SHORTLIST → CONFIRM）**：只對入圍幣種訂閱逐筆 ticker 與盤口深度。
- 理由：公開 API 無使用費，主要成本是限流 / IP 封鎖（BE-03 實測 429）、頻寬（Binance 全市場約 3–7 GB/天）、CPU（Bybit 全訂閱約 7,000 則/秒）與維護。實作屬 `websocket-data-layer`。

---

## 42. Testing Requirements

**Unit Test**：Funding calculation、Fee calculation、Slippage、PnL、Hedge Ratio、Position Average Price。

**Integration Test**：Binance Adapter、Bybit Adapter、Market Data、Scanner、Risk、Paper Execution。

**Scenario Test**（至少）：

| ID | 情境 |
|----|------|
| S01 | Normal Full Fill |
| S02 | Long Partial / Short Full |
| S03 | Long Full / Short Reject |
| S04 | Both Timeout |
| S05 | Cancel Success |
| S06 | Cancel Failure |
| S07 | Market Price Spike |
| S08 | Funding Rate Change |
| S09 | Stale Market Data |
| S10 | Exchange Disconnect |
| S11 | Kill Switch |
| S12 | Emergency Exit |
| S13 | Partial Hedge 補足成功（95% → ≥ 99%）與超時轉 LEG_IMBALANCE |
| S14 | Funding 不對齊 / 非 trading_exchanges 配對 → Opportunity REJECTED |

**時間戳測試**：每個 Scenario 結束後斷言「所有實體都有 `created_at` / `updated_at`、所有狀態轉換都有事件、事件時間單調不減」（規格書 §25）。

📎 測試框架：vitest（HANDOFF B0，尚未建立）。Scenario Test 使用錄製的市場資料 + 固定 seed 的 failure injection，不打真實 API。

---

## 43. Paper Trading Acceptance Test — 完整成功交易

```text
Opportunity Created
  ↓ Risk Passed
  ↓ 2 Orders Created
  ↓ 2 Orders Submitted
  ↓ 2 ACK
  ↓ 2 Fills
  ↓ Hedge = 100%
  ↓ Funding Settlement
  ↓ Exit Orders
  ↓ 2 Exit Fills
  ↓ Position = 0
  ↓ PnL Finalized
```

**Database 必須可以完整還原以上流程。**

---

## 44. No-Fill Acceptance Test

```text
Opportunity → Risk PASS → Order Submitted → ACK → No Fill → Timeout
→ Cancel → Cancel ACK → Trade ABORTED
```

結果：`PnL = 0`、`Filled = 0`、`Status = ABORTED`、`Reason = ENTRY_TIMEOUT`。

但 **Trade、Order、Event 全部保留**。

---

## 45. Leg Imbalance Acceptance Test

```text
Long: 1000U FILLED
Short: 0U
  ↓ HEDGE RATIO = 0%
  ↓ LEG_IMBALANCE
  ↓ Cancel Short
  ↓ Emergency Close Long
  ↓ Long Exit FILLED
  ↓ Trade: EMERGENCY_EXIT
```

必須保存：原始 Entry、Emergency Exit、Price、Slippage、Fees、Duration、Loss。

---

## 46. Backtest Compatibility

Paper Execution Engine 必須設計成 `ExecutionInterface`：

```typescript
interface ExecutionEngine {
    submit(order: OrderRequest): Promise<Order>;
    cancel(orderId: string): Promise<Order>;
    getOrder(orderId: string): Promise<Order>;
}
```

Paper：`PaperExecutionEngine`；未來：`LiveExecutionEngine`。**Strategy 不知道自己是哪一種。**

---

## 47. Future Live Trading Gate

Paper Trading 通過後，**不直接開 Live**：

```text
Paper
 ↓ Backtest
 ↓ Paper vs Backtest Comparison
 ↓ Failure Analysis
 ↓ Execution Quality Analysis
 ↓ Risk Validation
 ↓ Small Capital Live
```

Live Execution Adapter 必須另外建立，且需使用者明確批准（HANDOFF Invariant #1）。

✅ C-04：對應規格書 §1.1 階段 ③ → ④ → ⑤。

---

## 48. 最重要的工程原則

### 48.1 不允許「成功交易優先」

系統不能只展示 Successful Trades，必須展示：Success、Failure、Timeout、Reject、Partial Fill、Cancel、Emergency Exit。

### 48.2 不允許「只有最後結果」

不能只保存 `PnL = +12.3 USDT`，必須可以知道：

```text
為什麼交易 → 什麼時間下單 → API 是否 ACK → 多少成交 → 成交價格
→ 花多久 → Funding 是多少 → Slippage 是多少 → 最後為什麼獲利 / 虧損
```

### 48.3 不允許 UI 決定交易狀態

UI 是 **Observer / Controller**，不是 Source of Truth。Source of Truth = Trading Engine、Event Store、Position Engine。

### 48.4 不允許交易流程依賴 UI

即使 Browser Closed，Paper Trading Engine 仍然應該繼續運行（✅ C-06：獨立 Node process，§3）。

---

## 49. 最終 Paper Trading System

```text
使用者設定：
  Capital = 10,000 USDT
  Max Positions = 5
  Max Trade = 1,000 USDT
  Max Leverage = 3x
        ↓
按下「掃幣」
        ↓
Scanner 自動掃描
        ↓
發現 BTCUSDT，Funding Spread +0.XX%
        ↓
Cost Model：Fee / Slippage / Price Difference
        ↓
Expected Net PnL
        ↓
Risk Engine：PASS
        ↓
Paper Execution：Binance Long / Bybit Short
        ↓
自動監控：ACK / Fill / Partial Fill / Hedge Ratio
        ↓
Funding Event
        ↓
自動退出：`exit_at`（預設 T+30s）平倉，不等入帳（✅ C-05，規格書 §19.2）
        ↓
PnL
        ↓
完整 Trade Record
        ↓
前端顯示：
  「這筆交易為什麼做」
  「怎麼成交」
  「花多少時間」
  「哪裡產生成本」
  「最後賺 / 虧多少」
  「如果失敗，失敗在哪裡」
```

這才是本專案第一個真正可交付的 **Automated Paper Trading Robot**。

---

## 50. 架構轉向摘要

現有 repo 已有不少「研究 / 回測 / dry-run」能力，**不建議再繼續把 `ExecutionSimulator` / `dryRunEngine` 往裡面塞功能**。下一個工程階段正式把：

```text
Research Prototype
        ↓
Paper Trading Runtime
```

分開。資料模型從：

```text
FundingEvent → TradeResult
```

升級成：

```text
Opportunity → Trade → TradeLeg → Order → Fill → Position → FundingSettlement → TradeResult
```

之後的 **回測 vs 模擬倉比較、成交品質分析、失敗原因分析、Replay、Live Trading**，全部建立在這個階層上。repo 既有的 `OrderState`、`PositionState`、`OrderLatencyMetrics`、`FunnelCandidate`、`RiskStatusReport`、`TimelineMilestone` 等概念會被沿用或升級，不是推翻重做。

### 50.1 開工順序（✅ C-09）

依序進行；每一項是一個（或多個）OpenSpec change，在各自的 `feature-*` 分支開發（§51）。

| 順序 | 項目 | 為什麼 Paper Trading 需要它 | 對應 |
|------|------|---------------------------|------|
| 1 | 測試框架 vitest + 現有行為特性測試 | 所有公式 / 狀態機需 fail-then-pass 證據；遷移時鎖住行為（C-11） | HANDOFF B0、P13 |
| 2 | Instrument Registry | 否則配對到錯的合約、結算時間不對齊 | issue 方向 ①、Q-01～Q-03 |
| 3 | 淨值口徑成本模型 | 否則 Expected Net PnL 系統性偏差 | issue 方向 ③、Q-04～Q-07 |
| 4 | WebSocket 資料層 + 時鐘同步 | stale data 防護、盤口深度滑價 | issue 方向 ②、BE-04、BE-07 |
| 5 | Paper Runtime（Schema → Execution → Position/Funding/PnL → Risk） | 本技術書主體；C-05 已決議（時鐘 / 場次 / 入帳規則已實作於 `runtime/src/`），C-16 決議後才做 Kill Switch | 規格書全文 |

---

## 51. 開發流程：OpenSpec + 分支 + Rollback

### 51.1 OpenSpec

- 本 repo 已 `openspec init`（`openspec/`）。任何新功能 / 需求變更 / 重構：需求模糊 → `/opsx:explore`；需求明確 → `/opsx:propose <name>` → 使用者確認 proposal → `/opsx:apply` → 驗證 → `/opsx:archive`。
- 實作前跑 `openspec validate`。
- 一個 change 的 tasks 超過約 12 項 → 拆成兩個 proposal。
- 本文件與規格書是 proposal 的上位依據；proposal 與本文件衝突時先回報，不得自行決定。

### 51.2 分支模型（✅ C-03）

```text
main ─────●────────────────────────●──────────►   永遠可運作；只接受來自 develop 的 merge；每次 merge 打 tag
           \                      ↗ (release, --no-ff, tag vX.Y.Z)
develop     ●────●────────●──────●────────────►   整合分支；來自 main
                  \      ↗ \    ↗
feature-*          ●──●─●    ●─●                  一個 OpenSpec change 一條；來自 develop，完成後 merge 回 develop
```

| 分支 | 來源 | 合併到 | 規則 |
|------|------|-------|------|
| `main` | — | — | 必須隨時可 `npm install --legacy-peer-deps && npm run dev` 正常運作；不直接 commit |
| `develop` | `main` | `main` | 整合測試用；merge 到 `main` 前 lint / build / test 必須全綠並實際啟動驗證 |
| `feature-<change-name>` | `develop` | `develop` | 名稱對應 OpenSpec change（例：`feature-instrument-registry`）；merge 前 rebase 到最新 `develop` |
| `hotfix-<name>` | `main` | `main` + `develop` | 只用於 `main` 壞掉的緊急修正 |

**合併門檻**（feature → develop、develop → main 都適用）：

1. `npm run lint`、`npm run build`、`npm test` 全過
2. 對應 OpenSpec change 的 tasks 全部勾選、`openspec validate` 通過
3. 使用 `--no-ff` merge（保留一個可整體 revert 的 merge commit）
4. develop → main：另需實際啟動 `npm run dev` 並打一次 `/api/market/live-scan`（HANDOFF §5）

### 51.3 Rollback 機制

| 情境 | 做法 |
|------|------|
| 某個 feature merge 進 `develop` 後出問題 | `git revert -m 1 <merge-commit>`（不改寫歷史） |
| `main` 的某次 release 出問題 | `git revert -m 1 <release-merge-commit>` 後重新打 tag；或從上一個 tag 開 `hotfix-*` |
| 需要回到已知可用版本 | `git checkout vX.Y.Z`（每次 merge 到 `main` 都有 tag） |
| Runtime 資料（SQLite） | Runtime 啟動前自動備份 DB 檔（`data/backup/<timestamp>.sqlite`）；schema migration 必須可逆（up / down） |

**禁止**：對 `main`、`develop` 使用 `push --force`、`reset --hard` 改寫已推送的歷史。建議在 GitHub 對 `main`、`develop` 開啟 branch protection。

---

## 52. 憑證與環境變數（✅ C-08）

| 項目 | 規則 |
|------|------|
| 檔案 | 真實值放 `.env.local`（被 `.gitignore` 的 `.env*` 排除，**不得提交**）；`.env.example` 只放空值範本 |
| 讀取位置 | 只有 Runtime（Node）讀取；不得進入前端 bundle、瀏覽器、Schema、`TradingEvent.payload`、log、錯誤訊息、匯出檔 |
| 權限 | Read ✅、Trading ❌、Withdraw ❌；建議 IP 白名單 |
| 缺少 key | Runtime 以「僅公開資料」模式啟動並在 Runtime Health 顯示 `CREDENTIALS: MISSING`，使用預設手續費並標示為估計值 |
| 驗證 | 啟動時呼叫唯讀端點確認權限；若偵測到 key 具備 Withdraw 權限 → 拒絕啟動 |

變數名稱（見 `.env.example`）：`BINANCE_API_KEY`、`BINANCE_API_SECRET`、`BYBIT_API_KEY`、`BYBIT_API_SECRET`、`OKX_API_KEY`、`OKX_API_SECRET`、`OKX_PASSPHRASE`（未來）。
