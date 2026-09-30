# Funding Rate Arbitrage Lab（跨交易所資金費率套利研究台）

> **一句話**：比較多家交易所「同一幣種永續合約」的資金費率，找出費率差夠大的組合，
> 以「低費率做多 / 高費率做空」的對沖方式領取費率差，並在**下單前**用 dry-run 量化滑價、手續費與失敗風險。

⚠️ **目前狀態：研究 / 模擬原型（Research + Dry-run）。本專案沒有任何真實下單程式碼。**
部分頁面使用即時公開行情，部分頁面仍是寫死的 mock 資料——請先看 [§4 哪些是真的、哪些是假的](#4-哪些是真的哪些是假的)。

接手開發請先讀 👉 [`assets/HANDOFF.md`](assets/HANDOFF.md)　·　架構圖 👉 [`assets/ARCHITECTURE.md`](assets/ARCHITECTURE.md)

下一階段（Paper Trading）規格 👉 [`docs/TRADING_SYSTEM_SPEC.md`](docs/TRADING_SYSTEM_SPEC.md)　·　開發技術書 👉 [`docs/PAPER_TRADING_TECH_SPEC.md`](docs/PAPER_TRADING_TECH_SPEC.md)

---

## 1. 策略在做什麼（30 秒版）

```
同一幣種 (e.g. SOLUSDT) 在 A、B 兩所的資金費率：
  A = -0.01%   B = +0.25%       → 費率差 spread = 0.26%

動作：A 開多 1000U、B 開空 1000U（價格曝險互相抵銷 = delta neutral）
結算：多方付 A 的費率（負費率 → 反而收錢），空方收 B 的費率
平倉：結算後雙邊平倉

淨利 ≈ spread − 手續費(4 筆 taker) − 滑價(4 筆) ± 兩腿價差漂移
     ≈ 0.26%  − 0.20%            − 4×slip
```

**只有當 spread 明顯大於「手續費 + 滑價」時才值得做**——這就是整個系統要回答的問題。

## 2. 需求 → 系統對照

| # | 需求 | 對應模組 / 頁面 | 目前完成度 |
|---|------|----------------|-----------|
| 1 | 找出「多所同時有該合約、且量穩定」的最佳交易所組合 | M3 Funnel Scanner（`server.ts` `/api/market/live-scan`） | 🟡 已抓 5 所即時費率並算最佳配對；**流動性篩選不可靠**（見 §5） |
| 2 | 結算前後 5 分鐘 K 棒震盪 & 成交量 → 評估滑價 | M2 ±2m Kline & Volume Shock | 🟡 公式完成；歷史資料為 mock，即時只有 Binance/Pionex 最近 5 根 |
| 3 | Dry-run：滑價、API 回應、手續費、成交與否、投入成本 | M5 Execution Flow、M6/M7 Dry-Run Console | 🟠 流程與畫面完成；**數值多為寫死的劇本**，非隨機模擬 |
| 3b | 費率邊界表：不同 spread / 滑價下的獲利空間 | M4 Sensitivity Matrix | 🟢 可用（純公式） |
| 4 | 共用 Schema，新增交易所可照框架擴充 | M1 Common Schema & Adapters | 🟠 Schema 已定義，但 server 端**沒有使用** adapter，擴充需改多處 |
| 5 | 新手可照流程閱讀的說明書 | 本 README + App 內 `(?)` Help Modal + Spec 頁 | 🟡 本次整理 |
| 6 | 未開發部分 | — | 見 [`assets/HANDOFF.md` §6 Backlog](assets/HANDOFF.md#6-backlog優先序) |

## 3. 在本機啟動網頁（Step by Step）

Gemini / AI Studio 是在雲端幫你啟動；這裡改成**在你自己的電腦**啟動，結果一樣是用瀏覽器打開操作。
整個流程只需要一個終端機（Terminal）視窗，約 5 分鐘。

### 你需要的工具

| 工具 | 用途 | 檢查指令 | 沒有的話（macOS） |
|------|------|---------|------------------|
| Git | 下載專案 | `git --version` | `xcode-select --install` |
| Node.js（含 npm） | 執行伺服器與前端 | `node -v`、`npm -v` | `brew install node`，或到 <https://nodejs.org> 下載 LTS |
| 瀏覽器 | 操作介面 | — | Chrome / Safari / Edge 皆可 |
| 網路 | 抓交易所公開行情 | — | 需能連到 Binance / Pionex / Bybit / Bitget / OKX 的 API |

> 已驗證環境：macOS + Node v26.3.0。較舊的 Node 版本尚未測試。

### Step 1｜下載專案

```bash
git clone https://github.com/YCHung1998/funding-analysis.git
cd funding-analysis
```

已經有專案資料夾的話，直接 `cd` 進去即可。

### Step 2｜安裝套件（只需做一次）

```bash
npm install --legacy-peer-deps
```

⚠️ **一定要加 `--legacy-peer-deps`**，否則會出現 `ERESOLVE could not resolve` 錯誤而安裝失敗。
看到 `npm warn allow-scripts ...` 的警告可以忽略。

### Step 3｜啟動

```bash
npm run dev
```

看到下面這行就代表成功（視窗要保持開著，關掉 = 伺服器停止）：

```
[5-Exchange Arbitrage Engine] Server listening on port 3000
```

### Step 4｜打開瀏覽器

前往 **<http://localhost:3000>**

- 預設進入「M3. Multi-Ex Funnel Scanner」頁。
- 第一次載入即時掃描約需 4–6 秒（要同時問 5 家交易所）。
- 想確認後端是否正常，可在瀏覽器打開 <http://localhost:3000/api/market/live-scan>，看到 `"success":true` 即可。

### Step 5｜停止

回到終端機按 **`Ctrl + C`**。

### 下次再啟動

只要重做 Step 3、Step 4（`cd` 到專案資料夾 → `npm run dev` → 開瀏覽器）。

### 常見問題

| 症狀 | 原因 | 解法 |
|------|------|------|
| `npm install` 出現 `ERESOLVE` | 少了 `--legacy-peer-deps` | 重跑 Step 2 的完整指令 |
| `command not found: npm` / `node` | 沒裝 Node.js | 見上方「你需要的工具」 |
| `Error: listen EADDRINUSE ... :3000` | 3000 port 被佔用（通常是上一次沒關掉的伺服器） | 執行 `lsof -ti :3000 \| xargs kill` 後再 `npm run dev` |
| 頁面開得起來，但某家交易所沒有資料 / 數量是 0 | 該交易所 API 連線失敗（公司網路、VPN、地區限制） | 換網路或開關 VPN；打開 `/api/latency/ping`，值為 `-1` 的就是連不到的交易所 |
| 瀏覽器顯示「無法連線」 | 伺服器沒在跑 | 確認終端機還開著並有 `Server listening` 字樣 |

### 進階：正式模式（先打包再啟動，較省資源）

```bash
npm run build                          # 產出 dist/
NODE_ENV=production npm start          # 一樣開 http://localhost:3000
```

### 其他開發指令

```bash
npm run lint     # tsc --noEmit 型別檢查
npm run build    # 打包到 dist/
```

### 關於 API Key

- **不需要任何 API Key** 就能跑：所有即時資料都來自交易所的公開行情 API。
- `.env.example` 內的 `GEMINI_API_KEY` / `APP_URL` 是 Google AI Studio 範本遺留，目前程式沒有使用。
- 交易所 API Key 目前**沒有任何用途**（沒有下單功能）；Local Secret Vault 頁面只是先把設定欄位做出來。

### 新手建議閱讀順序（照策略流程走）

| 步驟 | 頁面（上方分頁） | 你要回答的問題 |
|------|-----------------|---------------|
| ① | **M4. Sensitivity Matrix** | 在目前手續費下，spread 至少要多少才有賺？（先建立直覺） |
| ② | **M3. Multi-Ex Funnel Scanner** | 現在哪些幣、哪兩所的費率差最大？還剩多久結算？ |
| ③ | **M2. ±2m Kline & Volume Shock** | 這個幣結算前後波動、成交量衝擊大不大？滑價會吃掉多少？ |
| ④ | **M6/M7. Dry-Run & Risk Console** | 模擬整個 T-30s → T → T+30s 的下單、成交、結算、平倉，淨利剩多少？單腿失敗怎麼辦？ |
| ⑤ | M1 / Spec 頁 | 想擴充交易所或了解設計原則時再看 |

上方 Header 的 `(?)` 按鈕會依目前分頁顯示對應說明。

## 4. 哪些是真的、哪些是假的

| 頁面 | 資料來源 | 備註 |
|------|---------|------|
| M3 Funnel Scanner — Live 區 | ✅ **即時**：Pionex / Binance / Bybit / Bitget / OKX 公開 API（server 端 5 秒快取） | 三級漏斗示範區仍是 `src/engine/funnelScanner.ts` 內寫死的 15 個幣 |
| M2 Kline Viewer | 🟡 mock（`src/data/mockMarketData.ts`）＋ 即時 Binance/Pionex 最近 5 根 1m K | 非「結算時刻」的歷史 K 棒 |
| M4 Arbitrage Scanner | ❌ mock 回測事件 | |
| M4 Sensitivity Matrix | ✅ 純公式，無資料依賴 | |
| M5 60s Execution Flow | ❌ mock 事件 → `src/engine/arbitrageEngine.ts` | 公式可信，輸入是假的 |
| M6/M7 Dry-Run Console | 🟡 候選可來自即時掃描；**延遲、價格漂移、保證金、部分風控項為寫死常數** | 唯一可觸發的失敗情境是「強制單腿失敗（429）」 |
| M1 Schema Inspector | 範例 payload → adapter 轉換展示 | server 端實際解析**沒有走** adapter |
| Latency ping | ✅ 即時量測本機 → 5 所的 RTT | |

## 5. 已知限制（使用結果前必讀）

以下都已在程式碼中確認，詳細修正方向見 `assets/HANDOFF.md`：

1. **結算週期未正規化**：1h 合約和 8h 合約的費率直接相減比較，會高估/低估 spread；Binance / Bitget / OKX 週期被寫死為 8h。
2. **兩所結算時間可能不同**：目前取最早的那一所當 T，沒有檢查兩腿是否同時結算。
3. **成交量只來自 Binance**；Binance 沒上架的幣會被填入預設值 `10,000,000`，看起來像有量。實測排名前幾名常是 24h 量只有數十萬 U 的冷門幣。
4. **滑價估計在即時掃描中是依成交量分三級的常數**（0.015% / 0.03% / 0.05% 每腿），沒有看盤口深度。
5. **`1000PEPE` 類合約**會被正規化成 `PEPE`，但價格/數量倍數沒有換算，對沖數量會錯。
6. **手續費一律假設 taker 0.05%**，未依各所實際費率 / VIP 等級。
7. **沒有任何自動化測試。**

## 6. 核心公式

| 項目 | 公式 | 位置 |
|------|------|------|
| Spread | `abs(rate_A − rate_B)`（小數，0.0025 = 0.25%） | `server.ts`、`funnelScanner.ts` |
| 方向 | 低費率所做多、高費率所做空 | 同上 |
| 資金費損益 | 多方 `−N × rate_long`；空方 `+N × rate_short` | `arbitrageEngine.ts`、`dryRunEngine.ts` |
| 手續費拖累 | `2 × (taker_A + taker_B)`，預設 = 0.20% | `SensitivityMatrix.tsx` |
| 預期淨利 | `spread − fee_drag − 4 × slip_per_leg` | `server.ts:298` |
| 滑價模型（研究用） | `½ × bid-ask% + vol% × 0.12 × clamp(shock×0.5, 0.8, 2.5)`，下限 1bp | `arbitrageEngine.ts:51` |
| 量能衝擊 | `T 棒量 / avg(T-2m, T-1m 量)` | `arbitrageEngine.ts` |

## 7. 專案結構

```
server.ts                      Express：/api/market/live-scan、/api/latency/ping、/api/market/live-klines
src/
  types/schema.ts              Common Schema（CommonFundingRecord、SettlementWindowBar、交易結果）
  types/systemSpec.ts          M1–M7 系統型別（FunnelCandidate、訂單狀態機、風控、Secrets）
  adapters/*Adapter.ts         各所原始 payload → CommonFundingRecord（目前僅供 Schema 頁展示）
  engine/arbitrageEngine.ts    研究用 60 秒執行實驗 & 滑價模型
  engine/funnelScanner.ts      三級漏斗（mock 宇宙）
  engine/dryRunEngine.ts       Dry-run 時間軸 / 9 項風控 / 成本分解
  services/liveMarketService.ts 前端呼叫 server API
  data/mockMarketData.ts       mock 結算事件
  spec/arbitrageSpecV01.ts     App 內 Spec 頁的內容（設計原則）
  components/                  各分頁 UI
assets/HANDOFF.md              交接規範 & 目前狀態 & backlog
assets/ARCHITECTURE.md         架構圖（Mermaid + 元件索引，agent 優先讀這份）
assets/architecture.html       互動式架構圖（瀏覽器打開）
assets/architecture.json       架構圖原始定義（含元件 → 原始碼路徑）
issue/                         Review 問題清單（Q 量化 / BE 後端 / FE 前端），先讀 issue/README.md
```

## 8. 設計原則（不可違反）

1. **Truth Layer vs Intelligence Layer**：只有交易所 API 可作為下單與部位依據；CoinGlass 等聚合站只能當情報。
2. **策略層不得出現交易所名稱分支**（`if (Pionex) … else if (Binance)`）；差異由 adapter 吸收。
3. **永不假設 8 小時結算**；以交易所回傳的 `funding_time` / 週期為準。
4. **Cancel ≠ Close**：未成交單用取消，已成交部位必須市價平倉；單腿成交即進入 `LEG_IMBALANCE` 緊急平倉。
5. **憑證永不進入 Common Schema、日誌、匯出檔**；實盤金鑰禁止提現權限並綁 IP 白名單。

## 9. 免責

本專案僅供研究。資金費率套利並非無風險：費率可能在結算前翻轉、單腿成交失敗、交易所結算時間偏移、保證金不足強平等，都可能造成虧損。
