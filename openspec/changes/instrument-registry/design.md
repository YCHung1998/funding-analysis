## Context

- **現況**：`server.ts:31-46` 的 `extractBaseSymbol` 以字串替換推 base，`server.ts:161-175` 以 base 為唯一鍵聚合 5 所資料，後寫入者覆蓋前者。結果：Pionex 22 個 `USDT_*_PERP` 反向合約覆蓋 BTC / ETH 等主流幣（Q-01）；`1000PEPEUSDT` 與 `PEPEUSDT` 被視為同一合約；Binance 130 個 `SETTLING` 與 `TRADIFI_PERPETUAL` 合約照樣配對（Q-03）；Binance / Bitget / OKX 週期寫死 8h、Bitget 無結算時間、候選的 T 取 5 所最小值（Q-02）；24h 量只取 Binance、缺值填 1,000 萬（P3）；klines 路由把 `1000PEPEUSDT` 轉成不存在的 Pionex symbol 且未驗證輸入（BE-09）。
- **規格依據**：規格書 §3（Market Data 正確性前提 = issue 方向 ①）、§5 `Opportunity`（`symbol` 為註冊表統一 ID、兩腿結算時間分開記錄、`funding_aligned`，C-10）、§25 時間戳；技術書 §5（`getMarkets()` 應回傳註冊表所需欄位）、§9（Symbol Intersection 以註冊表配對、缺資料 = 淘汰）、§50.1 第 2 項（C-09）。
- **限制**：HANDOFF §3 Invariants #1（不下單）、#3（交易所差異只在 adapter）、#4（不假設 8h）、#5（費率存小數）；規格書 §2.1 漸進遷移（先特性測試、每步三綠）；`main` 必須隨時可 `npm run dev`（技術書 §51.2）。
- **查證**：本 change 撰寫時（2026-09-30）以 6 次循序公開 GET 實測下列 metadata 欄位（見 Decision 4 表格「實測」欄）；其餘欄位引用 issue 檔內已記錄的實測 / 官方引述，查不到者標「未查證」。

## Goals / Non-Goals

**Goals:**

- 以 metadata 建立「交易所 × 合約」註冊表，讓配對以合約身分（而非字串）成立。
- 讓每一腿的下次結算時間與週期都有可追溯的來源，並讓配對強制檢查兩腿對齊。
- 提供穩定介面給 `websocket-data-layer`（訂閱清單、串流更新資金費時程）與 `paper-trading-event-loop`（場次資格所需的對齊結果與週期）。
- 研究端 `server.ts` 立即受益（修正 Q-01～Q-03、BE-09 的輸出），且每一步 `main` 都可運作。

**Non-Goals:**

- WebSocket、single-flight、限流退避、新鮮度（`websocket-data-layer`）；成本模型與淨值排序（`net-cost-model`）；流動性門檻（HANDOFF §8 Q3 待決）；hedge ratio 基準（C-19 待決）；持久化（`trading-schema-storage`）；前端改版。

## Decisions

### 1. 位置：`runtime/src/market/instruments/` + `runtime/src/adapters/<exchange>/instruments.ts`

```
runtime/src/
├── adapters/
│   ├── binance/instruments.ts   ← 原生欄位對應、狀態 / 類型對照、週期來源（交易所差異只在這裡）
│   ├── bybit/instruments.ts
│   ├── okx/instruments.ts       ← 掃描用；OKX 未來加入交易時沿用
│   ├── bitget/instruments.ts    ← 僅掃描
│   └── pionex/instruments.ts    ← 僅掃描
└── market/
    ├── http/publicRestClient.ts ← 最小 REST 讀取埠 + BasicRestClient（websocket-data-layer 會提供強化版實作）
    └── instruments/
        ├── types.ts             ← Instrument、FundingSchedule、PairMatchResult、InstrumentSourceStatus
        ├── canonical.ts         ← instrument_key、倍數前綴白名單、覆寫表
        ├── registry.ts          ← 記憶體註冊表、diff、事件、version / onChange
        ├── matching.ts          ← matchPair / candidatePairs
        └── orderSpec.ts         ← 取整與最小值檢查
```

