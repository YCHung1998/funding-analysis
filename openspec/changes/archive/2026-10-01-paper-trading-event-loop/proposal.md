## Why

資金費只在結算時刻 T 發放、且只發給「結算時刻持倉」的人，但 v0.2 規格草稿以「持續掃描 + Opportunity 固定 2 秒 TTL」描述事件迴圈，沒有把決策錨定在 T，也沒有定義「何時算正式收到資金費、何時可以安心平倉」（規格書 C-05 待決）。在建置 Paper Runtime 之前，必須先把時間模型、場次生命週期與結單規範定下來，否則 Trade Manager、回測共用（規格書 §29）與風控都沒有依據。

分支：`feature-paper-trading-event-loop`（來自 `develop`）。

## What Changes

- **時鐘介面**：所有 Runtime 模組只透過可注入的 Clock 取得時間與排程（真實時鐘 / 虛擬時鐘），與交易所時鐘校正；Paper 與 Backtest 共用同一套程式（D-8）。
- **結算場次（Settlement Session）**：每個即將到來的結算時刻 T 建立一個場次，由時鐘推動階段 `WATCH → SHORTLIST → ARM → ENTRY → LOCK → CONFIRM → EXIT`；v0.1 三級漏斗改為階段關卡（D-2）。
- **單次結算策略**：只做單次結算，不跨期持倉；移除「續抱」邏輯（D-1）。
- **Opportunity 失效規則**：以「換階段 / 輸入變動超過容忍值 / 資料過舊」取代固定 2 秒 TTL，另設最長存活上限（D-3）。
- **交易所結算規則表**：每所的不確定區間（Binance ±15s、Bybit ±5s；OKX 未來 ≤60s）、週期來源、已結算費率來源，由 Adapter 提供，策略層不出現交易所分支。
- **結單規範（安心平倉 vs 正式入帳）**：進場截止 = T − 不確定區間 − 修補時間 − 緩衝；不確定區間內不得減倉；平倉於 `T + 不確定區間 + 緩衝`（預設 +15s → Binance×Bybit 為 T+30s），**不等待入帳確認**（E-1 A、E-2 A）；入帳以公開已結算費率推定，狀態 `EXPECTED → ELIGIBLE → SETTLED / MISSED`，損益在兩腿 SETTLED 後定案（D-6）。
- **合約範圍**：只交易結算週期 ≥ 2 小時的合約；入圍與預備階段重新讀取週期，臨時轉為 < 2h 即放棄（D-7）；1 小時合約注意事項寫入文件。
- **可設定的進場窗口**：預設值可設定，之後以 Paper 數據校準（D-4）。
- **文件**：規格書 C-05 改為已決議並補結單規範；新增 `docs/REFERENCES.md` 收錄各所資金費率機制官方文件（使用者指定 5 份）；技術書記錄 D-5 兩層資料取得策略（實作屬 WebSocket 資料層 change）。

## Non-goals

- 不實作 WebSocket 資料層、Instrument Registry、成本模型（技術書 §50.1 第 2–4 項，各自獨立 change）。本 change 只以介面 / 假資料餵入。
- 不實作 Paper 撮合、Order / Fill / Position 引擎、Kill Switch（C-16 待決）。
- 不支援跨多次結算持倉、不支援結算週期 < 2 小時的合約。
- 不呼叫任何私有端點、不下任何真實訂單。
- 不處理 hedge ratio 計算基準（C-19 待決）。

## Capabilities

### New Capabilities

- `trading-clock`: 可注入的時鐘介面（真實 / 虛擬）、排程、與交易所時鐘偏差校正與記錄。
- `settlement-session`: 每個結算時刻 T 的場次生命週期、階段時間表、合約資格（兩腿對齊、週期 ≥ 2h、屬於 trading_exchanges）、場次與全域持倉上限。
- `opportunity-lifecycle`: Opportunity 狀態與失效規則（換階段、輸入變動、資料過舊、最長存活）。
- `funding-settlement-rules`: 交易所結算規則表、進場截止 / 持倉鎖定 / 安心平倉時間、資金費入帳推定與損益定案。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability）

## Impact

- **新增程式**：`runtime/src/` 下的 clock、scheduler、session、opportunity 失效判斷、venue rules、funding confirmation（純邏輯 + 單元測試，不含 I/O）。
- **依賴**：需先完成 `setup-vitest`（技術書 §50.1 第 1 項）。本 change 的純邏輯部分不依賴第 2–4 項；Runtime 串接真實資料時才需要。
- **文件**：`docs/TRADING_SYSTEM_SPEC.md`（C-05、§5、§14.1 修補時間、§18–19、§26、§34）、`docs/PAPER_TRADING_TECH_SPEC.md`（§8、§10、§23、§38、§41、D-5）、新增 `docs/REFERENCES.md`、`assets/HANDOFF.md` §7 / §8。
- **對應**：規格書 C-05、C-10、§19、§25、§29；issue Q-02、Q-04、BE-04、BE-07。
