# Q-02｜結算時程模型錯誤：兩腿結算時間不對齊、Bitget 無結算時間、Binance/Bitget/OKX 週期寫死 8h

- **嚴重度**：Critical（T-30s/T+30s 單次結算策略的前提是「兩腿都在 T 結算」；不對齊時實際只收付一腿，預期獲利可直接變成虧損）
- **類別**：策略正確性
- **位置**：`server.ts:185,187`（Binance）、`server.ts:200-203`（Pionex 以剩餘時間猜週期）、`server.ts:222-234`（Bitget 未設 `nextFundingTimes`、週期寫死 8）、`server.ts:247`（OKX 寫死 8）、`server.ts:287-292`（取所有交易所 `min(nextFundingTime)`、`min(interval)`，與 best_pair 無關）、`src/adapters/binanceAdapter.ts:76`、`src/adapters/bybitAdapter.ts:82`（`next_funding_time` 再 +interval）、`src/engine/funnelScanner.ts:55-56`
- **對應 HANDOFF**：P1、P2 / B2、B3

## 問題（技術描述）
```ts
// server.ts:287-292
const validTimes = Object.values(agg.nextFundingTimes).filter(t => t > now);
const nextFundingTime = Math.min(...validTimes);        // 5 所取最早者，不是 best_pair 兩腿
const intervalHours = Math.min(...intervals);            // 同上
```
1. **配對時完全不檢查兩腿 T 是否相同**（`server.ts:264-285` 只比費率）。
2. **Bitget 沒有結算時間**：ticker 不含 `nextFundingTime`，程式也沒補，Bitget 腿永遠不參與時間判斷。
3. **週期寫死 8h**：Binance（`:187`）、Bitget（`:232`）、OKX（`:247`）。Pionex 以「距下次結算剩幾小時」推週期（`:202-203`），8h 合約在距結算 < 4.2h 時被標成 4h、< 1.2h 時被標成 1h。
4. `funnelScanner.ts:55-56` 以 `Math.ceil(now / intervalMs) * intervalMs` 推結算時間，與檔頭註解「NEVER assumed」自相矛盾；adapter 對 `nextFundingTime` 再 `+ interval`，把「下一次」變成「下下次」。

**策略面的正確理解**：對「單次結算、T±30s」策略，應比較的是**同一個 T 上兩腿各自實際收付的費率**（原始每期費率，不需換算每小時）；4h 與 8h 合約在 00/08/16 UTC 同時結算時，原始 spread 就是正確收益，但在 04/12/20 UTC 只有 4h 腿結算。週期換算（per-hour）只在「持倉跨多期」時才是正確口徑（HANDOFF §8 問題 1）。

## 證據
- `curl -s https://fapi.binance.com/fapi/v1/fundingInfo`：803 筆中 `fundingIntervalHours` = **4h：469、8h：333、1h：1**。
- `curl -s "https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES"`：816 筆中 `fundingRateInterval` = **8：429、4：386、1：1**；單筆範例 `{"symbol":"BTCUSDT","fundingRateInterval":"8","nextUpdate":"1790784000000"}`。另 `GET /api/v2/mix/market/funding-time` 回 `{"nextFundingTime":"1790784000000","ratePeriod":"8"}`。
- `curl -s "https://www.okx.com/api/v5/public/funding-rate?instId=ANY"`：`CHIP-USDT-SWAP` `fundingTime - prevFundingTime = 4h`。
- 以同一快照重跑 `server.ts` 邏輯：週期寫錯的合約數 **Binance 451、Bitget 377、OKX 211**；803 個 candidate 中 **61 個 best_pair 兩腿結算時間差 > 60s**。
- 具體反例 `CXMT`：Long Binance（rate 0.159%，4h，T+3.91h）/ Short OKX（rate 0.309%，8h，T+7.91h），系統顯示 spread 0.150%、`next_funding_time` = T+3.91h。實際在 T+3.91h 只有 Binance 結算：long 腿**支付** 0.159%，short 腿收 0 → 資金費 PnL = **-1.59 USDT / 1000U**，不是 +1.50。
- 官方文件：
  - Binance（https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-Info）：「Query funding rate info for symbols that had FundingRateCap/FundingRateFloor / fundingIntervalHours adjustment」（即未列出者為預設 8h）。
  - Binance FAQ（https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031）：「Binance reserves the right to update the funding interval of a perpetual contract that differs from the default 8-hour funding interval.」
  - OKX（https://www.okx.com/docs-v5/en/ ，Get funding rate）：「users should focus on the difference between `fundingTime` and `nextFundingTime` fields to determine the funding fee interval of a contract.」
  - Bybit（https://bybit-exchange.github.io/docs/v5/market/tickers）：`fundingIntervalHour`「Funding interval hour」「This value currently only supports whole hours」（Bybit 目前已正確使用）。
  - Bitget：官方 API 文件頁為 JS 渲染，**未能取得**原文；欄位存在以 curl 實測為準。ccxt（https://github.com/ccxt/ccxt/issues/27115）：「Bitget funding rates also vary between 8/4/1 hour」。