- **為什麼**：技術書 §4 已把 `market/` 定義為行情與商品資料層、`adapters/` 為交易所差異層；註冊表是 Runtime 與研究端共用的純邏輯 + 低頻 I/O，放在 `runtime/src/` 讓 Runtime 成為單一來源，研究端 `server.ts` 以 import 使用（方向：研究 → runtime，符合 C-11「研究 UI 漸進改為 import runtime」）。
- 技術書 §4 目錄只列 `binance/`、`bybit/`；本 change 加入 `okx/`、`bitget/`、`pionex/` 三個**僅含 instrument mapper** 的 adapter 目錄，因為規格書 §3 要求 Scanner 對 5 所產生 Opportunity（C-01）。它們不含任何帳戶或下單方法。
- `runtime/src/` 不得直接讀系統時間（`trading-clock` 的自動檢查）：註冊表所有函式以參數接收 `now`；`BasicRestClient` 以建構參數注入 `localNow: () => number`（Runtime 傳 Clock、`server.ts` 傳 `Date.now`）。
- **替代方案**：放在 `src/services/`（研究端）→ Runtime 無法重用且違反「runtime 為 v0.2 單一來源」；放在 `server.ts` 內 → 延續 HANDOFF §4.3 的散落問題。皆否決。

### 2. 資料模型

```typescript
type InstrumentStatus = 'TRADING' | 'PRE_TRADING' | 'HALTED' | 'DELISTING' | 'DELISTED' | 'UNKNOWN';
type ContractType = 'LINEAR_PERPETUAL' | 'INVERSE_PERPETUAL' | 'TRADFI_PERPETUAL' | 'DATED_FUTURE' | 'UNKNOWN';

interface FundingSchedule {
  next_funding_time: number | null;
  funding_interval_hours: number | null;
  interval_source: 'EXCHANGE_FIELD' | 'EXCHANGE_DOC_DEFAULT' | 'DERIVED_FROM_TIMES' | 'UNKNOWN';
  schedule_status: 'VALID' | 'STALE' | 'MISSING';
  exchange_timestamp: number | null;
  local_received_timestamp: number | null;
  updated_at: number;
}

interface Instrument {
  instrument_id: string;            // `${exchange}:${native_symbol}`
  exchange: ExchangeId;
  native_symbol: string;            // '1000PEPEUSDT'、'PEPE-USDT-SWAP'
  instrument_key: string;           // 'PEPE/USDT:USDT'
  base_asset: string; quote_asset: string; settle_asset: string;
  listed_base_asset: string;        // '1000PEPE'
  price_multiplier: number;         // 標準化價格 = 報價 / price_multiplier
  qty_unit_in_base: number;         // 1 單位下單數量 = 多少標的
  multiplier_source: 'METADATA' | 'PREFIX' | 'OVERRIDE' | 'NONE';
  contract_type: ContractType; native_contract_type: string;
  status: InstrumentStatus; native_status: string;
  ambiguous: boolean;
  tick_size: number; qty_step: number; min_qty: number; min_notional: number | null;
  funding: FundingSchedule;
  created_at: number; updated_at: number; status_changed_at: number; last_seen_at: number;
}
```

- 金額 / 費率欄位一律小數（Invariant #5）；時間一律 epoch ms。
- `price_multiplier` 與 `qty_unit_in_base` 分開：Binance `1000PEPEUSDT` 兩者皆 1000；OKX `PEPE-USDT-SWAP` 報價以每 PEPE 計（`price_multiplier = 1`），但 1 張 = `ctVal × ctMult` = 10,000,000 PEPE。C-19 若決議以數量計算 hedge ratio，直接用 `toBaseQty()`。
- 註冊表在本 change 只存在記憶體；`Instrument` 仍帶 `created_at` / `updated_at`，日後由 `trading-schema-storage` 決定是否落地（例如 `instruments` 表）。

### 3. `instrument_key` 與倍數解析

