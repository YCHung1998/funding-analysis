# TESTING 測試與手動驗證指引

> 給要在本機**安裝、跑自動化測試、手動驗證**的人。開發規範在 [`HANDOFF.md`](HANDOFF.md)，使用說明在 [`../README.md`](../README.md)。
> 「畫面看起來對」「應該可以」不算驗證：每一步都有**預期結果**，對不上就記錄下來（見 §5）。

---

## 1. 安裝與本機檢查（每次切分支 / 拉新 code 後）

在專案根目錄執行：

1. **確認分支**：`git branch --show-current`（通常是 `develop` 或 `feature-*`）；`git log --oneline -3` 確認是最新。
2. **確認版本**：`node -v`、`npm -v`（已驗證：Node v26.3.0、npm 11.16.0；建議 Node ≥ 22）。
3. **停掉正在跑的 `npm run dev`**（Ctrl+C），避免 `node_modules` 被佔用。
4. **清掉舊套件**：`rm -rf node_modules`（從其他分支裝的 `node_modules` 可能少套件，例如 vitest）。
5. **依 lockfile 重裝**：`npm ci --legacy-peer-deps`
   - 必須加 `--legacy-peer-deps`，否則會 `ERESOLVE`（HANDOFF P15）。
   - 結尾的 `npm warn allow-scripts ...` 是**警告，不是錯誤**，可忽略。
6. **本機 CI**：`npm run check`（= lint → build → test，任一步失敗即停止）
   - 預期：看到 `✓ built`，最後 `Test Files 11 passed`、`Tests 56 passed`（數量會隨新 change 增加，只要全部 passed）。

### 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| `Missing script: "check"` | 不在已含 vitest 的分支 | `git checkout develop` 後重做步驟 1 |
| `vitest: command not found` / `Cannot find package 'vitest'` | `node_modules` 是舊的 | 重做步驟 4、5 |
| `ERESOLVE unable to resolve dependency tree` | 少了 `--legacy-peer-deps` | 用步驟 5 的完整指令 |
| `npm ci` 說 lockfile 與 package.json 不同步 | 本地改過 `package.json` / `package-lock.json` | `git status` 檢查；不需保留就 `git checkout -- package.json package-lock.json` |
| `EBADENGINE` 或語法錯誤 | Node 太舊 | 升級 Node（≥ 22） |
| `Cannot find module @esbuild/...` 等 esbuild 錯誤 | npm 擋掉 esbuild 安裝腳本 | `npm approve-scripts esbuild` 後重做步驟 5 |
| `listen EADDRINUSE ... :3000` | 3000 port 被佔用 | `lsof -ti :3000 \| xargs kill` 後再 `npm run dev` |
| check 停在 `error TS...` | 型別錯誤 | 依錯誤訊息的 `檔案(行,列)` 修正 |

## 2. 自動化測試

| 指令 | 用途 |
|------|------|
| `npm test` | 單次跑全部測試（失敗時結束碼非 0） |
| `npx vitest run src/engine/arbitrageEngine.test.ts` | 只跑單一檔案 |
| `npx vitest run -t "Q-05"` | 只跑名稱含關鍵字的測試 |
| `npm run test:watch` | 開發時 watch 模式 |
| `npm run test:coverage` | 覆蓋率報告：終端機摘要 + `coverage/index.html`（僅報告，不設門檻） |

- 測試**不打真實 API**（`fetch` 在測試中會直接拋錯）；需要的資料一律寫在測試檔內的固定 fixture。
- 名稱含 `[Q-xx] 現況` 的測試鎖住的是**已知 bug 的現況**，不是正確行為；修 bug 時同一 PR 改寫該測試，不得用 `vitest -u` 或刪測試帶過。

## 3. 手動 API 驗證（需要網路）

先在一個終端機 `npm run dev`，看到 `Server listening on port 3000` 後，另開終端機執行：

### 3.1 即時掃描 `/api/market/live-scan`

```bash
curl -s localhost:3000/api/market/live-scan | node -e '
const d=JSON.parse(require("fs").readFileSync(0));
console.log("success:",d.success,"cached:",d.cached,"pairs:",d.total_matched_pairs,"qualified:",d.threshold_qualified_count,"latency_ms:",d.fetch_latency_ms);
console.log("exchange_counts:",JSON.stringify(d.exchange_counts));
const c=d.candidates[0]; console.log("top1:",c.symbol,c.best_pair.pair_label,"spread:",c.spread);'
```

