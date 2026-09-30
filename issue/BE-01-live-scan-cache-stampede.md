# BE-01｜live-scan 冷快取時無 single-flight，併發請求放大上游流量（cache stampede）

- **嚴重度**：Critical（實測 10 個併發請求就打出 70 次上游呼叫並觸發 Binance / OKX / Bitget 429，距離 IP 封鎖只差一步）
- **類別**：限流風險 / 吞吐
- **位置**：`server.ts:22-23`、`server.ts:57-64`、`server.ts:69-117`、`server.ts:357`
- **對應 HANDOFF**：無（HANDOFF 未列；影響 B4/B6 之後的所有即時資料工作）

## 問題（技術描述）
快取只在「上游全部回來之後」才寫入；在這之前進來的每個請求都看到 `liveScanCache` 過期，於是各自重打 7 個上游端點。沒有 in-flight promise 共用（single-flight / request coalescing）。

```ts
if (liveScanCache && now - liveScanCache.timestamp < CACHE_TTL_MS) { return res.json(...) }
// ↓ 每個 cache miss 的請求都各自執行
const bnPromise = fetch('https://fapi.binance.com/fapi/v1/premiumIndex', ...)
...
const [...] = await Promise.all([...7 promises]);
liveScanCache = { timestamp: now, data: payload };   // 最後才寫入
```

前端 `FunnelScannerView` 與 `DryRunConsole` 兩個分頁都會呼叫 `fetchLiveMarketScan()`，多開分頁 / 多人使用 / 自動輪詢在 TTL 到期的同一瞬間，就會同時 miss。

## 證據（實測）
在 scratchpad 以原始 `server.ts`（只把 PORT 改為可覆寫，未改邏輯）跑在 :3001，並以 `--import` 預載的 fetch 計數器記錄每次上游呼叫。

| 情境 | 上游呼叫數 | 回應延遲 |
|---|---|---|
| 1 個冷請求 | 7 | 1,134 ms |
| 10 個併發冷請求 | **70** | 2.72–6.04 s |
| 50 個併發冷請求 | **350** | p50 6.05 s、全部 ≈ 6.0 s（撞到 6s timeout） |

- 50 併發時 350 次上游中 **125 次 `TimeoutError`**，OKX `public/funding-rate` 回 **429** 16 次。
- 整段測試累計：OKX funding-rate 429 ×24、Binance `premiumIndex` 429 ×3、`ticker/24hr` 429 ×4、Binance `ping` 429 ×5、Bitget tickers 429 ×4。
- Binance 權重：在同一分鐘內量 `x-mbx-used-weight-1m`，10 個併發 scan 前 = 1、後 = **502**（每次 scan ≈ 50 權重）。
- （誠實揭露：本測試自身就讓本機 IP 收到 Binance 429；之後停止壓測，權重已回到 1，未收到 418。）

官方文件：
- Binance exchangeInfo（https://fapi.binance.com/fapi/v1/exchangeInfo）：`"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 2400`
- Binance General Info（https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info）：「Repeatedly violating rate limits and/or failing to back off after receiving 429s will result in an automated IP ban (HTTP status 418).」
- OKX（https://www.okx.com/docs-v5/en/）Get funding rate：「Rate Limit: 10 requests per 2 seconds Rate limit rule: IP + Instrument ID」

## 影響
- 2400 / 50 = **48 次 scan/分鐘** 就吃滿 Binance 權重；一次 50 併發（例如 T-30s 前多個分頁同時刷新）即可超過，重複發生會被 418 封 2 分鐘到 3 天。
- OKX funding-rate 以 `instId=ANY` 視為同一 instId，2 秒內第 11 次即 429 → 該所資料被靜默清空（見 BE-02）。
- 使用者感受延遲從 ~1 s 惡化到 6 s，正好落在 T-30s 決策窗口內。

## Top 3 解方
### 1. In-flight promise 共用（single-flight）（推薦）
- 做法：模組層級保存 `let inflight: Promise<Payload> | null`；cache miss 時若 `inflight` 存在就 `await inflight`，否則建立並在 `finally` 清空。約 10 行，不需新套件。
- 預期效益：N 個併發冷請求 → 上游恰好 7 次（實測基準 70/350 → 7），Binance 權重上限固定在每 TTL 50。
- 取捨：所有等待者共享同一次失敗；需搭配 BE-02 的部分失敗語意。
- 參考：https://pkg.go.dev/golang.org/x/sync/singleflight — 「Do executes and returns the results of the given function, making sure that only one execution is in-flight for a given key at a time.」
### 2. 背景定時刷新 + stale-while-revalidate
- 做法：以 `setInterval`（或遞迴 `setTimeout`）由伺服器自己每 N 秒刷新一次快照，HTTP handler 只讀記憶體；過期時先回舊資料並標記 `cache_age_ms`，背景更新。
- 預期效益：上游流量與前端請求數完全脫鉤（固定 7 次 / N 秒）；handler p99 ≈ 快取命中延遲（實測 7–8 ms）。
- 取捨：無人使用時仍持續打上游（可在閒置時暫停）。
- 參考：https://datatracker.ietf.org/doc/html/rfc5861 — 「the stale-while-revalidate Cache-Control extension indicates that caches MAY serve the response in which it appears after it becomes stale, up to the indicated number of seconds.」
### 3. undici `deduplicate` interceptor
- 做法：建立 `new Agent().compose(interceptors.deduplicate())` 作為 fetch `dispatcher`，同一 URL 的併發 GET 在傳輸層合併。
- 預期效益：同樣把重複上游呼叫壓到 1 次 / URL，無需改 handler 結構。
- 取捨：只去重「同時在途」的請求，不解決 TTL 語意；需額外安裝 `undici` 套件以取得 interceptors。
- 參考：https://github.com/nodejs/undici/blob/main/docs/docs/api/Interceptors.md — 「Deduplicates concurrent identical requests so that only one is sent over the wire.」

## 驗收條件
- [ ] 冷快取下 50 個併發 `/api/market/live-scan`，上游呼叫計數 = 7
- [ ] 同上情境 p95 延遲 < 單次冷請求延遲 × 1.2
- [ ] 60 秒持續以 20 rps 打 live-scan，`x-mbx-used-weight-1m` 峰值 ≤ 12 × 50 = 600
