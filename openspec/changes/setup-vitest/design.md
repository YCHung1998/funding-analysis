## Context

- 現況：`package.json` 沒有任何測試相關依賴或 script（HANDOFF P13）；`npm run lint` = `tsc --noEmit`（`tsconfig.json` 沒有 `include`，因此會型別檢查 repo 內所有 `.ts`，包含日後的測試檔與設定檔）；`npm run build` = `vite build`。Vite 為 8.3.x，TypeScript 為 ^7。
- 待測邏輯的可測性：
  | 對象 | 現況 | 可否直接測 |
  |------|------|-----------|
  | `src/engine/arbitrageEngine.ts` | 已匯出純函式，無時間 / 網路相依 | ✅ |
  | `src/engine/funnelScanner.ts` | `runFunnelScan(currentTime, notional)` 已可注入時間 | ✅ |
  | `src/engine/dryRunEngine.ts` | `executeDryRunSimulation` 已匯出，唯一不定因素是 `client_order_id` 內的 `Date.now()` | ✅（固定系統時間） |
  | `src/adapters/*.ts` | 6 個已匯出 mapping 函式，缺欄位時 fallback 到 `Date.now()` | ✅（固定系統時間） |
  | `server.ts` 的 `extractBaseSymbol`、配對 / spread、Expected Net PnL、結算時間彙整 | 未匯出；且 `server.ts` 被 import 時會執行 `dotenv.config()`、建立 Express、呼叫 `start()` 監聽 3000 port | ❌ 需抽出 |
- 限制：HANDOFF §3 Invariants（本 change 不涉及下單、憑證；抽出後不得把交易所分支帶入 engine 層——抽出的函式放在過渡期 server 層，不放 `src/engine/`）；規格書 §2.1 遷移規則 1「先鎖行為再搬」、規則 4「每步三綠」；技術書 §4「測試放在各模組旁」、§42 Scenario Test 放 `runtime/test/scenarios/` 且不打真實 API。
- 已知 bug 不在本 change 修正（Q-01、Q-02、Q-05、Q-06、Q-08），只以測試鎖住現況並標註。

## Goals / Non-Goals

**Goals:**

- 一個指令（`npm test`）跑完所有測試；一個指令（`npm run check`）完成本機三綠檢查。
- 為後續 change 預留 `runtime/**/*.test.ts` 的納入規則，讓它們不必再動 vitest 設定。
- 以最小、可逐字比對的抽出，讓 `server.ts` 的 live-scan 計算可被測試。
- 為所有「之後會被搬移或修正」的邏輯建立特性測試基準，已知 bug 以 issue ID 標註，讓修 bug 的 change 能提供 fail-then-pass 證據。

**Non-Goals:**

- 修 bug、重構 `server.ts`、改走 adapters（B6）、型別統一（P10）。
- UI / React 元件測試、jsdom、E2E。
- coverage 門檻、遠端 CI。
- 建立 `runtime/` 目錄與其 tsconfig。

## Decisions

### 1. 使用 vitest 5.x，獨立 `vitest.config.ts`，不共用 `vite.config.ts`

- `vitest@5` 的 peerDependencies 為 `vite: ^6.4.0 || ^7.0.0 || ^8.0.0`，與現有 vite 8.3 相容（2026-09-30 以 `npm view vitest peerDependencies` 查得 5.0.3）。`@vitest/coverage-v8` 版本必須與 `vitest` 完全一致。
- 設定檔以 `defineConfig` from `vitest/config` 撰寫，**不** `mergeConfig(viteConfig)`：
  ```ts
  // vitest.config.ts（示意）
  export default defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'runtime/**/*.test.ts', 'test/**/*.test.ts'],
      exclude: ['node_modules/**', 'dist/**'],
      setupFiles: ['./vitest.setup.ts'],
      globals: false,
      passWithNoTests: true,
      coverage: {
        provider: 'v8',
        include: ['src/engine/**', 'src/adapters/**', 'server/**', 'runtime/src/**'],
        exclude: ['**/*.test.ts'],
        reporter: ['text', 'html'],
        reportsDirectory: 'coverage',
      },
    },
  });
  ```
