# HANDOFF 交接規範

> 給**下一位接手者**（人或 AI agent）的單一入口。先讀完本檔再動 code。
> 使用者導向的說明在 [`../README.md`](../README.md)；本檔講「怎麼接著做、不能踩什麼」。
> 先看架構圖：[`ARCHITECTURE.md`](ARCHITECTURE.md)。安裝、測試與手動驗證步驟：[`TESTING.md`](TESTING.md)。
> 詳細問題清單（25 個，含實測與參考）：[`../issue/README.md`](../issue/README.md)。
> 下一階段規格：[`../docs/TRADING_SYSTEM_SPEC.md`](../docs/TRADING_SYSTEM_SPEC.md)（Paper Trading v0.2，What）＋ [`../docs/PAPER_TRADING_TECH_SPEC.md`](../docs/PAPER_TRADING_TECH_SPEC.md)（開發技術書，How）。**兩份文件中標 ⚠️ 待決 C-xx 的段落，決定前不得實作。**

- 最後更新：2026-09-30
- 基準 commit：`95535ca`（GitHub `main` 與本地 `funding` 分支相同）
- 程式來源：Google AI Studio（Gemini）一次生成，**尚未經過人工逐行審查**

---

## 0. 接手前 5 分鐘檢查

```bash
npm install --legacy-peer-deps   # 不加會因 esbuild 版本衝突失敗
npm run lint                     # 基準：通過（0 error）
npm run build                    # 基準：通過
npm test                         # 基準：全綠（不打真實 API）；npm run check = lint → build → test
npm run dev                      # http://localhost:3000
curl -s localhost:3000/api/market/live-scan | head -c 300   # 應回 success:true
```

2026-09-30 實測基準：lint ✅、build ✅、`live-scan` 回 803 組配對（Pionex 439 / Binance 726 / Bybit 725 / Bitget 702 / OKX 467），耗時約 4.3s；`/api/latency/ping` 5 所皆有回應。
**如果你的結果和這個基準差很多，先查原因再開發。**

## 1. 專案目標與範圍

**目標**：低風險跨交易所資金費率套利——同幣種、兩所對沖（低費率做多 / 高費率做空），領取費率差。

**階段**（2026-09-30 依規格書 v0.2 §1.1 / C-04 改為五階段；目前在 ① → ③ 的前置工作）：

| 階段 | 內容 | 狀態 |
|------|------|------|
| ① Research | 5 所即時掃描 + 歷史/結算窗口分析 + 獲利邊界 | 🟡 掃描可用，歷史資料為 mock |
| ② Dry-run | 現有劇本式流程展示 | 🟠 凍結，不再加功能 |
| ③ Paper Trading | 即時行情 + 模擬撮合 + 完整交易紀錄（Binance × Bybit） | ⬜ 規格完成，前置工作未開始 |
| ④ Backtest vs Paper 驗證 | 同 Schema 回測與 Paper 比對 | ⬜ |
| ⑤ Small Capital Live | 真實下單 | ⛔ 不存在，**未經使用者明確批准不得開始** |

**使用者的 6 項需求**（任何改動都要能對應回其中一項）：

1. 多所同時有該合約、成交量穩定 → 選出最佳交易所組合
2. 結算前後 5 分鐘 K 棒震盪 & 成交量 → 評估滑價
3. Dry-run 模擬：滑價、API 回應異常、手續費、是否成交、投入成本差異；並有「費率 × 獲利」邊界表
4. 共用 Schema，新增交易所照框架即可
5. 新手可照流程讀懂的說明書（要更簡單）
6. 其餘待開發

## 2. 名詞

| 名詞 | 定義 |
|------|------|
| funding rate | 每次結算的費率，**小數**（0.0001 = 0.01%），正值 = 多付空 |
| spread | 兩所費率差 `abs(rA − rB)`（⚠️ 目前未依結算週期正規化） |
| T | 資金費結算時刻；`T-30s` 進場、`T+30s` 出場為目前實驗設定 |
| fee drag | 4 筆 taker 手續費總和，預設 0.20% |
| leg | 對沖的一邊（long leg / short leg） |
| LEG_IMBALANCE | 一腿成交、另一腿失敗 → 產生裸部位，必須立即平倉 |
| Truth Layer | 交易所 API（可作為下單/部位依據） |
| Intelligence Layer | CoinGlass 等聚合資料（只能參考，不可下單） |

## 3. 不可違反的規則（Invariants）

違反任何一條 = PR 不接受。

1. **不送真實訂單**。真實下單 / 撤單端點不得出現在程式碼中，直到階段 ⑤（Small Capital Live）另立 OpenSpec change 並經使用者明確批准。Paper Trading 可呼叫**唯讀**私有端點（手續費等級、限流額度、權限檢查）。（2026-09-30 依 C-08 修訂）
2. **憑證隔離**：API Key/Secret 只放 `.env.local`（`.gitignore` 的 `.env*` 已排除，不要改），只由 Runtime（Node）讀取；不得出現在前端、Common Schema、`TradingEvent.payload`、log、錯誤訊息、匯出檔、git。Key 權限必須為 Read-only、禁止 Withdraw。（2026-09-30 依 C-08 修訂）
3. **策略/引擎層不得出現交易所名稱分支**。交易所差異只能存在 `src/adapters/` 與（過渡期）`server.ts` 的抓取段。
4. **不得假設 8 小時結算**；週期與結算時間必須來自交易所回傳值。
5. **費率一律存小數**；UI 顯示時才 ×100。
6. **Cancel ≠ Close**：模擬或實作訂單狀態時，未成交單走 cancel、已成交部位走 close。
7. **mock 必須標示**：任何 UI 若顯示 mock / 寫死數值，畫面上要能看出來，README §4 表格要同步更新。
8. **改公式必附測試**（見 §5 DoD）。

## 4. 目前架構與已確認的問題

### 4.1 資料流

完整架構圖與元件索引見 [`ARCHITECTURE.md`](ARCHITECTURE.md)（互動版 [`architecture.html`](architecture.html)）。**本圖尚未同步** `websocket-data-layer`（使用者已決定 ARCHITECTURE 圖重繪留到所有 change 做完的最後一輪，見本節下方文字說明）。

> 2026-10-01（`websocket-data-layer`）：請求路徑與上游抓取已脫鉤，取代下圖第一行。

```
交易所公開 API ──► runtime/src/market/marketDataService（WS + POLL，背景常駐）──► MarketState（記憶體最新值表）
                     └ adapters/<exchange>/marketData.ts 解析（feed 描述、限流規則表只在這裡）

server.ts (/api/market/live-scan) ──► 只讀 MarketState + registry.matchPair（請求路徑 0 次上游呼叫）──► liveMarketService ──► FunnelScannerView / DryRunConsole

adapters/<exchange>/instruments.ts ──► InstrumentRegistry（合約 metadata，1 小時刷新，獨立於上面的即時行情）
adapters/*Adapter.ts（舊，src/adapters/）──► 只被 SchemaInspector（展示頁）使用
mockMarketData.ts ──► ArbitrageScanner / SettlementKlineViewer / ExecutionSimulator
funnelScanner.ts (15 個寫死幣) ──► App.tsx 預設候選、Dry-run Top3
```

- **GuardedRestClient**（`runtime/src/market/http/guardedRestClient.ts`）：single-flight、限流規則表 + 標頭用量、斷路器（`OPEN`/`HALF_OPEN`/`CLOSED`）、錯誤分類。`server.ts` 的 `restClient` 現在是這個（原本的 `BasicRestClient` 已移除）；`instrument-registry` 的 metadata 刷新（`refreshBinance` 等）與即時行情共用同一個實例、同一組限流規則表。
- **RealClock 校正**：`server.ts` 每 30 s 對 5 所各呼叫一次 `queryServerTime`（經 `GuardedRestClient`，不做 single-flight）校正 `clock.calibrate(exchange, sample)`；live-scan 的 `time_to_settlement_sec` 用 `clock.now()`。
- **SourceStatus**：每所 `HEALTHY`/`DEGRADED`/`FAILED`/`RATE_LIMITED`/`INITIALIZING`，隨 live-scan 回應的 `sources` 欄位（含 `rate_limit.used/limit/circuit`）一併回傳，取代原本只有 `registry_sources`（合約 metadata 來源狀態，兩者不同、都保留）。

### 4.2 已確認問題（依對結果正確性的影響排序）

> 2026-09-30 深度 review 後，每項的詳細證據與 Top 3 解方見 [`../issue/`](../issue/README.md)。P5 已被推翻、P11 可結案，見 issue 索引 §4。