- `instrument_key = base/quote:settle`（ccxt unified symbol 的慣例），`contract_type` 另存；配對同時比對兩者。
- 倍數優先序：`OVERRIDE`（設定檔 `multiplier_overrides`）→ `METADATA`（OKX `ctVal`/`ctMult`）→ `PREFIX`（`listed_base_asset` 符合 `^(1000000|100000|10000|1000|1M)([A-Z][A-Z0-9]*)$`）→ `NONE`（倍數 1）。
- 前綴白名單要求前綴後緊接字母，因此 `1INCH` 不會被誤判；真正以數字開頭命名的幣若誤判，以 `multiplier_overrides` 修正，並由配對的價格守門（Decision 6 第 8 點）作最後防線。
- 實測佐證：Binance `1000PEPEUSDT` 的 `baseAsset = "1000PEPE"`、Bybit `1000PEPEUSDT` 的 `baseCoin = "1000PEPE"`——交易所 metadata 本身不提供倍數欄位，必須由 adapter 解析前綴；OKX 則提供 `ctVal = "10000000"`、`ctValCcy = "PEPE"`。

### 4. 各所 adapter 欄位對應

| 交易所 | metadata 端點 | 身分 / 類型 / 狀態 | 下單規格 | 週期 / 下次結算 | 查證 |
|--------|--------------|-------------------|---------|----------------|------|
| Binance | `GET /fapi/v1/exchangeInfo` | `baseAsset`、`quoteAsset`、`marginAsset`、`contractType`（`PERPETUAL` / `TRADIFI_PERPETUAL` / 季度）、`status`（`TRADING` / `SETTLING` / `PENDING_TRADING`） | `PRICE_FILTER.tickSize`、`LOT_SIZE.stepSize` / `minQty`、`MIN_NOTIONAL.notional` | 週期 `GET /fapi/v1/fundingInfo` `fundingIntervalHours`（未列出 = 8，官方文件，Q-02）；下次結算 `premiumIndex.nextFundingTime` | 實測（exchangeInfo 欄位、SETTLING 見 Q-03）；其他狀態值（如 `CLOSE`）未查證 → 對照表未列者 = `UNKNOWN` |
| Bybit | `GET /v5/market/instruments-info?category=linear`（分頁 `nextPageCursor`） | `baseCoin`、`quoteCoin`、`settleCoin`、`contractType`（`LinearPerpetual`…）、`status`（`Trading` / `PreLaunch` / `PendingOpen` / `Delivering`，Q-03 官方引述）、`symbolType`（`stock` → TradFi） | `priceFilter.tickSize`、`lotSizeFilter.qtyStep` / `minOrderQty` / `minNotionalValue` | 週期 `fundingInterval`（**分鐘**，實測 480）；下次結算 tickers `nextFundingTime` | 實測；每頁上限未查證 |
| OKX | `GET /api/v5/public/instruments?instType=SWAP` | `instId`、`ctType`（`linear` / `inverse`）、`ctValCcy`、`settleCcy`、`state`（`live`，Q-03） | `tickSz`、`lotSz`、`minSz`；`ctVal`、`ctMult` | `GET /api/v5/public/funding-rate?instId=ANY` 的 `fundingTime`（下次）與 `nextFundingTime`，週期 = 差值（官方引述見 Q-02） | 實測 `ctVal`/`ctMult`/`ctType`/`lotSz`/`minSz`；`state` 其他值未查證 |
| Bitget | `GET /api/v2/mix/market/contracts?productType=USDT-FUTURES` | `baseCoin`、`quoteCoin`、`symbolType`（`perpetual`）、`symbolStatus`（`normal`） | tick = `priceEndStep × 10^−pricePlace`；qty step = `sizeMultiplier`；`minTradeNum`、`minTradeUSDT` | 週期 `fundInterval`；下次結算 `GET /api/v2/mix/market/current-fund-rate` 的 `nextUpdate` + `fundingRateInterval`（Q-02 實測） | 實測欄位；`sizeMultiplier` 為「下單數量步進」係依實測值推論（官方文件頁為 JS 渲染，未查證）；`symbolStatus` 其他值未查證 |
| Pionex | `GET /api/v1/common/symbols?type=PERP` | `baseCurrency`、`quoteCurrency`、`status`（`TRADING`）；`quoteCurrency ≠ USDT`（如 `USDT_BTC_PERP`）→ `INVERSE_PERPETUAL` | `quoteStep`（tick）、`baseStep`、`minSizeLimit`、`minNotional` | 下次結算 `market/indexes` 的 `nextFundingTime`；**無週期欄位**（未查證）→ `interval_source = 'UNKNOWN'` | 實測；`settle_asset` 未提供，adapter 以 `quoteCurrency` 為準（未查證） |