## 影響
- 所有「4h 腿 × 8h 腿」組合在非共同結算時點的預期 PnL 全錯；每 8h 內有一半的 4h 結算時點屬此類。CXMT 例：預期 +1.50 USDT，實際 -1.59 USDT（未計成本），誤差 3.09 USDT / 1000U。
- 含 Bitget 腿的組合（前 12 名中有 8 組）完全沒有時間驗證，`time_to_settlement_sec` 取的是另一所的時間，T-30s 進場可能落在 Bitget 結算之前或之後數小時。
- `interval_hours` 欄位與 UI 的週期篩選（`FunnelScannerView.tsx:298-300`）結果不可信。

## Top 3 解方
### 1. 每腿各自取「真實下次結算時間 + 週期」，只配對同 T 的兩腿（推薦）
- 做法：Binance `premiumIndex.nextFundingTime` + `fundingInfo.fundingIntervalHours`（未列出=8）；Bybit `nextFundingTime` + `fundingIntervalHour`；OKX `fundingTime` + (`fundingTime - prevFundingTime`)；Bitget `current-fund-rate` 的 `nextUpdate` + `fundingRateInterval`；Pionex 在 `SymbolAggregate` 只存 `nextFundingTime`，週期以歷史結算間隔推（Pionex 公開文件未提供週期欄位，**未查證**）。配對迴圈內加入 `|tA - tB| <= 60_000` 的條件，候選的 `next_funding_time` 改為該對的共同 T。
- 取捨：候選數會下降；需多打 Binance `fundingInfo`、Bitget `current-fund-rate` 兩個批次端點（皆可每小時快取）。
- 參考：OKX 文件 — 「use the difference between fundingTime and nextFundingTime to determine the actual interval」；ccxt #27115 — 「implement a `fetch_funding_intervals` method similar to Binance's implementation」。
### 2. 非對齊時改用「單腿收付」口徑計算，而非直接淘汰
- 做法：對每個候選計算 `fundingPnL_at_T = Σ_{legs settling at T} side × rate`；只有一腿結算時仍可能有利可圖（例如 short 腿 rate 很高、long 腿不結算），但需要承擔更長持倉或兩腿不同時退出的設計。
- 取捨：邏輯較複雜；對「T+30s 雙腿同時平倉」的現行流程需分支。
- 參考：Binance FAQ — 「You are only liable for funding payments in either direction if you have open positions at the pre-specified funding times.」
### 3. 跨多期持倉口徑時才做週期正規化
- 做法：若使用者選擇持倉跨多次結算（HANDOFF §8 Q1），以 `rate / intervalHours` 或「持有期間內累計預期收付」比較；UI 同時顯示 per-event 與 per-8h 兩欄。
- 取捨：單次結算策略不需要；混用兩種口徑會誤導。
- 參考：OKX 文件 — 「the funding rate collection frequency, currently set at 8 hours, may be adjusted to higher frequencies such as 6 hours, 4 hours, 2 hours, or 1 hour.」

## 驗收條件
- [ ] 單元測試：Binance 4h 腿（T1）× OKX 8h 腿（T2 = T1 + 4h）→ 不應出現在同 T 候選中（或以單腿口徑計算出 -rate）。
- [ ] 單元測試：OKX 週期 = `(fundingTime - prevFundingTime)/3.6e6`；Binance 未列於 fundingInfo 者 = 8。
- [ ] 所有 candidate 的兩腿 `nextFundingTime` 皆非空，且 `|tA - tB| <= 60s`。
- [ ] Pionex 8h 合約在距結算 2h 時，`interval_hours` 仍為 8。
