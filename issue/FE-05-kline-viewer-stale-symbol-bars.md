# FE-05｜M2 K 棒檢視器切換幣種後仍顯示上一個幣種的即時 K 棒（未重置、未比對回應 symbol）

- **嚴重度**：Medium（會把 A 幣的結算前後震盪 / 量能衝擊標成 B 幣，直接誤導滑價評估；但需先按過「Fetch Live 1m Klines」才會觸發）
- **類別**：正確性（race）
- **位置**：`src/components/SettlementKlineViewer.tsx:29-81`、`:83-84`、`:326-329`

## 問題（技術描述）

```tsx
// :29 liveKlines 是元件內 state，與 currentDataset.symbol 無關聯
const [liveKlines, setLiveKlines] = useState<{ pionex; binance } | null>(null);

// :34-37 —— 以「按下當時」的 symbol 發請求，無 AbortController / ignore
const res = await fetchLiveKlines(currentDataset.symbol);
...
setLiveKlines({ pionex: pMapped, binance: bMapped });   // 不檢查 res.symbol

// :83-84 —— 只要 liveKlines 不為 null 就一律優先使用
const pBars = liveKlines?.pionex || currentDataset.pionex_klines;
const bBars = liveKlines?.binance || currentDataset.binance_klines;

// :326-329 —— 下拉選單切換 symbol 時不會清掉 liveKlines（載入中也可切換，只有按鈕被 disabled）
<select value={currentDataset.symbol} onChange={e => onSelectSymbol(e.target.value)}>
```

兩條觸發路徑：

1. **無 race 也會錯**：載入 PEPE 即時 K 棒 → 下拉切到 SOL → 標題、Spread 顯示 SOL，但 K 棒 / 量能衝擊（`pShock`、`bShock`）仍是 PEPE 的。
2. **亂序回應**：載入 PEPE 中（按鈕 disabled 但 select 可操作）切到 SOL → PEPE 回應抵達後寫入 → 畫面標為 SOL。

## 證據（實測）

- 靜態分析：`grep -n 'setLiveKlines' src/components/SettlementKlineViewer.tsx` → 只有 `:29` 宣告與 `:79` 寫入，**沒有任何在 symbol 變更時的重置**；`fetchLiveKlines` 的回傳型別含 `symbol`（`src/services/liveMarketService.ts:72-77`），但元件未使用。
- 未在瀏覽器重現（依規定未啟動 dev server）；路徑 1 為確定性行為，不依賴時序。
- 官方文件：
  - https://react.dev/learn/you-might-not-need-an-effect —「there is no guarantee about which order the responses will arrive in.」與「you will be displaying the wrong search results. This is called a "race condition"」
  - https://react.dev/reference/react/useEffect —「This ensures your code doesn't suffer from "race conditions": network responses may arrive in a different order than you sent them.」

## 影響

- 需求 #2（結算前後 5 分鐘震盪與量能 → 評估滑價）的畫面可能對錯幣種；量能衝擊倍數差異可能很大（不同幣種 baseline volume 差距數量級），交易員據此設定滑價會嚴重偏差。

## Top 3 解方

### 1. 以 `key={symbol}` 讓元件在切換幣種時重置 state（推薦，最小改動）
- 做法：`App.tsx` 渲染 `<SettlementKlineViewer key={currentDataset.symbol} ... />`；同時在寫入前檢查 `res.symbol === symbolAtRequest`。
- 預期效益：切換即清空舊的 `liveKlines`；舊請求的回應因比對不符被丟棄。
- 取捨：切換後需重新按一次抓取（可搭配解方 2 自動抓）。
- 參考：https://react.dev/learn/you-might-not-need-an-effect —「To fix the race condition, you need to add a cleanup function to ignore stale responses」

### 2. 把 liveKlines 以 symbol 為 key 存放，並在 effect 中以 AbortController 取消
- 做法：`const [liveBySymbol, setLiveBySymbol] = useState<Record<string, Bars>>({})`；讀取 `liveBySymbol[currentDataset.symbol]`；抓取放在 `useEffect`（或 handler）並在 symbol 變更 / unmount 時 `ac.abort()`。
- 預期效益：切回之前的幣種可重用已抓資料；亂序回應不會寫到錯的 key。
- 取捨：需自行管理快取過期。
- 參考：https://developer.mozilla.org/en-US/docs/Web/API/AbortController —「allows you to abort one or more Web requests as and when desired.」

### 3. 資料抓取函式庫以 `['klines', symbol]` 作為 query key
- 做法：TanStack Query `useQuery({ queryKey: ['klines', symbol], queryFn, enabled: userRequested })`。
- 預期效益：key 綁定 symbol，天生不會串資料；自帶快取與取消。
- 取捨：新增依賴（與 FE-01/02 一起導入較划算）。
- 參考：https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults —「Stale queries are refetched automatically in the background when: New instances of the query mount, The window is refocused, The network is reconnected」

## 驗收條件
- [ ] 載入 PEPE 即時 K 棒後切到 SOL，畫面立即回到 SOL 的資料（mock 或重新抓取），不再顯示 PEPE 的 bars（可用 bars 的 `symbol` 欄位斷言）。
- [ ] DevTools 將 `/api/market/live-klines` throttle 至 3 s：載入 PEPE 途中切到 SOL，回應抵達後畫面仍為 SOL，舊請求顯示 `(canceled)` 或被丟棄。
- [ ] 寫入 `liveKlines` 前有 `res.symbol` 比對（code review）。