- **為什麼**：`vite.config.ts` 載入 `@vitejs/plugin-react` 與 `@tailwindcss/vite`，對純計算測試無用且拖慢啟動；待測對象都是 Node 可執行的 TS。目前待測檔案皆未使用 `@/` alias，不需要 `resolve.alias`；日後需要時再加。
- **替代方案**：在 `vite.config.ts` 加 `test` 區塊 → 每次測試都載入 UI plugin，且 `server.hmr` 等設定與測試無關；jest → 需額外 ts-jest / babel 設定，與 Vite 生態重複，被否決。
- `passWithNoTests: true`：避免「某 glob 沒有匹配（例如 `runtime/` 尚不存在）」導致失敗；整體仍有本 change 建立的測試，不會掩蓋「完全沒測試」的情形。

### 2. 測試檔放在模組旁；納入四個根目錄

- 單元 / 特性測試與被測檔同目錄（`src/engine/arbitrageEngine.test.ts`、`src/adapters/binanceAdapter.test.ts`、`server/liveScanMath.test.ts`），符合技術書 §4。
- `test/` 放跨模組的基礎設施測試（`test/infrastructure.test.ts`：驗證 fetch 替身、`test.include` 含 `runtime/**/*.test.ts`）。
- `runtime/**/*.test.ts` 一併涵蓋 `runtime/src/**` 旁的單元測試與 `runtime/test/scenarios/**`（技術書 §42）。**跨 change 介面**：後續 change 只要把測試命名為 `*.test.ts` 放在 `runtime/` 下即可被 `npm test` 執行；若 `runtime/` 需要不同環境（例如 SQLite native module），由該 change 以 vitest `projects` 擴充，不改變本 change 的納入樣式。
- 只納入 `.test.ts`（不含 `.tsx`）：目前沒有 UI 測試需求；`paper-trading-ui` 需要時自行擴充 `include` 與 jsdom 環境。

### 3. 明確 import，不開 globals

- `tsconfig.json` 的 `types` 只有 `vite/client`；開 globals 需要改 tsconfig 加 `vitest/globals`，影響前端型別環境。明確 `import { describe, it, expect, vi } from 'vitest'` 讓測試檔可直接通過 `tsc --noEmit`，**不修改 `tsconfig.json`**。

### 4. 離線與決定性規範

- `vitest.setup.ts` 以 `vi.stubGlobal('fetch', …)` 換成會拋出 `Error('Network access is disabled in tests')` 的替身；需要模擬上游回應的測試自行 `vi.stubGlobal` 覆蓋，並在 `afterEach` 還原（`vi.unstubAllGlobals()` 後重新套用預設替身，由 setup 的 `beforeEach` 處理）。
- 讀 `Date.now()` 的被測程式（`dryRunEngine`、adapters、`parseCoinGlassIntelligence`）以 `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(Date.UTC(2026, 0, 1, 7, 30, 0))` 固定；只假造 `Date` 避免干擾其他計時器。
- 固定基準時間統一使用 `2026-01-01T07:30:00Z`（距 08:00 UTC 結算 30 分鐘），讓 1h / 4h / 8h 合約的倒數都是 1800 秒，易於人工驗算。
- 不使用 `Math.random`（目前待測程式也沒有）；時間字串皆為 UTC（`toISOString`），不需設定 `TZ`。

### 5. 特性測試寫法

