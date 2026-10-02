## Context

- **現況**：研究 UI（`src/`，React 19 + Vite，`server.ts` 以 Vite middleware 服務）有 9 個分頁，全部 static import（FE-06）；`App.tsx` 以 `activeTab` 條件渲染，`Header.tsx` 定義 `ActiveTab` 聯集，`HelpModal.tsx` 的 `HELP_DICTIONARY: Record<ActiveTab, …>` 會強制每個分頁都有說明條目。資料抓取只有 `liveMarketService.fetchLiveMarketScan()`，無 `AbortController`；`DryRunConsole` 有 FE-01 的 stale closure / 亂序覆寫。沒有 WebSocket、沒有測試。
- **架構前提**（技術書 §3、C-06）：Paper Trading Runtime 是獨立 Node process，是 SQLite 的唯一寫入者；`server.ts` 唯讀查詢 SQLite 並把 Runtime 事件以 WebSocket 轉發；控制指令經 `server.ts` 轉交 Runtime 控制通道，由 Runtime 自行驗證。UI 是 Observer / Controller（§48.3），交易流程不依賴 UI（§34、§48.4）。
- **上游 change**（本 change 只消費）：`setup-vitest`（測試基礎）；`trading-schema-storage`（`runtime/src/types/` v0.2 型別、`glossary.ts`、Paper 唯讀查詢 API）；`runtime-health-reconciliation`（Health 模型、WebSocket 事件轉發）；`paper-trading-event-loop`（Decision 6：`funding_confirmed` / `finalized_at` 與「已平倉 · 待入帳」顯示語意）。
- **限制**：HANDOFF §3 Invariants（尤其 #1 不下單、#2 憑證不進前端、#3 無交易所名稱分支、#5 費率小數、#7 mock 標示）；C-16 Kill Switch 已於 2026-10-02 決議為三層分級（本 change 的 Kill Switch UI 仍為 disabled 佔位，真正的三顆按鈕待 `risk-engine-kill-switch` group 4 落地後另排排程實作）；C-19 hedge ratio 基準已決議為 `QUANTITY`（UI 只顯示 Runtime 給的值，不受影響）。
- **本 change 不寫任何持久化實體、不產生狀態轉換**，因此 design rule「每個實體有 `created_at` / `updated_at`、每次轉換有 TradingEvent」在本 change 的落點是：UI 如實**顯示**這些時間戳與事件，不遺漏、不合併。

## Goals / Non-Goals

**Goals:**

- 一個 lazy load 的 Paper Trading 分頁，能完整呈現規格書 §27、§28 所需資訊，包括失敗 / 未成交 / 撤單 / Emergency Exit。
- 所有狀態代碼走單一術語表（C-15）；所有 Slippage 顯示走單一歸因元件（C-13）。
- 資料層零競態（FE-01）、列表有界（FE-04）、斷線可恢復且不影響 Runtime。
- 上游 API 尚未就緒時，能以明確標示的 mock 資料源開發與驗收 UI。

**Non-Goals:**

- `server.ts` API / WebSocket 實作、SQLite、術語表內容、Kill Switch 行為本體（C-16 已決議，實作屬 `risk-engine-kill-switch` group 4）、Runtime 啟停與設定 UI、既有分頁重構或全面 lazy 化。

## Decisions

### 1. 目錄與分頁掛載

```
src/features/paperTrading/
├── PaperTradingTab.tsx          # 分頁根元件（default export 供 React.lazy）
├── api/
│   ├── contracts.ts             # 只 re-export runtime/src/types 的型別 + API 回應包裝型別
│   ├── paperApi.ts              # 型別化唯讀 client（GET + AbortSignal）
│   ├── controlChannel.ts        # Kill Switch 指令 client（預留，無呼叫點）
│   ├── dataSource.ts            # live | mock 選擇（VITE_PAPER_DATA_SOURCE）
│   └── mock/fixtures.ts         # 以 runtime 型別宣告的 fixtures
├── hooks/
│   ├── useAbortableQuery.ts     # 帶鍵比對與 abort 的查詢 hook
│   └── usePaperEventStream.ts   # WebSocket + 重連 + 補抓 + 有界緩衝
├── components/
│   ├── StatusCode.tsx           # 英文代碼 + ? 術語提示
│   ├── SlippageAttribution.tsx  # 歸因樣式 + 防呆標註
│   ├── MockBadge.tsx
│   ├── AccountPanel.tsx  RuntimeHealthPanel.tsx  EventStreamPanel.tsx
│   ├── CurrentTradesTable.tsx  CompletedTradesTable.tsx  FundingConfirmationBadge.tsx
│   ├── TradeDetail.tsx  TradeTimeline.tsx  PnlWaterfall.tsx
│   └── KillSwitchPlaceholder.tsx
```

