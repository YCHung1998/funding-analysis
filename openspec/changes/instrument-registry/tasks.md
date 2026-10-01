> 前置：`setup-vitest` 已合併（技術書 §50.1 第 1 項）。分支 `feature-instrument-registry`（來自 `develop`）。
> 每個公式 / 狀態轉換任務先寫失敗測試再實作（fail-then-pass）；所有測試以錄製 fixture 驅動，不打真實 API；每個任務結束時 `npm run lint`、`npm run build`、`npm test` 皆綠（規格書 §2.1）。

## 1. 鎖住現行行為與骨架

- [x] 1.1 特性測試：把 `server.ts` live-scan 的「解析 + 聚合」與 `extractBaseSymbol` 抽成可測函式（行為不變），以錄製的 5 所回應 fixture 鎖住現行輸出；Q-01 / Q-02 / Q-03 / BE-09 的已知錯誤案例（`USDT_BTC_PERP` 覆蓋 BTC、4h×8h 取 min(T)、`SETTLING` 腿、量預設 1,000 萬）以測試名稱標明將被哪個任務修正
- [x] 1.2 骨架與埠：確認 / 建立 `runtime/` 骨架（design 跨 change 假設 A1、A2、A5）；新增 `runtime/src/market/instruments/types.ts`、`EventSink`、`PublicRestClient` 與 `BasicRestClient`（非 2xx、逾時、解析錯誤、交易所信封錯誤皆 throw `UpstreamError`，不回空陣列）；加入「`runtime/src/market/instruments/` 不得出現交易所名稱字面值」的自動檢查測試

## 2. 正規化與 adapter

- [x] 2.1 `canonical.ts`：`instrument_key`、倍數優先序（OVERRIDE → METADATA → PREFIX → NONE）、前綴白名單（`1INCH` 不誤判）、`qty_unit_in_base`；先寫 spec 中 6 個 Scenario 的失敗測試
- [x] 2.2 Binance adapter（`exchangeInfo` + `fundingInfo` + `premiumIndex`）：身分、類型（`TRADIFI_PERPETUAL`）、狀態（`SETTLING` → `DELISTING`、未知 → `UNKNOWN`）、`PRICE_FILTER` / `LOT_SIZE` / `MIN_NOTIONAL`、週期（未列出 = 8，`EXCHANGE_DOC_DEFAULT`）、`nextFundingTime = 0` → `MISSING`
- [x] 2.3 Bybit adapter（`instruments-info` 分頁 + tickers）：`symbolType = 'stock'` → TradFi、`Delivering` → `DELISTING`、`fundingInterval` 分鐘換算小時、`lotSizeFilter` / `priceFilter`
- [x] 2.4 OKX（`ctVal`/`ctMult`、週期 = `nextFundingTime − fundingTime`）、Bitget（tick = `priceEndStep × 10^−pricePlace`、`sizeMultiplier` 步進、`current-fund-rate` 時程）、Pionex（`quoteCurrency ≠ USDT` → `INVERSE_PERPETUAL`、週期 `UNKNOWN`）三個掃描用 adapter，含信封錯誤處理

## 3. 註冊表核心

- [x] 3.1 `registry.ts`：`applySnapshot` diff（新增 / 變更 / `ABSENT_FROM_SOURCE` → `DELISTED`）、`created_at` / `updated_at` / `status_changed_at` / `last_seen_at` 規則、歧義標記、逐所來源狀態與失敗隔離（保留上次成功資料）、`version` / `onChange` / `subscribableSymbols`，每次轉換經 `EventSink` 送出對應事件
- [x] 3.2 資金費時程：`STALE`（不以 +週期外推）/ `MISSING`、`updateFundingSchedule`（亂序忽略、未登錄拒絕、週期變動產生 `FUNDING_SCHEDULE_CHANGED`）
- [x] 3.3 `matching.ts` 的 `matchPair` / `candidatePairs`（8 項檢查依序、否決原因、成功結果欄位對齊規格書 §5）與 `orderSpec.ts`（`roundQtyDown`、`roundPrice`、`checkOrderMinimums`、`toBaseQty`，十進位取整）

## 4. 研究端過渡

- [x] 4.1 `server.ts` live-scan 改用註冊表：非阻塞啟動刷新 + 定期刷新、以 `instrument_key` 聚合、`best_pair` 只取 `matchPair` 成立者、逐腿結算時間 / 週期 / 24h 成交額（各所各自來源，Pionex 新增 `market/tickers?type=PERP`；缺量淘汰）、新增欄位與 `registry_sources`、未就緒回 503；更新 `src/services/liveMarketService.ts` 型別（新增選用欄位）；把 1.1 中標明的已知錯誤測試改為修正後的期望值
- [x] 4.2 `server.ts` live-klines：輸入驗證（400）、以註冊表解析各所原生 symbol（`1000PEPEUSDT` → Pionex `PEPE_USDT_PERP`）、`URLSearchParams` 組 URL、上游非 2xx 逐所標示；**未刪除** `extractBaseSymbol`／`findBestPair`／`resolveSettlement`（見 report：保留供 Q-01/Q-02/Q-03 特性測試回歸比對，`server.ts` 已不再呼叫它們）

## 5. 收尾

- [ ] 5.1 （部分完成，見 report）執行 `npm run lint`、`npm run build`、`npm test`、`openspec validate instrument-registry --strict` 全數通過並附輸出 ✅；`npm run dev` 後實際打 `/api/market/live-scan` 與 `/api/market/live-klines?symbol=1000PEPEUSDT`，記錄改前 / 改後配對數與前 10 名 ✅；**未完成**：更新 HANDOFF §4.2、§4.3、`assets/ARCHITECTURE.md`、新增 HANDOFF §7——依任務指示本 agent 不得編輯 `assets/HANDOFF.md`／`assets/ARCHITECTURE.md`，確切文字已附在 report，交由 integrator 合併