預期：
- `success: true`；首次 `cached: false`，5 秒內再打一次 → `cached: true`。
- `pairs` 約 800（2026-10-01 實測 805），五所 `exchange_counts` 都 > 0（實測 Pionex 439 / Binance 728 / Bybit 725 / Bitget 707 / OKX 467）。
- 某一所為 0 或總數差很多 → 該所 API 可能失敗（server 會吞掉錯誤，issue BE-02），記錄下來。
- `top1` 依 spread 排序；`spread` 為小數（0.0025 = 0.25%）。

### 3.2 延遲 `/api/latency/ping`

```bash
curl -s localhost:3000/api/latency/ping
```

預期：5 所皆為正數毫秒；`-1` 代表該所 3 秒內無回應。

### 3.3 K 棒 `/api/market/live-klines`

```bash
curl -s "localhost:3000/api/market/live-klines?symbol=BTCUSDT" | head -c 400
```

預期：`success: true`、`symbol: "BTCUSDT"`、`pionex_symbol: "BTC_USDT_PERP"`，含 Binance 與 Pionex 的 1m K 棒。

## 4. 手動 UI 驗證

`npm run dev` 後開 http://localhost:3000 ，依序檢查（資料真假見 README §4）：

| # | 分頁 | 操作 | 預期 |
|---|------|------|------|
| 1 | M3. Multi-Ex Funnel Scanner | 開啟頁面 | Live 區載入即時候選（五所費率、最佳配對）；下方三級漏斗為寫死 15 幣示範 |
| 2 | M3 → Dry-run | 在 Live 候選列點「Run Dry-Run」 | 自動切到 M6/M7，鎖定該候選 |
| 3 | M6/M7. Dry-Run & Risk Console | 開啟（模擬會自動計算，無需按執行） | 狀態 `BALANCED_HEDGED`；9 項風控無 FAIL（r6 量 ≤ 15M、r8 spread < 0.20% 時為 WARN）；名目 1000U 時兩腿進場手續費各 0.5U |
| 4 | M6/M7 | 切換名目 500 / 1000 / 2000 | 成本表與預期純利依名目等比例變化 |
| 5 | M6/M7 | 點「模擬單腿失衡 (Inject)」 | 按鈕變「單腿失衡觸發中 (ACTIVE)」；狀態 `LEG_IMBALANCE`；風控 r3、r4 為 FAIL；建議 `EMERGENCY_CLOSE_FILLED_LEG`；時間軸 step 4 為 `EMERGENCY_ACTION`。再點一次恢復 |
| 6 | M6/M7 | 點「立即刷新費率」 | 顯示「更新中...」後恢復，費率更新（需網路） |
| 7 | M2. ±2m Kline & Volume Shock | 切換幣種與交易所（both / Pionex / Binance） | 圖表更新；mock 結算事件 + 即時最近 1m K |
| 8 | M4. Arbitrage Scanner、M5. 60s Execution Flow | 開啟、點選事件 | 頁面正常顯示，無錯誤；資料為 mock（README §4） |
| 9 | M4. Sensitivity Matrix | 調整參數 | 矩陣即時重算（純公式） |
| 10 | M1. Common Schema & Adapters | 開啟 | 顯示範例 payload → Common Schema 的欄位對照 |
| 11 | Local Secret Vault | 只看不填 | **不要輸入真實 API Key**（明文存 localStorage，HANDOFF P12） |
| 12 | 全部分頁 | 開瀏覽器 DevTools → Console | 無紅色錯誤（網路暫時失敗的 warning 可接受） |

已知會「看起來怪但屬現況」的項目（不用回報為新 bug）：Dry-run 延遲依交易所名稱寫死（P7）、`1000PEPE` 類合約被併成 `PEPE`（P6）、1h 與 8h 費率直接相減（P1）、Binance/Bitget/OKX 結算週期寫死 8h（Q-02）。

## 5. 記錄結果

- 自動化：貼 `npm run check` 最後 5 行。
- 手動：記錄日期、分支 / commit（`git log --oneline -1`）、§3 的數字、§4 每一項 ✅ / ❌ 與截圖。
- 開發者交接寫進 `HANDOFF.md` §7；發現新問題依 `issue/README.md` 格式新增或回報。
