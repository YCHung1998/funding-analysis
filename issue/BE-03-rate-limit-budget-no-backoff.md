# BE-03｜全市場重量級端點 + 不讀限流標頭、不退避：IP 封鎖風險

- **嚴重度**：High（每次 scan 固定吃 Binance 50 權重、OKX 單一 bucket，且收到 429 後仍繼續打；封鎖時長 60 秒～3 天）
- **類別**：限流風險
- **位置**：`server.ts:69-107`（7 個全市場端點）、`server.ts:394`（ping 也打 Pionex 全市場端點）、`server.ts:433-438`（klines）
- **對應 HANDOFF**：無

## 問題（技術描述）
- 每次 scan 打的都是「不帶 symbol 的全市場」端點：Binance `premiumIndex`（全部）+ `ticker/24hr`（全部，只為了取 24h 量）。
- 完全不讀 `X-MBX-USED-WEIGHT-1m`、`x-ratelimit-*`、`Retry-After`，也沒有 429/418 後的冷卻（circuit breaker）。
- 同一 IP 上 `/api/latency/ping` 與 live-scan 同時被前端呼叫（`FunnelScannerView.tsx:135-136`），Pionex 在一次刷新就被打 2 次全市場端點。

## 證據（實測）
Binance 權重（同一分鐘內讀 `x-mbx-used-weight-1m` 的增量）：

| 端點 | 實測權重 |
|---|---|
| `GET /fapi/v1/premiumIndex`（全部） | 10 |
| `GET /fapi/v1/ticker/24hr`（全部） | **40** |
| `GET /fapi/v1/premiumIndex?symbol=BTCUSDT` | 1 |
| `GET /fapi/v1/klines?...&limit=10` | 1 |

→ 每次 scan = 50；Binance 上限 2400/分 → 最多 48 次 scan/分。10 個併發 scan 實測權重 1 → 502。

各所上限（官方）與本專案的單次 scan 消耗：

| 交易所 | 官方上限 | 封鎖後果 | 本專案 |
|---|---|---|---|
| Binance | 2400 weight/分（exchangeInfo） | 418，2 分鐘～3 天 | 50/scan |
| OKX funding-rate | 10 次 / 2 s，IP + instId | 429 | `ANY` 共用 1 個 bucket；實測併發時 429 ×24 |
| OKX tickers | 20 次 / 2 s，IP | 429 | 1/scan |
| Bybit | 600 次 / 5 s，IP | 403，至少 10 分鐘 | 1/scan |
| Pionex | 所有端點共用 10 次/秒/IP | 429 並封 60 秒，違規再延長 | scan + ping 各 1 |

實測 Pionex 回應標頭：`x-ratelimit-tokens: 29`（程式未讀取）。

官方文件原文：
- https://fapi.binance.com/fapi/v1/exchangeInfo — `"rateLimitType": "REQUEST_WEIGHT", ... "limit": 2400`
- https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info — 「Every request will contain `X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)` in the response headers which has the current used weight for the IP for all request rate limiters defined.」
- https://www.okx.com/docs-v5/en/ — 「Get funding rate Retrieve funding rate. Rate Limit: 10 requests per 2 seconds Rate limit rule: IP + Instrument ID」；Tickers：「Rate Limit: 20 requests per 2 seconds Rate limit rule: IP」
- https://bybit-exchange.github.io/docs/v5/rate-limit — 「You are allowed to send 600 requests within a 5-second window per IP by default.」、「you should terminate all HTTP sessions and wait for at least 10 minutes.」
- https://pionex-doc.gitbook.io/apidocs/restful/general/rate-limit.md — 「All endpoints share the 10 per second limit based on IP.」、「you will receive HTTP status 429 and your IP/ACCOUNT will be banned (60 seconds).」
- Binance 各端點權重的官方頁面（`.../rest-api/Mark-Price`、`.../24hr-Ticker-Price-Change-Statistics`）：**未能取得**（SPA/反爬，WebFetch 只拿到首頁），上表權重為實測值。
- 備註：OKX 文件確實記載 `instId` 可為 `ANY`：「or ANY to return the funding rate info of all perpetual and X-Perps futures contracts」（可關閉 HANDOFF P11 的「未查證」）。

## 影響
- 被封 IP 的時段內，所有交易所資料都靠 BE-02 的靜默空陣列「看起來正常」。若封鎖發生在結算前，T-30s 決策所需資料全失。
- 未來若在同一 IP 上加上下單（Live 階段），行情輪詢吃掉的權重會直接擠壓下單/撤單的配額（Binance 限制以 IP 計，非 API key）。

## Top 3 解方
### 1. 改用 WebSocket 全市場串流取代 REST 輪詢（推薦，見 BE-04）
- 做法：Binance `!markPrice@arr`、Bybit `tickers.{symbol}`、OKX `funding-rate`/`tickers`、Bitget ticker 頻道；REST 只保留啟動時與斷線補洞。
- 預期效益：REST 權重從 50/scan × 12 scan/分 = 600/分 降到接近 0；不再與未來下單共用配額。
- 取捨：需要連線管理、心跳、重連與序號/快照處理。
- 參考：https://www.okx.com/docs-v5/en/ — 「Funding rate channel Retrieve funding rate. Data will be pushed in 30s to 90s.」
### 2. 權重預算器 + 429/418 斷路器
- 做法：每次回應讀 `x-mbx-used-weight-1m`、`x-ratelimit-tokens`、`Retry-After`；以 token bucket 管控，超過 70% 預算就延長刷新間隔；收到 429 → 該所停止請求至 `Retry-After`/固定冷卻（Bybit 403 → 10 分鐘）。
- 預期效益：理論上不可能觸發 418；限流狀態可顯示在 `sources`（BE-02）。
- 取捨：需要每所各自的規則表。
- 參考：https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info — 「When a 429 is received, it's your obligation as an API to back off and not spam the API.」
### 3. 降低單次權重：拆頻率 / 換輕端點
- 做法：24h 量變化慢，`ticker/24hr`（40 權重）改為每 60 s 取一次或改用 WS `!ticker@arr`；ping 改打 Pionex 帶 symbol 的輕量請求（實測 `indexes?symbol=BTC_USDT_PERP` 僅 234 bytes）。
- 預期效益：Binance 每次 scan 權重 50 → 10（−80%）；Pionex 每次刷新 100 KB → 0.2 KB。
- 取捨：量資料最多 60 s 舊，對套利篩選影響小。
- 參考：https://pionex-doc.gitbook.io/apidocs/restful/general/rate-limit.md — 「Each route has a `weight` which determines for the number of requests each endpoint counts for. Heavier endpoints will have a heavier `weight`.」

## 驗收條件
- [ ] 程式有每所限流規則表，並解析 `x-mbx-used-weight-1m` / `Retry-After`
- [ ] 模擬 429 後，該所在冷卻期內上游呼叫數 = 0
- [ ] 穩態下 Binance `x-mbx-used-weight-1m` < 240（10% 預算）
