## Why

Paper Trading Runtime 會把每一筆 Trade（成功、失敗、未成交、撤單、Emergency Exit）寫進 SQLite，但目前研究 UI 只有劇本式的 Dry-Run Console（規格書 §1.1：凍結）與 mock 的 Execution Simulator，沒有任何畫面能讓使用者觀察真實的 Paper 帳戶、交易與 Runtime 健康狀態。規格書 §32 的 DoD 要求「任何一個 Trade 都能從 Opportunity 一路追蹤到 Result」，這必須有一個**只觀察、不決定**的前端才能驗收（技術書 §34、§35、§48.3、§48.4）。

分支：`feature-paper-trading-ui`（來自 `develop`）。

## What Changes

- **新分頁 `Paper Trading`**（`ActiveTab = 'paper'`）：以 `React.lazy` + `Suspense` 載入（FE-06），Header 新增標籤，HelpModal 新增對應說明；既有 Dry-Run Console / Execution Simulator 不改內部邏輯，只在標籤上標示「凍結 / mock」以免與 Paper 混淆（規格書 §1.1）。
- **Account 區**（規格書 §27）：Total / Available / Allocated Capital、Current / Max Positions，數值一律來自 Runtime 的 AccountSnapshot，UI 不自行計算。
- **Current Trades / Completed Trades**（§27）：同時列出失敗 / 未成交 / 撤單 / Emergency Exit（技術書 §48.1），提供結果分類篩選；已平倉但資金費未定案的交易顯示「已平倉 · 待入帳」→「已定案」並標「推定結算（依公開已結算費率）」（`paper-trading-event-loop` design Decision 6）。Completed Trades 走伺服器端分頁（FE-04）。
- **Trade Detail**（§28）：Strategy / Config Version、Position（單腿名目 + Gross、Margin、Capital Allocation，C-17）、Entry、Funding（兩腿各自結算時間與 Eligibility）、Exit、Result、完整 Timeline（全部 `TradingEvent`，含未成交、撤單、拒絕）。
- **狀態顯示規則（C-15）**：共用 `StatusCode` 元件——一律顯示英文代碼，旁邊 `?` 點擊顯示中文名稱與一句話定義，資料只來自 `runtime/src/types/glossary.ts`（由 `trading-schema-storage` 提供）。
- **滑價防呆（C-13、規格書 §20.1）**：共用 `SlippageAttribution` 元件以歸因樣式顯示並標「已含在 Price PnL 中，不另外扣除」；損益瀑布圖中 Slippage 是 Price PnL 的子項；`?` 說明 `Net = Funding + Price − Fees`。
- **Runtime Health 面板**（技術書 §32）與**即時事件串流**（技術書 §34）：資料來自 `server.ts` 唯讀 REST 與 WebSocket 轉發；斷線 / 資料過舊時明確標示，不顯示假的「RUNNING」。
- **資料層**：型別化唯讀 client（`AbortController`、請求代號比對，杜絕 FE-01 的 stale closure / 亂序覆寫）與 WebSocket hook（重連、依序號補抓、有界緩衝）；Runtime API 尚未就緒時可切換到 **明確標示的 mock 資料源**（HANDOFF Invariant #7）。
- **Kill Switch 控制區**：只預留 UI 位置與「控制指令經 `server.ts` 轉交 Runtime、Runtime 自行驗證」的 client 通道；按鈕停用並標示 **blocked-by C-16**。
- **文件**：README §4（mock / live 對照）新增 Paper Trading 列；HANDOFF §7 交接紀錄。

## Non-goals

- 不實作 `server.ts` 的 Paper 唯讀 API / WebSocket 轉發、SQLite schema、術語表內容（分屬 `trading-schema-storage`、`runtime-health-reconciliation`）；本 change 只消費其契約，契約列於 design「跨 change 假設」。
- 不實作 Kill Switch 行為（C-16 待決）；不送出任何控制指令。
- 不讓 UI 計算或決定任何交易狀態、PnL、Hedge Ratio、Funding（技術書 §48.3）；UI 只格式化 Runtime 給的值。
- 不修改 Dry-Run Console / Execution Simulator 的功能與資料流（§1.1 凍結）；不處理 FE-02、FE-03、FE-05、FE-07；不把既有 9 個分頁全部改為 lazy（FE-06 其餘部分另立 change）。
- 不新增啟動 / 停止 Runtime、修改 `PaperTradingConfig` 的 UI（未有規格）。
- 不送真實訂單、不在前端出現任何 API 憑證（Invariant #1、#2）。

## Capabilities

### New Capabilities

- `paper-trading-ui`: Paper Trading 分頁——Account、Current / Completed Trades、Trade Detail（含 Timeline 與損益瀑布）、狀態代碼 + 術語表提示、滑價歸因防呆、Runtime Health、即時事件串流、Kill Switch 預留區、mock 標示、lazy load 與列表分頁、資料抓取的競態防護。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability。本 change 引用但不修改 `trading-schema`、`event-store`、`runtime-health`、`kill-switch`、`funding-settlement-rules`、`pnl-engine`、`position-accounting`。）

## Impact

- **新增程式**：`src/features/paperTrading/`（分頁元件、資料 client、WebSocket hook、mock fixtures、共用顯示元件）與對應 `*.test.tsx`。
- **修改程式**：`src/App.tsx`（新分頁 lazy 掛載）、`src/components/Header.tsx`（`ActiveTab` 加 `'paper'`、標籤與凍結標示）、`src/components/HelpModal.tsx`（`HELP_DICTIONARY` 新增 `paper` 條目）。不改 `server.ts`、`runtime/`。
- **依賴**：`setup-vitest`（必須先完成，含 jsdom 與 React Testing Library；若未包含則本 change 以 `--legacy-peer-deps` 補 devDependency）；`trading-schema-storage`（`runtime/src/types/` 型別與 `glossary.ts`、Paper 唯讀 API）；`runtime-health-reconciliation`（Health API、WebSocket 事件轉發）。後兩者未合併前以 mock 資料源開發與驗收 UI，真實串接列為合併後驗證項。
- **對應**：規格書 §1.1、§6–§8、§9、§18、§20.1、§21、§24、§26、§27、§28、§32（DoD）、C-13、C-15、C-16（blocked）、C-17；技術書 §3、§27.1、§32、§33、§34、§35、§48.1–48.4；HANDOFF Invariant #1、#2、#7；issue FE-01、FE-04、FE-06。
