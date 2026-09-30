# FE-04｜「顯示全部」時一次渲染 803 列 / 約 2.8 萬個元素，搜尋每個按鍵都重繪整張表

- **嚴重度**：Medium（預設 30 列時成本小；選「全部」後每次按鍵 / 排序 / 篩選的 React render 就約 78 ms，加上 DOM 更新與 layout 容易逼近 INP 200 ms 門檻）
- **類別**：渲染
- **位置**：`src/components/FunnelScannerView.tsx:719-730`（`[30, 50, 100, 9999]`）、`:336`、`:862-1011`（row map）、`:618`（search `onChange`）

## 問題（技術描述）

```tsx
// :719 —— 「全部」= 9999，實際 803 列全部掛上 DOM
{[30, 50, 100, 9999].map(limit => <button onClick={() => setPageSize(limit)}>...)}
// :336
const displayedCandidates = processedCandidates.slice(0, pageSize);
// :862 —— 每列是 inline JSX（非 memo 元件），約 35 個元素
displayedCandidates.map((cand, idx) => <tr key={cand.symbol}> ...12 個 <td> ... </tr>)
// :618 —— 受控 input，每個按鍵 setSearchQuery → 整個 1019 行元件 + 全部列重新 render
onChange={e => setSearchQuery(e.target.value)}
```

- 過濾 / 排序本身**已經用 `useMemo`**（`:173-334`），且實測只要 1.46 ms——任務描述中「sort/filter 每次 render 重算」的疑慮**不成立**。瓶頸在列的 render 與 DOM 數量。
- 沒有虛擬化、沒有 `memo` 化的 Row、沒有 `useDeferredValue`，所以輸入框的更新與重繪 803 列是同一個同步 render。

## 證據（實測）

腳本：把 `FunnelScannerView.tsx:868-1009` 的 row JSX 原樣抽成 scratch 元件，餵入實際 live-scan 回應（803 筆），用 `react-dom/server` `renderToStaticMarkup` 量 React 產生元素樹的時間（不含瀏覽器 DOM commit / style / layout，實際瀏覽器成本只會更高）：

```
npx tsx bench2.tsx   (Node 26, React 19.3.0)
candidates 803 processed 803 processAll ms 1.46
rows=30   render ms=5.31   elements=1061   html KB=60
rows=100  render ms=7.21   elements=3511   html KB=199
rows=803  render ms=78.06  elements=28116  html KB=1590
```

- 每列 ≈ 35 個元素；「全部」模式下表格單獨就有 28,116 個元素，是 Lighthouse 警告門檻（800）的 35 倍。
- 官方文件：
  - https://web.dev/articles/dom-size-and-interactivity —「According to Lighthouse, a page's DOM size is excessive when it exceeds 1,400 nodes. Lighthouse will begin to throw warnings when a page's DOM exceeds 800 nodes.」
  - https://web.dev/articles/inp —「An INP below or at **200 milliseconds** means a page has **good responsiveness**.」
  - https://react.dev/reference/react/useMemo —「If the overall logged time adds up to a significant amount (say, `1ms` or more), it might make sense to memoize that calculation.」

## 影響

- 交易員選「全部」後搜尋 `SOL`：輸入框每個字元都要等 ~78 ms（React）+ 瀏覽器 reconciliation / layout 才回顯，打字明顯卡頓；排序切換同理。
- 1.6 MB 等級的 DOM 常駐記憶體，捲動與 hover（每列 `transition-colors`）也增加 style/paint 成本。
- 若之後依 FE-03 加入每秒倒數，而倒數 state 放在本元件，則每秒都會重繪 2.8 萬元素。

## Top 3 解方

### 1. 以 TanStack Virtual 虛擬化表格列（推薦）
- 做法：安裝 `@tanstack/react-virtual`，`useVirtualizer({ count: processedCandidates.length, getScrollElement, estimateSize: () => 56, overscan: 10 })`，只渲染可見列；移除 `9999` 分頁選項或保留但走虛擬化。
- 預期效益：不論 803 或 5000 筆，DOM 內只保留約（可視高度 / 列高 + overscan）≈ 30 列（對照上表約 1,000 元素 / 5 ms 級）。
- 取捨：`<table>` 需配合 padding row 或改 CSS grid；Ctrl+F 找不到未渲染列。
- 參考：https://tanstack.com/virtual/latest/docs/introduction —「TanStack Virtual is a headless UI utility for virtualizing long lists of elements in JS/TS, React, Vue, Svelte, Solid, Lit, and Angular.」

### 2. `memo` 化 Row + `useDeferredValue(searchQuery)`
- 做法：抽出 `const CandidateRow = memo(...)`（props：`cand`、`notional`、穩定的 `onDryRun`），`processedCandidates` 的 `useMemo` 改依賴 `deferredQuery`。
- 預期效益：輸入框更新優先、列表「稍後追上」；未變動的列在排序以外的更新（如倒數、isScanning）中跳過 render。
- 取捨：不減少 DOM 數量；篩選結果變動時仍需重繪。
- 參考：https://react.dev/reference/react/useDeferredValue —「it tells React that re-rendering the list can be deprioritized so that it doesn't block the keystrokes.」及「This optimization requires `SlowList` to be wrapped in `memo`.」

### 3. CSS `content-visibility: auto` 作為零依賴的過渡方案
- 做法：`tbody tr { content-visibility: auto; contain-intrinsic-size: auto 56px; }`（或以列群組包裝）。
- 預期效益：瀏覽器跳過畫面外列的 style/layout/paint；不需改 React 結構。
- 取捨：不減少 React render 時間（78 ms 仍在），只省瀏覽器端渲染；對 table row 的支援需實測（未查證）。
- 參考：https://web.dev/articles/content-visibility —「if the element is off-screen its descendants are not rendered.」

## 驗收條件
- [ ] 選「全部」時 `document.querySelectorAll('tbody tr').length ≤ 60`（虛擬化）。
- [ ] Chrome Performance 面板：「全部」模式下在搜尋框輸入單一字元，對應 interaction 的 INP ≤ 100 ms（DevTools 無 CPU throttle），≤ 200 ms（4x slowdown）。
- [ ] 同腳本複測 row render：「全部」模式實際渲染的列數 × 單列成本 ≤ 10 ms。
