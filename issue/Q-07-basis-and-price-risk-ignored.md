# Q-07｜跨所基差 / 價格漂移風險完全未進入預期 PnL，且資金費以名目本金而非持倉價值計算

- **嚴重度**：High（高 spread 候選的跨所基差本身就 0.13–0.37%，與要賺的資金費同一量級；60 秒內基差變動即可吃掉全部收益，但掃描與 dry-run 視為 0 或常數）
- **類別**：風險 / 策略正確性
- **位置**：`server.ts:298`（`expectedNetPnlPct` 無價格項）、`server.ts:245`（OKX 的 "mark" 其實是 `t.last`）、`src/engine/dryRunEngine.ts:139-140`（價格 PnL 常數 +0.008% / −0.009%）、`src/engine/dryRunEngine.ts:194-201`（r5 基差檢查寫死 `'0.018%'` 且永遠 PASS）、`src/engine/arbitrageEngine.ts:132-136`（兩腿漂移各自取 T 棒 return 的一半，未建模相關性）、`src/engine/arbitrageEngine.ts:166-172`、`dryRunEngine.ts:145-146`（funding = notional × rate）
- **對應 HANDOFF**：P7

## 問題（技術描述）
```ts
const expectedNetPnlPct = maxSpread - fixedFeeDragPct - totalSlippagePct;   // server.ts:298 — 無基差項
const pricePnLLong  =  notional * 0.00008;                                   // dryRunEngine.ts:139
const pricePnLShort = -notional * 0.00009;                                   // dryRunEngine.ts:140
value: '0.018%', status: 'PASS',                                             // dryRunEngine.ts:197-198
```
1. **進場基差**：long 腿買在 A 所、short 腿賣在 B 所，兩所價格本來就不同；出場時基差若擴大（對 long/short 不利方向），價格 PnL 為負。系統既不顯示進場基差，也不估計其 60 秒變動分布。
2. **結算前後的系統性價格行為**：高正費率合約的溢價（perp 高於現貨）正是費率高的原因；結算後溢價常收斂，而收斂幅度在兩所不一定相同（費率差異大 = 溢價差異大）。這是資金費套利的主要隱藏成本，程式完全沒有建模。
3. **資金費計算基礎**：各所以「持倉名目價值 = 數量 × 結算時 mark price」計算，而非固定 1000U；進場後價格變動會改變兩腿名目，兩腿數量若以各自成交價換算，名目也不完全相等（小誤差，但在 1000U、0.2% 級距仍需一致處理）。
4. OKX 的 marks 用 `t.last`（最新成交價）而非 mark price，跨所比較口徑不一致。

## 證據
- 以同快照計算達門檻 12 組兩腿的 mark 相對差（`server.ts` 邏輯重跑）：SIREN 0.259%、FLY 0.350%、CYPH −0.281%、BOT −0.261%、MEW −0.368%、US −0.167%、NAVER 0.133%、O −0.138% —— 與其 funding spread（0.21–1.02%）同量級。
- Binance FAQ（https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031）：「Funding Amount = Nominal Value of Positions * Funding Rate」，名目價值 = mark price × 合約數量。
- He, Manela, Ross, von Wachter,《Fundamentals of Perpetual Futures》（https://arxiv.org/abs/2212.06888）：「perpetuals are not guaranteed to converge to the spot price」「Empirically, deviations from these prices in crypto are larger than in traditional currency markets」——跨所/跨市場價格偏離是實證上顯著的風險。
- 「結算後溢價收斂、價格在 T 附近系統性移動」的具體幅度：本次未取得可引用的量化研究——**未查證**，需以 B7 歷史窗口資料自行驗證。

## 影響
- 對 1000U、spread 0.25% 的交易，資金費收益 2.5 USDT；兩腿基差在 60 秒內只要不利變動 0.25%（冷門合約常見）即歸零。目前 UI 顯示的「預期淨利」與 dry-run 的價格 PnL（+0.08 −0.09 = −0.01 USDT）嚴重低估此風險。
- dry-run 的 r5 永遠 PASS，使用者無法看到基差風險，與需求 #3 的「真實模擬」目標相違。
- 在極端情況（冷門幣、結算時價格劇烈跳動），一腿觸發強平而另一腿仍在，形成裸曝險（槓桿與保證金亦為常數 `$5,000`，見 Q-08）。

## Top 3 解方
### 1. 把「進場基差」與「60 秒基差變動分布」納入預期 PnL（推薦）
- 做法：Level 2 以兩腿 `bid1/ask1` 計算可成交基差 `basis_entry = ask_long / bid_short − 1`；以 B7 抓取的「結算 ±2m」1m K 棒估計兩腿 60 秒相對報酬差的標準差 `σ_basis_60s`；排名改用 `net − basis_entry_cost − z·σ_basis_60s`（z 依風險偏好，如 1.0）。dry-run 的 `pricePnL` 改為由此分布抽樣，r5 以實際值判定。
- 取捨：需要歷史資料與盤口快照；冷門合約的估計樣本少。
- 參考：He et al. — 「deviations from these prices in crypto are larger than in traditional currency markets」。
### 2. 資金費以持倉價值計算並對齊兩腿數量
- 做法：`qty = notional / fillPrice`（依各所 lot step 取整），`fundingPnL = −side × qty × markPrice_T × rate`；兩腿以「相同 base 數量」而非「相同 USDT」對沖，殘差 delta 記錄於報表。
- 取捨：需要 Q-01 的倍數與 lot size 資料。
- 參考：Binance FAQ — 「Funding Amount = Nominal Value of Positions * Funding Rate」。
### 3. 基差止損 / 退出條件
- 做法：持倉期間監控兩腿 mark 價差，若不利變動超過 `maxBasisDrift`（例如 funding spread 的 50%）且 T 尚未到，則提前 abort；T 後若基差不利則可延後平倉等待回歸（需設定上限）。
- 取捨：提前退出仍需付 4 筆手續費；延後平倉增加持倉風險。
- 參考：未查證（常見實務作法，本次未取得可引用來源）。

## 驗收條件
- [ ] live-scan 每個 candidate 輸出 `entry_basis_pct`（以兩腿 bid/ask 計算），OKX 腿使用 mark price 而非 last。
- [ ] dry-run 的 `price_pnl` 不再是常數；給定 seed 與 `σ_basis_60s`，多次模擬輸出分布（平均、5% 分位）。
- [ ] r5 的 `value` 與 `status` 由實際基差計算，基差 > 閾值時為 WARN/FAIL。
- [ ] 單元測試：價格上漲 1% 時，funding PnL = qty × markPrice_T × rate（而非 1000 × rate）。