| ID | 問題 | 位置 | 影響需求 |
|----|------|------|---------|
| P1 | ✅ 已解（`instrument-registry`）：配對改為兩腿下次結算時間差 ≤ 60s 才成立，週期取各所回傳值。原描述：不同結算週期（1h/4h/8h）的費率直接相減；Binance/Bitget/OKX 週期寫死 8 | `runtime/src/market/instruments/matching.ts` | #1 |
| P2 | ✅ 已解（`instrument-registry`）：`matchPair` 逐腿比對結算時間，不再取 min。原描述：兩腿結算時間未檢查是否一致，取 `min(nextFundingTime)` 當 T | `runtime/src/market/instruments/matching.ts` | #1 #3 |
| P3 | ✅ 已解（`instrument-registry`）：每腿各自的 24h 量，缺值直接淘汰。原描述：24h 量只取 Binance；缺值填 `10,000,000`（實測 PUFFERUSDT 命中）→ 冷門幣看起來有量 | `server/liveScanRegistry.ts` | #1 |
| P4 | 🟡 Runtime 已解（`net-cost-model` `slippageEngine` + `websocket-data-layer` `orderBookService` 提供真實盤口）；研究端 live-scan 仍以 `LEGACY_VOLUME_TIER` 明確標示過渡——盤口已到 Runtime，但研究端 `server/liveScanMath.ts` 還沒接上，待下一輪決定要不要做。原描述：即時滑價 = 依量分三級常數，未用盤口深度 / K 棒波動 | `server/liveScanMath.ts` `computeLiveScanNetPnl` | #2 |
| P5 | ~~各所費率欄位語意未對齊~~ **已推翻**：兩者皆為預測值，實際風險見 Q-04。原描述：Binance 用 `lastFundingRate`、Pionex 用 `nextFundingRate`（當期 vs 預測，**需查官方文件確認**） | `server.ts:183,198` | #1 |
| P6 | ✅ 已解（`instrument-registry`）：以 `instrument_key` + 價格倍數配對，反向合約不再併入線性合約（舊函式與 `[Q-xx] 現況` 測試保留為歷史紀錄，server 已不呼叫）。原描述：`extractBaseSymbol` 去掉 `1000` 前綴但沒換算倍數；且 `replace('USDT','')` 只替換第一次出現 | `runtime/src/market/instruments/canonical.ts` | #1 #3 |
| P7 | 🟡 Runtime 端已解（`risk-engine-kill-switch` 第 1–3 組）：`runtime/src/risk/` 28 項檢查皆由注入輸入計算、輸入缺失一律 FAIL（`coverage.test.ts` 強制每項有 FAIL 測試）；研究原型 `dryRunEngine.ts` 凍結不回改，UI 仍標示。原描述：Dry-run 數值寫死：延遲依交易所名稱三元式、價格漂移固定 ±0.008%、保證金 `$5,000`、風控 r5/r7/r9 永遠 PASS；唯一失敗情境是單腿 429 | `dryRunEngine.ts` | #3 |
| P8 | 部分成交、API timeout、重試、費率在 T 前翻轉，皆未模擬 | `dryRunEngine.ts` | #3 |
| P9 | ✅ 已解（`net-cost-model`）：Fee Engine 依交易所 / maker-taker 取費率（`DEFAULT_FEE_TABLE` 數值待查證）；`dryRunEngine` 改讀 Fee Engine。原描述：手續費固定 taker 0.05%，無各所 / maker / VIP 設定 | 多處 | #3 |
| P10 | 兩套型別並存：`schema.ts` 以 Pionex×Binance 為中心（`pionex_rate`/`binance_rate`），`systemSpec.ts` 以 5 所欄位平鋪；交易所清單在 ≥6 處重複定義 | `types/`、`server.ts`、`liveMarketService.ts` | #4 |
| P11 | ✅ 可結案（實測 `instId=ANY` 回 717 筆）。OKX 用 `funding-rate?instId=ANY` 批次取費率，實測 OKX 有 467 筆有費率，但此參數行為**未查證官方文件** | `server.ts:98` | #1 |
| P12 | Local Secret Vault 以明文存 `localStorage` | `LocalSecretsView.tsx:71` | 安全 |
| P13 | ✅ 已解（`d9813a4`，change `setup-vitest`）：vitest 5 + 特性測試基準，`npm run check` 為本機合併門檻。原描述：無測試框架、無任何測試 | — | 全部 |
| P14 | AI Studio 遺留：`package.json` name=`react-example`、未使用的 `@google/genai`、`GEMINI_API_KEY`、`metadata.json` | 根目錄 | #5 |
| P15 | `npm install` 需 `--legacy-peer-deps`（devDependency `esbuild@^0.25` 與 vite 8 衝突） | `package.json` | #5 |

### 4.3 新增一個交易所目前要改的地方

這份清單本身就是 P10 的症狀——目標是縮到「新增 1 個 adapter 檔 + 註冊 1 行」。

> 2026-10-01（`instrument-registry`）：**合約 metadata** 已達成目標——新增交易所只需一個 `runtime/src/adapters/<exchange>/instruments.ts` 正規化函式（產出 `InstrumentSnapshotInput[]`，參考 binance / bybit / okx / bitget / pionex）並在 `server.ts` 的 metadata 刷新註冊；`runtime/src/market/instruments/` 不需修改（不得出現交易所名稱，`runtime/test/instrumentsNoExchangeLiteral.test.ts` 把關）。結算規則表另需在 `runtime/src/venue/venueRules.ts` 補該所規則。下列 1–7 仍適用於研究 UI 的舊型別與費率抓取段。

1. `src/types/schema.ts` → `ExchangeId`
2. `src/types/systemSpec.ts` → `SupportedExchange`、`SimulatedOrderLeg.exchange`、`FunnelCandidate` 各欄位、`TimelineMilestone.exchange`、`LocalSecretsConfig`
3. `src/adapters/<name>Adapter.ts` → 新增 raw type、`FIELD_MAPPING_DOC`、`mapXToCommon`
4. `server.ts` → `ExchangeName`、fetch promise、解析段、`EXCHANGES`、`exchange_counts`、candidate 輸出欄位、`/api/latency/ping`
5. `src/services/liveMarketService.ts` → `ExchangeName`、`LiveMarketCandidate` 欄位、`exchange_counts`
6. `src/engine/dryRunEngine.ts` → 延遲三元式
7. UI：`SchemaInspector`、`FunnelScannerView`、`LocalSecretsView`

## 5. 完成定義（Definition of Done）

一個改動要宣稱「完成」，必須全部滿足：

- [ ] 能對應到 §1 的需求編號或 §4.2 的問題 ID
- [ ] `npm run check`（= lint → build → test）全綠
- [ ] 改到公式 / 引擎 / adapter → 有自動化測試，且附「改前失敗、改後通過」證據；修正已被特性測試鎖住的 bug（測試名稱含 `[Q-xx]` 與「現況」）時，同一 PR 改寫該測試，不得以 `vitest -u` 或刪測試帶過
- [ ] 改到即時資料 → 實際打一次 `/api/market/live-scan` 並記錄結果
- [ ] 資料來源有變（mock ↔ live）→ 更新 README §4
- [ ] 更新本檔 §4.2（解掉的問題標 ✅ 並附 commit）與 §7 交接紀錄

「畫面看起來對」「應該可以」不算驗證。

## 6. Backlog（優先序）

排序原則：**先讓掃描結果可信（#1），再讓 dry-run 可信（#3），最後才擴充與美化。**

| ID | 項目 | 解決 | 規模 |
|----|------|------|------|
| B0 | ✅ 完成（change `setup-vitest`）：建立 vitest，先為 `arbitrageEngine`、`extractBaseSymbol`、spread 計算補特性測試（鎖住現有行為） | P13 | S |
| B1 | 修 `npm install` 依賴衝突；清掉 AI Studio 遺留 | P14 P15 | S |
| B2 | 費率正規化：各所取真實週期，spread 改為「同一結算時點實際收付」或「換算成每小時」比較，並在 UI 標示 | P1 P5 | M |
| B3 | ✅ 完成（`instrument-registry`）：結算時間對齊：只配對兩腿結算時間差 ≤ 容忍值（如 60s）的組合 | P2 | S |
| B4 | 流動性改為每所各自的 24h 量 + 盤口深度；缺資料 = 淘汰而非填預設值；加最低量門檻 | P3 P4 | M |
| B5 | ✅ 完成（`instrument-registry`）：符號正規化：處理 `1000x` 倍數、改用各所 instrument info 對照 | P6 | M |
| B6 | server 改走 `adapters/` 並統一型別：`Record<ExchangeId, …>` 取代平鋪欄位，交易所註冊表集中一處 | P10 | L（建議拆 2 個 change） |
| B7 | 歷史結算窗口：抓真實「結算時刻 ±2m」1m K 棒（非最近 5 根），供需求 #2 | #2 | M |
| B8 | Dry-run 情境引擎：可設定 seed 的隨機延遲、部分成交、timeout/重試、費率翻轉、滑價分布；輸出多次模擬的損益分布 | P7 P8 | L |
| B9 | ✅ 完成（`net-cost-model`）：手續費設定化（每所 maker/taker/VIP） | P9 | S |
| B10 | 新手模式：首頁「一條龍」流程（選幣 → 看風險 → 看邊界 → dry-run），隱藏進階分頁 | #5 | M |
| B11 | Secret Vault 改為不持久化或加密；在真正需要下單前可考慮直接移除 | P12 | S |
| B12 | 舊型別遷移 1/6：`OrderState`（v0.1）→ `PaperOrder.order_state`，改 import `runtime/src/types` | P10 | S |
| B13 | 舊型別遷移 2/6：`SimulatedOrderLeg` → `PaperOrder` + `Fill` | P10 | M |
| B14 | 舊型別遷移 3/6：`PositionState` → `Trade.status`（`TradeStatus`） | P10 | M |
| B15 | 舊型別遷移 4/6：`TimelineMilestone` → 由 `TradingEvent` 絕對時間戳推導 | P10 | M |
| B16 | 舊型別遷移 5/6：`ArbitrageTradeResult` → `TradeResult` | P10 | M |
| B17 | 舊型別遷移 6/6（最後，依賴 Runtime scanner）：`FunnelCandidate` → `Opportunity` | P10 | L |
| B19 | 術語表補條目：`SESSION`（WATCH…SKIPPED，規格書 §26.4）、`HEALTH`（Runtime Health 狀態，待 `runtime-health-reconciliation`）、風控 `reason_code` 中英對照；目前 UI 對這些代碼顯示「術語表缺少此代碼」 | — | S |
| B20 | Paper UI 發現的上游型別缺口：`AccountSnapshot` 無 `max_positions`（UI 顯示 —）、`FundingSettlement` 無 `interval_hours`、`PaperOrder` 無每腿 USDT 滑價歸因；由 `position-funding-pnl` / `trading-event-store` 決定是否補欄位 | P10 | S |
| B21 | 風控持續檢查的排程（`entry_risk_interval_ms` / `position_risk_interval_ms`）尚未接上主迴圈：`EntryRiskMonitor` / `PositionRiskMonitor` 的 `start` / `continue` / `end` 由 `paper-execution-engine` 呼叫 | — | S |
| B18 | event-loop 剩餘本地型別改用 `TradingEvent`：`SessionPhaseChangedEvent`、`OpportunityEvent`（及 `PositionSide`、`TradeHedgeState`、`SessionPhase` 的歸屬），見 `runtime/src` 內 `TODO(trading-schema-types)` | — | S |

