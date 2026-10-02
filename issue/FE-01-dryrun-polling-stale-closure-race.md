# FE-01｜Dry-Run 自動刷新的 stale closure 與亂序回應會把鎖定目標「跳回」舊幣種

- **嚴重度**：High（交易員切換目標後，最多一個請求週期內畫面可能悄悄回到舊幣種，後續的時間軸 / 成本表 / 風控都會以錯的標的計算）
- **類別**：正確性（race）
- **位置**：`src/components/DryRunConsole.tsx:66-79`（interval）、`src/components/DryRunConsole.tsx:82-120`（`refreshRatesForLockedTarget`）

## 問題（技術描述）

```tsx
// :67-79
useEffect(() => {
  const timer = setInterval(() => {
    setCountdown(prev => {
      if (prev <= 1) {
        refreshRatesForLockedTarget();   // ① side effect 寫在 state updater 裡
        return 10;
      }
      return prev - 1;
    });
  }, 1000);
  return () => clearInterval(timer);
}, [lockedCandidateState.symbol]);       // ② refresh 函式被 closure 鎖在 effect 建立時的那次 render

// :82-113
const refreshRatesForLockedTarget = async () => {
  const scanRes = await fetchLiveMarketScan();       // ③ 沒有 AbortController / ignore flag
  const found = scanRes.candidates.find(c => c.symbol === lockedCandidateState.symbol ...);
  if (found) setLockedCandidateState({ ...lockedCandidateState, ... }); // ④ 用舊 closure 的 symbol 覆寫
};
```

四個缺陷疊加：

1. **Updater 內含副作用**：`setCountdown` 的 updater 內呼叫 `refreshRatesForLockedTarget()`（發 fetch）。React 規定 updater 必須是 pure；目前 `src/main.tsx` 沒有開 `<StrictMode>` 所以不會雙發，但只要日後加上 StrictMode，開發模式下每 10 秒就會發 2 次請求。
2. **Stale closure**：interval 的 callback 只在 `lockedCandidateState.symbol` 改變時重建，因此它呼叫的 `refreshRatesForLockedTarget` 永遠是「effect 建立那次 render」的版本，讀到的 `lockedCandidateState`、`notional` 都是舊值（例如使用者把本金從 1000 改成 2000 後，自動刷新寫回的 `expected_net_pnl_usdt` 仍以 1000 計算）。
3. **無取消機制**：切換目標或切換分頁（元件 unmount）時，in-flight 的 `fetch` 不會被 abort，也沒有 `ignore` 旗標。
4. **亂序覆寫（核心 bug）**：時間線如下（靜態分析推導，未在瀏覽器重現）——
   - t0：鎖定 A，倒數歸零 → 發出 A 的 live-scan 請求（cache 冷時伺服器耗時約 4.3 s，見 HANDOFF §0 基準）。
   - t0+1s：使用者在 Zone A 點選 B → `onSelectCandidate(B)` → 同步 effect `setLockedCandidateState(B)`。
   - t0+4s：A 的請求回來，舊 closure 執行 `setLockedCandidateState({ ...A, 最新費率 })` → **鎖定目標被覆寫回 A**，interval effect 再度以 A 重建。

## 證據（實測）

- 呼叫點計數：`grep -rnE 'setInterval' src` → 只有 2 處（`DryRunConsole.tsx:68`、`ExecutionSimulator.tsx:36`）；`grep -rn 'AbortController' src` → **0 處**；`grep -rn 'visibilitychange\|document.hidden' src` → **0 處**。
- cleanup：兩處 `setInterval` 都有 `return () => clearInterval(timer)`（✅ 已確認 unmount 會停止計時器），但 fetch 本身不會被取消。
- 競態窗口：live-scan 伺服器 cache TTL 為 5 s（`server.ts:23 CACHE_TTL_MS = 5000`），刷新週期 10 s，因此每次自動刷新幾乎都落在 cache 失效後，需重新打 5 家交易所；HANDOFF 基準耗時約 4.3 s → 每 10 s 週期中約 40% 時間有請求 in-flight，此時切換目標就會觸發覆寫。
- 官方文件：
  - https://react.dev/reference/react/useState —「If you pass a function as `nextState`, it will be treated as an _updater function_. **It must be pure**」
  - https://react.dev/reference/react/useEffect —「This ensures your code doesn't suffer from "race conditions": network responses may arrive in a different order than you sent them.」
  - https://react.dev/learn/you-might-not-need-an-effect —「Since it will call `setResults()` last, you will be displaying the wrong search results. This is called a "race condition"」

