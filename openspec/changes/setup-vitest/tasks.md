> 分支 `feature-setup-vitest`（來自 `develop`）。本 change 為技術書 §50.1 第 1 項，無前置 change。
> 規則：本 change 不修任何 bug；特性測試鎖住「現在的輸出」，已知 bug 的測試名稱須含 issue ID 與「現況」、註解寫修正後預期（design §5）。
> 特性測試無「改前失敗」可言，改以「先把某個期望值暫改錯 → 確認紅燈 → 還原 → 綠燈」證明測試有效；server 抽出則以「先寫測試（模組不存在，紅）→ 逐字搬移（綠）」取得 fail-then-pass 證據。每個 task 完成後 `npm run check` 必須全綠。

## 1. 測試框架

- [ ] 1.1 `npm install -D --legacy-peer-deps vitest @vitest/coverage-v8`（兩者同版本，預定 5.x，確認 peer 支援 vite 8）；新增 `vitest.config.ts`（node 環境、四個 include 樣式、排除 `node_modules`/`dist`、`passWithNoTests`、coverage v8 僅報告）與 `vitest.setup.ts`（`fetch` 替身拋錯）；`package.json` 新增 `test`、`test:watch`、`test:coverage`、`check` 四個 script
- [ ] 1.2 新增 `test/infrastructure.test.ts`：斷言 `fetch` 在測試中拋出「禁止網路」錯誤、`test.include` 含 `runtime/**/*.test.ts` 等四個樣式；確認 `npm test`、`npm run test:coverage`（產生 `coverage/index.html`、無門檻）、`npm run check` 行為符合 spec，並驗證測試檔型別錯誤會被 `npm run lint` 抓到

## 2. 既有模組特性測試（已匯出，無需抽出）

- [ ] 2.1 `src/engine/arbitrageEngine.test.ts`：`enrichKlineBar`、`estimateSlippageRate`（1 bp 下限、shock 夾限、midPrice = 0）、`simulateExecutionExperiment`（方向規則含費率相等、4 筆 taker 費、id / `funding_time_str`、`[Q-05]` 現況 `net_pnl ≈ −2.400000108`，註解修正後 ≈ −1.20）
- [ ] 2.2 `src/engine/funnelScanner.test.ts`：以 `Date.UTC(2026,0,1,7,30,0)` 鎖住排名、Level1 淘汰、Level2（DOGE、WIF）、Level3、PEPE 浮點殘差、1h/4h/8h 倒數 1800s（標註 `[Q-08]`、`[Q-06]`）
- [ ] 2.3 `src/engine/dryRunEngine.test.ts`：固定系統時間，鎖住正常與 `forceLegImbalance` 兩情境的 `position_state`、`cost_table`、`telemetry`、`risk_report` 狀態、`timeline` id/status 序列、`client_order_id`（標註 `[Q-08]` 單腿失敗仍計資金費、`[P7]` 延遲依交易所名稱）
- [ ] 2.4 `src/adapters/*.test.ts`（6 檔）：每個 mapping 函式一份完整 fixture + 一份缺欄位 fixture，以 `toEqual` 鎖住整筆輸出；固定系統時間處理 `Date.now()` fallback；標註 `[Q-02]` 下次結算 +8h 假設

## 3. server.ts 最小抽出

- [ ] 3.1 先寫 `server/liveScanMath.test.ts`（此時因模組不存在而紅燈，保留輸出為證據）：`extractBaseSymbol`（含 `[Q-01]` `USDT_BTC_PERP`、`[P6]` 倍數前綴、`1INCHUSDT`）、`findBestPair`（最大 spread / 多空 / `pair_spreads` 鍵、< 2 所回 `null`、全相等預設、`[Q-02][P1]` 跨週期直接相減）、`computeLiveScanNetPnl`（`[Q-05][P4]` 三級滑價與 100M 邊界、`[Q-06]` 固定 0.20%、門檻含等號）、`resolveSettlement`（`[Q-02][P2]` 取 min、無有效時間 +8h、週期取 min / 預設 8）
- [ ] 3.2 依 design §6 將四段邏輯逐字搬到 `server/liveScanMath.ts`（泛型交易所名稱、`now` 參數化），`server.ts` 改為 import 並移除原實作；3.1 轉綠；`git diff --color-moved=zebra` 確認僅搬移；實際 `npm run dev` 打一次 `/api/market/live-scan`，確認回應欄位集合不變並記錄結果

## 4. 收尾

- [ ] 4.1 README 本機執行段落補 `npm test`、`npm run check`、`npm run test:coverage` 說明與「測試不打真實 API」；HANDOFF §4.2 P13 標 ✅（附 commit）、§5 DoD 移除「測試框架尚未建立」字樣、§6 B0 標完成
- [ ] 4.2 執行 `npm run lint`、`npm run build`、`npm test`（即 `npm run check`）與 `openspec validate setup-vitest --strict` 全數通過並附輸出；更新 HANDOFF §7 交接紀錄（含 vitest 實際版本、live-scan 實測結果、Open Questions 的處理）
