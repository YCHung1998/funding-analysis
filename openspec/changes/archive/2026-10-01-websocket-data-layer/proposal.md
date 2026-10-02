## Why

研究原型每次 `/api/market/live-scan` 都在請求路徑上同步打 7 個全市場 REST 端點：冷快取時無 single-flight（10 併發 → 70 次上游、觸發 429，BE-01）；上游失敗被 `.catch(() => [])` 吞掉並以 `success:true` 快取殘缺資料（30 次中只有 1 次完整，BE-02）；不讀限流標頭、不退避（BE-03）；資料新鮮度在 T-30s 只有秒級且倒數凍結（BE-04）；最慢上游閘住整體回應（BE-05）；整包 686 KB 下載只為取 1 筆（BE-08、FE-02、FE-03）。Paper Trading 的 Risk Engine 必須在 `STALE_MARKET_DATA` 時阻止新交易（技術書 §8），盤口深度滑價需要逐筆深度（技術書 §6），而 `paper-trading-event-loop` 已決議兩層資料取得策略（D-5）與事件驅動的資料層（C-05 部分決議）。依 C-09 開工順序，這是 Instrument Registry 與成本模型之後的第 4 項。

分支：`feature-websocket-data-layer`（來自 `develop`，完成後 `--no-ff` merge 回 `develop`）。

## What Changes

- **兩層資料取得（D-5）**：
  - **全市場層**（場次 WATCH 階段、研究掃描）：Binance 全市場推播（`!markPrice@arr`）+ 低頻 24h 量 REST；Bybit 批次 REST 每 N 秒（預設 10 s）；Pionex / Bitget / OKX 低頻 REST（預設 30 s）。訂閱 / 輪詢範圍 = `instrument-registry` 的 `subscribableSymbols()`，隨註冊表 `onChange` 自動增減。
  - **入圍層**（場次 SHORTLIST → CONFIRM）：只對入圍合約（僅 `trading_exchanges`）訂閱逐筆 ticker 與盤口深度；由場次以 `promote(session_id, instrument_ids)` / `release(session_id)` 驅動，多場次以參照計數共用訂閱。
- **WebSocket 連線管理**：心跳（依 adapter 宣告的 ping 間隔 / 閒置逾時）、斷線指數退避重連（含 jitter 與上限）、連線壽命到期前主動輪替、單連線主題上限分片；每次連線狀態轉換產生 TradingEvent。
- **REST 快照 / 補洞**：啟動初始快照、訂閱入圍時的盤口快照、重連或序號缺口後的回補；所有 REST 經 `GuardedRestClient`（實作 `instrument-registry` 定義的 `PublicRestClient` 埠）：single-flight、逐所限流規則表、解析限流標頭（`X-MBX-USED-WEIGHT-1M`、`Retry-After` 等）、預算接近上限時拉長輪詢、429 / 418 / 403 斷路器、暫時性錯誤退避。
- **每所狀態回報（不吞錯）**：每所 `SourceStatus`（狀態、最後成功時間、錯誤類型 / HTTP 狀態、限流狀態、資料年齡、筆數）；失敗不覆寫最後一次成功資料，超過上限年齡即剔除並明確標示。
- **資料新鮮度**：每筆行情同時保存 `exchange_timestamp` 與 `local_received_timestamp`（規格書 §25 第 4 點）；`data_age_ms` 以 `trading-clock` 的每所時鐘換算；超過門檻 → `STALE_MARKET_DATA` 狀態與事件，恢復時 `MARKET_DATA_RECOVERED`。Risk Engine 據此阻擋（屬 `risk-engine-kill-switch`）。
- **交易所伺服器時間查詢**：提供 `queryServerTime(exchange, localNow)` 給 `trading-clock` 校正使用；本 change **不**定義或計算時鐘偏差。
- **研究端過渡（最小處理）**：`/api/market/live-scan` 改為讀取記憶體行情狀態（請求路徑上不再打上游），回應新增 `sources`（每所狀態）、`data_as_of`，`time_to_settlement_sec` 於每次回應時由絕對時間重算，支援 `?symbol=` 只回單一合約；既有欄位向下相容。