B12–B17 每一步：先寫特性測試鎖住現況 → 遷移 → `npm run check` 全綠（C-11 規則 1）。

## 7. 交接紀錄格式

每次結束一段工作（或換人 / 換 agent）時，在本節**最上方**新增一筆：

```markdown
### YYYY-MM-DD — <作者或 agent>
- **做了什麼**：<對應需求 # / 問題 P# / Backlog B#>
- **驗證證據**：<指令 + 結果；測試名稱；live-scan 實測數字>
- **沒做完 / 已知問題**：<具體到檔案:行號>
- **下一步建議**：<1–3 項，指向 Backlog ID>
- **需要使用者決定的事**：<沒有就寫「無」>
```

### 2026-10-03（2）— Claude Sonnet 5，`position-funding-pnl`（分支 `feature-position-funding-pnl`，來自 `design/position-funding-pnl-contract-final`）
- **做了什麼**：實作 OpenSpec change `position-funding-pnl`（capability `position-accounting` + `pnl-engine`）tasks 1.1–5.1 全部 12 項完成：
  - Position：`runtime/src/types/account.ts` 的 `PaperPosition` 加法欄位（`base_quantity`/`entry_filled_quantity`/`exit_filled_quantity`/`entry_notional_usdt`/`average_exit_price`/`realized_price_pnl_usdt`/`fees_usdt`/`slippage_attribution_usdt`/`applied_fill_ids`），搭配可逆遷移 `runtime/src/storage/migrations/002_position_accounting_fields.ts` 與 `orderRepository.ts` 持久化；`runtime/src/trading/positionManager.ts`（純函式 `applyFill`）：加權平均開倉、逐筆實現平倉 PnL（`average_entry_price` 凍結）、`fill_id` 冪等、`RECONCILIATION_ERROR`/`POSITION_OVERCLOSE`/`UNKNOWN_ORDER`/`UNSUPPORTED_FEE_ASSET`、`unrealizedPnl`；經 `Ledger.applyFill` 與 Fill/Order/`POSITION_OPENED`/`POSITION_CLOSED` 事件同一交易原子寫入。
  - Hedge ratio / imbalance：`runtime/src/trading/hedgeRatio.ts`——`computeHedgeRatio`（`NOTIONAL`/`QUANTITY` 可切換，預設 `QUANTITY`，✅ C-19）、`classifyHedge`（`HEDGED`/`PARTIALLY_HEDGED`/`LEG_IMBALANCE`，邊界 0.99/0.90，symbol tier 覆寫）、`updateLegImbalance`（連續不平衡區間量測）。
  - FundingSettlement 金額：`runtime/src/trading/fundingAmount.ts`（`fundingAmount(state, input)` hook，正式釘選簽章，呼叫 `cost-model.fundingCashflow`）；task 3.2 發現並記錄一個循環 import 限制（見下「沒做完」）；`src/engine/dryRunEngine.ts:151` 修正 Q-08（單腿失敗時不對沖的一腿也不計資金費，因為它會在結算前被緊急平倉）。
  - TradeResult：`runtime/src/accounting/pnlEngine.ts`（`aggregatePnl`/`roiOnNotional`/`roiOnCapital`，含 Q-05「滑價不重複扣除」迴歸測試）、`runtime/src/accounting/tradeResultAssembler.ts`（`assembleTradeResult`：暫定 → 定案，`final_status`/`result_reason` 優先序，重用 `funding-settlement-rules` 的 `finalizeTradeResult`）。
  - 情境測試：`runtime/test/scenarios/positionFundingPnl.scenario.test.ts`（S01 完整成功、零成交 ABORTED、單腿 EMERGENCY_EXIT 三情境，Position → FundingSettlement → TradeResult 全鏈）。
  - 文件：規格書 §14（`hedge_ratio_basis` 設定欄位 + 已實作註記）、§21（TradeResult 欄位計算方式已實作註記）；技術書 §20–§23（已實作註記）、§38（新增 `hedge_ratio_basis`、`break_even_tolerance_usdt`）。
- **驗證證據**：
  - fail-then-pass（唯一真正的 bug 修正，task 3.3 Q-08）：`src/engine/dryRunEngine.test.ts` 先改既有測試斷言 `funding_pnl.leg_long` 應為 `0`，確認紅燈（`expected 0, got -0.1`），修正 `dryRunEngine.ts:151` 後轉綠（9/9 tests）。其餘 11 項任務為新模組（無既有 bug 可先紅燈），採先寫測試鎖住 tasks.md/spec 的數字案例、每個模組完成後 100% 綠的方式驗證（非嚴格 red-green-refactor，已在最終報告中註明此偏離）。
  - `npm run lint`（`tsc --noEmit`）→ 無輸出（通過）。
  - `npm run build`（vite build）→ 1721 modules transformed，✓ built in 656ms。
  - `npm test`（`vitest run`）→ **128 個測試檔、1179 個測試全過**（含新增 11 個測試檔：`hedgeRatio.test.ts` 15、`positionManager.test.ts` 14、`fundingAmount.test.ts` 7、`fundingAmount.crossCheck.test.ts` 3、`pnlEngine.test.ts` 8、`tradeResultAssembler.test.ts` 10、`positionFundingPnl.scenario.test.ts` 3，以及既有 `dryRunEngine.test.ts` 修正後 9）。
  - `npx openspec validate position-funding-pnl --strict` → `Change 'position-funding-pnl' is valid`。
  - 分支 `feature-position-funding-pnl`，起點 `design/position-funding-pnl-contract-final` tip `4bc792d`。
- **沒做完 / 已知問題**：
  - **task 3.2 偏離 design.md 字面敘述，已於 tasks.md 3.2 記錄**：design.md 建議「若狀態機已自帶現金流計算，改為呼叫 `fundingAmount`」，但 `funding/settlementInference.ts`（`funding-settlement-rules` 狀態機，屬已合併的 `paper-trading-event-loop`）無法直接呼叫 `trading/fundingAmount.ts`——`accounting/fundingMath.ts`（`fundingAmount` 的依賴）已反向 import `settlementInference.ts` 的 `computeSettlementCashflow`，形成循環 import。兩者皆為同一原語的薄包裝（Q-07 已透過共用原語滿足，無口徑分裂風險），改以 `runtime/src/trading/fundingAmount.crossCheck.test.ts` 的等價性測試鎖住，而非實際改寫呼叫關係。若未來要真的讓狀態機呼叫這份 hook，需要先把 `computeSettlementCashflow` 這個原語搬到兩者都能安全 import 的更底層模組（例如直接搬進 `cost-model`），屬於下一輪的重構，不在本 change 範圍內。
  - `runtime/src/trading/` 目錄目前只有本 change 的 `hedgeRatio.ts`/`positionManager.ts`/`fundingAmount.ts`；`paper-execution-engine` 尚未落地，其 `entryCoordinator.ts`/`exitCoordinator.ts`（會 import 本 change 的 `computeHedgeRatio`/`classifyHedge`）與 `PositionReader.getOpenQuantity` port 仍待該 change 實作時對齊（CONTRACT_MEMO_SKEPTIC.md §1 已指出的既知缺口，非本 change 缺陷）。
  - `tradeResultAssembler.ts` 不會自己呼叫 `Ledger`/`EventStore` 寫入 `TRADE_COMPLETED`——`shouldEmitTradeCompleted` 只是純函式判斷式，實際接線（何時呼叫 `assembleTradeResult`、何時提交 `TradeResult` 到資料庫）留給尚不存在的 Runtime 主迴圈 / Trade Manager（`paper-execution-engine` 或其後續 change）。
  - `positionManager.applyFill` 的 `contractMultiplier` 由呼叫端傳入（未直接依賴 `InstrumentRegistry`），維持純函式特性；呼叫端整合 `instrument-registry` 的 `qty_unit_in_base` 查詢為下一輪工作。
