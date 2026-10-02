# BE-04｜REST 輪詢 + 5 秒快照：T-30s 資料新鮮度不足，倒數秒數在快取內凍結

- **嚴重度**：High（T-30s 時資料可能已舊 0.5–6+ 秒，倒數誤差最高約 5 秒 ≈ 決策窗口的 17%）
- **類別**：延遲
- **位置**：`server.ts:22-23`（`CACHE_TTL_MS = 5000`）、`server.ts:57-64`（快取命中直接回舊 payload）、`server.ts:287-289`（`time_to_settlement_sec` 在抓取當下算死）
- **對應 HANDOFF**：P2（結算時間對齊）相關；需求 #1 #3

## 問題（技術描述）
1. 資料新鮮度 = 上游 REST 往返（實測 0.5–1.3 s）+ 快取年齡（0–5 s）+ 前端輪詢間隔。沒有任何推播來源。
2. 快取命中時回傳 `...liveScanCache.data`，其中每個候選的 `time_to_settlement_sec` 是「抓取當下」算的，不隨時間遞減：

```ts
const timeToSettlementSec = Math.max(Math.floor((nextFundingTime - now) / 1000), 0); // now = 抓取時刻
...
return res.json({ success: true, cached: true, cache_age_ms: ..., ...liveScanCache.data });
```

3. 費率在結算前最後一分鐘仍會變動（預測費率），但 REST 快照只能取樣。

## 證據（實測）
- 快取凍結：兩次請求相隔 3 s，第二次 `cached:true, cache_age_ms: 4364`，第一名候選 `time_to_settlement_sec` 兩次都是 **13768**（應少 4 秒）。
- REST 冷抓取延遲（8 次循序、間隔 5.2 s）：總延遲 520–1,270 ms（`fetch_latency_ms` 503–1,248）。
- WebSocket 實測（`ws` 套件，本機直連）：

| 串流 | 實測 | 內容 |
|---|---|---|
| Binance `wss://fstream.binance.com/market/ws/!markPrice@arr` | 8 s 內 6 則，間隔 394–2,411 ms；每則 744 個 symbol、約 81 KB | 含 `r`（funding rate）、`T`（next funding time）、`E`（事件時間） |
| Bybit `tickers.BTCUSDT` | 5 s 內 32 則，中位間隔 **101 ms** | 含 `fundingRate`、`nextFundingTime` |
| OKX `funding-rate`（BTC-USDT-SWAP） | 訂閱即推 1 則快照 | 含 `fundingRate`、`fundingTime` |

  註：舊路徑 `wss://fstream.binance.com/ws/!markPrice@arr` 與 `/stream?streams=` 在本機 8 秒內 0 則訊息，原因**未查證**（Binance WS 路徑疑似改版），實作時需以官方文件為準。

官方文件：
- Bybit（https://bybit-exchange.github.io/docs/v5/websocket/public/ticker）：「Derivatives & Options - 100ms」
- OKX（https://www.okx.com/docs-v5/en/）：「Funding rate channel Retrieve funding rate. Data will be pushed in 30s to 90s.」；Tickers channel：「The fastest rate is 1 update/100ms.」
- Bitget（舊版 v1 文件，https://bitgetlimited.github.io/apidoc/en/mix/）：Tickers Channel「Data will be pushed every 150 ms.」（v2 文件頁：**未能取得**）
- Binance `!markPrice@arr` 官方頁：**未能取得**（WebFetch 只拿到首頁），上表為實測。

## 影響
- 在 T-30s 進場的設定下，最壞情況是看著 6 秒前的費率與凍結 5 秒的倒數做決策；費率若在最後階段翻轉（HANDOFF P8），REST 快照會錯過。
- 若要做到 T-30s 精準觸發，倒數必須由伺服器時間（BE-07）即時計算，而非從快照讀取。

## Top 3 解方
### 1. 伺服器端 WebSocket 聚合 + 記憶體最新值表（推薦）
- 做法：伺服器啟動時連 Binance `!markPrice@arr`、Bybit `tickers.*`（分批訂閱）、OKX `funding-rate`/`tickers`、Bitget ticker；維護 `Map<symbol, {rate, nextFundingTime, mark, ts}>`；REST 只作冷啟動快照與斷線補洞；每 20 s 心跳、斷線指數退避重連。
- 預期效益：新鮮度由「秒級」降到「100 ms–3 s（依交易所推播頻率）」；/live-scan 直接讀表，延遲 ≈ 快取命中（實測 7–8 ms）；REST 權重幾乎歸零（BE-03）。
- 取捨：需處理重連、訂閱上限、各所訊息格式；OKX funding-rate 推播僅 30–90 s 一次（費率本身更新慢，可接受）。
- 參考：https://bybit-exchange.github.io/docs/v5/ws/connect — 「we recommend that you send the `ping` heartbeat packet every 20 seconds to maintain the WebSocket connection.」
### 2. 把「倒數」與「快照」分離
- 做法：payload 只回 `next_funding_time`（絕對時間）與 `server_time`；`time_to_settlement_sec` 在每次回應時以 `nextFundingTime - (Date.now() + clockOffset)` 重新計算，或交給前端以伺服器時間推算。
- 預期效益：消除快取期間最多 5 s 的倒數誤差（實測 4.4 s）。
- 取捨：幾乎無；前端需改用絕對時間。
- 參考：https://www.okx.com/docs-v5/en/ — 「Get system time Retrieve API server time.」（以交易所時間為準的絕對時間戳）
### 3. 結算前自適應刷新
- 做法：若仍用 REST，依距最近結算時間動態調 TTL：> 5 分鐘時 30 s，T-2m 內 1 s 且只抓入選候選（帶 symbol 的輕端點，Binance 權重 1）。
- 預期效益：平時權重大降，關鍵窗口新鮮度提高到 ~1 s。
- 取捨：仍是輪詢，新鮮度上限受 REST 往返限制（實測 0.5–1.3 s）。
- 參考：https://datatracker.ietf.org/doc/html/rfc5861 — 「caches MAY serve the response in which it appears after it becomes stale, up to the indicated number of seconds.」

## 驗收條件
- [ ] 快取命中的回應中 `time_to_settlement_sec` 與 `next_funding_time - server_time` 誤差 ≤ 1 s
- [ ] 每個候選附 `source_ts`（交易所事件時間），T-60s～T 期間 p95 資料年齡 < 3 s
- [ ] WS 斷線後 30 s 內自動恢復，期間標記 `stale`