- `App.tsx`：`const PaperTradingTab = lazy(() => import('./features/paperTrading/PaperTradingTab'))`，`activeTab === 'paper'` 時包 `<Suspense fallback={…}>` 渲染。其他分頁維持 static import（FE-06 其餘部分另立 change，避免本 change 動到凍結分頁）。
- `Header.tsx`：`ActiveTab` 加 `'paper'`；新標籤 `Paper Trading`（highlight）放在 `M6/M7` 之後；`dryrun` 標籤加 `FROZEN`、`simulator` 標籤加 `MOCK` 小徽章（只改 tabs 陣列資料與渲染，不改元件邏輯）。
- `HelpModal.tsx`：新增 `paper` 條目（型別強制）。
- **為什麼放 `src/features/`**：與既有 `src/components/` 的研究原型隔離，方便日後把研究 UI 整體淘汰或替換，也讓「Paper 不得 import dry-run 引擎」可以用路徑做靜態檢查。
- **替代方案**：另開一個獨立前端 app → 需要第二套 Vite / 部署，現階段不值得；放進 `DryRunConsole` 擴充 → 違反 §1.1 凍結。

### 2. 與既有分頁的關係（規格書 §1.1）

| 分頁 | 資料 | 本 change 的處理 |
|------|------|-----------------|
| M6/M7 Dry-Run Console | 劇本式 `dryRunEngine` + 寫死常數 | 不改邏輯；標籤加 `FROZEN`；Paper 分頁不得 import |
| M5 60s Execution Flow | mock 事件 + `arbitrageEngine` | 不改邏輯；標籤加 `MOCK` |
| **Paper Trading（新）** | Runtime（經 `server.ts`） | 唯一呈現 Paper 帳戶與交易的地方 |

- Funnel Scanner 的「Run Dry-Run」按鈕維持導向 Dry-Run；**不**新增「送到 Paper」按鈕——選幣與進場由 Runtime 的 Scanner / Session 決定（`paper-trading-event-loop`），UI 若能指定交易就變成交易流程的 dependency（§48.4）。
- Header 品牌列的 `Research ──► Dry-Run ──► Live` 保持不動（Open Question 2）。

### 3. UI 是 Observer：快照為準，事件只觸發重抓

- 所有狀態與金額來自 REST 快照；WebSocket 事件用於（a）事件串流顯示、（b）Timeline 追加、（c）**失效通知**——收到帶 `trade_id` 的事件時，把該 Trade 的查詢標記為過期並重抓（同一 Trade 250 ms 內合併為一次）；收到帳戶 / 健康相關事件時重抓 Account / Health。
- **為什麼**：若 UI 依事件自己套用狀態轉換，就等於在前端重寫一份狀態機，與 Runtime 產生分歧時 UI 會顯示錯誤狀態（§48.3）。重抓成本低（本機 SQLite 唯讀查詢）。
- UI 不做任何財務計算：Hedge Ratio、Unrealized PnL、Funding Expected、ROI、Duration、Gross Notional 都由 API 提供；UI 只格式化（費率 ×100、金額千分位、時間 UTC 毫秒）。唯一允許的衍生值是「相對時間偏移」與「資料新鮮度」（`now − snapshot_at`），屬顯示用途。
- **替代方案**：前端 event-sourcing 重建狀態 → 否決，理由如上。

### 4. 資料抓取：`useAbortableQuery`（FE-01）

- 每次查詢以 `key`（例如 `['trade', trade_id]`、`['completed', filter, cursor]`）識別；effect 建立 `AbortController`，cleanup 時 `abort()`；回應寫入前比對 `key` 與請求序號，不符丟棄。
- 輪詢（Health、Account 在 WebSocket 斷線時的後備）用獨立 effect + `setInterval`，updater 一律純函式；以 `useEffectEvent`（React 19 已提供，FE-01 解方 2）讀取最新 props 而不重建計時器。
- 不引入 TanStack Query：需求只有少數查詢，自寫 hook ~80 行且可完整測試；避免在 `setup-vitest` 之外再擴大依賴（FE-01 解方 3 列為替代方案）。

### 5. 事件串流：`usePaperEventStream`

