## Context

- 技術書 §2：只有 Execution Adapter 與真實交易不同；§46：`ExecutionEngine` 讓 Strategy 不知道是 Paper 還是 Live。
- 狀態機 ✅ C-14（規格書 §9–§10）、hedge ratio 門檻 ✅ C-12（§14）、名目定義 ✅ C-17；hedge ratio 基準 ✅ C-19（2026-10-02 決議為 `QUANTITY`）。
- 上游契約：
  - `trading-schema`：`PaperOrder`、`Fill`、`Trade`、`TradeLeg`、轉換表、`transitionEventType`、`makeTransitionEvent`。
  - `event-store`：`Ledger.applyOrderTransition` / `applyFill` / `releaseCapital`（同步 commit），`EventQueue`（`HEDGE_RATIO_CHANGED` 等觀測事件），`assertTraceability`。
  - `trading-clock`：`Clock`（`now` / `at` / `after` / `cancel`）、`VirtualClock`。
  - `funding-settlement-rules`：`entry_deadline`、`hedged_by`、鎖定區間、`exit_at` 的守門與拒絕原因（`ENTRY_DEADLINE_PASSED`、`LOCK_WINDOW`、`NOT_HEDGED_BEFORE_WINDOW`）——本 change 只呼叫。
  - `market-data-stream`：盤口快照（含 `local_received_timestamp` / 資料年齡）；`instrument-registry`：step size、合約乘數；`cost-model`：taker / maker 費率；`position-accounting`：腿的持倉數量、hedge ratio 與 `classifyHedge`。

## Goals / Non-Goals

**Goals:** 可替換的執行介面；貼近現實且可重現的 Paper 撮合；雙腿進場 / 緊急平倉 / 正常平倉的狀態推進；執行層 Scenario Test。

**Non-Goals:** Live adapter、Kill Switch 本體（C-16 已決議三層分級，實作屬 `risk-engine-kill-switch` group 4）、Position / PnL 計算、Risk 判斷、時間窗口規則定義。

## Decisions

### 1. 介面與 Port

```typescript
interface ExecutionEngine {
  submit(req: OrderRequest): Promise<PaperOrder>;
  cancel(orderId: string): Promise<PaperOrder>;
  getOrder(orderId: string): Promise<PaperOrder>;
  onOrderUpdate(l: (order: PaperOrder, fills: Fill[]) => void): () => void;   // §46 補充
}

// 由其他 capability 提供，本 change 以 fake 測試
interface OrderBookSource   { getOrderBook(ex: ExchangeId, symbol: string): OrderBookSnapshot | undefined; onUpdate(...): () => void; }   // market-data-stream
interface InstrumentSource  { getInstrument(ex, symbol): { step_size: number; contract_multiplier: number } }                              // instrument-registry
interface FeeRateSource     { getTakerFeeRate(ex, symbol): number; getMakerFeeRate(ex, symbol): number }                                // cost-model
interface PositionReader    { getOpenQuantity(leg_id: string): number }                                                                 // position-accounting
interface FundingWindowGuard {                                                                                                          // funding-settlement-rules
  canSubmitEntry(trade_id: string, now: number): GuardResult;
  canSubmitExit(trade_id: string, purpose: 'EXIT' | 'EMERGENCY_CLOSE', now: number): GuardResult;
}
type GuardResult = { allowed: true } | { allowed: false; reason: string };
```

- `onOrderUpdate` 是對技術書 §46 的補充：非同步成交需要推送，否則 coordinator 只能輪詢 `getOrder`。Live adapter 可用 user-data stream 實作同一介面。
- `submit` 回傳時訂單已是 `SUBMITTED`（`CREATED → SUBMITTED` 同步完成），後續 ACK / fill 由 Clock 排程推進。
- **替代方案**：coordinator 直接用 EventQueue 監聽 → 事件佇列是觀測通道（非同步、可延遲），不應成為交易邏輯依賴（技術書 §35），否決。

### 2. 撮合模型

- 撮合時機：ACK 後經 `fill_ms` 以**當下**盤口快照撮合；GTC 剩餘量在每次 `OrderBookSource.onUpdate` 重新撮合（加上 `fill_ms` 延遲）。
- 每個被吃的價位一筆 Fill（符合規格書 §11「一張 Order 多筆 Fill」並讓 Fill 價格可追溯）。
- 簡化：Paper 撮合不從盤口扣除自己吃掉的量（下一次快照以交易所實際資料為準）；同一次撮合內不重複吃同一價位。
- `liquidity = 'TAKER'`（MARKET 以 taker 費率計費）；`'SIMULATED'` 的用途列 Open Question。
- LIMIT：只做「可成交部分立即成交、剩餘量在後續快照穿價時成交」，不模擬排隊位置（Non-goal）。

### 3. 故障注入與可重現性

