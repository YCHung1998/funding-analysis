## Why

專案目前沒有任何測試框架與測試（HANDOFF P13 / Backlog B0），但 HANDOFF §5 DoD 與 Invariant 8 要求「改公式必附 fail-then-pass 測試」，規格書 §2.1 遷移規則 1 要求「先鎖行為再搬」，技術書 §51.2 的合併門檻要求 `npm test` 全綠。後續所有 change（`instrument-registry`、`net-cost-model`、`websocket-data-layer`、`paper-trading-event-loop` …）都會搬移或修正 `arbitrageEngine`、`server.ts` live-scan 計算、`funnelScanner`、`dryRunEngine` 與 `adapters/`，若沒有先鎖住「現在的輸出」，就無法證明搬移沒有改變行為、也無法證明修 bug 真的改對了。因此它是技術書 §50.1 開工順序第 1 項，必須最先完成。

分支：`feature-setup-vitest`（來自 `develop`）。

## What Changes

- **導入 vitest**：新增 `vitest`（與 `@vitest/coverage-v8`）為 devDependency；新增獨立的 `vitest.config.ts`（Node 環境、不載入 React / Tailwind plugin）與 `vitest.setup.ts`（測試中禁止真實網路請求）。
- **npm scripts**：`npm test`（`vitest run`，單次執行、非 watch）、`npm run test:watch`、`npm run test:coverage`（僅報告，不設門檻）、`npm run check`（本機 CI 等價：`lint` → `build` → `test`，任一失敗即停止）。
- **測試納入規則**：`src/**/*.test.ts`、`server/**/*.test.ts`、`runtime/**/*.test.ts`（技術書 §4「測試放在各模組旁」、§42 Scenario Test 放 `runtime/test/scenarios/`）、`test/**/*.test.ts`；`runtime/` 尚未存在時不報錯。
- **最小抽出（只搬、不改行為）**：`server.ts` 因 import 時會啟動 Express 與 Vite，無法直接測試。將 `extractBaseSymbol`、最佳配對 / spread 計算、Expected Net PnL（量能三級滑價 + 固定費）、結算時間 / 週期彙整四段邏輯原樣搬到 `server/liveScanMath.ts`，`server.ts` 改為 import；函式本體逐字不變，`/api/market/live-scan` 回傳格式不變。
- **特性測試（characterization tests）**：鎖住下列模組**目前的輸出（含已知 bug）**，測試名稱標註對應 issue ID，之後修 bug 的 change 必須同步修改該測試：
  - `src/engine/arbitrageEngine.ts`：`enrichKlineBar`、`estimateSlippageRate`、`simulateExecutionExperiment`（含 Q-05 滑價重複扣除：`net_pnl ≈ −2.40`，正確值應為 −1.20）
  - `server/liveScanMath.ts`：`extractBaseSymbol`（Q-01 / P6：`USDT_BTC_PERP → BTC`、`1000PEPEUSDT → PEPE`）、spread 與最佳配對（Q-02 / P1 不同週期直接相減）、Expected Net PnL（Q-05(b) / P4 量能三級常數、Q-06 固定 0.20% 費）、結算時間彙整（Q-02 / P2 取 min、缺值假設 8h）
  - `src/engine/funnelScanner.ts`：`runFunnelScan` 排名、各級淘汰與結算倒數（Q-08 寫死宇宙）
  - `src/engine/dryRunEngine.ts`：`executeDryRunSimulation` 正常與 `forceLegImbalance` 兩情境（Q-08 / P7：延遲依交易所名稱、單腿失敗仍計資金費）
  - `src/adapters/*.ts`：6 個 mapping 函式（Binance `next_funding_time = nextFundingTime + 8h` 屬 Q-02 / Invariant 4 違反的現況）
- **文件**：README 本機執行段落補 `npm test` / `npm run check`；HANDOFF §4.2 P13 標 ✅、§5 DoD 移除「測試框架尚未建立」字樣、§6 B0 標完成、§7 交接紀錄。

## Non-goals

- **不修任何 bug**：Q-01、Q-02、Q-05、Q-06、Q-08 等現有錯誤行為一律原樣鎖住；修正屬 `instrument-registry`、`net-cost-model` 等後續 change。
- 不重構 `server.ts` 結構、不改走 `adapters/`（B6）、不統一型別（P10）；抽出僅限上述四段純計算。
- 不建立 `runtime/` 目錄或其 tsconfig（屬 `paper-trading-event-loop` / `trading-schema-storage`），本 change 只預先把 `runtime/**/*.test.ts` 納入規則。
- 不寫 React 元件 / UI 測試、不引入 jsdom 或 Testing Library（需要時由 `paper-trading-ui` 擴充）。
- 不設 coverage 門檻、不接 GitHub Actions 等遠端 CI（只提供本機 `npm run check`）。
- 不修 `npm install` 需 `--legacy-peer-deps` 的依賴衝突（B1 / P15）。
- 不呼叫任何交易所 API（測試一律離線）、不下任何真實訂單。

## Capabilities

### New Capabilities

- `test-infrastructure`: vitest 設定與測試納入規則、npm 測試 / 本機 CI 指令、測試離線與決定性（固定時間）規範、coverage 報告、server.ts 純計算的最小抽出，以及對既有引擎 / adapter / live-scan 計算的特性測試基準（含已知 bug 的 issue 標註規則）。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability）

## Impact

- **新增檔案**：`vitest.config.ts`、`vitest.setup.ts`、`server/liveScanMath.ts`、各模組旁的 `*.test.ts`（`src/engine/`、`src/adapters/`、`server/`）、`test/infrastructure.test.ts`。
- **修改檔案**：`package.json`（devDependencies、scripts）、`package-lock.json`、`server.ts`（改為 import 抽出的函式，邏輯不變）、`README.md`、`assets/HANDOFF.md`。
- **依賴**：`vitest`、`@vitest/coverage-v8`（版本須與 vite 8 相容，見 design Open Questions）。
- **下游**：`instrument-registry`、`websocket-data-layer`、`net-cost-model`、`position-funding-pnl`、`trading-schema-storage`、`paper-execution-engine`、`runtime-health-reconciliation`、`risk-engine-kill-switch`、`paper-trading-ui`、`paper-trading-event-loop` 全部依賴本 change 提供的 `npm test`、納入規則與特性測試基準。
- **對應**：HANDOFF P13、B0、§3 Invariant 8、§5 DoD；規格書 §2.1（C-11 遷移規則 1、4）；技術書 §4、§42、§50.1 第 1 項、§51.2；issue Q-01、Q-02、Q-05、Q-06、Q-08（僅標註，不修正）。