- 連線 `ws(s)://<host>/ws/paper`；狀態 `CONNECTING → CONNECTED → RECONNECTING → DISCONNECTED`。
- 重連：指數退避 1s、2s、4s … 上限 30s，加 ±20% jitter；分頁卸載時關閉 socket 並清除計時器。
- 補抓：記錄最後 `seq`；重連後 `GET /api/paper/events?after_seq=<seq>&limit=500`，與後續推送以 `event_id` 去重、依 `(timestamp, seq)` 排序。
- 緩衝：環狀緩衝 500 筆（可設定），`useReducer` 管理；渲染只取緩衝內容，不做無上限累加。
- 分類標籤 `[SCAN] [RISK] [ORDER] [FILL] [POSITION] [FUNDING] [SYSTEM]` 由 `event_type` 前綴對照（顯示用，不是狀態；對照表為 UI 常數，因術語表 category 粒度不同）。
- WebSocket 只收不送（除協定層 ping）；控制指令走 REST 控制通道（Decision 8）。

### 6. 列表有界（FE-04）

- Completed Trades：伺服器端游標分頁，每頁 50；「載入下一頁」替換目前頁（保留「上一頁」游標堆疊），DOM 最多 50 列。篩選改變時重置游標。
- Current Trades：受 `max_positions` 限制（規格預設 5），不分頁；若 API 回傳筆數超過 100 則顯示前 100 並提示（防禦）。
- Timeline：每頁 200 事件，超過顯示「載入更多」。
- **為什麼選分頁不選虛擬化**：Completed Trades 會無限增長，虛擬化仍需一次載入全部資料；分頁同時限制網路與 DOM，且不需新增 `@tanstack/react-virtual`。
- 排序：Current Trades 以「警示狀態優先（`LEG_IMBALANCE`、`EMERGENCY_EXIT`、`FAILED`）→ `created_at` 新到舊」；Completed Trades 以 `finalized_at ?? updated_at` 新到舊（伺服器端）。

### 7. 狀態代碼與術語表（C-15）

- `StatusCode({ code, category? })`：渲染 `<code>` + `?` 按鈕；點擊開啟 popover（`role="dialog"`、Esc 關閉、點外部關閉），內容 `zh` + `definition_zh`。
- 術語表以 **build-time import** 取得：`import { GLOSSARY } from '../../../runtime/src/types/glossary'`（Vite root 為專案根目錄、`@/*` alias 已指向根目錄，可直接 import）。**不**另開 API：術語表是程式碼常數，build-time import 可讓 tsc 在代碼改名時直接報錯。
- Runtime Health 狀態（`RUNNING`、`CONNECTED`、`HEALTHY`、`ARMED`、`STALE`、`RUNTIME_UNREACHABLE` …）也要有術語條目 → 跨 change 假設 A-3。
- 覆蓋測試：列舉型別中的所有代碼，斷言術語表都有條目（型別以 `as const` 陣列匯出為前提，假設 A-2）。

### 8. Kill Switch 預留（本輪仍維持佔位；C-16 已於 2026-10-02 決議為三層分級，三顆按鈕的實際 UI 排入下一輪待 `risk-engine-kill-switch` group 4 落地後一起做）

- `KillSwitchPlaceholder`（本 change 已完成的部分，不重新打開）：顯示區塊標題 `KILL SWITCH`、`⚠️ 待決 C-16` 說明與規格書 §34 C-16 的 5 個子問題摘要連結；一個 disabled 按鈕（不綁 onClick）。C-16 決議結果（三層分級：L1 STOP ENTRY / L2 CANCEL ENTRY / L3 FLATTEN）見規格書 §23、§34；UI 改為三顆按鈕是下一輪工作，不在本 change 範圍內追加。
- `controlChannel.ts`：`sendControlCommand(cmd: ControlCommand, signal): Promise<ControlAck>`，`POST /api/paper/control`，回應只代表 server 已轉交（`202`），實際結果以 Runtime 事件 `KILL_SWITCH_*` / Health 呈現，UI 不做樂觀更新。本 change 只有定義與單元測試（驗證請求形狀），無呼叫點；以靜態檢查把關。
- Kill Switch 目前狀態（若 Runtime 回報）顯示在 Health 面板（假設 A-4），未回報時顯示 `—`。

### 9. mock 資料源（Invariant #7）