- **下一步建議**：
  1. `paper-execution-engine` 落地時：import `runtime/src/trading/hedgeRatio.ts` 的 `computeHedgeRatio`/`classifyHedge`（不要重新實作），並對齊 `PositionReader.getOpenQuantity` 回傳 `positionManager` 的 `base_quantity`。
  2. Runtime 主迴圈／Trade Manager 落地時：在 Trade/Leg 終態事件處呼叫 `assembleTradeResult`，並用 `shouldEmitTradeCompleted` 判斷是否需要寫入一筆 `TRADE_COMPLETED`。
  3. 若要真正讓 `funding-settlement-rules` 呼叫 `fundingAmount`（而非目前的等價性測試），需要先把 `computeSettlementCashflow` 搬到兩者共同的更底層模組，解開循環 import。
- **需要使用者決定的事**：無新增；舊的非框架待定項（最低流動性門檻、`slippage_safety_buffer_pct`、`basis_sigma_pct`、`DEFAULT_FEE_TABLE` 官方查證、`research_min_net_pnl_usdt`）持續提醒，不影響本次交付。

### 2026-10-03 — Claude (Opus 5.5)：KS-6 決議
- **做了什麼**：使用者確認 KS-6（Kill Switch 解除規則，design.md Open Question 3，非 C-16 原五題範圍）採用推薦方案——只能手動解除、清理中拒絕解除、來源恢復不自動解除。核對 `runtime/src/risk/killSwitch.ts` 的 `release()` 本來就是依此實作，**不需要改程式碼**；只更新文件標記：`openspec/changes/risk-engine-kill-switch/design.md`（Open Questions 1/2/3、Decision 6 附近的「推薦方案的延伸」註記）、`specs/kill-switch/spec.md`（Requirement「只能手動解除」移除「待決議」但書）。順便把同一份 Open Questions 清單裡早該更新卻漏掉的 C-16、C-19 也標為已決議（2026-10-02 那輪決議時漏改了這個檔案的 Open Questions 區）。
- **驗證證據**：純文件變更，不影響程式邏輯；`npm run check` 未重跑（無程式變更），`openspec validate risk-engine-kill-switch --strict` 待下次 check 確認仍通過。
- **沒做完 / 已知問題**：無新增。
- **下一步建議**：KS-6 不再需要提醒；其餘非框架待定項（最低流動性門檻、`slippage_safety_buffer_pct`、`basis_sigma_pct`、`DEFAULT_FEE_TABLE` 官方查證、`research_min_net_pnl_usdt`）持續提醒。
- **需要使用者決定的事**：無新增（KS-6 已決議）。

### 2026-10-02（2）— Claude Sonnet 5，`risk-engine-kill-switch` group 4（分支 `feature-kill-switch-c16`）
- **做了什麼**：C-16 決議後實作 `risk-engine-kill-switch` 第 4 組（Kill Switch，之前 blocked）。`runtime/src/risk/killSwitch.ts`（`KillSwitchCoordinator`）：三層分級 `NONE < L1_STOP_ENTRY < L2_CANCEL_ENTRY < L3_FLATTEN`，只升不降（`activate()`）、手動解除（`release()`，清理中拒絕）、L1 `applyL1`（`CREATED`/`PRE_FLIGHT` → `abortTrade`）、L2 `applyL2`（只對 `has_open_entry_orders` 的 Trade 呼叫 `cancelEntryOrders` + 全面 `rejectFurtherEntry`）、撤單重試（`handleOrderCancelRejected`，`Clock.after` 排程，用盡後 `KILL_SWITCH_CANCEL_FAILED`）、撤單後分類（`handleEntryOrdersSettled` + 匯出的純函式 `classifyAfterEntryCancel`，依 `hedge_ratio_hedged_min` 分 `ABORTED`/`HEDGED`/`LEG_IMBALANCE`）、L3 兩段式確認（`requestFlatten`/`confirmFlatten`，一次性 token + TTL，逾時/錯誤碼 → `KILL_SWITCH_FLATTEN_REJECTED`，絕不送出平倉單）、L3 `applyL3`（對 `HEDGED`/`PARTIALLY_HEDGED`/`LEG_IMBALANCE` 送 `startEmergencyExit`，跳過已在 `EXIT_PENDING`/`EMERGENCY_EXIT` 的 Trade）、自動觸發（`handleAutoTrigger`：`EXCHANGE_DISCONNECTED`/`STALE_MARKET_DATA` → L1，`RECONCILIATION_ERROR` → L1 + `failTrade`；`CLOCK_UNRELIABLE` 無對應 case）、事件重建（`static rebuildLevel(events)` 從 `KILL_SWITCH_ACTIVATED`/`RELEASED` 重建層級，`restoreLevel()` 安裝、不發事件）、`entryGateSource()` 給 `ENTRY_GATE` 注入。六個新事件碼加入 `runtime/src/types/event.ts`（`KILL_SWITCH_EVENT_TYPES`，含 `NO_TRADE_EVENT_TYPES`）與 `glossary.ts`（6 筆條目）。`RiskConfig`/`DEFAULT_RISK_CONFIG` 新增 4 個設定欄位。`openspec/changes/risk-engine-kill-switch/specs/kill-switch/spec.md` 移除「待 C-16」標記（KS-6 解除規則因不在 C-16 原題範圍，改標為獨立待決項 KS-6，見下）。
- **驗證證據**：fail-then-pass（`killSwitch.test.ts` 26 tests 先紅後綠，含修正 cancel-retry 迴圈次數的一次失敗）；`runtime/test/scenarios/riskEngine.scenario.test.ts` 新增 Scenario S11（`ENTRY_PENDING`/`HEDGED`/`EXIT_PENDING` 三筆 Trade 依序 L1→L2→L3，斷言 3 筆 `KILL_SWITCH_ACTIVATED`、`close_reason`/撤單/平倉指令、事件時間單調不減）；`npm run lint`（`tsc --noEmit`）通過；`npm run build`（vite build，1721 modules）通過；`npm test`（`vitest run`）**121 個測試檔、1119 個測試全過**；`npx openspec validate risk-engine-kill-switch --strict` → `Change 'risk-engine-kill-switch' is valid`。分支 `feature-kill-switch-c16`，起點為 `develop` tip `816a82b`。
- **沒做完 / 已知問題**：
  - `paper-execution-engine` 不存在，`KillSwitchExecutionPort`（`cancelEntryOrders`/`rejectFurtherEntry`/`startEmergencyExit`/`abortTrade`/`failTrade`）只有測試用的假實作；`runtime/src/risk/riskCoordinator.ts` 既有的 `ExecutionCommandPort`（3 個方法）與這裡的 `KillSwitchExecutionPort`（5 個方法）是兩個獨立較窄的 port，尚未合併成單一介面——留給 `paper-execution-engine` 落地時視其內部分工決定是否合一。
  - Kill Switch 不自己維護 Trade 清單：`activate`/`confirmFlatten` 每次呼叫都需要呼叫端傳入當下的 `KillSwitchTradeSnapshot[]`；呼叫端（尚不存在的 Runtime 主迴圈／`paper-execution-engine`）要負責組這份清單。
  - `handleOrderCancelRejected`/`handleEntryOrdersSettled` 是本 change 設計的「回呼」方法，假設 `paper-execution` 會在 `ORDER_CANCEL_REJECTED` 與「該 Trade 的進場單皆終態」時呼叫；這個事件轉呼叫的接線本身不存在（design.md §8 列出的介面沒有涵蓋回呼方向），等 `paper-execution-engine` 落地時需對齊。
  - 鎖定區間 `NOT_ELIGIBLE` 標記屬 `funding-settlement-rules`，本 change 只送出 `startEmergencyExit` 請求，不實作 `FundingSettlement` 狀態機。
  - Runtime 啟動時「ARM 前恢復 Kill Switch 層級」尚無真正的啟動序列可掛（`static rebuildLevel` + `restoreLevel` 已可獨立測試，呼叫時機留給未來的 Runtime 入口）。
  - KS-6（Kill Switch 解除規則：只能手動、清理中拒絕、來源恢復不自動解除）是 design.md Open Question 3，不在 C-16 原五題範圍內，依推薦方案實作但**尚未經使用者書面決議**——需持續提醒。
  - 文件部分：`docs/TRADING_SYSTEM_SPEC.md` §22.1 28 項表格加上 `failAction` 欄；`docs/PAPER_TRADING_TECH_SPEC.md` §38 加 4 個新設定欄位、§11 新增 11.1 對照小節、§27 新增 27.2 `reason_code` 中英對照表。
- **下一步建議**：
  1. `paper-execution-engine` 落地時：實作 `KillSwitchExecutionPort`，接上 `ORDER_CANCEL_REJECTED`/進場單終態事件呼叫 `handleOrderCancelRejected`/`handleEntryOrdersSettled`，並在自身啟動序列裡呼叫 `KillSwitchCoordinator.rebuildLevel`/`restoreLevel`。
  2. `paper-trading-ui` 的三顆按鈕可直接呼叫 `activate`/`release`/`requestFlatten`/`confirmFlatten`。
  3. 請使用者確認 KS-6（解除規則）是否採用本 change 的推薦方案。