## 影響

- 交易員在 T-30s 前切換到另一個候選時，畫面有約 40% 機率在數秒後跳回前一個幣種，而 Banner 上的「LOCKED ACTIVE TARGET」會讓人以為仍是新選的標的 → dry-run 結論（延遲、成本、風控）對錯標的。
- 本金修改後，自動刷新寫入的預期淨利 USDT 與畫面設定不一致。

## Top 3 解方

### 1. 把「倒數顯示」與「資料抓取」拆開，抓取改用帶 cleanup 的 effect + AbortController（推薦）
- 做法：
  - 倒數只負責顯示（純 updater：`prev => prev <= 1 ? 10 : prev - 1`）。
  - 抓取改成獨立 `useEffect(() => { const ac = new AbortController(); const id = setInterval(() => load(ac.signal), 10_000); return () => { clearInterval(id); ac.abort(); }; }, [symbol])`；`load` 回應後先比對 `found.symbol === symbolAtRequestTime` 才 `setState`（或用 `let ignore` 旗標）。
  - `fetchLiveMarketScan(signal)` 把 `signal` 傳進 `fetch`。
- 預期效益：切換目標 / unmount 時舊請求被中止，覆寫機率降為 0；updater 變 pure，StrictMode 安全。
- 取捨：需改 `liveMarketService` 函式簽名（加可選 `signal`）。
- 參考：https://developer.mozilla.org/en-US/docs/Web/API/AbortController —「The **`AbortController`** interface represents a controller object that allows you to abort one or more Web requests as and when desired.」

### 2. 用 `useEffectEvent` 讀最新 props/state，消除 stale closure
- 做法：`const onTick = useEffectEvent(() => refresh(lockedCandidateState, notional))`，interval 內呼叫 `onTick()`，effect deps 只留 `symbol`。專案已安裝 React 19.3.0（`node -p "require('react/package.json').version"`），`react.production.js` 內可找到 `useEffectEvent`。
- 預期效益：自動刷新永遠使用最新 `notional` 與目標，不必為了讀新值而重建 interval。
- 取捨：仍需搭配解方 1 的 abort/ignore 才能解決亂序。
- 參考：https://react.dev/reference/react/useEffectEvent —「They always "see" the latest values from render (like props and state) without re-synchronizing your Effect, so they're excluded from Effect dependencies.」

### 3. 改用資料抓取函式庫（TanStack Query / SWR）以 query key = symbol 管理
- 做法：`useQuery({ queryKey: ['live-scan'], queryFn, refetchInterval: 10_000, select: d => d.candidates.find(...) })`，鎖定 symbol 改變時由 key/`select` 自動對應，不再手動 `setState` 回寫。
- 預期效益：內建去重、取消、背景暫停（見 FE-02），`select` 只取需要的那一筆。
- 取捨：新增依賴（約十數 KB gzip，未實測）；需學習 cache 語意。
- 參考：https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults —「Queries can optionally be configured with a `refetchInterval` to trigger refetches periodically, which is independent of the `staleTime` setting.」；https://overreacted.io/making-setinterval-declarative-with-react-hooks/ —「So what if we didn't replace the interval at all, and instead introduced a mutable `savedCallback` variable pointing to the _latest_ interval callback?」

## 驗收條件
- [ ] `grep -rn 'AbortController\|signal' src/services/liveMarketService.ts src/components/DryRunConsole.tsx` 至少各 1 處。
- [ ] `setCountdown` 的 updater 內不含任何函式呼叫（code review）。
- [ ] 以 DevTools Network 將 `/api/market/live-scan` throttle 成 5 s 延遲：鎖定 A → 刷新中切到 B → 請求回來後 Banner 仍顯示 B（手動測 10 次 0 次失敗），且舊請求在 Network 顯示 `(canceled)`。
- [ ] 把 `<App />` 包進 `<StrictMode>` 後，開發模式每個刷新週期只發出 1 個 live-scan 請求。
- [ ] 改本金為 2000 後的下一次自動刷新，`expected_net_pnl_usdt = 2000 × expected_net_pnl_pct`。
