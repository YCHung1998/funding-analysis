> 前置：`setup-vitest` change 已完成（技術書 §50.1 第 1 項）。分支 `feature-paper-trading-event-loop`（來自 `develop`）。
> 每個邏輯任務先寫失敗測試再實作（fail-then-pass），所有測試用 VirtualClock，不打真實 API。

## 1. 文件

- [ ] 1.1 新增 `docs/REFERENCES.md`：收錄 design §8 的 6 份資金費率機制官方文件（URL、重點、已查證引述、未逐字核對標記、查證日期），並由 README / 規格書 §19 / 技術書 §23 連結
- [ ] 1.2 更新 `docs/TRADING_SYSTEM_SPEC.md`（C-05 改為已決議；§19 補結單規範與規則表；§26 補 Session 階段與中文名稱；§5 / §18 補 `funding_confirmed`、`mark_price_source`、公布延遲欄位；D-7 的 1 小時合約注意事項）與 `docs/PAPER_TRADING_TECH_SPEC.md`（§8 時鐘、§10 失效規則、§23 入帳推定、§38 新設定欄位、§41 雙觸發架構、D-5 兩層資料），HANDOFF §8 同步

## 2. 時鐘（trading-clock）

- [x] 2.1 建立 `runtime/` TypeScript 骨架（tsconfig、vitest 納入 `runtime/**/*.test.ts`、`npm test` 涵蓋）並加入「`runtime/src/` 禁止直接使用 `Date.now` / `setTimeout`」的自動檢查測試（satisfied by shared skeleton 7eae294；verified red/green here — see report）
- [x] 2.2 `Clock` 介面 + `VirtualClock`（時間排序、同時到期依註冊順序、取消）＋ 共用契約測試
- [x] 2.3 `RealClock`：每所各自 offset / 誤差（RTT 中點）、參考時間軸與備援順位、偏差跳動與誤差過大判定；以純函式與 VirtualClock 模擬不同步情境測試（每腿保守換算函式移至 settlement-session 任務 3.2，因屬場次時間表計算）

## 3. 結算場次（settlement-session）

- [x] 3.1 交易所結算規則表（Binance 15/15 s、Bybit 5/5 s、OKX 0/60 s 預留）與 `pair_guard` 計算，經 adapter 介面提供（策略層無交易所分支）
- [x] 3.2 階段時間表計算與設定檔驗證（Binance × Bybit → T-25s / T-15s / T+15s / T+30s；OKX 腿 → T+75s；衝突設定啟動失敗）
- [x] 3.3 `SettlementSession` 狀態機：由時鐘驅動 `WATCH → … → DONE / SKIPPED`，每次轉換產生 `SESSION_PHASE_CHANGED` 事件；全域與單場次持倉上限（`DONE` 由外部於資金費入帳定案後呼叫 `markDone()`，見報告）
- [x] 3.4 合約資格判斷：trading_exchanges、結算時間對齊、週期 ≥ 2h，於 SHORTLIST 與 ARM 重新評估（含週期臨時轉為 1h 的案例）

## 4. 機會失效（opportunity-lifecycle）

- [x] 4.1 失效規則（換階段、輸入變動超過容忍值、資料過舊、最長存活、資格改變）與 ARM 最終決策（spread 翻轉、淨值低於門檻），每次狀態轉換產生對應事件（資格改變由 3.4 `evaluateContractEligibility` 提供，由呼叫端合併判斷，見報告）

## 5. 結單與入帳（funding-settlement-rules）

- [x] 5.1 進場截止 / `hedged_by` 未對沖轉 LEG_IMBALANCE / 鎖定區間禁止減倉 / `exit_at` 不等確認即觸發平倉的守門邏輯（以 Execution 介面的假實作驗證）
- [x] 5.2 `FundingSettlement` 推定：EXPECTED → ELIGIBLE → SETTLED / NOT_ELIGIBLE / MISSED、現金流正負號、公布延遲記錄、mark price 來源標記，以及 TradeResult `funding_confirmed` / `finalized_at` 定案規則（`EXPECTED` 由呼叫端於 ARM 建立，本模組處理 ARM 之後的推定，見報告）

## 6. 收尾

- [ ] 6.1 執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate paper-trading-event-loop` 全數通過並附輸出（已完成，證據見報告：26 test files / 135 tests passed）；更新 HANDOFF §7 交接紀錄（未做 — HANDOFF.md 不在本 agent 編輯範圍，確切文字見報告，留給 integrator 貼上）