## Non-goals

- 不重新定義時鐘、偏差估計、參考時間軸（`trading-clock`，屬 `paper-trading-event-loop`）；本 change 只提供伺服器時間查詢與使用 `Clock` 介面。
- 不定義場次、Opportunity 失效規則或 Risk 阻擋邏輯（`settlement-session`、`opportunity-lifecycle`、`risk-engine`）；本 change 只提供 `promote` / `release` 介面、新鮮度查詢與 `STALE_MARKET_DATA` 事件。
- 不實作滑價模型（`net-cost-model`）；只提供盤口深度資料。
- 不做前端改版（FE-02 的頁面可見性暫停輪詢、FE-03 的倒數由絕對時間推導與自動刷新）；只提供伺服器端的 `?symbol=` 篩選與每次回應重算的倒數，前端改動留給後續研究 UI change。
- 不加 HTTP 壓縮 / 分頁（BE-08 的 `compression` 需新依賴）；`?symbol=` 已解決單幣輪詢的主要浪費，其餘列入 Open Questions。
- 不持久化行情（`market_events` 表屬 `trading-schema-storage`）；不使用任何 API 憑證（全部為公開端點，Invariant #2）；不下任何真實訂單（Invariant #1）。
- 不改善 `/api/latency/ping`（BE-06）與 dev middleware（BE-10）。

## Capabilities

### New Capabilities

- `market-data-stream`: 兩層訂閱（全市場 / 入圍）、WebSocket 連線生命週期（心跳、重連、輪替、分片）、盤口序號完整性、正規化行情狀態、資料新鮮度與 `STALE_MARKET_DATA`。
- `market-data-snapshot`: REST 快照與補洞、single-flight、限流規則與斷路器 / 退避、每所來源狀態回報（不吞錯、最後成功資料）、交易所伺服器時間查詢、研究端 live-scan 由記憶體狀態供應。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability。`instrument-registry` 為依賴的 change，本 change 只使用其介面，不修改其需求。）

## Impact

- **新增程式**：`runtime/src/market/`（`marketDataService`、`orderBookService`、`stream/`、`state/`、`http/guardedRestClient`、`serverTime`）、`runtime/src/adapters/<exchange>/marketData.ts`（端點、訊息解析、限流規則表、心跳規格）、錄製訊息 fixture 與假 WebSocket / 假 REST 測試替身。
- **修改程式**：`server.ts`（live-scan 改讀記憶體狀態、嵌入式啟動行情服務）、`src/services/liveMarketService.ts`（型別新增選用欄位）；取代 `instrument-registry` 過渡期在 `server.ts` 的資金費時程刷新迴圈。
- **依賴**：`setup-vitest`；`instrument-registry`（`Instrument`、`subscribableSymbols`、`onChange`、`updateFundingSchedule`、`PublicRestClient`）；`paper-trading-event-loop`（`trading-clock` 的 `Clock`、`RealClock`；`settlement-session` 的階段事件作為入圍層觸發來源）。不新增 npm 依賴（使用 Node 內建 `WebSocket` 與 `fetch`，見 design）。
- **外部 API**：穩態 REST 請求大幅下降（Binance 權重由每次 scan 50 降為每分鐘約 40）；新增常駐 WebSocket 連線（Binance 1 條全市場 + 入圍連線、Bybit 入圍連線）。
- **對應**：規格書 §3、§25；技術書 §6、§7、§8、§41、§50.1 第 4 項；決策 C-05（資料層事件驅動）、C-09、D-5；issue BE-01、BE-02、BE-03、BE-04、BE-05、BE-08、FE-02、FE-03（伺服器端部分）。
- **文件**：技術書 §6–§8 補實作註記；HANDOFF §4.1 資料流、§7；`assets/ARCHITECTURE.md`。
