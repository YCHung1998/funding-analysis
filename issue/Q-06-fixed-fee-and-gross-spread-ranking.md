# Q-06｜手續費一律 0.05% 且以「毛 spread」選對與判門檻，忽略各所真實費率

- **嚴重度**：Medium（Bybit×Bitget 組合每筆交易少算 0.03%；門檻判斷用毛 spread，淨利為負的候選也會被標為達標）
- **類別**：成本模型 / 策略正確性
- **位置**：`server.ts:264-285`（以毛 `spread` 選 best_pair）、`server.ts:297`（`fixedFeeDragPct = 0.0020`）、`server.ts:333`（`meets_threshold: maxSpread >= 0.0020`）、`server.ts:337`（依毛 spread 排序）、`src/engine/funnelScanner.ts:46`、`src/engine/dryRunEngine.ts:125-129`、`src/engine/arbitrageEngine.ts:23-24`、`src/components/ExecutionSimulator.tsx:42-67`（`longFee` 塞進 `pionex_taker_fee` 欄位）
- **對應 HANDOFF**：P9 / B9

## 問題（技術描述）
```ts
const fixedFeeDragPct = 0.0020;                 // server.ts:297：4 × 0.05%，不分交易所
meets_threshold: maxSpread >= 0.0020,           // server.ts:333：毛 spread，不扣滑價
matchedCandidates.sort((a, b) => b.spread - a.spread);  // server.ts:337：排序也用毛 spread
```
1. 各所 VIP0 taker 並不相同（見證據），但即時掃描、funnel、dry-run 全部固定 0.05%。adapter 中其實已寫了 `fee_rate: 0.00055`（Bybit）等值，但 server 未使用。
2. 選 best_pair 時只比 `|rateA − rateB|`，**不比「扣除該對手續費 + 兩腿滑價 + 時間對齊」後的淨值**；在 5 所中常出現毛 spread 最大、淨值卻不是最大的組合。
3. `ExecutionSimulator.tsx` 把使用者選的 `longFee` 傳入 `pionex_taker_fee`、`shortFee` 傳入 `binance_taker_fee`，但 `simulateExecutionExperiment` 內 Pionex 可能是 short → 兩腿手續費對調。

## 證據
- 各所 VIP0 / 一般用戶 USDT 永續 taker（皆為本次實際抓取頁面）：
  - Binance：finder.com（https://www.finder.com/cryptocurrency/trading/binance-futures-fees）「you'll pay a 0.02% maker fee and a 0.05% taker fee on USDⓈ-M Futures trades.」（Binance 官方費率頁 https://www.binance.com/en/fee/futureFee 需登入，**未能取得**表格）
  - Bybit：Bitsgap（https://bitsgap.com/blog/bybit-trading-fees-explained-what-it-costs）「Bybit charges 0.02% maker and 0.055% taker on perpetual contracts at the base, non-VIP tier」（Bybit 官方 help center 逾時，**未能取得**）
  - Bitget（官方）：https://www.bitget.com/support/articles/12560603817155 「Taker fee: 0.06% (for consuming liquidity by placing market orders), actual fee varies by account level.」
  - OKX（官方 learn 頁）：https://www.okx.com/en-us/learn/what-is-okx-perpetual-futures — 「Maker at 0.02% and Taker at 0.05%」
  - Pionex：Coin Bureau（https://coinbureau.com/review/pionex-review）「Futures: Its fee is at 0.02% Makers and 0.05% Takers.」（Pionex 官方費率頁**未查證**）
- 以同快照重跑：達門檻 12 組中 8 組為 Bybit×Bitget，真實 4 筆 taker = 2×(0.055%+0.06%) = **0.23%**；其餘含 Bybit 的為 0.21%。程式一律 0.20%。
- `MEW`（Bybit×Bitget，毛 spread 0.208%）被標 `meets_threshold = true`，但扣真實手續費 0.23% 後資金費收益即為負（尚未計滑價）。

## 影響
- Bybit×Bitget 每筆 1000U 少算 0.30 USDT；對 0.20–0.25% 區間的候選，這 0.03% 就決定正負。
- 以毛 spread 排序/判門檻，使用者看到的「達標」與實際淨利不一致（與 Q-05 疊加後差距更大）。
- ExecutionSimulator 在 Pionex 為 short 時手續費歸屬錯誤，單腿損益表不正確（總額在兩所費率相同時不變）。

## Top 3 解方
### 1. 每所費率設定表 + 以淨值選對與排序（推薦）
- 做法：新增 `FEE_TABLE: Record<ExchangeId, {maker, taker}>`（預設取上列 VIP0，允許使用者覆寫 VIP 等級）；配對迴圈內對每一對計算 `net = (r_short − r_long) − 2(takerA + takerB) − slipA − slipB`，以 `net` 選 best_pair、排序，`meets_threshold` 改為 `net > 0`（或 `net >= userMinEdge`）。毛 spread 保留為顯示欄位。
- 取捨：需要 Q-05 的滑價估計才完整；UI 需同時顯示毛/淨。
- 參考：Bitget 官方 — 「Taker fee: 0.06% ... actual fee varies by account level.」
### 2. 支援 maker 進場 / taker 對沖的混合執行
- 做法：先在流動性較好的腿掛 post-only maker，成交後立即以 taker 對沖另一腿；成本改為 `maker_A + taker_B`（例：0.02% + 0.05%）。
- 取捨：maker 未成交風險、T-30s 時間窗內可能來不及；需要 Q-04 的 abort 規則配合。
- 參考：Bitget 官方 — 「Maker fee: 0.02% (for providing liquidity as market makers)」。
### 3. 從帳戶 API 讀取實際費率
- 做法：有金鑰時以各所「查詢用戶費率」私有端點（例如 Binance `GET /fapi/v1/commissionRate`）覆寫預設值。
- 取捨：需要私有 API；各所端點名稱**未查證**。
- 參考：Bybit Bitsgap 文章同時指出實際費率依帳戶等級而定（「at the base, non-VIP tier」）。

## 驗收條件
- [x] 單元測試：Bybit×Bitget、spread 0.208%、滑價 0 → `expected_net_pnl_pct < 0` 且 `meets_threshold === false`。（2026-10-01 `net-cost-model`：`expectedNet.test.ts`「毛 spread 通過但淨值為負（Q-06 MEW）」）
- [x] 單元測試：best_pair 依 `net` 而非毛 spread 選擇（構造毛 spread 最大但手續費最高的組合）。（`expectedNet.test.ts`、`server/liveScanRegistry.test.ts`）
- [x] ExecutionSimulator：Pionex 為 short 時，Pionex 腿的 `entry_fee` 使用 short 端設定的費率。（`arbitrageEngine.test.ts` `resolveLegFeeRates`）
