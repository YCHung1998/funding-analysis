# FE-07｜假倒數計時器與 App 頂層每次 render 重跑 mock 計算（成本極低，但造成誤導與 prop 身分不穩）

- **嚴重度**：Low（實測 CPU 成本在微秒～2 ms 級；主要問題是 M5 的「10 秒費率更新倒數」其實什麼都不更新，會讓交易員誤以為資料是即時的）
- **類別**：渲染
- **位置**：`src/components/ExecutionSimulator.tsx:32-40`、`:105`；`src/App.tsx:27-35`、`:78`；`src/components/DryRunConsole.tsx:67-79`、`:122-126`

## 問題（技術描述）

```tsx
// ExecutionSimulator.tsx:34-40 —— 每秒 setState，只為了顯示 :105 的 {rateCountdown}s；歸零後不抓任何資料
React.useEffect(() => {
  const timer = setInterval(() => setRateCountdown(prev => (prev <= 1 ? 10 : prev - 1)), 1000);
  return () => clearInterval(timer);
}, []);
```

```tsx
// App.tsx:27-35 —— 每次 App render 都重跑
const backtestResults = runAllBacktests(datasets);
const funnel = runFunnelScan(Date.now(), 1000);                 // Date.now() → 每次都是新物件
const [selectedCandidate, setSelectedCandidate] = useState<FunnelCandidate>(
  funnel.level3_selected || funnel.level2_top3[0]               // 初值每次 render 都被計算（但只用第一次）
);
// :78 —— 每次 render 都傳新的陣列參考
<DryRunConsole top3Candidates={funnel.level2_top3} ... />
```

- `ExecutionSimulator`：每秒重新 render 466 行元件並重跑 `simulateExecutionExperiment`（資料來源是 mock，每秒結果相同）。
- `DryRunConsole`：每秒 countdown 也使整個 625 行元件 re-render，並重跑 `executeDryRunSimulation`（無 `useMemo`）。
- `App`：`runAllBacktests` / `runFunnelScan` 無 `useMemo`；`useState` 初值非 lazy initializer；`funnel.level2_top3` 參考每次都不同，使任何 `memo` 化的子元件都無法跳過 render。

## 證據（實測）

```
npx tsx bench.ts（scratch；Node 26）
datasets 8
runAllBacktests          8.48 µs/call
runFunnelScan            2.44 µs/call
executeDryRunSimulation  2.49 µs/call
identity stable? false false      ← 連續兩次 runFunnelScan 的 level2_top3 / level3_selected 參考不同

npx tsx bench3.tsx（renderToStaticMarkup，代表 React render 成本）
DryRunConsole       1.69 ms  elements 316
ExecutionSimulator  0.48 ms  elements 183
```

- 結論：任務描述懷疑「App 每次 render 重跑 `runAllBacktests`/`runFunnelScan` 很貴」→ **CPU 面向否證**（遠低於 React 文件建議考慮 memo 的 1 ms）；但**身分不穩定成立**。「每秒倒數重繪整個大元件」→ **成立但成本低**（DryRunConsole ≈1.7 ms/秒，約 0.17% 主執行緒）。
- `grep -n 'rateCountdown' src/components/ExecutionSimulator.tsx` → 僅 `:32` 宣告、`:36` 更新、`:105` 顯示，沒有任何抓取邏輯。
- 官方文件：
  - https://react.dev/reference/react/useMemo —「If the overall logged time adds up to a significant amount (say, `1ms` or more), it might make sense to memoize that calculation.」
  - https://react.dev/reference/react/memo —「This memoized version of your component will usually not be re-rendered when its parent component is re-rendered as long as its props have not changed.」（每次都是新陣列參考 = props 已改變，memo 失效）
  - https://react.dev/reference/react/useState —「If you pass a function as `initialState`, it will be treated as an _initializer function_.」

## 影響

- **誤導**：M5 畫面寫「10 秒費率更新倒數」，但資料是 mock、從不更新，違反 HANDOFF 不變式 #7（mock 必須標示）的精神。
- CPU：兩個計時器元件同時只會掛載一個（分頁互斥），每秒 0.5–1.7 ms，影響可忽略；但若依 FE-03 在大表格加倒數而沿用同一模式，成本會放大到 FE-04 的量級。
- 身分不穩：未來若對 `DryRunConsole` 做 `memo` 或以 `top3Candidates` 作為 effect 依賴，會每次 App render 都失效 / 觸發。

## Top 3 解方

### 1. 移除假倒數，或改為明確的「mock 資料」標示（推薦）
- 做法：刪除 `ExecutionSimulator.tsx:32-40` 的 interval 與 `:105` 顯示，改為「資料來源：mock（不會更新）」徽章；DryRunConsole 的倒數抽成獨立小元件 `<RefreshCountdown nextAt={...} />`，只有它每秒 re-render。
- 預期效益：消除誤導；每秒 re-render 範圍從 316 元素降到個位數元素。
- 取捨：無。
- 參考：https://react.dev/reference/react/memo —「`memo` lets you skip re-rendering a component when its props are unchanged.」

### 2. App 頂層衍生資料移到 module scope 或 `useMemo`
- 做法：`MOCK_DATASETS` 是模組常數，`const BACKTEST_RESULTS = runAllBacktests(MOCK_DATASETS)` 放在 module scope；`funnel` 用 `useMemo(() => runFunnelScan(Date.now(), 1000), [])`；`useState(() => ...)` 改 lazy initializer。
- 預期效益：`top3Candidates` 參考穩定，後續 `memo` 最佳化才有效。
- 取捨：`funnel` 不再隨時間變化（本來就只在 render 時被動變化，並非刻意設計）。
- 參考：https://react.dev/learn/you-might-not-need-an-effect —「This tells React that you don't want the inner function to re-run unless either `todos` or `filter` have changed.」

### 3. `executeDryRunSimulation` / `simulateExecutionExperiment` 以 `useMemo` 包裝
- 做法：`const simulation = useMemo(() => executeDryRunSimulation(lockedCandidateState, notional, forceLegImbalance), [lockedCandidateState, notional, forceLegImbalance])`。
- 預期效益：CPU 節省極小（µs 級），主要讓 `simulation` 物件參考穩定、便於子元件 memo。
- 取捨：依 React 文件，低於 1 ms 的計算 memo 收益有限，屬次要。
- 參考：https://react.dev/reference/react/useMemo —「If the overall logged time adds up to a significant amount (say, `1ms` or more), it might make sense to memoize that calculation.」

## 驗收條件
- [ ] `grep -n 'setInterval' src/components/ExecutionSimulator.tsx` → 0 筆，且 M5 畫面有 mock 標示。
- [ ] React DevTools Profiler「Highlight updates」：DryRun 分頁閒置時每秒只有倒數小元件閃爍。
- [ ] 以 React DevTools 確認連續兩次 App render 的 `DryRunConsole` `top3Candidates` prop 參考相同（或單元測試斷言 `Object.is`）。
