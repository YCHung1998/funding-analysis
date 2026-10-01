## Why

Paper Trading 的驗證價值在於「模擬現實世界會失敗的情況」（規格書 §0 #6）：盤口深度造成的滑價、部分成交、ACK 逾時、撤單失敗、單腿失衡與緊急平倉。現有 `dryRunEngine.ts` 是劇本式流程（延遲依交易所名稱三元式、唯一失敗情境是單腿 429，HANDOFF P7、P8），且已凍結（C-04）。需要一個與未來 Live 可互換的 `ExecutionEngine` 與 `PaperExecutionAdapter`，讓 Strategy / Risk / Position 不需修改就能從 Paper 換到 Live（技術書 §2、§46）。

分支：`feature-paper-execution-engine`（來自 `develop`）。

## What Changes

- `ExecutionEngine` 介面（`submit` / `cancel` / `getOrder` + `onOrderUpdate`，技術書 §46），Paper 與未來 Live 共用一套契約測試；Strategy 不知道實作種類。
- `PaperExecutionAdapter`：
  - Order 狀態機完全依 ✅ C-14（規格書 §9）：9 個狀態；`ORDER_TIMEOUT`、`ORDER_ACK_TIMEOUT`、`ORDER_CANCEL_REJECTED` 是事件；無 `CLOSED`。
  - 市價單逐檔吃單（BUY 吃 ASK、SELL 吃 BID；技術書 §14 例子均價 100.006）、每個價位一筆 Fill、手續費與滑價紀錄。
  - 部分成交與剩餘量重新撮合、`IOC` 剩餘量 `EXPIRED`、`LIMIT` 只吃不劣於限價的價位。
  - `max_order_lifetime_ms` 逾時、`ack_timeout_ms`、撤單成功 / 失敗 / 撤單前已全部成交。
  - reduce-only close order（Cancel ≠ Close，Invariant #6）。
  - 模擬延遲（ACK / fill / cancel）與**可設 seed、可重現**的故障注入（技術書 §37）。
- 雙腿執行（技術書 §17、§18；規格書 §13、§14）：hedge ratio 兩條門檻（`hedge_ratio_hedged_min` 0.99、`hedge_ratio_imbalance_below` 0.90、`partial_hedge_max_duration_ms` 5000，✅ C-12）、`PARTIALLY_HEDGED` 補足、`LEG_IMBALANCE` → Emergency Close（規格書 §15、技術書 §19）、正常平倉。
- hedge ratio 公式與分類沿用 `position-accounting`（不重複實作），計算基準以設定 `hedge_ratio_basis: 'NOTIONAL' | 'QUANTITY'` 切換，預設 `NOTIONAL`（規格書 §14「決議前先用 notional」）；**⚠️ C-19 待決，不在本 change 決定**。
- 所有時間經 `paper-trading-event-loop` 的 `Clock`；進場截止、`hedged_by`、鎖定區間、`exit_at` 由 `funding-settlement-rules` 決定，本 change 只呼叫其守門介面。
- Scenario Test：技術書 §42 中屬執行層的 S01–S07、S10、S12、S13。

## Non-goals

- 不建立任何真實交易所的下單 / 撤單端點或 `LiveExecutionEngine`（Invariant #1；階段 ⑤ 另立 change）。
- 不決定 C-19（hedge ratio 基準）、不實作 Kill Switch（C-16）。
- 不重新定義進場截止、鎖定區間、平倉時間（屬 `funding-settlement-rules`）或場次排程（`settlement-session`）。
- 不計算 Position 平均價、Funding、PnL、TradeResult（屬 `position-accounting`、`pnl-engine`）；不估算手續費率與預期滑價（屬 `cost-model`）。
- 不實作 Pre-Trade / Entry Risk 判斷（屬 `risk-engine`）；不實作 LIMIT 單的排隊位置模擬。
- 不修改 `dryRunEngine.ts`（凍結）。

## Capabilities

### New Capabilities

- `paper-execution`: `ExecutionEngine` 介面與契約、Paper 撮合與 Order 狀態機、逾時 / 撤單 / reduce-only、模擬延遲與可重現故障注入、hedge ratio（可切換基準）與門檻行為、雙腿進場協調、Emergency Close 與正常平倉。

### Modified Capabilities

（無）

## Impact

- **新增程式**：`runtime/src/execution/`（`executionInterface.ts`、`paperExecution.ts`、`matching.ts`、`failureInjection.ts`、`rng.ts`）、`runtime/src/trading/`（`entryCoordinator.ts`、`exitCoordinator.ts`）、`runtime/test/scenarios/`、`runtime/test/fakes/`（假盤口、假 guards、假 fee provider）。
- **依賴**：`setup-vitest`；`trading-schema-types`（型別、轉換表、`makeTransitionEvent`）；`trading-event-store`（`Ledger`、`EventQueue`、`assertTraceability`）；`paper-trading-event-loop`（`Clock` / `VirtualClock`、`funding-settlement-rules` 守門）；`websocket-data-layer`（`market-data-stream` 盤口介面，測試用假盤口）；`instrument-registry`（step size、合約乘數；測試用假資料）；`net-cost-model`（`cost-model` 手續費率）；`position-funding-pnl`（`position-accounting`：腿部位、hedge ratio、`classifyHedge`）。
- **設定**：`PaperTradingConfig`（技術書 §38）既有欄位 + 新增 `hedge_ratio_basis`、`execution_latency`、`failure_injection`、`market_order_time_in_force`、`cancel_retry_*`。
- **對應**：規格書 §9–§17、§24、§25、§31（Partial Fill / Failure / Emergency Exit）；技術書 §2、§5、§13–§19、§37、§38、§42–§46；✅ C-12、C-14、C-17；⚠️ C-19；Invariant #1、#3、#6；HANDOFF P7、P8、B8。