- **需要使用者決定的事**：KS-6（Kill Switch 解除規則，design.md Open Question 3）——已依推薦方案實作，待書面確認；非框架待決項（最低流動性門檻、`slippage_safety_buffer_pct`、`basis_sigma_pct`、`DEFAULT_FEE_TABLE` 官方查證、`research_min_net_pnl_usdt`）持續提醒，不影響本次交付。

### 2026-10-02 — Claude (Opus 5.5)：C-16、C-19 決議
- **做了什麼**：把規格書 §34 僅剩的兩個待決項（C-16 Kill Switch 分層、C-19 hedge ratio 計算基準）整理成選項，交由使用者逐項選擇；全數採用設計文件已準備的推薦方案。寫回：規格書 §23（Kill Switch 改為三層分級敘述）、§14（hedge_ratio 公式改用合約乘數換算後的基礎資產數量，並更新 §14.1 `hedged_min` 推導）、§34 決策紀錄（C-16、C-19 兩列皆標 ✅）；技術書 §33（Kill Switch 三層表格）；`risk-engine-kill-switch` design.md/tasks.md（group 4 解除 blocked-by C-16，Decision 6/7 標記已決議）；`position-funding-pnl`、`paper-execution-engine` 的 design/proposal/tasks 把 `hedge_ratio_basis` 預設從 `NOTIONAL` 改為 `QUANTITY`；`runtime-health-reconciliation` design.md 註記 C-16(5) 的決議結果與既有保守行為一致、無需修改；`paper-trading-ui` design/proposal 註記 C-16 已決議，三顆按鈕 UI 留待下一輪（不重開已完成的 task 3.6）；HANDOFF §8 第 5、6 項標 ✅。
- **驗證證據**：純文件變更，未改程式邏輯，不需要跑測試；已交叉核對所有引用 C-16/C-19 的 design.md / proposal.md / tasks.md（`grep -rn "C-16\|C-19" openspec/changes/*/{design,proposal,tasks}.md`）逐一處理，僅 `net-cost-model`（已完成並整合）保留原文不動（歷史記錄不回改）。
- **沒做完 / 已知問題**：決議只落在文件層級，尚未實作——`risk-engine-kill-switch` group 4（3 個任務）、`position-funding-pnl`/`paper-execution-engine` 的 `hedgeRatio.ts` 實際預設值、`paper-trading-ui` 的三顆按鈕 UI，皆待下一輪 apply。
- **下一步建議**：下一輪可直接排 `risk-engine-kill-switch` group 4（現在不再 blocked）與 `position-funding-pnl` → `paper-execution-engine` → `runtime-health-reconciliation`；`paper-trading-ui` 的 Kill Switch 真實按鈕可在 `risk-engine-kill-switch` group 4 完成後一併排入。
- **需要使用者決定的事**：無新增（C-16、C-19 已決議）；舊的非框架待定項（最低流動性門檻、`slippage_safety_buffer_pct`、`basis_sigma_pct`、`DEFAULT_FEE_TABLE` 官方查證、`research_min_net_pnl_usdt`）仍待提醒。

### 2026-10-01（7）— Claude Sonnet 5（`trading-event-store`，分支 `feature-trading-event-store`）
- **做了什麼**：實作 OpenSpec change `trading-event-store`（capability `event-store`）tasks 1.1–5.1 全部完成：
  - 基礎：`runtime/src/storage/driver.ts`（`SqliteDriver` 介面 + `NodeSqliteDriver`，`node:sqlite` `DatabaseSync`，WAL + `foreign_keys=ON`，`transaction(fn)` 可重入（巢狀呼叫併入外層交易，只有最外層 BEGIN/COMMIT/ROLLBACK）、拒絕 async callback、`backupTo` 用 `VACUUM INTO`）；`runtime/src/storage/migrate.ts`（`migrate`/`rollback`/`currentVersion`，`schema_migrations` 表，每檔一 transaction）；`runtime/src/storage/backup.ts`（啟動前備份，UTC 檔名格式、`PRAGMA integrity_check`、同毫秒加 `-1`/`-2` 後綴、失敗丟 `BackupFailedError` 拒絕啟動、新安裝不備份）。`package.json` 加 `engines.node >=22.13`；`.gitignore` 加 `data/`。
  - 資料表與 Repository：`runtime/src/storage/migrations/001_initial.ts`（技術書 §29 全部 13 張表、§30 外鍵、索引、`trading_events` append-only 觸發器 UPDATE/DELETE 皆擋）；`rowMapping.ts` + `tradeRepository.ts`（opportunities/trades+legs/risk_checks）、`orderRepository.ts`（orders/fills/positions/funding_settlements）、`accountRepository.ts`（account_snapshots/pnl_snapshots）、`marketDataRepository.ts`（market_events/funding_rates，只建表+round trip，不寫內容）；全部無 delete 方法（測試斷言）。
  - Event Store：`eventStore.ts`——`EventStore.append`（本地事件驗證 + `assertNoCredentials`、`seq` 由 autoincrement、`recorded_at` 由注入 Clock 產生、與 `timestamp` 分開）；`replay({trade_id?,from_seq?,to_seq?})`；`rebuildProjections(targetDb)`（依 event_type 分派到對應 repository，用 `payload.after`/`payload.snapshot`/`payload.fill`），以技術書 §43 完整成功交易（2 腿、2 ACK、2 Fill、對沖、資金費、2 Exit Fill、Position 關閉）與 §44 未成交交易（ABORTED/ENTRY_TIMEOUT）兩個驗收情境驗證「重建列 = 原列」。
  - 寫入架構：`runtime/src/telemetry/eventQueue.ts`（`EventQueue`：`publish` 只做緩衝 push 不呼叫任何 consumer，三條獨立排程鏈——DB 批次 flush + 指數退避重試（100ms→5s）、UI/Analytics 共用 tick；overflow 只標記旗標不丟 DB 事件；UI buffer 滿丟最舊 + 計數；`getStatus()`/`drain()`）；`runtime/src/storage/ledger.ts`（`Ledger`：`reserveCapitalAndCreateTrade`/`releaseCapital`/`applyOrderTransition`/`applyFill` 皆單一 DB transaction 內寫實體列 + 事件；`INSUFFICIENT_CAPITAL` 不寫任何東西；事件只傳給注入的 `publishToUi` callback，結構上不可能被 `EventQueue`/`DatabaseWriter` 重寫）；`runtime/test/helpers/assertTraceability.ts`（缺 `created_at`/`updated_at`、狀態與最後事件 `payload.to`/`payload.after[status]` 不符、缺轉換事件、同一 trade 事件時間隨 seq 遞減，四項檢查皆有正反例測試）。
  - 全程 fail-then-pass：每個檔案先寫測試確認因模組不存在而失敗，再實作到通過；過程中發現 `transaction(fn)` 需要可重入（repository 自身的 `saveTrade` 用了 transaction，`Ledger` 外層又包一層）才補上巢狀交易測試與實作。
- **驗證證據**：`npm run lint`（`tsc --noEmit`）通過；`npm run build`（vite build）通過；`npm test`（`vitest run`）**97 個測試檔、947 個測試全過**（含既有 850 個 + 本次新增 97 個）；`npx openspec validate trading-event-store --strict` → `Change 'trading-event-store' is valid`；`npm run check` 整體綠燈。分支 `feature-trading-event-store`，起點 commit `f46ab96`。
- **沒做完 / 已知問題**：
  - design.md Open Questions 1–4（備份保留策略、orders/fills 同步寫入是否回寫技術書 §35、DB 路徑 `data/runtime.sqlite`、overflow 行為）**待定**——本 change 依 design.md 既定決策實作（全部保留備份、orders/fills 同步、路徑可由設定覆寫但未接 config 層、overflow 標記但不丟 DB 事件），尚未經使用者書面批准，需持續提醒。
  - 尚未接上任何啟動流程（無 `main`/`server.ts` 呼叫 `backupBeforeStartup`/`migrate`/建立 `EventQueue`/`Ledger` 實例）——此 change 的範圍只到 storage/event-store/ledger 本身，實際啟動組裝屬後續 change（`paper-execution-engine`/`runtime-health-reconciliation`）。
  - `rebuildProjections` 的 event_type → projection 對應表是本次新設計（design.md 未逐一列出 dispatch 規則），`RISK_CHECK_*`/`LEG_STATUS_CHANGED`/`FUNDING_SETTLED` 等分支僅有基本測試覆蓋（§43/§44 驗收情境未涵蓋 LEG_STATUS_CHANGED 與 RISK_CHECK_* 的 payload.after 路徑），下游若發現欄位缺漏需回來補。
  - `assertTraceability` 對 `funding_settlements` 的事件比對用 `trade_id` 分組（非 `funding_id`），同一 trade 有多筆 funding_settlements 時可能誤判；目前無測試涵蓋此邊界，留給下游（`position-funding-pnl`）發現時修正。
  - 後端（啟動流程、`server.ts` 讀取 API、前端事件推送）完全未接上，不可 archive（依使用者既定政策：後端未接上不 archive）。
