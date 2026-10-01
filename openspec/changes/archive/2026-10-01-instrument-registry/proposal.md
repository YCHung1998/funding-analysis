## Why

研究原型以 `extractBaseSymbol` 字串去尾來決定「兩所是不是同一個合約」，結果把 Pionex 22 個反向合約（`USDT_BTC_PERP`）蓋掉主流幣、把 `1000PEPEUSDT` 與 `PEPEUSDT` 視為同一合約、把下市中（`SETTLING`）與股票永續（`TRADIFI_PERPETUAL`）當成可交易，且結算週期寫死 8h、兩腿結算時間從未比對（issue Q-01、Q-02、Q-03、BE-09；HANDOFF P1 P2 P3 P6）。規格書 §5 要求 `Opportunity.symbol` 必須是 Instrument Registry 的統一 ID，技術書 §9 要求 Symbol Intersection 以註冊表配對；依 C-09 開工順序，這是 `setup-vitest` 之後的第一個 change，後續的成本模型、WebSocket 資料層（`websocket-data-layer`）與 Paper Runtime 都以它為前提。

分支：`feature-instrument-registry`（來自 `develop`，完成後 `--no-ff` merge 回 `develop`）。

## What Changes

- **交易所 × 合約註冊表**：啟動時與定期從各所 instrument / exchange-info 端點建立 `Instrument` 表，欄位含 base / quote / settle、原始上架 base（如 `1000PEPE`）、價格倍數（1000x 等）、每單位下單數量對應的 base 數量（OKX `ctVal`）、合約類型（線性永續 / 反向 / TradFi 股票永續 / 交割）、狀態（交易中 / 預上市 / 暫停 / 下市中 / 已下市）、資金費週期與下次結算時間、tick size / step size / min qty / min notional。
- **統一 ID（`instrument_key`）**：`BASE/QUOTE:SETTLE`（例：`PEPE/USDT:USDT`），取代 `extractBaseSymbol`；倍數以交易所 metadata 為準，前綴解析只作為補充並受白名單 / 覆寫表約束。
- **配對規則**：兩腿只有在「`instrument_key` 相同、合約類型為可配對類型（預設只有線性永續）、兩腿狀態皆 `TRADING`、兩腿下次結算時間差 ≤ `funding_alignment_tolerance_ms`（C-10，預設 60,000）、倍數正規化後價格差 ≤ 容忍值」時成立；不成立一律回傳明確的否決原因，不填預設值（HANDOFF B3、B5、P3「缺資料 = 淘汰」）。
- **資金費時程**：每腿各自的下次結算時間與週期來自交易所回傳（Binance `fundingInfo` 未列出者依官方文件為 8h 並標示來源；OKX 以 `nextFundingTime − fundingTime` 推得）；結算時間已過而未刷新時標 `STALE`，**不得以「+ 週期」推算**（Invariant #4，Q-02 第 4 點）。提供 `updateFundingSchedule()` 讓 `websocket-data-layer` 以串流資料更新。
- **事件與時間戳**：每筆 `Instrument` 有 `created_at` / `updated_at`；上架、狀態轉換、規格變更（倍數、步進、週期）、下架都產生 TradingEvent（規格書 §25）。
- **研究端過渡**：`server.ts` 的 `/api/market/live-scan` 改以註冊表配對與逐腿結算時間 / 週期 / 24h 量（移除 `|| 10000000` 與寫死 8h），回應欄位向下相容並新增 `instrument_key`、`long_funding_time`、`short_funding_time`、`funding_aligned` 等；`/api/market/live-klines` 以註冊表解析各所原生 symbol 並驗證輸入（BE-09）。`main` 在每一步都保持可運作。
- **下單規格輔助**：依 `qty_step` / `tick_size` / `min_qty` / `min_notional` 的取整與最小值檢查（純函式），供後續 `paper-execution` 使用。

## Non-goals

- 不實作 WebSocket 串流、REST single-flight / 限流退避、資料新鮮度（屬 `websocket-data-layer`）；本 change 的 REST 讀取只做「檢查 `res.ok`、不吞錯、逐所回報失敗」的最小版本。
- 不實作成本模型 / 淨值排序（`net-cost-model`）、盤口深度滑價、最低流動性門檻（HANDOFF §8 Q3 待決）。
- 不決定 hedge ratio 以數量或名目計算（C-19 待決）；註冊表只提供換算所需的 `qty_unit_in_base` / `price_multiplier`。
- 不支援反向（幣本位）合約與 TradFi 股票永續的配對；它們會被登錄但標示為不可配對。
- 不持久化到 SQLite（`trading-schema-storage` 的 `event-store`）；事件經 `EventSink` 介面送出，未接上 event-store 前使用記憶體 / 結構化 log 實作。
- 不修改前端元件（`FunnelScannerView` 等）的行為；新增欄位只是可用而已。
- 不呼叫任何私有端點、不下任何真實訂單（Invariant #1）。

## Capabilities

### New Capabilities

- `instrument-registry`: 交易所 × 合約註冊表（metadata 擷取與正規化、`instrument_key`、倍數與合約類型、狀態、資金費時程、下單規格）、配對規則與否決原因、註冊表變更事件，以及研究端 `server.ts` 的過渡使用規則。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability。與 `paper-trading-event-loop` 的 `settlement-session` 之關係見 design「跨 change 假設」——本 change 只提供配對與對齊結果，不重新定義場次資格。）

## Impact

- **新增程式**：`runtime/src/market/instruments/`（registry、matching、倍數解析、下單規格輔助、型別）、`runtime/src/adapters/{binance,bybit,okx,bitget,pionex}/instruments.ts`（各所原生欄位對應）、`runtime/src/market/http/`（最小 REST 讀取埠與基本實作）、錄製的 API 回應 fixture 與單元測試。
- **修改程式**：`server.ts`（live-scan 配對、live-klines symbol 解析；移除 `extractBaseSymbol`）、`src/services/liveMarketService.ts`（型別新增選用欄位）。
- **外部 API**：每所多 1–3 個低頻公開 metadata 端點（Binance `exchangeInfo`、`fundingInfo`；Bybit `instruments-info`；OKX `public/instruments`；Bitget `mix/market/contracts`、`current-fund-rate`；Pionex `common/symbols`），預設每小時刷新一次；live-scan 另加 Pionex `market/tickers?type=PERP`（逐腿 24h 成交額）。
- **依賴**：`setup-vitest`（必須先完成）。不依賴 `paper-trading-event-loop`（註冊表以參數接收 `now`，不直接讀系統時間）；若其 `runtime/` 骨架已存在則沿用。被 `websocket-data-layer`、`net-cost-model`、`paper-trading-event-loop` 的 Runtime 串接依賴。
- **對應**：規格書 §3（Market Data 正確性前提）、§5（C-10）、§25；技術書 §5 `getMarkets()`、§9、§50.1 第 2 項；issue Q-01、Q-02、Q-03、BE-09；HANDOFF P1、P2、P3、P6，B2、B3、B5（B4 的「缺資料 = 淘汰」部分）。
- **文件**：HANDOFF §4.2（P1 P2 P3 P6 標記）、§4.3（新增交易所步驟縮減）、§7；`assets/ARCHITECTURE.md` 資料流。
