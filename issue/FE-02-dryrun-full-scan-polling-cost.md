# FE-02｜Dry-Run 每 10 秒下載整包 803 筆（686 KB）只為取 1 筆，且分頁隱藏時不暫停、倒數以 tick 計而非牆鐘

- **嚴重度**：High（單一分頁每小時約 247 MB 下載 + 每次觸發後端重打 5 家交易所；背景分頁被瀏覽器節流後倒數與實際刷新時間脫鉤）
- **類別**：輪詢
- **位置**：`src/components/DryRunConsole.tsx:67-79`、`src/components/DryRunConsole.tsx:85-90`、`src/services/liveMarketService.ts:64-70`

## 問題（技術描述）

```tsx
// DryRunConsole.tsx:85-90 —— 每 10 秒抓全市場，再在前端 find 1 筆
const scanRes = await fetchLiveMarketScan();          // GET /api/market/live-scan（整包）
const found = scanRes.candidates.find(c => c.symbol === lockedCandidateState.symbol || ...);
```

```tsx
// :68-76 —— 倒數以「每秒 -1」計，不是依 Date.now() 計算
setCountdown(prev => (prev <= 1 ? (refresh(), 10) : prev - 1));
```

1. **Over-fetch**：只需要鎖定幣種的 5 所費率，卻每 10 秒下載並 `JSON.parse` 全部 803 筆候選。
2. **無可見性控制**：沒有 `visibilitychange` / `document.hidden` 判斷；分頁在背景仍持續輪詢（直到瀏覽器強制節流）。
3. **倒數與真實時間脫鉤**：背景分頁的計時器被節流後，「每 tick 減 1」的倒數會變慢（Chrome 隱藏 >5 分鐘後每分鐘才喚醒一次 → 實際約 10 分鐘才刷新一次），回到分頁時畫面上的「費率更新倒數」與資料實際年齡不符，且沒有「資料時間」過期提示（`lastUpdatedTime` 有 state 但沒有 stale 警示）。

## 證據（實測）

- 在另一 agent 已啟動的 dev server 上以唯讀 GET 量測（未自行啟動 server）：
  ```
  curl -s -H 'Accept-Encoding: gzip, br' -D - -o /dev/null localhost:3000/api/market/live-scan
  → Content-Length: 685560（無 Content-Encoding，未壓縮）
  node: candidates=803, bytes=685,514, gzip 後 65,543, JSON.parse 平均 2.29 ms（Node 26, M 系列 Mac）
  ```
- 每小時流量：685,560 B × 360 次 ≈ **246.8 MB/h**（若後端加 gzip 約 23.6 MB/h；壓縮屬後端範圍，交由 backend reviewer）。
- 實際只使用 1/803 ≈ 0.12% 的資料。
- `grep -rn 'visibilitychange\|document.hidden' src` → 0 處。
- 官方文件：
  - https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API —「An application showing a dashboard of information doesn't want to poll the server for updates when the page isn't visible」
  - 同頁 —「Timers such as `setTimeout()` are throttled in background/inactive tabs to help improve performance.」
  - https://developer.chrome.com/blog/timer-throttling-in-chrome-88 — 強節流條件之一「The page has been _hidden_ for more than 5 minutes.」，此時「the browser will check timers in this group once per **minute**.」

## 影響

- 頻寬 / CPU：每 10 s 一次 686 KB 下載 + 約 2 ms parse + React 重新 render；筆電行動網路下每小時 ~247 MB。
- 後端與交易所：每個開著 Dry-Run 的分頁都會讓 server 在 cache（5 s TTL）過期後重打 5 家交易所，多分頁時放大對交易所公開 API 的請求量（限流風險，細節交由 backend reviewer）。
- 資料即時性：交易員切回分頁時，看到的「倒數 Ns」可能是數分鐘前的舊費率，而畫面沒有任何過期警示——對 T-30s 進場決策是誤導。

## Top 3 解方

### 1. 以 Page Visibility 暫停/恢復輪詢，並以牆鐘計算倒數與資料年齡（推薦）
- 做法：新增 `usePolling(fn, 10_000)` hook：`document.hidden` 時 `clearInterval`，`visibilitychange` 回到 visible 時**立即**抓一次再恢復；倒數改為 `Math.max(0, nextAt - Date.now())` 計算；Banner 顯示「資料時間 hh:mm:ss」，超過 2 個週期標紅。
- 預期效益：背景分頁流量 → 0；回到前景立刻拿到新資料；倒數永遠反映真實時間。
- 取捨：需自寫 hook（約 30 行）與測試。
- 參考：https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API —「This is especially useful for saving resources and improving performance by letting a page avoid performing unnecessary tasks when the document isn't visible.」

### 2. 改用 SWR / TanStack Query 的輪詢設定（預設背景不抓）
- 做法：`useSWR('/api/market/live-scan', fetcher, { refreshInterval: 10_000 })`（`refreshWhenHidden` 預設關閉）；或 TanStack Query `refetchInterval: 10_000`，並與 FunnelScannerView 共用同一個 cache key，兩個分頁不重複抓。
- 預期效益：可見性暫停、去重、切回前景重抓都內建；與 FE-01 的 race 一併解決。
- 取捨：新增依賴；需統一資料層。
- 參考：https://swr.vercel.app/docs/revalidation —「Both are disabled by default so SWR won't fetch when the webpage is not on screen, or there's no network connection.」

### 3. 前端改呼叫「單幣種」查詢或改為推播（需與 backend 協調）
- 做法：前端改呼叫 `GET /api/market/live-scan?symbol=XXX`（或新端點）只回 1 筆；長期可用 Server-Sent Events 由 server 在費率變動時推播。
- 預期效益：每次回應從 686 KB 降到約 1 KB 等級（803 筆平均每筆 ≈ 854 B，估算）；推播可去掉輪詢延遲。
- 取捨：需要後端改動（跨出本 lane，需 backend reviewer 同意）。
- 參考：https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events —「With server-sent events, it's possible for a server to send new data to a web page at any time, by pushing messages to the web page.」

## 驗收條件
- [ ] DevTools Network：Dry-Run 分頁切到背景 60 秒內 `/api/market/live-scan` 請求數 = 0；切回前景 1 秒內發出 1 次。
- [ ] 鎖定單一幣種時，每次刷新回應大小 ≤ 5 KB（解方 3）或整頁只有一個共享輪詢（解方 2）。
- [ ] 分頁隱藏 6 分鐘後切回，Banner 顯示的資料時間與實際相符，逾 20 s 顯示過期警示。
- [ ] 倒數在 DevTools「CPU 6x slowdown」下仍與牆鐘誤差 ≤ 1 s。