- **下一步建議**：
  1. `paper-execution-engine`：組裝啟動序列（`backupBeforeStartup` → `migrate` → 建立 `EventStore`/`EventQueue`/`Ledger` 單例），把 risk-engine-kill-switch 的 Order/Fill/Position 寫入改走 `Ledger`。
  2. 請使用者就 design.md Open Questions 1–4 做出決定並寫回 design.md / 技術書 §35 註記。
  3. `runtime-health-reconciliation` 可直接消費 `EventQueue.getStatus()`（Database 健康狀態）與 `assertTraceability`（重啟恢復檢查）。
- **需要使用者決定的事**：design.md Open Questions 1–4（備份保留策略、orders/fills 同步寫入是否回寫技術書 §35、DB 路徑設定方式、overflow 行為）——沿用 design.md 既定決策實作，但尚未經使用者書面確認，請在下次 review 時明確回覆或指出需調整處。

### 2026-10-01（6）— Claude Sonnet 5，`websocket-data-layer`（分支 `feature-websocket-data-layer`）
- **做了什麼**：實作 OpenSpec change `websocket-data-layer`（12 項任務 1.1–5.1 全數完成）：
  - 基礎：`MarketDataEvent`（雙時間戳、`timestamp_source`、`tier`）、`SourceStatus`、`MarketDataAdapter` feed 描述、假 WebSocket / 假 REST 測試替身、架構守門擴充至 `runtime/src/market/` 的交易所名稱字面值檢查（`runtime/src/market/types.ts`、`runtime/src/market/testDoubles/`、`runtime/test/architecture.test.ts`）。
  - `GuardedRestClient`（single-flight、限流規則表 + 標頭用量、軟上限拉長輪詢、斷路器 `CLOSED`/`OPEN`/`HALF_OPEN`、`Retry-After` 取大值）取代 `BasicRestClient`（`runtime/src/market/http/guardedRestClient.ts`、`rateLimiter.ts`）。
  - `SourceStatus` 狀態機、`queryServerTime` + `ServerTimeSource`（`runtime/src/market/sourceStatus.ts`、`serverTime.ts`）。
  - `wsConnection` / `connectionPool`（狀態機、心跳、指數退避、先建後拆輪替、主題分片，`runtime/src/market/stream/`）、`marketState` + `freshness`（正規化寫入、新鮮度、`STALE_MARKET_DATA`/`MARKET_DATA_RECOVERED`，`runtime/src/market/state/`）、`orderBookService`（`SNAPSHOT_STREAM`/`DELTA_STREAM`、序號缺口 → `RESYNCING`）、`fundingService`。
  - 5 所 `marketData.ts` adapter（`runtime/src/adapters/<exchange>/marketData.ts`）。
  - `marketDataService`（兩層協調、`promote`/`release`/`releaseInstruments`）與 `server.ts` 嵌入（`/api/market/live-scan` 改讀記憶體狀態、新增 `sources`/`data_as_of`、`?symbol=`、503 未就緒、移除舊 REST 抓取段與 Bitget 專屬時程刷新迴圈）。
  - 新增 `TradingEventType` 擴充碼：`FEED_STATE_CHANGED`、`MARKET_DATA_RECOVERED`、`ORDER_BOOK_RESYNC`、`SOURCE_STATUS_CHANGED`、`RATE_LIMIT_CIRCUIT_CHANGED`、`SHORTLIST_SUBSCRIPTION_DROPPED`（`runtime/src/types/event.ts` + `glossary.ts`）。
- **驗證證據**：
  - `npm run check`（lint → build → test）全綠：97 測試檔、939 測試通過；`openspec validate websocket-data-layer --strict` 通過。
  - 實測 Binance WS 真實連線（task 3.1）：`wss://fstream.binance.com/ws/!markPrice@arr`（WHATWG 標準路徑）35 s 內 0 則訊息；`wss://fstream.binance.com/market/ws/!markPrice@arr` 連線後約 2 s 開始收訊息、15 s 內收到 10 則、每則 745 symbol，Node 內建 WebSocket 全程維持 `OPEN`（不需要 `ws` 依賴，design.md Open Question 2 已回答）。
  - 實測 OKX mark-price 端點（task 3.3）：`GET /api/v5/public/mark-price?instType=SWAP` 可用、批次回傳全市場，design.md 標記的「未查證」已查證並改為直接取用（不再以 `last` 代替）。
  - `npm run dev`（`NODE_ENV=production` + port-patch require script，監聽 3001，未動使用者的 3000）實測 live-scan：5 所全部 `HEALTHY`，`total_matched_pairs` 405→570（快照持續補齊）；Binance `rate_limit.used` 在 ~165 s 觀測窗（**縮短自建議的 10 分鐘**，見下方已知限制）穩定在 41–53/2400（約 2%）；50 併發請求 279 ms、50/50 成功（上游呼叫數結構性為 0，查詢路徑不碰 `restClient`）；`?symbol=` 篩選、倒數每次請求重算（3 s 間隔對應减少 ~7 s，含量測開銷）皆驗證通過。
  - 實測中發現並修正一個真實 bug：OKX 把 tickers / funding-rate / mark-price 拆成 3 個獨立 POLL feed，`MarketState.upsert` 原本整筆覆寫會讓較新但欄位較少的 feed 把另一個 feed剛寫入的欄位沖掉，導致一開始 `total_matched_pairs = 0`；改為「較新時覆寫、但傳入 `null` 的欄位保留舊值」的欄位級合併，修正後見上方 405/570 筆。已補迴歸測試 `marketState.test.ts`「merges fields across separate feeds」。
- **沒做完 / 已知問題**：
  - `runtime/src/market/state/marketState.ts` 的新鮮度門檻目前是單一全域值（`server.ts:91` 的 `thresholds`），spec 要求 `watch_stale_threshold_ms` 應逐所計算為「該所 feed 輪詢間隔 × 3」；暫以保守值 90 s（最慢全市場 POLL 間隔 30 s × 3）避免假性 stale/recovered 抖動（task 5.1 實測時曾以 30 s 門檻 = 輪詢間隔本身，觀察到 Pionex/Bitget 每輪都在門檻邊界抖動並正確觸發 `STALE_MARKET_DATA`/`MARKET_DATA_RECOVERED` 事件——這同時證明了偵測機制本身是對的，純粹是閾值設定需要逐所化）。
  - 「拔網路 30 s」驗證以 Binance WS 全程維持連線、以及既有單元 / 情境測試（`wsConnection.test.ts` 的 backoff / idle-timeout / reconnect+resubscribe 皆以 VirtualClock 決定性驗證）替代；本次手動驗證沒有真的拔斷本機網路（環境限制）。
  - `promote`/`release` 已實作參照計數與 `WARMING_UP`，但尚未接上 `settlement-session`（B3 跨 change 假設，依規劃屬 Paper Runtime 主迴圈 change）。
  - `ConnectionPool` 的 `unsubscribe`（部分合約取消訂閱但連線仍有其他訂閱者）目前只刪除本地參照計數，未送出 `UNSUBSCRIBE` 訊框（`marketDataService.ts` 的 `unsubscribeShortlist` 註解已標註，留待入圍層接上真實場次時補強）。
  - Bybit `orderbook.50` 的 `prev_sequence` 轉換（`u - 1`）未逐檔對照官方文件驗證，只以合成 fixture 測試過（`bybit/marketData.test.ts`）。
  - Bitget 限流規則表沿用研究原型既有假設（每秒 10 次），design.md 本就標記「未查證」，本 change 未能查證官方數字，保持 `verified: false`。
- **下一步建議**：
  1. `MarketState` 門檻改為逐所（`Record<ExchangeId, number>` 或由 adapter 的 `fullMarket[].interval_ms` 自動推導 × 3）。
  2. Paper Runtime 主迴圈 change 串接 `settlement-session` → `marketDataService.promote`/`release`。
  3. `assets/ARCHITECTURE.md` 重繪（使用者已決定留到所有 change 完成後最後一輪，本 change 刻意不碰）。
- **需要使用者決定的事**：無（design.md 的 5 個 Open Questions 已在實作中以保守預設值 / 實測回答：Q2 Node 內建 WebSocket 可用；Q4 `data_stale_threshold_ms` 暫用建議值 3,000 ms；Q1/Q3/Q5 維持 design.md 的「本 change 預設不加」）。