- 各 adapter 另須驗證回應信封：OKX `code ≠ "0"`、Bybit `retCode ≠ 0`、Bitget `code ≠ "00000"` → 視為 `API_ERROR`，不得當成空清單（BE-02 同類問題）。
- 單元測試以**錄製的真實回應 fixture**（去除非必要欄位）驅動，不打真實 API。

### 5. 資金費時程與刷新節奏

- 兩種來源、兩種節奏：
  - **metadata 快照**（身分、類型、狀態、規格、Bybit / Bitget 週期）：啟動時 + 每 `instrument_refresh_interval_ms`（預設 1 小時）。
  - **資金費時程**（下次結算時間、Binance `fundingInfo`、Bitget `current-fund-rate`、OKX funding-rate）：由行情層呼叫 `updateFundingSchedule()` 更新。過渡期由 `server.ts` 每次 live-scan 取得的 ticker / premiumIndex / funding-rate 資料餵入；Bitget 與 Binance `fundingInfo` 另以 `funding_schedule_refresh_interval_ms`（預設 5 分鐘）刷新，並在偵測到該所有 `STALE` 時程時提前刷新（同所兩次間隔 ≥ 30 秒）。`websocket-data-layer` 上線後由串流 / 批次 REST 取代。
- `next_funding_time ≤ now` → `STALE`，直到收到新值；**不以 +週期外推**（研究原型 adapter 的 `nextFundingTime + interval` 錯誤，Q-02 第 4 點）。
- `updateFundingSchedule` 以 `exchange_timestamp` 單調遞增防止亂序覆寫。

### 6. 配對規則（`matchPair`）

- 檢查順序固定（見 spec），回傳**第一個**不成立的原因，讓測試與統計可重現。
- 對齊容忍值 `funding_alignment_tolerance_ms` 沿用 C-10 / 技術書 §38 的設定（預設 60,000），與 `settlement-session` 共用同一個設定值。
- 價格守門 `price_mismatch_tolerance_pct` 預設 0.02（Q-01 解方 3；屬常見實務，未查證官方依據）；`prices` 為選用參數，由呼叫端提供當下 mark price。註冊表本身不儲存價格。
- 配對**不**檢查 `trading_exchanges` 與週期 ≥ 2h：那是 `settlement-session` 的場次資格（C-01、D-7），研究掃描仍需對 5 所配對並記錄。
- `candidatePairs(instrument_key, opts)`：列舉該 key 下所有跨所組合並回傳每組的 `PairMatchResult`（成功與否決皆回傳），供掃描器記錄被否決的原因（規格書 §25 第 6 點）。

### 7. 事件

- 經注入的 `EventSink.emit(event: TradingEvent)` 送出；事件類型見 spec。`server.ts` 過渡期使用 `ConsoleEventSink`（每行一筆結構化 JSON）+ 最近 N 筆記憶體 ring buffer；Runtime 接上 `event-store` 後改注入正式實作。
- 市場層事件與 Trade 無關，`trade_id` 留空（見跨 change 假設 A3）。

### 8. 最小 REST 讀取埠

```typescript
interface PublicRestClient {
  getJson<T>(req: { exchange: ExchangeId; url: string; weight?: number; timeout_ms?: number }): Promise<RestResult<T>>;
}
interface RestResult<T> { data: T; http_status: number; headers: Record<string, string>; local_sent: number; local_received: number; }
class UpstreamError extends Error {
  exchange: ExchangeId; kind: 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'PARSE' | 'API_ERROR' | 'RATE_LIMITED';
  http_status?: number; retry_after_ms?: number;
}
```