- **明確斷言優先，快照為輔**：公式輸出（PnL、spread、滑價）以 `toBeCloseTo(value, 9)` 逐欄斷言，數值以「先跑現有程式取得 → 人工驗算公式 → 寫入測試」取得；大型結構（adapter 整筆輸出、dry-run `timeline` 的 `id`/`status` 序列、funnel 各級 symbol 序列）用 `toEqual` 對固定字面值，**不使用** `toMatchSnapshot` 外部快照檔，避免 `-u` 一鍵覆蓋掉 bug 標註。
- **已知 bug 標註**：測試名稱格式 `it('[Q-05] 現況：滑價被扣兩次，net_pnl ≈ −2.40', …)`，並附註解 `// 修正後預期：≈ −1.20（見 issue/Q-05 驗收條件）`。修正 issue 的 change 必須在同一 PR 改寫此測試（先讓它以新預期值失敗，再修程式使其通過），成為 fail-then-pass 證據。
- **覆蓋對象與 issue 對照**：
  | 測試檔 | 主要鎖住的行為 | 標註 |
  |--------|---------------|------|
  | `arbitrageEngine.test.ts` | `enrichKlineBar`（open = 0 分支、baselineVol）、`estimateSlippageRate`（1 bp 下限、shock 夾在 0.8–2.5、midPrice = 0 時 base 0.01）、`simulateExecutionExperiment`（方向規則、4 筆 taker 費 2.00 USDT、滑價重複扣除、id / 時間字串） | Q-05 |
  | `server/liveScanMath.test.ts` | `extractBaseSymbol`、最佳配對 / `pair_spreads`、量能三級滑價與固定費、結算時間取 min 與 8h 假設 | Q-01、P6、Q-02、P1、P2、Q-05(b)、P4、Q-06、Q-03（量缺值 1,000 萬在 `getOrCreate`，本 change 不抽出，僅在測試檔註解記錄） |
  | `funnelScanner.test.ts` | 排名、Level1 淘汰（spread < 0.10%）、Level2 depth / 淨值 > 0 篩選、Level3 選擇、倒數 | Q-08、Q-06 |
  | `dryRunEngine.test.ts` | 正常 / 單腿失敗兩情境的 `cost_table`、`telemetry`、`risk_report`、`timeline` | Q-08、P7 |
  | `src/adapters/*.test.ts` | 6 個 mapping 的完整 / 缺欄位 fixture | Q-02（Binance / OKX / Bitget 下次結算 +8h） |

### 6. server.ts 最小抽出方式

- **位置**：新建 `server/liveScanMath.ts`（過渡期 server 層，對應 Invariant 3「交易所差異只能存在 adapters 與 server.ts 抓取段」）。不放 `src/engine/`，因為其中的交易所名稱清單與型別屬 server 過渡層；也不放 `src/`，避免被誤認為前端程式。將來 `instrument-registry` / B6 取代時整個檔案可移除。
- **抽出範圍（僅四段，函式本體逐字不變）**：
  | 匯出名稱 | 來源 | 內容 |
  |---------|------|------|
  | `extractBaseSymbol(raw)` | `server.ts:31-46` | 原函式整段搬移 |
  | `findBestPair(rates, exchanges)` | live-scan 迴圈中 `activeExchanges` 過濾、`< 2` 略過、兩兩配對取最大 spread 段 | 回傳 `null`（對應原本的 `continue`）或 `{ activeExchanges, maxSpread, bestLongEx, bestShortEx, pairSpreads }` |
  | `computeLiveScanNetPnl(maxSpread, volume24h)` | 量能三級 `estSlippagePct`、×4、`fixedFeeDragPct = 0.0020`、淨值與 `meets_threshold` 段 | 回傳 `{ estSlippagePct, feeDragPct, expectedNetPnlPct, expectedNetPnlUsdt, meetsThreshold }`，欄位值與原本寫入 candidate 的值一一對應 |
  | `resolveSettlement(nextFundingTimes, intervals, now)` | `validTimes` / `nextFundingTime` / `timeToSettlementSec` / `intervalHours` 段 | 回傳 `{ nextFundingTime, timeToSettlementSec, intervalHours }` |
- **型別**：為避免新模組 import `server.ts`（會觸發副作用），`findBestPair` 以泛型 `<E extends string>` 接受交易所名稱；`ExchangeName` 型別與 `EXCHANGES` 常數仍留在 `server.ts`。泛型只影響型別，不影響執行結果。
- **不抽出**：fetch / 解析各所 JSON（含 Pionex 週期推斷、OKX 對照）、`getOrCreate`（含量缺值 1,000 萬）、排序與 payload 組裝、`/api/latency/ping`、`/api/market/live-klines`。它們屬 I/O 或會由 `instrument-registry` / `websocket-data-layer` 整段取代。
- **流程（遵守「先鎖行為再搬」）**：因原始碼在抽出前無法 import，採「先寫測試（紅：模組不存在）→ 逐字搬移（綠）」：
  1. 先寫 `server/liveScanMath.test.ts`，期望值取自以原 `server.ts` 邏輯人工驗算的結果；此時測試因模組不存在而失敗（紅燈證據）。
  2. 將四段程式碼剪下貼到新模組（只加 `export`、函式包裝與參數化 `now` / `exchanges`），`server.ts` 改呼叫；測試轉綠。
  3. 以 `git diff --color-moved=zebra` 確認除包裝行外皆為「移動」而非「修改」；實際啟動 `npm run dev` 打一次 `/api/market/live-scan`，確認回應欄位集合與抽出前相同、`total_matched_pairs` 量級一致（HANDOFF §5「改到即時資料」要求），結果記入 HANDOFF §7。