- PRNG：自寫 `mulberry32`（無依賴）；`stream(client_order_id) = mulberry32(hash32(seed, client_order_id))`，每張單有獨立亂數流，事件交錯順序不影響結果。
- 每張單固定順序取亂數：`reject → ack_loss → ack_latency_jitter → 每次撮合 fill_probability / fill_ratio → cancel_failure`，確保同 seed 可重現。
- 設定以交易所 ID 為 key 的**資料**（`failure_injection['Bybit'] = {...}`），程式不出現交易所名稱字串（Invariant #3，以原始碼掃描測試把關）。
- 可注入項目對照技術書 §37：API latency（`ack_latency_ms`）、Order rejection、Partial fill（`max_fill_ratio`）、No fill（`fill_probability = 0`）、Cancel failure、Market spike（`price_shift_pct`）、Exchange disconnect（`disconnect_windows`）、Stale data（盤口年齡）、Orderbook liquidity collapse（`liquidity_multiplier`）。Funding change 屬 market-data / event-loop，不在執行層。

### 4. Execution Policy（技術書 §18）

- `ORDER_TIMEOUT`（ENTRY / EXIT）→ 立即撤單；EXIT 撤單成功後以剩餘量重送。
- 分類時機：所有腿的進場單皆達終態、或任一腿以 0 成交終結（先撤另一腿掛單）時分類；在此之前只發 `HEDGE_RATIO_CHANGED`（避免「A 先成交、B 還在路上」被誤判 0% → LEG_IMBALANCE）。`hedged_by` 由 `funding-settlement-rules` 呼叫 `forceLegImbalance` 兜底。
- `PARTIALLY_HEDGED`：以落後量（依目前基準換算為數量，向下取整到 step size）重送 ENTRY 單；重送前檢查 `canSubmitEntry`。
- 單腿 REJECTED 不重試（v1），直接走分類；是否重試列 Open Question。

### 5. hedge ratio 基準可切換（✅ C-19 2026-10-02 已決議為 `QUANTITY`）

- 公式與分類只有一份實作：`position-accounting`（position-funding-pnl）的 hedge ratio 與 `classifyHedge`，本 change 只呼叫並執行門檻對應的行為（補單、計時、緊急平倉）。**替代方案** 執行層自算 → 兩份公式口徑可能分裂，否決。
- 設定 `hedge_ratio_basis: 'NOTIONAL' | 'QUANTITY'`（與 position-accounting 共用同一欄位），**預設改為 `QUANTITY`**（C-19 決議：合約乘數換算後的基礎資產數量）。
- 每筆 `HEDGE_RATIO_CHANGED` 仍同時記錄兩種基準的值（`payload.notional_ratio`、`payload.quantity_ratio`），供事後對照。

### 6. Trade / Leg 狀態推進與資金

- Coordinator 以 `makeTransitionEvent` 產生事件，經 `Ledger` 同步寫入（Trade、Leg 狀態屬帳本類，`trading-event-store` Decision 4）。
- 進入 `ABORTED`、`CLOSED` 時同一 transaction 呼叫 `Ledger.releaseCapital`；`FAILED` **不**自動釋放（需人工確認部位，資金保持保留，避免在未知部位下再開新倉）。
- TradeResult、realized PnL 由 `pnl-engine` 訂閱終態事件產生；本 change 不寫 TradeResult。

### 7. 檔案

```
runtime/src/execution/executionInterface.ts   ExecutionEngine、OrderRequest、ports
runtime/src/execution/paperExecution.ts       PaperExecutionAdapter（狀態機、排程）
runtime/src/execution/matching.ts             純函式：walkBook、slippage、fee
runtime/src/execution/failureInjection.ts     設定解析、disconnect / stale 判斷
runtime/src/execution/rng.ts                  mulberry32、hash32、stream
runtime/src/trading/entryCoordinator.ts       雙腿進場、PARTIALLY_HEDGED、forceLegImbalance、Emergency Close
runtime/src/trading/exitCoordinator.ts        正常平倉
runtime/test/fakes/                           FakeOrderBook、FakeGuard、FakeFeeRates、FakeInstruments、FakePositions
runtime/test/contracts/executionEngine.contract.ts
runtime/test/scenarios/S01…S13.test.ts
```

## Risks / Trade-offs

- [不扣除自己吃掉的盤口量，連續重撮可能高估成交] → 同一 order 的剩餘量只在**新快照**到達時重撮；日後可加「自身影響衰減」模型。
- [NOTIONAL 預設會讓價差大的配對卡在 PARTIALLY_HEDGED] → C-19 已決議改用 `QUANTITY`，此風險已排除；`NOTIONAL` 僅保留供對照，兩種比率仍都記錄。
- [故障注入使測試不穩定] → 一律固定 seed；決定性測試比對兩次執行的事件序列。
- [`FAILED` 不釋放資金可能讓可用資金偏低] → 刻意偏保守；人工處理流程屬 `risk-engine-kill-switch`（C-16 已決議三層分級，group 4 待實作）。
- [上游 port 尚未實作] → 全部以 fake 測試；介面形狀若與上游 change 不同，於整合時以 adapter 對接，不改本 capability 行為。