- `BasicRestClient`：檢查 `res.ok`（非 2xx → `HTTP` / 429、418、403 → `RATE_LIMITED` 並解析 `Retry-After`）、逾時（`AbortSignal.timeout`）、JSON 解析錯誤皆 throw `UpstreamError`，**不回傳空陣列**。
- `websocket-data-layer` 會以同一介面提供 `GuardedRestClient`（single-flight、限流預算、斷路器），註冊表不需修改。

### 9. 研究端 `server.ts` 過渡

1. **先特性測試**（規格書 §2.1 規則 1）：把 live-scan 的「解析 + 聚合」抽成可測函式，以錄製 fixture 鎖住現行輸出（含已知錯誤，測試名稱標明將被修正的 issue ID），確認綠燈後才改。
2. 啟動：`server.ts` 建立 `InstrumentRegistry` 與 `BasicRestClient`，**非阻塞**地做第一次刷新（`app.listen` 不等待）；`setInterval` 定期刷新（`server.ts` 不在 `runtime/src/` 內，可用系統計時器）。
3. live-scan：仍沿用現有 7 個 REST 端點取得費率 / 價格 / 量（輪詢改造屬 `websocket-data-layer`），另加 Bitget `current-fund-rate`（由註冊表的 5 分鐘刷新提供，不增加每次 scan 的請求）；聚合鍵改為 `instrument_key`，`best_pair` 只從 `matchPair` 成立的組合挑選；候選 `next_funding_time` = 該組的 `long_funding_time`（兩腿已對齊）；`volume_24h = min(long_volume_24h, short_volume_24h)`，任一腿缺量 → 該組淘汰。各腿 24h 成交額來源：Binance `ticker/24hr.quoteVolume`（既有請求）、Bybit tickers `turnover24h`、Bitget tickers `usdtVolume`、OKX tickers `volCcy24h × last`（既有請求內已有欄位）；Pionex 新增 1 個請求 `GET /api/v1/market/tickers?type=PERP` 的 `amount`（2026-09-30 實測：607 筆、`BTC_USDT_PERP.amount` 為 USDT 計價成交額）。
4. 回應向下相容：保留全部既有欄位；新增欄位見 spec。註冊表尚未完成第一次刷新時回 HTTP 503 `{ success: false, error: 'REGISTRY_NOT_READY' }`（前端既有 `if (!res.ok) throw` 會顯示錯誤，不會顯示錯誤資料）。某所註冊表來源失敗 → 該所不參與配對，並在 `registry_sources` 標示。
5. live-klines：`^[A-Z0-9]{2,20}$` 驗證 → 以 Binance 原生 symbol 查註冊表取得 `instrument_key` → 取 Pionex 對應原生 symbol；以 `URL` + `searchParams` 組上游 URL；上游非 2xx 逐所標示錯誤。
6. 刪除 `extractBaseSymbol`（無其他引用）。

## 跨 change 假設

