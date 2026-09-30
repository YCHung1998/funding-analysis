# Q-08｜Dry-run 與 Funnel 以常數 / mock 驅動：風控永遠 PASS、單腿失敗仍計資金費、Funnel 用假資料推結算時間

- **嚴重度**：Medium（不直接影響即時掃描，但使用者用它判斷「能不能做」，輸出幾乎與輸入無關，給出虛假的安全感）
- **類別**：風險 / 策略正確性
- **位置**：`src/engine/dryRunEngine.ts:97-98`（延遲依交易所名稱三元式）、`:125-129`（手續費固定 0.05%）、`:139-140`（價格 PnL 常數）、`:145`（單腿失敗時 long 腿仍計資金費）、`:194-237`（r5/r7/r9 永遠 PASS、r6 以 `volume_24h × 0.02` 冒充盤口深度）、`src/engine/funnelScanner.ts:20-36`（`RAW_UNIVERSE_SYMBOLS` 寫死 15 檔與費率）、`:55-57`（`ceil(now/interval)` 推結算時間、最小 30s）、`:111-117`（無合格者時仍把第一名標為 `Level3_Selected`）
- **對應 HANDOFF**：P7、P8 / B8

## 問題（技術描述）
```ts
const fundingPnLLong = -notional * longRate;                        // dryRunEngine.ts:145 — 無論是否 forceLegImbalance
// timeline step_4：單腿失敗時在 T-29.84s 就已「CLOSE longEx position」
value: `$${(candidate.volume_24h * 0.02 / 1000).toFixed(0)}k`,        // :207 — 24h 量的 2% 當作 ±0.1% 深度
level3Selected = level2Top3.length > 0 ? ... : { ...evaluatedAll[0], funnel_stage: 'Level3_Selected' };  // funnelScanner.ts:111-117
```
1. **單腿失敗情境的 PnL 錯誤**：short 腿被拒、long 腿在 T-29.84s 已緊急平倉，T 時沒有持倉，不應收付資金費；但 `fundingPnLLong` 仍以 `-notional × longRate` 計入，且未計緊急平倉的額外滑價與不利價格。
2. **風控檢查為裝飾**：r5（基差）、r7（保證金 `$5,000`）、r9（上架驗證）永遠 PASS；r6 以 24h 量的 2% 推深度，與實際盤口無關；唯一 FAIL 來源是手動 `forceLegImbalance`。
3. **Funnel 假設**：以 mock universe 與整點倍數推結算時間（違反自身「NEVER assume」規則，且與 Q-02 的真實時程衝突）；Level 2 全部淘汰時仍輸出「已選定」候選，下游 dry-run 會對不合格標的模擬進場。
4. 未模擬：部分成交、API timeout / 重試、T 前費率翻轉、結算延遲（HANDOFF P8）。

## 證據
- 程式碼行號如上（`dryRunEngine.ts:145-146` 與 `:128-129,135-136,140` 的 `forceLegImbalance ? 0 : ...` 對照：short 腿全部歸零，long 腿資金費未歸零）。
- `funnelScanner.ts:7-10` 檔頭：「Funding settlement intervals are NEVER assumed to be 8 hours ... strictly bound to exchange truth `funding_time` / `next_funding_time`」，但 `:55-56` 以 `Math.ceil(currentTime / intervalMs) * intervalMs` 推算。
- Binance FAQ（https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031）：「You are only liable for funding payments in either direction if you have open positions at the pre-specified funding times. If you do not have a position, you are not liable for any funding.」→ 單腿失敗且已平倉時資金費應為 0。

## 影響
- 單腿失敗情境：若 longRate = −0.3%（long 腿本應收取），報表顯示 +3 USDT 的資金費收入，實際為 0，另加緊急平倉成本 → 報表把一次虧損顯示為獲利或小虧。
- 使用者看到 9 項風控 8 項 PASS，會誤以為系統已驗證保證金、基差、上架狀態；實際上 Q-01/Q-03 的錯誤合約、下市合約都會通過 r9。
- Funnel 在無合格標的時仍「選定」一檔，可能導致對負期望值交易做 dry-run 並被誤讀為可行。

## Top 3 解方
### 1. 情境化、可設 seed 的 Monte Carlo dry-run（推薦，對應 B8）
- 做法：將延遲、成交率、部分成交比例、滑價、基差漂移（Q-07）、T 前費率變動（Q-04）改為分布參數，由真實量測（`/api/latency/ping`、盤口、歷史 K 棒）校準；輸出 N 次模擬的損益分布（均值、5% 分位、虧損機率）。單腿失敗分支中 long 腿 `fundingPnL = 0`，並加上緊急平倉成本。
- 取捨：實作量 L；需先完成 Q-04/Q-05/Q-07 的資料來源。
- 參考：Binance FAQ — 「If you do not have a position, you are not liable for any funding.」
### 2. 風控檢查綁定真實資料
- 做法：r5 用即時兩腿 mark 差；r6 用 Q-05 的 walk-the-book 深度；r7 用帳戶可用保證金（有金鑰時）或使用者輸入；r9 用 Q-03 的 instrument 狀態；資料缺失時狀態為 `UNKNOWN`（不得 PASS）。
- 取捨：無金鑰時 r7 只能半自動。
- 參考：Binance exchangeInfo（https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information）— `status`「Current trading state of the symbol」。
### 3. Funnel 改吃 live-scan 結果並允許「無選定」
- 做法：`runFunnelScan` 輸入改為 live-scan candidates（含 Q-02 的真實 T）；`level3_selected` 型別改為 `FunnelCandidate | null`，無合格者時 UI 顯示「本輪不交易」。
- 取捨：需調整 `FunnelScannerView` 與 `DryRunConsole` 對 null 的處理。
- 參考：OKX 文件（https://www.okx.com/docs-v5/en/）— 「users should focus on the difference between `fundingTime` and `nextFundingTime` fields to determine the funding fee interval」（結算時間應取自交易所而非推算）。

## 驗收條件
- [ ] 單元測試：`forceLegImbalance = true`、`longRate = -0.003` → `cost_table.funding_pnl.leg_long === 0`。
- [ ] 單元測試：Level 2 無合格者 → `level3_selected === null`。
- [ ] 單元測試：同一 seed 兩次 dry-run 結果相同；不同 seed 的 `price_pnl` 分布標準差 > 0。
- [ ] 風控資料缺失時對應項目狀態為 `UNKNOWN` 而非 `PASS`。