### 7. npm scripts 與 coverage

```jsonc
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage",
"check": "npm run lint && npm run build && npm test"
```

- `check` 使用 `&&` 串接，任一步失敗即停止；不另裝 `npm-run-all`。
- **Coverage 決策：啟用但僅報告、不設門檻、不進 `check`**。理由：(1) 特性測試的目的在鎖行為而非追求覆蓋率，研究原型（UI、I/O 段）設門檻只會逼出無意義測試；(2) Runtime（`runtime/src/accounting`、`trading` 等）才是需要高覆蓋的地方，但它尚未存在，門檻應由建立它的 change 依模組設定；(3) 提供報告讓 reviewer 能看出哪些公式尚未被鎖住。`coverage/` 已在 `.gitignore`。

## Risks / Trade-offs

- [特性測試把 bug 當成「正確」鎖住，可能被誤解為規格] → 測試名稱強制含 issue ID 與「現況」字樣，註解寫修正後預期；spec 明訂修 bug 時必須同 PR 改測試。
- [抽出時不小心改變行為（例如 `now` 取值時機）] → 函式本體逐字搬移、`now` 以參數傳入且在呼叫端仍取同一個 `now` 變數；`git diff --color-moved` 檢查 + 實打一次 live-scan。
- [浮點數斷言在不同 Node 版本有細微差異] → 使用 `toBeCloseTo(…, 9)` 而非 `toBe`；整數 / 字串欄位才用精確比對。
- [vitest 5 與 TypeScript 7 / `--legacy-peer-deps` 安裝行為不相容] → 安裝後先跑 `npx vitest --version` 與空跑 `npm test`；若失敗，退回 vitest 4.x 中宣告支援 vite 8 的最新版本並在 HANDOFF §7 記錄（見 Open Questions）。
- [`tsc --noEmit` 會檢查 `vitest.config.ts`，若 vitest 型別與 TS 7 衝突導致 lint 失敗] → `skipLibCheck` 已開啟；仍失敗時在 HANDOFF 記錄並回報，不得以關閉 lint 規避。
- [`passWithNoTests` 可能掩蓋 glob 打錯] → `test/infrastructure.test.ts` 斷言 `include` 樣式字面值，且本 change 至少建立 9 個測試檔。

## Migration Plan

1. 在 `feature-setup-vitest`（來自 `develop`）依 tasks 順序實作；每個 task 結束時 `npm run check` 必須全綠（規格書 §2.1 規則 4）。
2. 完成後 `openspec validate setup-vitest --strict`，以 `--no-ff` merge 回 `develop`。
3. Rollback：`git revert -m 1 <merge-commit>` 即可完整移除（新增檔案 + `server.ts` 還原為內嵌函式；抽出不改行為，因此 revert 不影響功能）。

## Open Questions

1. **vitest 版本**：預定 `vitest@^5`（peer 支援 vite 8）；若與 TypeScript 7 或 `--legacy-peer-deps` 安裝有問題，是否接受退回 4.x？（預設：接受，並記錄於 HANDOFF §7）
2. **coverage 門檻**：本 change 不設。Runtime 各模組（accounting / trading）是否要在建立時設門檻（例如行覆蓋 ≥ 90%）？建議由 `position-funding-pnl` / `paper-execution-engine` 決定。
3. **抽出檔位置**：`server/liveScanMath.ts` 是否可接受？另一選項是 `src/server/`；若 B6 會把 server 整體搬到 `runtime/` 或 `server/`，現在的位置可直接沿用。
4. **Q-03 量缺值 1,000 萬**：位於 `getOrCreate` 閉包，本 change 未抽出、未鎖住；是否要擴大抽出範圍？（預設：否，由 `instrument-registry` / B4 處理時再補測試）