### 2026-10-01（5）— Claude (Opus 5.5) 整合 + 1 個 Sonnet agent（net-cost-model）
- **做了什麼**：分支 `integration/net-cost-model`：新增 `runtime/src/accounting/`（feeConfig、feeEngine、slippageEngine、pnlFormula、fundingMath、expectedNet）。修正 Q-05（研究引擎滑價重複扣除：`net_pnl` −2.40 → −1.20）、Q-06（固定 0.20% 手續費 → 費率表；live-scan 以淨值排序與判門檻，跨所價差納入預期 PnL）、P9（dryRunEngine 手續費依交易所，Bybit 腿 0.5 → 0.55 USDT / 1000U）。資金費金額共用 `funding/settlementInference.ts`，未分叉公式。
- **review 發現並修正**：live-scan 的 `fee_drag_pct`、`est_slippage_pct` 以兩腿名目為分母、淨值以單腿名目為分母，畫面數字對不起來且手續費 / 滑價看起來只有一半（同時讓 dry-run 的模擬滑價減半）；已統一為單腿名目並加「各項加總 = 淨值」測試。
- **驗證證據**：`npm run check` 全綠（92 檔 / 934 測試）；`openspec validate --all --strict` 15/15；`[Q-05]`、`[Q-06]` 特性測試先改期望值紅燈後修正；所有成本函式對 NaN / Infinity / undefined 皆拋錯。live-scan 實測（integrator）：715 組配對、無非有限值、依淨值排序、各項加總與淨值誤差 ≤ 0.0001 USDT；過門檻 6 → 0，主因為新納入的不利跨所價差（例：KSTRUSDT 做多所比做空所貴 0.25%）。
- **待定（非框架）**：`slippage_safety_buffer_pct`、`basis_sigma_pct`、`DEFAULT_FEE_TABLE` 官方查證、`research_min_net_pnl_usdt`（技術書 §38 net-cost-model 段）。
- **沒做完 / 已知問題**：未 archive（`ExpectedNetConfig` 尚未接入持久化設定）；live-scan 仍用 `LEGACY_VOLUME_TIER` 滑價（待 websocket-data-layer）；Q-04（預測費率誤差折扣）與結算窗口價差擴大需歷史資料 B7。
- **下一步建議**：下一輪 `trading-event-store`、`websocket-data-layer`（可並行）→ `position-funding-pnl` → `paper-execution-engine` → `runtime-health-reconciliation`。`paper-execution-engine` 必須直接使用 `slippageEngine.walkBook`（或通過同一組 250 單位 / 100.006 情境）。（2026-10-01 integrator 註：`trading-event-store`、`websocket-data-layer` 已完成，見本節（6）（7）；研究端 live-scan 仍是 `LEGACY_VOLUME_TIER`——`websocket-data-layer` 提供的是 Runtime 的盤口資料，接回研究端 `server/liveScanMath.ts` 不在任一 change 範圍內，留給下一輪決定要不要做。）

### 2026-10-01（4）— Claude (Opus 5.5) 整合 + 2 個 Sonnet agent（第 1b 波）
- **做了什麼**：整合分支 `integration/wave-1b`：
  - `risk-engine-kill-switch` 第 1–3 組：`runtime/src/risk/`（28 項 Pre-Trade / Entry / Position 檢查、`RiskStatusReport` / `risk_checks` / 事件輸出、ARM 與 PRE_FLIGHT 閘門、Entry / Position 監控）；依賴以注入介面 + 假資料測試。review 發現**輸入為 NaN / Infinity / 空陣列時風控放行（fail-open）**，已修正為一律 FAIL（集中輸入驗證 + 逐欄位自動產生的缺漏測試）。第 4 組 Kill Switch blocked-by C-16。
  - `paper-trading-ui`：新增「Paper Trading」分頁（`src/features/paperTrading/`，獨立 chunk）；後端（Paper 唯讀 API、Health、`/ws/paper`）尚未存在，以 `VITE_PAPER_DATA_SOURCE=mock` 開發，頁面與各區塊標示 MOCK；Kill Switch 為停用版位（C-16）。測試加入 jsdom + React Testing Library（`*.test.tsx` 以檔頭 `// @vitest-environment jsdom` 宣告）。
- **驗證證據**：`npm run check` 全綠（83 檔 / 870 測試）；`openspec validate --all --strict` 15/15；risk 修正前紅燈 Pre-Trade 17/43、Entry 10/31、Position 17/35，integrator 以獨立探測（NaN / undefined / Infinity / null 共 86 例）重驗全過；UI 抽查費率 ×100 只在顯示層、live 失敗不退回 mock、所有 `.tsx` 測試皆宣告 jsdom。
- **沒做完 / 已知問題**：risk 第 4 組（C-16）；UI 真實串接（tasks 4.1，待 Paper API / runtime-health）；B19–B21。兩個 change 都未 archive（仍有未完成 tasks）。
- **手動查看**：`VITE_PAPER_DATA_SOURCE=mock npm run dev` → 點「Paper Trading」分頁（見 `assets/TESTING.md` §4）。
- **需要使用者決定的事**：C-16、C-19；風控門檻預設值（技術書 §38 risk-engine 段，目前為起算值）。

### 2026-10-01（3）— Claude (Opus 5.5)
- **做了什麼**：C-05 回寫規格書 / 技術書並 archive `paper-trading-event-loop`；依使用者決議處理第一波待決事項：
  - 結算保護區間：每腿用自己交易所的區間、在自己時鐘上換算後取保守值（settlement-session spec 敘述改為與實作一致）。
  - `funding_confirmed`：`SETTLED` / `NOT_ELIGIBLE` 視為已確認、`MISSED` 未確認（原實作把 `NOT_ELIGIBLE` 當未確認，與 design 不符，已修正）。
  - trading-schema 7 題：補欄位回寫規格書（Opportunity / Fill / TradeResult 時間戳、`TradingEvent` 欄位）、Leg 轉換圖、事件擴充碼列入技術書 §26、adapter 帳戶型別改名 `ExchangeAccountInfo`、術語表加 `SESSION` / `HEALTH`；`PaperPosition` 計算語意留給 `position-funding-pnl`。
  - 費率防呆門檻：使用者決議 **10%**（原提案 5%），`|rate| > 0.10` 才判定為百分比誤存。
- **驗證證據**：`NOT_ELIGIBLE` 與 10% 門檻皆先寫失敗測試再修正；`npm run check` 全綠；`openspec validate --all --strict` 15/15。
- **沒做完 / 已知問題**：B18（event-loop 剩餘本地事件型別）；ARCHITECTURE 圖重產延到最後一輪。
- **下一步建議**：使用者 review 後再開第 1b 波（`paper-trading-ui`、`risk-engine-kill-switch` 第 1–3 組）。
- **需要使用者決定的事**：C-16、C-19（仍待決）。

### 2026-10-01（2）— Claude (Opus 5.5) 整合 + 3 個 Sonnet agent（第一波）
- **做了什麼**：三個 change 並行開發後由 integrator 合併（分支 `integration/wave-1`）：
  - `trading-schema-types`：`runtime/src/types/` 成為 v0.2 Schema 單一來源（ids、5 張狀態轉換表、Opportunity / Trade / Order / Fill / Funding / Result / Risk / Account、`TradingEvent` 含 instrument-registry 與 event-loop 擴充碼、`assertNoCredentials` / `validateEntity`、`glossary.ts`）；六個舊型別 `@deprecated`、`src/types/legacy/`；`RiskStatusReport` 改由 runtime re-export。
  - `paper-trading-event-loop`：`runtime/src/clock`（Clock / VirtualClock / RealClock）、`scheduler`、`venue`（結算規則表）、`session`（場次時間表、狀態機、資格、持倉上限）、`opportunity`（失效、ARM 決策）、`funding`（執行閘門、入帳推定）。review 發現並修正 TimerQueue 兩個 bug（批次中新排的計時器被丟棄、較早 callback 讀到錯誤 `now()`）。
  - `instrument-registry`：`runtime/src/market/instruments`（canonical、registry、matching、orderSpec）、5 所 instrument adapter、`BasicRestClient`；`server.ts` live-scan / live-klines 改用註冊表。review 發現 Bitget 結算時間未取得（Bitget 從不配對），已補 `current-fund-rate` 批次端點（5 分鐘刷新 + STALE 提前刷新）。
  - 整合：本地暫時型別改為 import `runtime/src/types`（registry 事件改為正式 `TradingEvent` 格式）；型別所有權守門測試修正誤判；新增 `docs/REFERENCES.md`。
- **驗證證據**：`npm run check` 全綠（48 檔 / 293 測試）；`openspec validate --all --strict` 12/12；各 change 皆有紅燈→綠燈證據（agent 回報 + integrator 獨立重跑）。live-scan（抽出前 805 組 / 過門檻 12 → 現在 714 組 / 6；五所皆 OK；Bitget 出現在 325–412 組最佳配對；所有候選兩腿結算時間差 0 ms）；`live-klines?symbol=1000PEPEUSDT` → `PEPE_USDT_PERP`；非法 symbol → 400。
- **沒做完 / 已知問題**：event-loop task 1.2（規格書 / 技術書段落回寫）未做；B18（event-loop 剩餘本地事件型別）；`price_mismatch_tolerance_pct`（2%）與 `funding_alignment_tolerance_ms`（60s）寫死在 `server.ts`，尚未設定化；Pionex / Bitget 尚無結算規則表（`requireVenueRule` 會 throw）。
- **下一步建議**：第 1b 波 `paper-trading-ui`、`risk-engine-kill-switch`（第 1–3 組）；第二波 `net-cost-model`、`trading-event-store`、`websocket-data-layer`。
- **需要使用者決定的事**：~~event-loop 兩處 spec 解讀、trading-schema 7 項 Open Questions~~ ✅ 已於 2026-10-01（3）決議。

