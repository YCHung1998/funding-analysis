# FE-03｜M3 漏斗掃描是一次性快照：無自動刷新、結算倒數凍結、「<30 分鐘」篩選用過期值

- **嚴重度**：High（主畫面宣稱「即時」，但費率與倒數只在掛載時抓一次；放著 10 分鐘後，倒數與篩選結果都是錯的，並會把凍結的倒數帶進 Dry-Run）
- **類別**：輪詢
- **位置**：`src/components/FunnelScannerView.tsx:158-162`、`:917-918`、`:303-304`、`:371`

## 問題（技術描述）

```tsx
// :84  dataSource 只有初值，全專案沒有任何地方呼叫 setDataSource
const [dataSource, setDataSource] = useState<'live' | 'benchmark'>('live');
// :158-162 —— 只在掛載時抓一次，之後只能手動按「即時掃描」
useEffect(() => { if (dataSource === 'live') performLiveScan(); }, [dataSource]);

// :917-918 —— 倒數直接顯示 server 回傳當下的秒數快照，不隨時間遞減
{Math.floor(cand.time_to_settlement_sec / 3600)}h {Math.floor((cand.time_to_settlement_sec % 3600) / 60)}m
// :303 —— 「< 30 分鐘結算」篩選也用這個快照
if (timeFilter === 'soon_30m' && item.time_to_settlement_sec > 1800) return false;
// :371 —— 點 Run Dry-Run 時把凍結的秒數傳下去
time_to_settlement_sec: cand.time_to_settlement_sec,
```

- 任務描述懷疑此元件「輪詢過密 / 多重 interval」——**實際相反**：此元件沒有任何輪詢（`grep -n 'setInterval' src/components/FunnelScannerView.tsx` → 0 處），問題是「不刷新」。
- 資料含 `next_funding_time`（絕對時間戳），但 UI 用的是相對秒數 `time_to_settlement_sec`，所以不會隨時間前進。
- Dry-Run 的自動刷新（`DryRunConsole.tsx:94-110`）也沒有更新 `time_to_settlement_sec` / `settlement_time`，凍結值會一路沿用。

## 證據（實測）

- `grep -rn 'setDataSource(' src` → 0 處（僅宣告）；`grep -n 'setInterval\|setTimeout' src/components/FunnelScannerView.tsx` → 0 處。
- live-scan 回應（803 筆）每筆同時含 `next_funding_time` 與 `time_to_settlement_sec`（`src/services/liveMarketService.ts:36-37`）。
- 範例推算：若 T-35 分鐘時載入頁面，不按刷新，20 分鐘後畫面仍顯示「0h 35m」且不是紅字；「<30 分鐘結算」篩選會把這個實際只剩 15 分鐘的標的排除。
- 官方文件：https://react.dev/learn/you-might-not-need-an-effect —「You can cache (or "memoize") an expensive calculation by wrapping it in a `useMemo` Hook」（倒數可由 `next_funding_time - now` 在 render 時推導，不需另存 state）。

## 影響

- 交易員最關心的「距結算還有多久」在畫面上靜止不動，且沒有「資料時間」標示，容易錯過 T-30s 進場窗口或對已過結算的標的做 dry-run。
- 費率本身也不會更新：掃描結果可能已是數十分鐘前的費率。

## Top 3 解方

### 1. 倒數由絕對時間推導 + 一個輕量的「now」時鐘（推薦）
- 做法：在 table 外層放一個獨立的 `useNow(1000)`（只有需要顯示時間的小元件訂閱它），每列以 `next_funding_time - now` 計算剩餘秒數；篩選 `soon_30m` 也改用 `next_funding_time - Date.now()`；傳給 Dry-Run 時傳 `next_funding_time`，由接收端自行推導。
- 預期效益：倒數與篩選永遠正確，不需額外網路請求。
- 取捨：每秒 re-render 的範圍要限縮（倒數格抽成 `memo` 小元件），否則會放大 FE-04 的全表 re-render 成本。
- 參考：https://react.dev/reference/react/memo —「`memo` lets you skip re-rendering a component when its props are unchanged.」

### 2. 可見時自動輪詢費率（與 Dry-Run 共用 cache）
- 做法：以 FE-02 的 `usePolling` 或 SWR/TanStack Query（`refreshInterval` 30–60 s，背景暫停），FunnelScannerView 與 DryRunConsole 共用同一 key，避免兩處各自下載 686 KB。
- 預期效益：費率自動更新，且整個 App 同時間只有一個 live-scan 輪詢。
- 取捨：週期要與後端 cache TTL（5 s）及交易所限流協調。
- 參考：https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults —「Stale queries are refetched automatically in the background when: New instances of the query mount, The window is refocused, The network is reconnected」

### 3. 至少顯示資料年齡並提示過期
- 做法：表頭顯示「資料時間 hh:mm:ss（N 秒前）」，超過 60 s 顯示黃色、超過結算週期顯示紅色並停用「Run Dry-Run」。
- 預期效益：成本最低，先消除「以為是即時」的誤導。
- 取捨：不解決資料本身過期。
- 參考：https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API —「An application showing a dashboard of information doesn't want to poll the server for updates when the page isn't visible」（搭配解方 2 時，切回分頁需立即判斷過期）

## 驗收條件
- [ ] 載入後不操作 3 分鐘，任一列的倒數減少 3 分鐘（±1 s）。
- [ ] `soon_30m` 篩選在 T-31m 載入、等待 2 分鐘後會自動包含該標的。
- [ ] 分頁可見時，費率在設定週期內自動更新（Network 可見週期性請求）；全 App 同時最多 1 個 live-scan 輪詢。
- [ ] 表頭顯示資料時間，並在超時時變色。