- `VITE_PAPER_DATA_SOURCE = 'live' | 'mock'`，預設 `live`；`dataSource.ts` 依此回傳實作同一介面 `PaperDataSource` 的 live / mock 物件。mock 以 fixtures + 可控時鐘模擬事件串流（固定序列循環），不做隨機。
- mock 模式：頂端 `MOCK DATA` 橫幅 + 每區塊 `MOCK` 徽章；README §4 新增一列說明。
- `live` 失敗**不**退回 mock（避免把假資料當真，這正是 Q-08 / P7 的教訓）。
- fixtures 以 `runtime/src/types/` 型別宣告 → 上游型別變動時 tsc 會報錯，避免 mock 漂移。

### 10. 格式化規則

- 時間：`HH:mm:ss.SSS`（UTC）＋日期於 tooltip；Timeline 另顯示相對 Trade `created_at` 的 `+Δms`。
- 費率：小數 → `%`，4 位小數；金額 USDT 2 位小數、千分位；比例（hedge ratio）1 位小數百分比。
- 缺值一律 `—`（不得顯示 0，避免把「未發生」誤讀為「0 成交」以外的意義；0 成交時 Filled Notional 仍顯示 API 給的 `0`）。
- 不依交易所名稱做任何分支（Invariant #3）；交易所清單一律取自資料。

### 11. 跨 change 假設（API 形狀，實作前需與上游 change 對齊）

所有路徑由 `server.ts` 提供、唯讀查詢 SQLite；型別以規格書 §5–§21 與技術書 §27 為準（由 `trading-schema-storage` 匯出於 `runtime/src/types/`）。

| ID | 假設 | 提供者 |
|----|------|--------|
| A-1 | `runtime/src/types/` 匯出 `Opportunity`、`Trade`、`TradeLeg`、`PaperOrder`、`Fill`、`FundingSettlement`、`TradeResult`、`TradingEvent`、`TradeStatus`、`LegStatus`、`OrderState`、`OpportunityStatus`、`TradingEventType`；`TradeResult` 含 `funding_confirmed: boolean`（`paper-trading-event-loop` D-6） | `trading-schema-storage` |
| A-2 | `runtime/src/types/glossary.ts` 匯出 `GLOSSARY: readonly GlossaryEntry[]`（技術書 §27.1）與查詢函式；各狀態聯集另以 `as const` 陣列匯出（如 `TRADE_STATUSES`）供覆蓋測試 | `trading-schema-storage` |
| A-3 | 術語表涵蓋 Runtime Health 狀態代碼（新增 category `HEALTH`，或 `EVENT` 內含） | `runtime-health-reconciliation` + `trading-schema-storage` |
| A-4 | `GET /api/paper/health` → `RuntimeHealth { engine, exchanges: Array<{ exchange: ExchangeId; status }>, market_data, scanner, risk_engine, paper_execution, database, kill_switch?, last_event_at: number \| null, runtime_heartbeat_at: number, server_time: number }`（技術書 §32）；Runtime 未執行時 server 仍回 200 並以心跳過期表達，server 自身錯誤回 5xx | `runtime-health-reconciliation` |
| A-5 | `GET /api/paper/account` → `AccountSnapshot { total_capital_usdt, available_capital_usdt, allocated_capital_usdt, current_positions, max_positions, config_version, snapshot_at, created_at, updated_at }`（規格書 §27；`account_snapshots` 表） | `trading-schema-storage` |
| A-6 | `GET /api/paper/trades?scope=current` → `{ items: TradeSummary[] }`；`GET /api/paper/trades?scope=completed&final_status=&cursor=&limit=50` → `{ items: TradeSummary[]; next_cursor: string \| null }`。`TradeSummary` = `Trade` 摘要欄位 + `long_exchange`、`short_exchange`、`hedge_ratio`、`unrealized_pnl_usdt`、`funding_expected_usdt`（current）或 `TradeResult` 摘要（completed，含 `funding_confirmed`、`finalized_at`、`slippage_attribution_usdt`、`final_status`、`result_reason`、`total_trade_duration_ms`）與各腿 `settlement_status` 摘要 | `trading-schema-storage` |
| A-7 | `GET /api/paper/trades/:trade_id` → `TradeDetail { trade, legs, orders, fills, funding_settlements, opportunity, result? }`；`margin_usdt` 與 `allocated_capital_usdt` 由 Runtime 提供 | `trading-schema-storage` |
| A-8 | `GET /api/paper/trades/:trade_id/events?cursor=&limit=200` → `{ items: Array<TradingEvent & { seq: number }>; next_cursor }`，依 `(timestamp, seq)` 升冪 | `trading-schema-storage`（event-store） |
| A-9 | `GET /api/paper/events?after_seq=&limit=500` → 全域事件補抓，同上排序；`seq` 為 event store 單調遞增序號 | `runtime-health-reconciliation` |
| A-10 | WebSocket `/ws/paper` 由 server 推送 `{ type: 'event'; seq; event: TradingEvent } \| { type: 'health'; health: RuntimeHealth } \| { type: 'hello'; last_seq }`；server 只轉發，不保證送達（UI 以 A-9 補抓） | `runtime-health-reconciliation` |
| A-11 | `POST /api/paper/control` `{ command, request_id }` → `202 { request_id, forwarded_at }`；Runtime 自行驗證，結果以 `KILL_SWITCH_*` 事件回報；指令集合 = `STOP_ENTRY`/`CANCEL_ENTRY`/`FLATTEN`（C-16 已決議三層分級） | `risk-engine-kill-switch` group 4 |
| A-12 | `payload` 不含憑證（Invariant #2），UI 可直接顯示摘要 | `event-store` |