| # | 假設 | 來源 / 若不成立 |
|---|------|----------------|
| A1 | `setup-vitest` 已合併：`npm test` 會執行 `runtime/**/*.test.ts` | 必要前置；若 vitest 尚未涵蓋 `runtime/`，本 change 第一個任務補上設定 |
| A2 | `ExchangeId` 以規格書 §5–§21 為準，由 `trading-schema` capability 定義於 `runtime/src/types/ids.ts`（工作區中的 change 目錄為 `trading-schema-types`；任務說明稱 `trading-schema-storage`）：`'Pionex' \| 'Binance' \| 'Bybit' \| 'Bitget' \| 'OKX'` | 若該 change 尚未合併，本 change 在同一路徑建立**完全相同**的定義並標註「由 trading-schema 接管」，不另外擴充 |
| A3 | `TradingEvent`（`trading-schema`，`runtime/src/types/event.ts`）的 `trade_id` 為 `string \| null`，市場層事件填 `null`；`TradingEventType` 目前是**封閉**的聯集（技術書 §26 核心碼 + 列舉的擴充碼），因此須在其擴充碼清單加入本 change 的 `INSTRUMENT_LISTED`、`INSTRUMENT_STATUS_CHANGED`、`INSTRUMENT_SPEC_CHANGED`、`FUNDING_SCHEDULE_CHANGED`、`INSTRUMENT_AMBIGUOUS`、`INSTRUMENT_UNKNOWN_VALUE`、`INSTRUMENT_SOURCE_STATUS_CHANGED`，並依其規則同時補 `glossary.ts` 條目 | 需與 `trading-schema-types` 協調（由先合併者補上）；在其合併前，本 change 以本地 `EventSink` 介面與事件型別運作，合併時改為 import |
| A4 | `paper-trading-event-loop` 的 `settlement-session` 以本 change 的 `matchPair` 結果（`funding_aligned`、`FUNDING_NOT_ALIGNED`）與 `Instrument.funding.funding_interval_hours` 判斷場次資格；場次資格的其餘條件（`trading_exchanges`、週期 ≥ 2h）由 `settlement-session` 負責 | 本 change 不重新定義場次資格；兩者共用 `funding_alignment_tolerance_ms` 設定 |
| A5 | `runtime/` TypeScript 骨架（tsconfig、禁止直接讀系統時間的檢查）由 `paper-trading-event-loop` 任務 2.1 建立 | 若本 change 先合併，則建立同規則的最小骨架；後合併者以 rebase 解決衝突 |
| A6 | `websocket-data-layer` 以 `subscribableSymbols()` / `onChange()` 取得訂閱清單，以 `updateFundingSchedule()` 回寫時程，並以 `PublicRestClient` 介面提供強化版 REST 客戶端 | 兩份 change 的介面約定，見 `websocket-data-layer` design |

## Risks / Trade-offs

- [前綴白名單誤判以數字開頭的真實幣名] → 前綴後必須緊接字母；`multiplier_overrides` 修正；價格守門作為最後防線；誤判時註冊表產生歧義或價格否決，而非靜默錯配。
- [交易所新增未知狀態值] → 對應為 `UNKNOWN`（不可配對）並產生事件，寧可漏掉機會也不配錯合約。
- [配對候選數下降（61 組不對齊、89 組缺量、7 組下市 / 股票永續被移除）] → 這是修正而非退化；在 HANDOFF §7 記錄改前 / 改後 live-scan 數字。
- [Pionex 無週期欄位] → `interval_source = 'UNKNOWN'`；配對不需要週期（只需對齊），但 Pionex 不在 `trading_exchanges`，不影響 Paper Trading。
- [註冊表首次刷新失敗導致 live-scan 503] → 非阻塞啟動 + 逐所隔離；只要有 ≥ 2 所成功即可配對。
- [Bitget 結算時間由 5 分鐘刷新提供，結算後短暫 `STALE`] → 偵測到 `STALE` 即提前刷新；`STALE` 期間該腿被否決（`FUNDING_TIME_MISSING`），不會用錯誤時間。
- [metadata 端點權重（Binance `exchangeInfo` 權重未查證）] → 每小時一次，對 2400/分的預算可忽略；`websocket-data-layer` 會納入限流預算。

## Migration Plan

1. 在 `feature-instrument-registry`（來自 `develop`）開發；先加特性測試與新模組（純新增，不影響 `main`）。
2. 切換 `server.ts` 為最後步驟之一，切換前後各打一次 `/api/market/live-scan` 並記錄 `total_matched_pairs`、`exchange_counts`、前 10 名，寫入 HANDOFF §7。
3. `--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`（技術書 §51.3）。註冊表無持久化資料，不需資料遷移。

## Open Questions

1. `price_mismatch_tolerance_pct` 預設 2% 是否合適？高波動幣在跨所價差大時可能誤殺——建議以 Paper 數據校準。
2. Pionex 資金費週期要不要以歷史結算紀錄推算（需查證 Pionex 是否有公開的 funding history 端點）？目前標 `UNKNOWN`，不影響 Paper Trading。
3. TradFi 股票永續（`TRADFI_PERPETUAL`）日後是否要以獨立規則納入研究掃描？目前登錄但不可配對。
4. `multiplier_overrides` 放在 `PaperTradingConfig`（有 `config_version`）還是獨立設定檔？建議前者，讓每筆 Opportunity 可追溯使用的覆寫版本。
