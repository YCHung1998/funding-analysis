# BE-10｜`npm start` 仍跑 Vite 開發中介軟體；埠號寫死、綁 0.0.0.0；遺留未使用的 okxFundingRateCache

- **嚴重度**：Low（研究階段本機使用影響小；部署或多實例時會出問題）
- **類別**：資源 / 可靠性
- **位置**：`package.json`（`"start": "tsx server.ts"`）、`server.ts:17`（`PORT = 3000`）、`server.ts:26`（`okxFundingRateCache`）、`server.ts:476-481`（`NODE_ENV !== 'production'` → Vite dev）、`server.ts:492`（`'0.0.0.0'`）
- **對應 HANDOFF**：P14（AI Studio 遺留）、B1

## 問題（技術描述）
1. `start` 與 `dev` 完全相同（`tsx server.ts`），未設 `NODE_ENV=production` → 「正式模式」其實跑的是 Vite dev server（即時轉譯、HMR WebSocket、原始碼可被取得），並在執行期以 tsx 轉譯 TypeScript。HANDOFF 的正式模式指令需手動加 `NODE_ENV=production`。
2. `PORT` 寫死 3000，HMR 埠 24678 由 Vite 預設；無法在同機起第二個實例。
3. `app.listen(PORT, '0.0.0.0')` 對區網開放 API 與 dev server。
4. `okxFundingRateCache` 宣告後從未使用（`grep` 僅 1 處）。

## 證據（實測）
- 本次嘗試 `npm run dev` 時，:3000 已被另一個 checkout（`/Users/eason.hung/Documents/github/funding-analysis`，相同 `server.ts`）的 dev 實例佔用，log：`WebSocket server error: Port 24678 is already in use` 接著 `Error: listen EADDRINUSE: address already in use 0.0.0.0:3000`，行程退出。因埠號寫死，本次量測改用 scratchpad 內複製的 server（僅把 PORT 改成可由環境變數覆寫）跑在 :3001。
- 對 :3000（dev 模式）`GET /src/App.tsx` → 200、21,437 bytes：前端原始碼（經 Vite 轉譯）直接可取。
- `okxFundingRateCache`：`grep -n okxFundingRateCache server.ts` → 只有 `26:` 宣告一行。**「無上限記憶體成長」的疑慮不成立**（從未寫入）；`liveScanCache` 也只有單一條目。記憶體方面已否定。

官方文件：
- Express 效能最佳實務（https://expressjs.com/en/advanced/best-practice-performance.html）：「Setting NODE_ENV to "production" makes Express: Cache view templates. Cache CSS files generated from CSS extensions. Generate less verbose error messages.」以及「Tests indicate that just doing this can improve app performance by a factor of three!」

## 影響
- 若照 `npm start` 部署，每個前端資源請求都走 Vite 即時轉譯，並暴露開發端點；與 live-scan 共用同一個 event loop。
- 無法以多實例/不同埠做 A/B 或藍綠部署；也阻礙本次這類平行驗證。

## Top 3 解方
### 1. 分離 dev / prod 啟動並設定 NODE_ENV（推薦）
- 做法：`"start": "NODE_ENV=production node dist/server.js"`，以 esbuild/tsc 預先編譯 server；`build` 同時產出前端 `dist/` 與 server bundle。
- 預期效益：正式模式不載入 Vite、不在執行期轉譯 TS；依 Express 文件所述可有顯著效能差異。
- 取捨：多一個 build 步驟。
- 參考：https://expressjs.com/en/advanced/best-practice-performance.html — 「Setting NODE_ENV to "production" makes Express: ... Generate less verbose error messages.」
### 2. 埠號與綁定位址設定化
- 做法：`const PORT = Number(process.env.PORT ?? 3000)`、`HOST = process.env.HOST ?? '127.0.0.1'`；Vite `server.hmr.port` 同樣可設定。
- 預期效益：可同機多實例；預設不對區網開放。
- 取捨：無。
- 參考：本次未取得直接描述此做法的官方文件，列為「未查證」（屬常見慣例）。
### 3. 移除死碼
- 做法：刪除 `okxFundingRateCache` 或在 BE-02 per-exchange 快取中正式使用並加上上限。
- 預期效益：降低誤解（註解宣稱「30s TTL」但實際不存在）。
- 取捨：無。
- 參考：https://datatracker.ietf.org/doc/html/rfc5861 — 「caches MAY serve the response in which it appears after it becomes stale, up to the indicated number of seconds.」（若保留，應有明確 TTL 語意）

## 驗收條件
- [ ] `npm start` 不載入 vite（啟動 log 無 Vite 警告，`GET /src/App.tsx` 回 404 或 index.html）
- [ ] `PORT=3001 npm start` 可與 3000 實例並存
- [ ] `grep okxFundingRateCache` 無未使用宣告