## Migration Plan

- 全部新增於 `runtime/`；不改研究原型與 `dryRunEngine.ts`。在 `feature-paper-execution-engine` 開發，`--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`。

## Implementation Notes (Task Group 1-2)

1. **`Ledger.createOrder`** (new method, `runtime/src/storage/ledger.ts`): spec
   "Order state machine per C-14" requires `ORDER_CREATED` to exist as an
   event and `CREATED → SUBMITTED` to commit atomically with order creation,
   but `ORDER_TRANSITIONS` has no `from` state for `CREATED` itself (only
   `CREATED: ['SUBMITTED']`), so `ORDER_CREATED` cannot come from
   `makeTransitionEvent`. Resolved by mirroring
   `reserveCapitalAndCreateTrade`'s existing pattern (two related events in
   one transaction): `createOrder(created, submitted, reason)` appends
   `ORDER_CREATED` directly (payload `{ after: created }`), then persists
   `submitted` and appends the `CREATED → SUBMITTED` transition event via the
   same `makeTransitionEvent` machinery `applyOrderTransition` uses. `created`
   is never written as its own row — only `submitted` is persisted, matching
   spec's "a persisted order is never left in `CREATED`". This does not
   change `ExecutionEngine`'s public surface.

2. **Fills arriving during `CANCEL_REQUESTED`**: spec says such fills "SHALL
   be recorded without leaving `CANCEL_REQUESTED` unless they complete the
   order", but `ORDER_TRANSITIONS.CANCEL_REQUESTED` has no self-loop (no
   `CANCEL_REQUESTED → CANCEL_REQUESTED` entry), so a non-completing fill
   cannot be committed as a transition event without actually changing
   `order_state`. Resolved conservatively: `PaperExecutionAdapter.runMatch`
   stays eligible to match while `CANCEL_REQUESTED` (so a fill that fully
   completes the order is applied immediately — `CANCEL_REQUESTED → FILLED`
   is a legal transition, exercised by the "filled before cancel arrives"
   scenario), but a fill that would only *partially* progress the order while
   a cancel is pending is deferred (not applied) until the cancel resolves —
   success keeps the order's `filled_quantity` as of cancel time and moves to
   `CANCELED`; failure reverts to `ACKNOWLEDGED`/`PARTIALLY_FILLED` and normal
   matching resumes from there on the next book update. No scenario in
   spec.md exercises the partial-non-completing-fill-during-cancel
   interleaving, so this is a documented simplification, not a spec
   violation. Does not change `ExecutionEngine`'s public surface.

3. **Deterministic `order_id`/`fill_id`**: spec's reproducibility scenario
   ("Same seed reproduces") compares "the two event logs (types, timestamps,
   payloads excluding `event_id`/`recorded_at`)" — payloads are compared, and
   `PaperOrder.order_id`/`Fill.fill_id` are embedded inside `payload.after`/
   `payload.fill`. A fresh `crypto.randomUUID()` per order/fill (real
   randomness, not seeded) would make every same-seed run differ on exactly
   those fields. Resolved by making order/fill identity deterministic:
   `order_id := client_order_id` (already caller-guaranteed-unique per order
   — no reason to mint a second id), `fill_id := `${order_id}:fill:${n}``
   (`n` = a per-order fill counter, itself deterministic since fills are
   applied in deterministic depth-walking order). `event_id` continues to use
   `crypto.randomUUID()` (explicitly excluded by the scenario). Does not
   change `ExecutionEngine`'s public surface (`OrderRequest.client_order_id`
   was already required).

## Open Questions

1. ~~**⚠️ C-19**：hedge ratio 以名目或數量計算？~~ ✅ 2026-10-02 已決議：`QUANTITY`（合約乘數換算後的基礎資產數量），`hedge_ratio_basis` 預設已改。
2. `Fill.liquidity` 的 `'SIMULATED'` 何時使用？本 change 對 MARKET 一律記 `'TAKER'`（費率依據）。
3. 單腿 `REJECTED` 是否應重試一次再走 LEG_IMBALANCE？v1 不重試。
4. `EXIT_PENDING` 超時卡住時，規格書 §26.2 沒有 `EXIT_PENDING → EMERGENCY_EXIT` 轉換；本 change 超過 `emergency_exit_timeout_ms` 轉 `FAILED`（`EXIT_TIMEOUT`）。是否應新增 `EXIT_PENDING → EMERGENCY_EXIT`？
5. `FAILED` Trade 的保留資金何時釋放——C-16 已決議三層分級，待 `risk-engine-kill-switch` group 4 落地後接上人工確認流程。
6. `ExecutionEngine.onOrderUpdate` 為技術書 §46 的補充，是否同意回寫技術書？
