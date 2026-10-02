# Q-04｜把「預測費率」當成確定收益，且未處理結算時刻容忍度與結算確認

- **嚴重度**：High（所有 5 所回傳的都是 T 之前持續變動的預測值；在 T-30m 做排名、T-30s 進場，期間費率翻轉或縮小都不會被偵測）
- **類別**：策略正確性 / 風險
- **位置**：`server.ts:183`（Binance `lastFundingRate`）、`server.ts:198`（Pionex `nextFundingRate`）、`server.ts:214,229,242`、`server.ts:298,333`（`expected_net_pnl`、`meets_threshold` 直接以當下預測值計算）、`src/engine/dryRunEngine.ts:145-146`（資金費 = 固定預測值 × notional）、`src/engine/funnelScanner.ts:12-16`（Level 3 在 T-30s 未重新取費率）
- **對應 HANDOFF**：P5、P8

## 問題（技術描述）
HANDOFF P5 懷疑「Binance `lastFundingRate` 是當期、Pionex `nextFundingRate` 是預測」而語意不一致。實測與文件顯示：**兩者（以及 Bybit/OKX/Bitget）都是「下一次結算的即時預測值」**，語意其實一致；真正的問題是程式把這個預測值當成已鎖定的收益：

```ts
const expectedNetPnlPct = maxSpread - fixedFeeDragPct - totalSlippagePct;  // server.ts:298
meets_threshold: maxSpread >= 0.0020,                                      // server.ts:333
const fundingPnLShort = notional * shortRate;                              // dryRunEngine.ts:146
```
- 沒有在 T-30s（進場前）與 T 前最後一刻重新取值、也沒有「費率翻轉 / spread 跌破門檻 → abort」的檢查（dry-run 的 r8 只是比對同一個靜態值）。
- 沒有在出場前確認「資金費已實際入帳」。Binance 明言結算有 15 秒誤差；其他所的容忍度未知。
- 各所預測值的更新頻率與算法不同（Binance 為時間加權的溢價指數估計），跨所比較的是不同時點、不同成熟度的估計值。

## 證據
- 預測 vs 已結算（`curl -s "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT"` 與 `curl -s "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=2"`）：
  - premiumIndex `lastFundingRate: -0.00000330`，`nextFundingTime: 1790784000000`
  - 最近一次已結算（`fundingTime: 1790755200000`）`fundingRate: -0.00000244`
  - ETH：`0.00005255` vs 已結算 `0.00005437`；SOL：`0.00000934` vs `0.00000901`。→ `lastFundingRate` **不是**上一期已結算值，而是下一期的即時估計。
- Binance API 文件（https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price）只寫「This is the Latest funding rate」，語意模糊；以上 curl 比對為判定依據。
- Binance FAQ（https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031）：顯示的費率是「an estimation of the last 8 hours of the premium index」；以及「There is a 15-second deviation in the actual funding fee transaction time. For example, when you open a position at 08:00:05 (UTC), the funding fee could still apply.」
- OKX 文件（https://www.okx.com/docs-v5/en/ ，Get funding rate）：fundingRate「Predicted funding rate for the upcoming settlement period... This is a forecast — the final settled rate may differ. See settFundingRate for the last settled rate.」
- SONYUSDT 反例（見 Q-03）：Bybit 預測 1.01%，近 5 次實際結算皆為 0。
- Pionex `market/indexes` 的欄位語意：Pionex 公開 API 文件（https://pionex-doc.gitbook.io/apidocs/llms-full.txt）未收錄此端點——**未查證**，僅由欄位名 `nextFundingRate` 推斷為預測值。

## 影響
- 排名與「預期淨利」建立在會變動的估計上：對 0.20% 門檻附近的候選，只要任一腿在 30 分鐘內變動 0.03–0.05%，淨利即由正轉負（成本已約 0.20–0.23%，見 Q-06）。
- 「T+30s 出場」在 Binance 是安全的（> 15s 誤差），但若某所結算延遲超過 30s，提早平倉會**錯過收取**但仍付出 4 筆手續費；反之「T-30s 進場」若該所結算提前，也會錯過。其他 4 所容忍度**未查證**。
- 實際虧損型態：費率在 T 前翻轉 → 兩腿都付費；dry-run 完全沒有這類情境（P8）。

## Top 3 解方
### 1. T-30s 重新取值 + abort 規則（推薦）
- 做法：Level 3（T-60s ~ T-30s）對選定兩腿各以單一 symbol 端點重新取預測費率（Binance `premiumIndex?symbol=`、OKX `funding-rate?instId=`、Bybit `tickers?symbol=`、Bitget `current-fund-rate?symbol=`），重算 `net = (r_short - r_long) - fees - slippage`，低於門檻或方向翻轉即 abort；dry-run 加入此判斷分支。
- 取捨：多 2 個請求、增加數十毫秒；可能放棄部分機會。
- 參考：OKX 文件 — 「This is a forecast — the final settled rate may differ.」
### 2. 出場前確認資金費已入帳，並採「時間 + 確認」雙條件出場
- 做法：出場條件改為 `now >= T + max(30s, venueTolerance)` **且** 已查到該筆 funding income（例如 Binance `GET /fapi/v1/income?incomeType=FUNDING_FEE`、OKX bills `type=8`、Bybit transaction log `type=SETTLEMENT`），逾時上限後才強制平倉。
- 取捨：需要私有 API（金鑰）；持倉時間拉長，價格風險略增。
- 參考：Binance FAQ — 「There is a 15-second deviation in the actual funding fee transaction time.」（其他所端點名稱**未查證**，實作前需逐所確認）
### 3. 以歷史「預測 vs 已結算」誤差建立折扣
- 做法：收集各所 T-30m / T-5m / T-30s 的預測值與最終結算值（Binance `/fapi/v1/fundingRate`、OKX `funding-rate-history` 的 `realizedRate`），估計誤差分布，排名改用 `spread - k·σ_forecast` 或其分位數。
- 取捨：需要先累積資料（可搭配 B7 歷史窗口）。
- 參考：OKX 文件（funding-rate-history）— 「fundingRate: Predicted funding rate」「realizedRate: Actual funding rate」。

## 驗收條件
- [ ] 單元測試：dry-run 情境「T-30s 重新取值時 spread 由 0.25% 變 0.10%」→ `action_recommendation === 'ABORT_PRE_FLIGHT'`。
- [ ] 單元測試：費率翻轉情境 → 模擬 funding PnL 為負且被記錄。
- [ ] HANDOFF P5 更新為「語意一致（皆為預測值），風險在於預測誤差」，附本檔 curl 證據。
- [ ] 出場邏輯有 `venueTolerance` 設定表，Binance ≥ 15s。
