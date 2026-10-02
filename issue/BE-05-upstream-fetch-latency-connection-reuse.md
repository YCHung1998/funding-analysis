# BE-05｜上游抓取延遲：Promise.all 被最慢者與 body 下載閘住，keep-alive 4s < TTL 5s 導致每次重握手

- **嚴重度**：High（冷 scan 0.5–1.3 s，其中 TCP/TLS/DNS 可避免；曾觀察到 5 s DNS 停頓，逼近 6 s timeout）
- **類別**：延遲
- **位置**：`server.ts:69-117`（7 個 `fetch` + `Promise.all`，每個 `AbortSignal.timeout(6000)`）
- **對應 HANDOFF**：HANDOFF §0 基準「耗時約 4.3s」

## 問題（技術描述）
1. `Promise.all` 等全部 7 個 → 回應時間 = 最慢上游（含 body 下載與 `r.json()` 解析）。
2. 使用 Node 內建 fetch 的預設 global dispatcher：undici 預設 `keepAliveTimeout = 4000 ms`，而 live-scan TTL 是 5000 ms → 每次快取過期再抓時，閒置連線已被關閉，**每次冷 scan 都要重新 TCP + TLS**。
3. 無 DNS 快取：`dns.lookup` 走 OS resolver（libuv threadpool），resolver 慢時直接吃進延遲。
4. 全市場 payload 很大（解壓後合計 2.17 MB），body 傳輸是主要耗時。

## 證據（實測）
上游（curl，`-w` 計時；identity / gzip 兩種 Accept-Encoding）：

| 端點 | identity bytes | gzip bytes | TTFB（gzip） |
|---|---|---|---|
| Binance premiumIndex | 204,578 | 24,632 | 157 ms* |
| Pionex indexes | 100,427 | 14,560 | 246 ms |
| Bybit tickers linear | 666,918 | 170,457 | 146 ms |
| Bitget tickers | 405,519 | 78,381 | 207 ms |
| OKX tickers SWAP | 145,899 | 34,916 | 145 ms |
| OKX funding-rate ANY | 351,838 | 25,161 | 141 ms |
| Binance ticker/24hr | 292,302 | 64,913 | 249 ms |
| **合計** | **2,167,481** | **413,020** | |

\* 第一次 curl Binance 兩個端點時 `time_namelookup = 5.008 s`（DNS 停頓），之後 2–4 ms。本機 resolver 為 `fe80::…%en0`（IPv6 link-local）與 `172.20.10.1`（手機熱點），此停頓屬環境因素，但程式沒有任何 DNS 快取可吸收。這很可能就是 HANDOFF 的 4.3 s 基準來源（本次冷 scan 未重現：0.52–1.27 s）。

伺服器內部（fetch 計數器記錄「收到 header」的時間）：8 次循序冷 scan，各上游 header 時間中位數 86–305 ms，但 `fetch_latency_ms` 為 503–1,248 ms → **約 60–80% 時間花在 body 下載 + 解析**。第一次冷 scan 由 Bybit（header 977 ms）閘住整體 1,086 ms。

keep-alive 影響（`/api/latency/ping`，同一台機器）：連續呼叫 Binance 54–121 ms；閒置 10 s 後 151 ms、Bybit 64–120 → 157 ms、Bitget 71–121 → 175 ms（多出約 +50–100 ms = 重新握手）。curl 分段：TCP 20–30 ms、TLS 再 +25–50 ms。

CPU 反證：7 個 body `JSON.parse` 合計 6.5 ms；payload `JSON.stringify` 1.27 ms；handler 非網路部分 13–22 ms → **O(symbols × exchanges²) 聚合不是瓶頸（已否定）**。

官方文件：
- undici Client（https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md）keepAliveTimeout：「The timeout, in milliseconds, after which a socket with no active requests times out. ... Default: `4e3`.」
- Node.js dns（https://nodejs.org/api/dns.html）：「it is implemented as a synchronous call to getaddrinfo(3) that runs on libuv's threadpool. This can have surprising negative performance implications for some applications」
- Node.js globals（https://nodejs.org/api/globals.html）：「You can use a custom dispatcher to dispatch requests passing it in fetch's options object.」

## 影響
- 冷 scan 的 ~100–200 ms 是可避免的握手成本；DNS 停頓時單次 scan 可達 5 s 以上，6 s timeout 下接近整所資料被丟棄（接 BE-02）。
- 若解決 BE-04 改走 WS，此問題大幅縮小；在那之前，它直接決定 T-30s 看到的資料年齡。

## Top 3 解方
### 1. 自訂 undici Agent：延長 keep-alive + DNS 快取（推薦）
- 做法：`npm i undici`；`setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 4 }).compose(interceptors.dns({ maxTTL: 60_000 })))`。
- 預期效益：每次冷 scan 省下 TCP+TLS（實測約 50–100 ms/所）與 DNS 停頓風險；最慢上游的 header 時間回到熱連線水準。
- 取捨：伺服器端可能早於 60 s 關閉連線（undici 會依 keep-alive hint 調整）；多一個依賴。
- 參考：https://github.com/nodejs/undici/blob/main/docs/docs/api/Interceptors.md — 「Caches DNS lookups so that repeated requests to the same origin reuse the resolved IP address instead of performing a fresh lookup every time.」
### 2. 逐所增量合併，而非等最慢者
- 做法：每所有自己的刷新迴圈與最新值（見 BE-04 方案 1 / BE-01 方案 2），聚合在讀取時進行；單所 timeout 縮為 2–3 s 並用 `Promise.allSettled`。
- 預期效益：回應延遲不再受最慢上游支配；某所變慢只影響該所年齡。
- 取捨：需要 per-exchange 時間戳與 age 欄位。
- 參考：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled — 「This returned promise fulfills when all of the input's promises settle」
### 3. 縮小 body：只抓需要的欄位 / 較小端點
- 做法：Bybit linear（667 KB，最大）改為 WS 或只在需要時抓；Binance 24h 量改低頻；確認請求帶壓縮（實測 Node v26 fetch 預設送 `accept-encoding: gzip, deflate`、`connection: keep-alive`，已具備）。
- 預期效益：傳輸量主要由 Bybit 決定（壓縮後 170 KB / 413 KB = 41%），移除後總 body 下載時間預估減少約 40%（依位元組比例推估，未實測）。
- 取捨：WS 化需額外工作。
- 參考：https://bybit-exchange.github.io/docs/v5/websocket/public/ticker — 「Derivatives & Options - 100ms」

## 驗收條件
- [ ] 連續冷 scan（間隔 5.2 s）時，上游連線重用率 > 90%（以 undici diagnostics_channel 或 socket 計數驗證）
- [ ] 冷 scan p95 < 600 ms（本機網路），且單所 timeout 不影響其他所資料
- [ ] DNS 停頓 5 s 的情境（模擬 lookup 延遲）下，已快取 origin 的請求不受影響