若上游最終形狀不同，只需調整 `api/paperApi.ts` 與 `api/contracts.ts` 的對應層，元件不受影響。

## Risks / Trade-offs

- [上游 API 形狀與假設不同] → 所有 API 存取集中在 `paperApi.ts` 一層；以 mock 資料源與 A-1–A-12 契約測試先行，上游合併後在 tasks 最後一項做真實串接驗證。
- [上游 change 尚未合併，本 change 無法取得 `runtime/src/types` 與 `glossary.ts`] → 本 change 以這兩者為**硬性前置**；若需提前開工，只能在 `trading-schema-storage` 的型別骨架合併後進行，不得在 `src/` 內自造替代型別或術語表。
- [「已平倉 · 待入帳」「已定案」是中文顯示文字，與 C-15「狀態一律英文代碼」的精神可能衝突] → 這是 D-6 指定的定案語意標示，不是狀態機代碼；列為 Open Question 1。
- [事件觸發重抓在事件密集時（部分成交大量回報）造成請求風暴] → 同 Trade 250 ms 內合併、進行中請求被新請求 abort。
- [WebSocket 在 Vite dev middleware 模式下的升級處理] → 由上游在 `server.ts` 處理；UI 端 URL 以 `location` 推導，dev 與 production 相同。
- [分頁（而非虛擬化）時使用者無法一次瀏覽全部歷史] → 提供結果篩選；大量分析屬階段 ④ 的匯出 / 分析工具，不在 UI 範圍。
- [測試依賴 jsdom / RTL，若 `setup-vitest` 未提供] → 本 change 補 `@testing-library/react`、`jsdom` devDependency（`--legacy-peer-deps`），並把 `*.test.tsx` 設為 jsdom 環境。

## Migration Plan

- 全為新增檔案 + `App.tsx` / `Header.tsx` / `HelpModal.tsx` 的小幅修改；既有分頁行為不變，預設分頁仍為 `funnel`。
- 在 `feature-paper-trading-ui` 開發，`--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`（技術書 §51）。回滾後 Header 無 Paper 分頁，Runtime 不受影響（UI 非 dependency）。

## Open Questions

1. 「已平倉 · 待入帳」/「已定案」要維持中文顯示（D-6 原文），還是改成英文代碼（例如 `FUNDING_PENDING` / `FINALIZED`）納入術語表以符合 C-15？目前依 D-6 以中文顯示。
2. Header 品牌列 `Research ──► Dry-Run ──► Live` 與 `7-MODULE SPEC v0.1` 是否改為五階段（§1.1）表述？本 change 暫不改，避免擴大範圍。
3. ~~Kill Switch 控制區在 C-16 決議後是一顆（連鎖）還是三顆按鈕~~ ✅ 2026-10-02 已決議：三顆分級按鈕（L1 STOP ENTRY / L2 CANCEL ENTRY / L3 FLATTEN），L3 需二次確認（見規格書 §23/§34）。UI 實作排入下一輪，待 `risk-engine-kill-switch` group 4 落地後一起做。
4. Paper 分頁是否需要登入 / 本機限定保護？目前 `server.ts` 監聽 `0.0.0.0`（BE-10 相關）；唯讀資料外洩風險低，但控制通道需要保護——建議隨 Kill Switch UI 實作一起決定。
5. Runtime Health 的「STALE」門檻 10 s 是否合適（取決於 Runtime 心跳頻率，由 `runtime-health-reconciliation` 決定）？
