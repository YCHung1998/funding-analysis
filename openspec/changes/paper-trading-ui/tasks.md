> 前置：`setup-vitest` 已完成；`trading-schema-storage` 至少已合併 `runtime/src/types/`（含 `glossary.ts`）型別骨架。開工前執行 `openspec validate paper-trading-ui --strict`。分支 `feature-paper-trading-ui`（來自 `develop`）。
> 每個任務先寫失敗的元件 / 單元測試（附「改前失敗、改後通過」輸出），再實作；每個任務結束時 `npm run lint`、`npm run build`、`npm test` 保持全綠。不改 `server.ts`、`runtime/`。

## 1. 分頁骨架與資料層

- [ ] 1.1 分頁掛載：`Header.tsx` 加 `'paper'` 分頁與 `FROZEN`（dryrun）/ `MOCK`（simulator）徽章、`HelpModal.tsx` 加 `paper` 條目、`App.tsx` 以 `React.lazy` + `Suspense` 載入 `src/features/paperTrading/PaperTradingTab.tsx`；測試：預設分頁不載入 Paper chunk、切換顯示 fallback 再顯示內容、`npm run build` 產生獨立 chunk、`src/features/paperTrading/` 不 import dry-run / mock 引擎（靜態檢查）
- [ ] 1.2 資料契約與資料源：`api/contracts.ts`（只 re-export `runtime/src/types`）、`api/paperApi.ts`（A-4–A-9 的 GET client，全部接 `AbortSignal`）、`api/dataSource.ts`（`VITE_PAPER_DATA_SOURCE`，live 失敗不退回 mock）、`api/mock/fixtures.ts`（spec 要求的 7 種案例，以 runtime 型別宣告）、`MockBadge` 與 `MOCK DATA` 橫幅；測試：請求路徑 / 參數形狀、只發 `GET`、不讀 `localStorage`、mock 模式橫幅與各區塊徽章
- [ ] 1.3 `useAbortableQuery`：鍵比對、請求序號、cleanup abort、純 updater、`useEffectEvent` 讀最新值的輪詢；測試（fake timers）：篩選切換時舊回應被丟棄、快速切換 Trade 不被覆寫、`StrictMode` 下每週期只有一個回應寫入 state、卸載後無 state 更新
- [ ] 1.4 `usePaperEventStream`：WebSocket 連線狀態、指數退避重連、`after_seq` 補抓、`event_id` 去重、500 筆環狀緩衝、卸載關閉；事件帶 `trade_id` 時發出 250 ms 合併的失效通知；測試以假 WebSocket 驗證斷線補抓（121–125 各一次）、800 筆只留 500、卸載清除計時器

## 2. 共用顯示元件

- [ ] 2.1 `StatusCode`（英文代碼 + `?` popover，資料只來自 `runtime/src/types/glossary.ts`、未知代碼提示）與 `SlippageAttribution`（括號斜體灰色、「已含在 Price PnL 中，不另外扣除」、`?` 說明 `Net = Funding + Price − Fees`）；測試：點擊顯示 `zh` / `definition_zh`、術語表覆蓋所有狀態 / 事件 / Health 代碼、`src/features/paperTrading/` 無與術語表 `zh` 相同的字串字面值、歸因樣式與標註

## 3. 區塊

- [ ] 3.1 `AccountPanel` 與 `RuntimeHealthPanel`：五個帳戶數值與 `STALE`；Health 各項以 `StatusCode` 顯示、交易所清單由資料渲染（無交易所名稱分支）、心跳過期顯示 `STALE`、連線失敗顯示 `RUNTIME_UNREACHABLE` 且不崩潰；Kill Switch 狀態有值才顯示
- [ ] 3.2 `CurrentTradesTable`：§27 十個欄位、費率 / 比例 / 金額格式化（小數 ×100 只在顯示層）、警示狀態優先排序與樣式、點擊開 Detail；事件只觸發重抓不改寫狀態（測試：收到 `TRADE_STATUS_CHANGED` 後在新快照前仍顯示舊狀態）
- [ ] 3.3 `CompletedTradesTable` 與 `FundingConfirmationBadge`：§27 欄位、`final_status` 篩選（預設全部，含 `ABORTED` / `FAILED` / `EMERGENCY_EXIT`）、伺服器端游標分頁每頁 50（803 筆時 DOM ≤ 50 列）、「已平倉 · 待入帳」→「已定案」與「推定結算（依公開已結算費率）」、`MISSED` 需人工檢查、待入帳 Net PnL 暫定樣式、Slippage 走 `SlippageAttribution`
- [ ] 3.4 `TradeDetail`：Strategy / Position（單腿、Gross、Margin、Capital Allocation 分開，C-17）/ Entry / Funding（兩腿各自結算時間、interval、`settlement_status`、Eligibility）/ Exit / Result 六區，缺值顯示 `—`；以 `useAbortableQuery` 取 A-7 並在失效通知時重抓；測試：Gross 顯示、兩腿結算分列、`ABORTED` 0 成交的缺值、快速切換不被舊回應覆寫
- [ ] 3.5 `TradeTimeline` 與 `PnlWaterfall`：Timeline 顯示全部 `TradingEvent`（含 timeout / cancel / cancel rejected / rejected / expired）、`(timestamp, seq)` 排序、絕對時間 + 相對偏移、`recorded_at` 不同時並列、每頁 200；瀑布圖 Funding → Price（子項 Slippage）→ Fees → Net，Net 取 API `net_pnl_usdt`、Slippage 不參與加總；測試對應 spec 各 Scenario
- [ ] 3.6 `EventStreamPanel` 與 `KillSwitchPlaceholder`：串流 `HH:mm:ss.SSS [CATEGORY] 摘要` 與連線狀態；Kill Switch 區顯示「⚠️ 待決 C-16」、按鈕 disabled 且點擊無網路請求；`api/controlChannel.ts` 只有定義與請求形狀單元測試，靜態檢查確認 `src/` 無呼叫點（按鈕行為 **blocked-by C-16**）

## 4. 收尾

- [ ] 4.1 執行 `npm run lint`、`npm run build`（確認 Paper 為獨立 chunk）、`npm test`、`openspec validate paper-trading-ui --strict` 並附輸出；實際啟動 `npm run dev`，以 `VITE_PAPER_DATA_SOURCE=mock` 走完 Account → Current → Completed（含失敗篩選）→ Detail → Timeline → 瀑布圖 → Kill Switch 停用，再以預設 `live` 驗證 API 不可用時顯示 `RUNTIME_UNREACHABLE` 而非 mock（上游 API 已合併時改為實打 `/api/paper/*` 並記錄結果）；更新 README §4（新增 Paper Trading 列、dry-run / simulator 標示）與 HANDOFF §7 交接紀錄
