# FE-06｜9 個分頁全部打包進單一 440 KB 入口 chunk，未做分頁級 `React.lazy`

- **嚴重度**：Low（本機工具、localhost 載入，首屏影響有限；但改動小、收益可量化：入口 JS gzip −29%）
- **類別**：Bundle
- **位置**：`src/App.tsx:8-17`（全部 static import）、`vite.config.ts`

## 問題（技術描述）

```tsx
// App.tsx:8-17 —— 所有分頁元件皆為 static import，預設只顯示 'funnel'
import { FunnelScannerView } from './components/FunnelScannerView';
import { DryRunConsole } from './components/DryRunConsole';
import { ArbitrageScanner } from './components/ArbitrageScanner';
... // SettlementKlineViewer, ExecutionSimulator, SensitivityMatrix, SchemaInspector, LocalSecretsView, SpecViewer, HelpModal
```

使用者一開始只看到 M3 漏斗，卻要下載並解析全部 10 個元件（含 SchemaInspector、SpecViewer 內嵌的大段說明文字、LocalSecretsView 等）。

## 證據（實測）

1. 基準建置：
   ```
   npm run build
   dist/assets/index-D6hRv6qv.css   50.99 kB │ gzip:   8.62 kB
   dist/assets/index-DpKMLXNT.js   440.14 kB │ gzip: 120.27 kB   （單一 chunk）
   ```
2. 以 sourcemap 逐 module 歸屬（scratch 腳本解析 `index-*.js.map` mappings）：
   ```
   202.2 KB npm:react-dom        25.7 KB FunnelScannerView   21.8 KB LocalSecretsView
    20.8 KB DryRunConsole         18.5 KB SchemaInspector      16.8 KB ExecutionSimulator
    14.6 KB SettlementKlineViewer 10.7 KB ArbitrageScanner     10.2 KB HelpModal
     8.9 KB SpecViewer             8.0 KB npm:lucide-react (38 個 icon module)
     8.0 KB npm:react              7.9 KB SensitivityMatrix     3.4 KB npm:scheduler
   ```
3. 在 scratch 複本（未改動原始碼）把 9 個非預設分頁 + HelpModal 改為 `React.lazy` + `<Suspense>` 後重新建置：
   ```
   index-*.js  276.89 kB │ gzip: 84.98 kB    ← 入口
   DryRunConsole 29.13 kB / SchemaInspector 26.40 kB / LocalSecretsView 24.85 kB / SpecViewer 18.15 kB / ... 各自成 chunk
   ```
   入口 JS：**440 → 277 KB（−37%）、gzip 120 → 85 KB（−29%）**。
4. 被懷疑但**已否證**的項目：
   - `@google/genai`、`motion`：`grep -rl "@google/genai\|motion" src` → 0 個檔案，產物中 `GoogleGenAI` 出現 0 次 → **未進 bundle**（僅為 `package.json` 冗餘依賴，影響安裝時間，屬 HANDOFF P14）。
   - `lucide-react`：採具名 import，產物只含 38 個用到的 icon、共約 8 KB → **tree-shaking 正常**。
   - Tailwind CSS：51 KB / gzip 8.6 KB → 無需處理。
   - `vite.config.ts:11` 使用 `__dirname`，Vite 8 建置時警告建議改 `import.meta.dirname`（不影響效能，順手修）。
- 官方文件：
  - https://react.dev/reference/react/lazy —「`lazy` lets you defer loading component's code until it is rendered for the first time.」
  - https://vite.dev/guide/features —「Vite automatically rewrites code-split dynamic import calls with a preload step so that when `A` is requested, `C` is fetched **in parallel**」

## 影響

- 首次載入少下載 / 解析約 35 KB gzip（163 KB raw）JS；在一般筆電上 parse+compile 可省數十毫秒（未實測瀏覽器端，屬估算）。對 localhost 使用者效益小，若日後部署到遠端或手機查看則更明顯。
- 單一大 chunk 也讓任何一個分頁改版都使整包快取失效。

## Top 3 解方

### 1. 分頁級 `React.lazy` + `Suspense`（推薦）
- 做法：`App.tsx` 將非預設分頁改為 `const DryRunConsole = lazy(() => import('./components/DryRunConsole').then(m => ({ default: m.DryRunConsole })))`，`<main>` 包 `<Suspense fallback={<Spinner/>}>`；`HelpModal` 同樣 lazy（開啟時才載入）。
- 預期效益：入口 gzip 120 → 85 KB（已實測）。
- 取捨：首次切換分頁有一次小 chunk 請求（localhost 下可忽略）；具名 export 需 `.then` 轉 default。
- 參考：https://react.dev/reference/react/lazy —「You can do this by wrapping the lazy component or any of its parents into a `<Suspense>` boundary」

### 2. Hover / idle 時預先載入分頁 chunk
- 做法：在 `Header` 分頁按鈕 `onMouseEnter` 呼叫同一個 `import()`（或 `requestIdleCallback` 後預載全部），使 lazy 的切換延遲接近 0。
- 預期效益：保有解方 1 的入口縮減，同時消除切換時的 Suspense 閃爍。
- 取捨：多一點程式碼；預載全部時總下載量不變。
- 參考：https://vite.dev/guide/features —「Vite automatically rewrites code-split dynamic import calls with a preload step」

### 3. 清理 `package.json` 冗餘依賴並加 bundle 預算檢查
- 做法：移除 `@google/genai`、`motion`（未使用）；把 `express`、`dotenv` 等 server-only 套件標注清楚；CI 加 `vite build` 後檢查入口 chunk gzip ≤ 90 KB。
- 預期效益：安裝更快、避免未來誤 import 大套件而不自知。
- 取捨：對目前 bundle 大小無直接影響（已確認未打包）。
- 參考：本條為一般工程實務，本 session 未取得可引用的官方原文（未查證）；「未打包」一事由上方建置證據支持，90 KB 預算門檻為本報告建議值。

## 驗收條件
- [ ] `npm run build` 後入口 JS gzip ≤ 90 KB，且 `dist/assets` 出現各分頁獨立 chunk。
- [ ] 首頁（funnel）載入時 Network 不請求 DryRunConsole / SchemaInspector / SpecViewer 等 chunk。
- [ ] `grep -n '"@google/genai"\|"motion"' package.json` → 0 筆（若決定清理）。