### 2026-10-01 — Claude (Opus 5.5)
- **做了什麼**：B0 / P13（OpenSpec change `setup-vitest`，分支 `feature-setup-vitest`，自 `47c6df0` 分出——`develop` 當時尚未含 proposal）。導入 `vitest@5.0.3` + `@vitest/coverage-v8@5.0.3`（peer 支援 vite 8，Open Question 1 不需退回 4.x）；`vitest.config.ts` / `vitest.setup.ts`（fetch 替身拋錯）；scripts `test`、`test:watch`、`test:coverage`、`check`。特性測試 11 檔：`arbitrageEngine`、`funnelScanner`、`dryRunEngine`、6 個 adapter、`server/liveScanMath`、`test/infrastructure`；已知 bug 以 `[Q-01] [Q-02] [Q-05] [Q-06] [Q-08] [P1] [P2] [P4] [P6] [P7]` 標註「現況」。`server.ts` 的 `extractBaseSymbol`、最佳配對、結算時間彙整、Expected Net PnL 逐字搬到 `server/liveScanMath.ts`。
- **驗證證據**：`npm run check` exit 0（lint ✅、build ✅、11 檔 56 測試 ✅，連跑兩次結果相同）；`openspec validate setup-vitest --strict` ✅；`test:coverage` 行 96% / 分支 87%（僅報告）。測試有效性：每組特性測試皆「暫改期望值或系統時間 → 紅 → 還原 → 綠」；`liveScanMath.test.ts` 先寫時紅（`Cannot find module './liveScanMath'`），搬移後 15/15 綠。`git diff --color-moved=zebra` 確認非搬移行僅為包裝與參數化（`agg.rates`→`rates`、`continue`→`return null`、`ExchangeName`→泛型 `E`）。live-scan 實測：抽出前（main 的 dev server :3000）與抽出後（本分支 :3001）同時請求，皆 805 組、過門檻 7 組、各所計數相同（Pionex 439 / Binance 728 / Bybit 725 / Bitget 707 / OKX 467），頂層與 candidate 欄位集合完全相同；以原內嵌公式重算抽出後 805 筆衍生欄位，0 筆不符。唯一差異 `1000CATUSDT` vs `CATUSDT` 為 P6 既有行為（兩者被併成 `CAT`，顯示名取決於上游回應順序），與抽出無關。
- **沒做完 / 已知問題**：Q-03（量缺值 1,000 萬，`server.ts` `getOrCreate`）未抽出、未鎖住（Open Question 4 預設）；`npm install` 時 npm 的 allow-scripts 會擋 esbuild postinstall，目前 tsx / vite build 仍可運作。
- **下一步建議**：`instrument-registry`、`paper-trading-event-loop`、`trading-schema-types` 可並行開工（皆只依賴本 change）。
- **需要使用者決定的事**：design Open Questions 2（Runtime coverage 門檻）、3（`server/liveScanMath.ts` 位置）。

### 2026-09-30（5）— Claude (Opus 5.5)
- **做了什麼**：新增 `docs/TRADING_SYSTEM_SPEC.md`（規格書 v0.2）與 `docs/PAPER_TRADING_TECH_SPEC.md`（技術書 v0.1），並依使用者對 C-01～C-18 的回覆整併（決策紀錄見規格書 §34）；`openspec init --tools claude`（`openspec/config.yaml` 填入專案 context 與規則）；建立 `develop`（來自 `main`）與 `feature-trading-spec-v02`；修訂本檔 Invariant #1 #2、§1 階段、§8；`.env.example` 加入 Bybit / OKX 欄位與規則；UI 上舊的「Spec v0.2」標籤改為 v0.1（C-02）。
- **驗證證據**：`openspec validate --all`、`npm run lint`、`npm run build` 結果見該次 commit 訊息。
- **沒做完 / 已知問題**：C-05（事件迴圈 / 進出場時機）、C-16（Kill Switch 分層）、C-19（hedge ratio 計算基準）待決；`funding` 分支（= main + ff733c4）已被 `feature-trading-spec-v02` 取代，可在合併後退役。
- **下一步建議**：`/opsx:explore paper-trading-event-loop`（C-05）→ `/opsx:propose setup-vitest`（技術書 §50.1 第 1 項）。
- **需要使用者決定的事**：C-05、C-16、C-19；§8 第 3 題。

### 2026-09-30（4）— Claude (Opus 5.5) + 3 個 review agent
- **做了什麼**：以量化交易員 / 後端效能 / 前端效能三個角色平行 review，產出 `issue/` 25 個 issue（Q 8、BE 10、FE 7）與索引 `issue/README.md`（最嚴重 5 件事、全案 Top 3 方向、推翻的假設）。未修改原始碼。
- **驗證證據**：主審查者獨立重做 Q-01（Pionex 22 個反向合約）、Q-05（滑價重複扣除）、FE-01（stale closure）；Binance FAQ 3 段引述、Go singleflight 引述逐字相符；OKX `instId=ANY` 實測回 717 筆。
- **沒做完 / 已知問題**：22 處「未查證 / 未能取得」，見 issue 索引 §6。後端 agent 的併發壓測曾讓本機 IP 收到 Binance / OKX / Bitget 的 429（未遭 418 封鎖）。
- **下一步建議**：B0（測試）→ issue 索引 §3 方向 ①（Instrument Registry）→ ③（PnL 淨值口徑）→ ②（WebSocket 資料層）。
- **需要使用者決定的事**：§8 仍待回覆。

### 2026-09-30（3）— Claude (Opus 5.5)
- **做了什麼**：新增架構圖 `ARCHITECTURE.md`（Mermaid + 元件索引 + 分頁對照）、`architecture.html`（互動版）、`architecture.json`（原始定義，元件連到原始碼）、`architecture.png`（截圖）；README 與本檔加入連結。需求 #5。
- **驗證證據**：archify `validate --quality showcase` 通過（9/9 checks、0 error、0 warning）；`deliver` 成功（sha256 `128332d2…`）；`visual-check` 在 1440×900 / 1600×1000 / 1920×1080 / 2048×1320 皆無溢出、最小字 8px；mermaid-cli 可成功渲染 Mermaid 區塊。
- **沒做完 / 已知問題**：互動 HTML 的 UI 文字為英文（archify 不支援繁中介面）；架構變動時需手動同步三個檔案。
- **下一步建議**：同第一筆。
- **需要使用者決定的事**：無新增。

### 2026-09-30（2）— Claude (Opus 5.5)
- **做了什麼**：README §3 改寫為本機啟動 Step by Step（工具清單、5 步驟、常見問題、正式模式）。需求 #5。
- **驗證證據**：在全新目錄照 README 逐步執行：`git clone`（main @ 95535ca）→ `npm install --legacy-peer-deps` → `npm run dev` → 出現 `Server listening on port 3000`、`GET /` 200、`live-scan` success=true、5 所 ping 皆有值；`npm run build && NODE_ENV=production npm start` 回傳打包後的 `index.html` 且 `live-scan` 200；重複啟動會出現 `EADDRINUSE`，`lsof -ti :3000 | xargs kill` 可釋放。
- **沒做完 / 已知問題**：本地 `funding` 分支未推到 GitHub（遠端只有 `main`，內容目前相同）；Windows / Linux 啟動步驟未驗證。
- **下一步建議**：同上一筆。
- **需要使用者決定的事**：無新增。

### 2026-09-30 — Claude (Opus 5.5)
- **做了什麼**：審閱 Gemini 產出的初版程式；重寫 README（需求對照、快速開始、mock/live 對照表、已知限制）；建立本交接規範。未修改任何程式碼。
- **驗證證據**：`npm install --legacy-peer-deps` 成功（不加則 ERESOLVE 失敗）；`npm run lint` 0 error；`npm run build` 成功；`npm run dev` 後 `GET /` 200、`/api/market/live-scan` success=true / 803 配對 / 4 組達 0.20% 門檻；排名前 3 為 HANMIUSDT（24h 量約 36 萬）、NAVERUSDT（約 17 萬）、PUFFERUSDT（量為預設值 10,000,000）→ 佐證 P3。
- **沒做完 / 已知問題**：§4.2 全部。P5、P11 需查官方 API 文件確認。
- **下一步建議**：B0 → B1 → B2/B3。
- **需要使用者決定的事**：見 §8。

## 8. 待使用者決定的問題

1. ~~獲利口徑 / 持倉跨幾次結算~~ ✅ 2026-10-01（C-05）：每筆 Trade 只做單次結算；結算場次、進出場窗口、入帳推定見規格書 §19、§26.4 與技術書 §8.1、§10、§23.1、§41。
2. ~~交易所範圍~~ ✅ 2026-09-30（C-01）：5 所持續掃描；Paper Trading 只在 Binance × Bybit，未來加 OKX；Pionex 僅掃描。
3. **最低流動性門檻**：24h 量 / 盤口深度要多少以上才算「穩定交易量」？（仍待決）
4. ~~是否導入 OpenSpec~~ ✅ 2026-09-30：已 `openspec init`；分支模型 `main` / `develop` / `feature-*`（技術書 §51）。
5. ~~Kill Switch 分層~~ ✅ 2026-10-02（C-16）：三層分級（L1 STOP ENTRY / L2 CANCEL ENTRY / L3 FLATTEN），5 個子問題皆採推薦方案，見規格書 §23、§34、`risk-engine-kill-switch` design.md §6–§7。
6. ~~Hedge ratio 以數量或名目計算~~ ✅ 2026-10-02（C-19）：改用合約乘數換算後的基礎資產數量（`QUANTITY`），見規格書 §14、§34。
