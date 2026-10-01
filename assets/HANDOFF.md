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

完整架構圖與元件索引見 [`ARCHITECTURE.md`](ARCHITECTURE.md)（互動版 [`architecture.html`](architecture.html)）。架構有變動時必須同步更新這三個檔案。

```
交易所公開 API ──► server.ts (/api/market/live-scan)  ──► liveMarketService ──► FunnelScannerView / DryRunConsole
                    └ 自己解析 JSON，沒用 adapters/

adapters/*.ts ──► 只被 SchemaInspector（展示頁）使用
mockMarketData.ts ──► ArbitrageScanner / SettlementKlineViewer / ExecutionSimulator
funnelScanner.ts (15 個寫死幣) ──► App.tsx 預設候選、Dry-run Top3
```

### 4.2 已確認問題（依對結果正確性的影響排序）

> 2026-09-30 深度 review 後，每項的詳細證據與 Top 3 解方見 [`../issue/`](../issue/README.md)。P5 已被推翻、P11 可結案，見 issue 索引 §4。

| ID | 問題 | 位置 | 影響需求 |
|----|------|------|---------|
| P1 | ✅ 已解（`instrument-registry`）：配對改為兩腿下次結算時間差 ≤ 60s 才成立，週期取各所回傳值。原描述：不同結算週期（1h/4h/8h）的費率直接相減；Binance/Bitget/OKX 週期寫死 8 | `runtime/src/market/instruments/matching.ts` | #1 |
| P2 | ✅ 已解（`instrument-registry`）：`matchPair` 逐腿比對結算時間，不再取 min。原描述：兩腿結算時間未檢查是否一致，取 `min(nextFundingTime)` 當 T | `runtime/src/market/instruments/matching.ts` | #1 #3 |
| P3 | ✅ 已解（`instrument-registry`）：每腿各自的 24h 量，缺值直接淘汰。原描述：24h 量只取 Binance；缺值填 `10,000,000`（實測 PUFFERUSDT 命中）→ 冷門幣看起來有量 | `server/liveScanRegistry.ts` | #1 |
| P4 | 即時滑價 = 依量分三級常數，未用盤口深度 / K 棒波動 | `server/liveScanMath.ts` `computeLiveScanNetPnl` | #2 |
| P5 | ~~各所費率欄位語意未對齊~~ **已推翻**：兩者皆為預測值，實際風險見 Q-04。原描述：Binance 用 `lastFundingRate`、Pionex 用 `nextFundingRate`（當期 vs 預測，**需查官方文件確認**） | `server.ts:183,198` | #1 |
| P6 | ✅ 已解（`instrument-registry`）：以 `instrument_key` + 價格倍數配對，反向合約不再併入線性合約（舊函式與 `[Q-xx] 現況` 測試保留為歷史紀錄，server 已不呼叫）。原描述：`extractBaseSymbol` 去掉 `1000` 前綴但沒換算倍數；且 `replace('USDT','')` 只替換第一次出現 | `runtime/src/market/instruments/canonical.ts` | #1 #3 |
| P7 | Dry-run 數值寫死：延遲依交易所名稱三元式、價格漂移固定 ±0.008%、保證金 `$5,000`、風控 r5/r7/r9 永遠 PASS；唯一失敗情境是單腿 429 | `dryRunEngine.ts` | #3 |
| P8 | 部分成交、API timeout、重試、費率在 T 前翻轉，皆未模擬 | `dryRunEngine.ts` | #3 |
| P9 | 手續費固定 taker 0.05%，無各所 / maker / VIP 設定 | 多處 | #3 |
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
| B9 | 手續費設定化（每所 maker/taker/VIP） | P9 | S |
| B10 | 新手模式：首頁「一條龍」流程（選幣 → 看風險 → 看邊界 → dry-run），隱藏進階分頁 | #5 | M |
| B11 | Secret Vault 改為不持久化或加密；在真正需要下單前可考慮直接移除 | P12 | S |
| B12 | 舊型別遷移 1/6：`OrderState`（v0.1）→ `PaperOrder.order_state`，改 import `runtime/src/types` | P10 | S |
| B13 | 舊型別遷移 2/6：`SimulatedOrderLeg` → `PaperOrder` + `Fill` | P10 | M |
| B14 | 舊型別遷移 3/6：`PositionState` → `Trade.status`（`TradeStatus`） | P10 | M |
| B15 | 舊型別遷移 4/6：`TimelineMilestone` → 由 `TradingEvent` 絕對時間戳推導 | P10 | M |
| B16 | 舊型別遷移 5/6：`ArbitrageTradeResult` → `TradeResult` | P10 | M |
| B17 | 舊型別遷移 6/6（最後，依賴 Runtime scanner）：`FunnelCandidate` → `Opportunity` | P10 | L |
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

