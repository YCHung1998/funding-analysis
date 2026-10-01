# Q-05｜滑價模型：研究引擎重複扣除滑價、即時掃描以「Binance 量三級常數」代替盤口

- **嚴重度**：High（研究引擎把滑價成本算成兩倍 → 系統性低估 PnL；即時掃描則對薄盤口系統性低估成本 → 高估 PnL，兩個方向的錯同時存在）
- **類別**：成本模型
- **位置**：`src/engine/arbitrageEngine.ts:122-147`（進出場價已含滑價）、`src/engine/arbitrageEngine.ts:186-200`（再扣一次 `totalSlippage`）、`src/engine/arbitrageEngine.ts:217,234`（腿別 net 同樣重複）、`server.ts:294-296`（量三級常數 ×4）、`src/engine/dryRunEngine.ts:132`、`src/engine/funnelScanner.ts:60`（mock `slip`）
- **對應 HANDOFF**：P4 / B4

## 問題（技術描述）
**(a) 重複計算（研究引擎）**
```ts
// arbitrageEngine.ts:126-128, 145-147 —— 價格已經含滑價
const binanceEntryPrice = binance.mark_price * (1 + binanceSlipRate);      // LONG 買在 mark 之上
const binanceExitPrice  = binanceExitMark   * (1 - binanceSlipRate);       // LONG 賣在 mark 之下
// :156-158 price PnL 已 ≈ drift − 2·slip
// :187-200 又再扣一次
const totalSlippage = totalEntrySlippage + totalExitSlippage;              // = notional × slip × 4
const netPnL = grossPnL - totalFee - totalSlippage;
```
Long 腿 price PnL = `(m(1+d)(1−s) − m(1+s)) / m(1+s) ≈ d − 2s`，已內含 2s 成本；之後又減 `2s × notional`，**每腿滑價被扣兩次**。`ExecutionSimulator.tsx` 與 `SensitivityMatrix` 皆使用此引擎。

**(b) 即時掃描不看盤口**
```ts
// server.ts:295-296
const estSlippagePct = volume24h > 100000000 ? 0.00015 : volume24h > 20000000 ? 0.0003 : 0.0005;
const totalSlippagePct = estSlippagePct * 4;
```
- 量取自 Binance（且缺值補 1,000 萬，見 Q-03），不是兩腿實際交易所。
- 1000U 這種小單的成本主體是**買賣價差的一半**加上盤口前幾檔的衝擊；三級常數對價差 0.2% 的冷門合約嚴重低估，對 BTC/ETH（價差 < 0.01%）則高估。
- 結算前後 1 分鐘是價差與波動放大的時段，常數模型無法反映（研究引擎有波動項，但即時掃描沒有）。

## 證據
- 數值推導（以 `custom_entry_slippage = 0.0003`、無漂移）：正確 4 筆滑價成本 = 4 × 0.03% × 1000 = **1.20 USDT**；`simulateExecutionExperiment` 回傳的 `net_pnl` 中滑價相關扣除 = price PnL 中的 ≈1.20 + `total_slippage` 1.20 = **2.40 USDT**。
- `curl -s "https://api.bybit.com/v5/market/tickers?category=linear&symbol=SONYUSDT"`：`bid1Price 23.91 / ask1Price 23.96`，相對價差 ≈ 0.21% → 單筆 taker 光半價差就 ≈ 0.105%，是程式最高檔 0.05% 的 2 倍；`turnover24h` 僅 24,678 USDT。
- Bybit tickers 文件（https://bybit-exchange.github.io/docs/v5/market/tickers）：已提供「bid1Price: Best bid price」等最佳買賣價欄位，程式已在抓但未使用。
- Binance 盤口端點（https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book）：`GET /fapi/v1/depth`，limit「5, 10, 20, 50, 100, 500, 1000」，weight 2（≤50 檔）。
- 衝擊模型業界慣例（https://en.wikipedia.org/wiki/Market_impact）：「Practitioners sometimes model market impact as proportional to the square root of traded volume, an approach that is supported by research.」
- Almgren–Chriss 原文 PDF 已下載但無法抽取文字——**未能取得**，不作為引用依據。

## 影響
- 研究 / 執行模擬頁（需求 #3）：每 1000U 多扣 `4 × slip × 1000`；以 0.03% 為例多扣 1.2 USDT，約等於 0.12% 的 spread → 真正淨利 +0.5 USDT 的交易會被顯示為 −0.7 USDT，錯殺可做的機會。
- 即時掃描（需求 #1）：冷門合約（正是高 spread 候選的主體）成本被低估 2–5 倍；例如價差 0.2% 的合約 4 筆 taker 半價差成本約 0.4%，模型只算 0.2%，**高 spread 的冷門幣被系統性推到排名前段**。

## Top 3 解方
### 1. 修正研究引擎：滑價只計一次（推薦，立即可做）
- 做法：二擇一——(i) 進出場價以 mark 計算、滑價獨立列為成本；或 (ii) 保留含滑價的成交價、`netPnL = pricePnL + fundingPnL − fees`，`total_slippage` 僅作顯示用（不再相減）。腿別 `net_pnl` 同步修正。
- 取捨：數字會變好看，需在 UI/HANDOFF 註明修正前後差異。
- 參考：屬基本損益會計（成交價已反映滑價即不可再扣），無需外部文獻；未另行引用。
### 2. 以盤口深度走簿（walk-the-book）估算 1000U 的成交均價
- 做法：Level 2（T-5m）對 Top-N 候選兩腿抓 `depth?limit=20`（Binance）、`/v5/market/orderbook`（Bybit）、`/api/v5/market/books`（OKX）、`/api/v2/mix/market/merge-depth`（Bitget），累加至 notional 1000U 求 VWAP，`slip = |VWAP − mid| / mid`；Level 1 至少用 `bid1/ask1` 的半價差。
- 取捨：每候選每腿 1 個請求；需處理各所深度格式（OKX/Bitget/Pionex 端點**未逐一查證**文件）。
- 參考：Binance Order Book 文件 — 「GET /fapi/v1/depth」「5, 10, 20, 50, 100, 500, 1000」。
### 3. 結算窗口的波動 / 價差放大係數
- 做法：以 B7 抓的「結算 ±2m」1m K 棒與盤口快照，統計各合約在 T 附近的價差倍數與 high-low range，對 Level 1 常數模型乘上 `settlementSpreadMultiplier`；並以平方根模型 `k·σ·sqrt(Q/V)` 作為深度不可得時的後備。
- 取捨：需要歷史資料累積；參數需定期校準。
- 參考：Wikipedia Market impact — 「proportional to the square root of traded volume」。

## 驗收條件
- [x] 單元測試：`simulateExecutionExperiment`，兩腿費率相同（funding 0）、無漂移、`custom_entry_slippage = 0.0003`、fee = 0 → `net_pnl ≈ −1.20`（±0.01），目前約 −2.40。（2026-10-01 `net-cost-model` 已修正）
- [ ] live-scan 每個 candidate 帶 `long_half_spread_pct`、`short_half_spread_pct`，且 `est_slippage_pct >= 2×(兩腿半價差和)`。（`websocket-data-layer` 已把真實盤口接進 Runtime `orderBookService`；研究端 live-scan 還沒接上，目前仍為 `LEGACY_VOLUME_TIER`，待下一輪決定是否接線）
- [ ] 對 SONYUSDT 類價差 > 0.2% 的合約，`est_slippage_pct` ≥ 0.4%。
