> 前置：`setup-vitest`、`trading-schema-types`、`trading-event-store`、`paper-trading-event-loop`（`Clock`、`funding-settlement-rules` 守門介面）已完成；`market-data-stream`、`instrument-registry`、`cost-model`、`position-accounting` 以 fake 替代。分支 `feature-paper-execution-engine`（來自 `develop`）。
> 每項先寫失敗測試再實作（fail-then-pass 證據貼 PR）；全部使用 `VirtualClock` 與固定 seed，不打任何 API；每項結束 lint / build / test 全綠。

## 1. 介面

- [ ] 1.1 `executionInterface.ts`（`ExecutionEngine`、`OrderRequest`、ports）＋ `runtime/test/fakes/` ＋ `executionEngine.contract.ts` 契約測試；原始碼檢查：trading/strategy 不 import `paperExecution`、無真實下單端點、execution/trading 無交易所名稱字串

## 2. PaperExecutionAdapter

- [ ] 2.1 Order 狀態機與時間戳：`CREATED → SUBMITTED → ACKNOWLEDGED → …`，每次轉換經 `Ledger.applyOrderTransition` 寫入並產生對應事件；`REJECTED` 原因
- [ ] 2.2 `matching.ts` 逐檔吃單（技術書 §14 均價 100.006、SELL 吃 BID）、每價位一筆 Fill、手續費、滑價正負號、step size 檢查；`applyFill` 同步寫入
- [ ] 2.3 部分成交與剩餘量：GTC 於盤口更新重撮、IOC `EXPIRED`、LIMIT 限價、`enable_partial_fill = false`
- [ ] 2.4 `max_order_lifetime_ms`（規格書 §12 時間線）與 `ack_timeout_ms`（晚到 ACK、訂單遺失）
- [ ] 2.5 撤單：成功（保留部分成交）、失敗回到原狀態 + `ORDER_CANCEL_REJECTED`、撤單前已全部成交、終態不可撤；reduce-only 驗證與 `REDUCE_ONLY_EXCEEDS_POSITION`；Cancel ≠ Close 測試
- [ ] 2.6 模擬延遲與故障注入（`rng.ts`、`failureInjection.ts`：reject、fill probability、ack loss、cancel failure、disconnect、stale、liquidity collapse、price spike）；同 seed 事件序列完全相同、異 seed 不同

## 3. 雙腿執行

- [ ] 3.1 接上 `position-accounting` 的 hedge ratio / `classifyHedge`（未合併前以 fake 實作同一介面）：`hedge_ratio_basis` 切換、`symbol_tier_overrides`、`HEDGE_RATIO_CHANGED` 記錄兩種比率（規格書 §13 例子、基準切換例子）
- [ ] 3.2 `entryCoordinator.ts`：`PRE_FLIGHT → ENTRY_PENDING`、分類時機、`ABORTED`（ENTRY_TIMEOUT / ENTRY_REJECTED）與資金釋放、`PARTIALLY_HEDGED` 重送與計時、`canSubmitEntry` 拒絕、`forceLegImbalance`、Leg 狀態事件
- [ ] 3.3 Emergency Close（撤單 → 重試 → reduce-only `EMERGENCY_CLOSE` → `CLOSED`/`EMERGENCY_EXIT` 或 `FAILED`/`EMERGENCY_EXIT_TIMEOUT`）與 `exitCoordinator.ts` 正常平倉（`canSubmitExit` 拒絕 `LOCK_WINDOW`、`NORMAL_EXIT`、`EXIT_TIMEOUT`）

## 4. Scenario 與收尾

- [ ] 4.1 `runtime/test/scenarios/`：S01、S02、S03、S04、S05、S06、S07、S10、S12、S13，每個結尾 `assertTraceability`
- [ ] 4.2 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate paper-execution-engine --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄（註明 hedge_ratio_basis 預設已依 C-19 決議改為 `QUANTITY`，兩種比率仍同時記錄供對照）