### 2026-10-01（2）— Claude (Opus 5.5) 整合 + 3 個 Sonnet agent（第一波）
- **做了什麼**：三個 change 並行開發後由 integrator 合併（分支 `integration/wave-1`）：
  - `trading-schema-types`：`runtime/src/types/` 成為 v0.2 Schema 單一來源（ids、5 張狀態轉換表、Opportunity / Trade / Order / Fill / Funding / Result / Risk / Account、`TradingEvent` 含 instrument-registry 與 event-loop 擴充碼、`assertNoCredentials` / `validateEntity`、`glossary.ts`）；六個舊型別 `@deprecated`、`src/types/legacy/`；`RiskStatusReport` 改由 runtime re-export。
  - `paper-trading-event-loop`：`runtime/src/clock`（Clock / VirtualClock / RealClock）、`scheduler`、`venue`（結算規則表）、`session`（場次時間表、狀態機、資格、持倉上限）、`opportunity`（失效、ARM 決策）、`funding`（執行閘門、入帳推定）。review 發現並修正 TimerQueue 兩個 bug（批次中新排的計時器被丟棄、較早 callback 讀到錯誤 `now()`）。
  - `instrument-registry`：`runtime/src/market/instruments`（canonical、registry、matching、orderSpec）、5 所 instrument adapter、`BasicRestClient`；`server.ts` live-scan / live-klines 改用註冊表。review 發現 Bitget 結算時間未取得（Bitget 從不配對），已補 `current-fund-rate` 批次端點（5 分鐘刷新 + STALE 提前刷新）。
  - 整合：本地暫時型別改為 import `runtime/src/types`（registry 事件改為正式 `TradingEvent` 格式）；型別所有權守門測試修正誤判；新增 `docs/REFERENCES.md`。
- **驗證證據**：`npm run check` 全綠（48 檔 / 293 測試）；`openspec validate --all --strict` 12/12；各 change 皆有紅燈→綠燈證據（agent 回報 + integrator 獨立重跑）。live-scan（抽出前 805 組 / 過門檻 12 → 現在 714 組 / 6；五所皆 OK；Bitget 出現在 325–412 組最佳配對；所有候選兩腿結算時間差 0 ms）；`live-klines?symbol=1000PEPEUSDT` → `PEPE_USDT_PERP`；非法 symbol → 400。
- **沒做完 / 已知問題**：event-loop task 1.2（規格書 / 技術書段落回寫）未做；B18（event-loop 剩餘本地事件型別）；`price_mismatch_tolerance_pct`（2%）與 `funding_alignment_tolerance_ms`（60s）寫死在 `server.ts`，尚未設定化；Pionex / Bitget 尚無結算規則表（`requireVenueRule` 會 throw）。
- **下一步建議**：第 1b 波 `paper-trading-ui`、`risk-engine-kill-switch`（第 1–3 組）；第二波 `net-cost-model`、`trading-event-store`、`websocket-data-layer`。
- **需要使用者決定的事**：event-loop 的兩處 spec 解讀（結算保護區間採「每腿各自換算再取保守值」；一腿 SETTLED、一腿 MISSED 時 `funding_confirmed = false`）；`trading-schema-types` design 的 7 項 Open Questions 與自行補的術語 / 欄位型別（需回寫規格書）。

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

1. **獲利口徑 / 持倉跨幾次結算**：併入規格書 C-05（WebSocket 事件驅動已確定；進出場時機待 `/opsx:explore paper-trading-event-loop` 評估）。
2. ~~交易所範圍~~ ✅ 2026-09-30（C-01）：5 所持續掃描；Paper Trading 只在 Binance × Bybit，未來加 OKX；Pionex 僅掃描。
3. **最低流動性門檻**：24h 量 / 盤口深度要多少以上才算「穩定交易量」？（仍待決）
4. ~~是否導入 OpenSpec~~ ✅ 2026-09-30：已 `openspec init`；分支模型 `main` / `develop` / `feature-*`（技術書 §51）。
5. **Kill Switch 分層**：規格書 C-16（5 個子問題）。
6. **Hedge ratio 以數量或名目計算**：規格書 C-19。
