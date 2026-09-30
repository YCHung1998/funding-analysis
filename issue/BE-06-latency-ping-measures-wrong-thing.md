# BE-06｜`/api/latency/ping` 量錯東西：429 被當成正常延遲、Pionex 打 100 KB 端點、混入握手時間

- **嚴重度**：Medium（實測 Binance 正在回 429 時，儀表板仍顯示 54–121 ms 的「健康」延遲）
- **類別**：可靠性 / 延遲
- **位置**：`server.ts:377-420`（特別是 `:389-390`、`:394`）
- **對應 HANDOFF**：P7（Dry-run 延遲寫死）的上游資料來源

## 問題（技術描述）
```ts
const s = Date.now();
await fetch('https://fapi.binance.com/fapi/v1/ping', { signal: AbortSignal.timeout(3000) });
pings.Binance = Date.now() - s;          // 不看 status；429/5xx 也記成延遲
...
await fetch('https://api.pionex.com/api/v1/market/indexes', ...)  // 全市場 ~100 KB
```
1. 不檢查 `r.ok` → 被限流時回報「很快」。
2. Pionex 用全市場 `indexes`（非輕量端點），且與 live-scan 同時被前端呼叫，額外吃 Pionex 10 次/秒的共用配額。
3. `fetch` 在收到 header 時就 resolve，body 沒讀也沒 cancel → 連線無法及時回收。
4. 單次樣本、混合了 DNS/TCP/TLS（閒置 > 4 s 後的第一次）與伺服器處理時間，無法代表「下單時」的熱連線 RTT。
5. 失敗一律為 `-1`，不區分 timeout / DNS / 429。

## 證據（實測）
- 5 次連續 ping，同時 fetch 計數器記錄到 `fapi.binance.com/fapi/v1/ping status=429` ×5，但 API 回報 Binance = **115, 121, 67, 64, 54 ms**。
- Pionex：`/api/v1/market/indexes` 100,383 bytes；ping 值 184–**2,499** ms（同時段 Bybit/Bitget/OKX 為 64–121 ms）。對照帶 symbol 的請求 `indexes?symbol=BTC_USDT_PERP` 僅 234 bytes 且回應含 `timestamp`。`/api/v1/common/timestamp` 回 404（Pionex 公開文件索引中未見 time 端點，**未查證**）。
- 熱/冷差異：連續呼叫 Binance 54–121 ms，閒置 10 s 後 151 ms；Bitget 71–121 → 175 ms。curl 分段顯示 TCP ≈ 20–470 ms、TLS 再 +25–50 ms（變異大）。

官方文件：
- undici README（https://github.com/nodejs/undici/blob/main/README.md）：「leaving the release of connection resources to the garbage collector can lead to excessive connection usage, reduced performance (due to less connection re-use), and even stalls or deadlocks when running out of connections.」
- Binance General Info（https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info）：「A `429` will be returned when either rate limit is violated」
- Pionex（https://pionex-doc.gitbook.io/apidocs/restful/general/rate-limit.md）：「All endpoints share the 10 per second limit based on IP.」

## 影響
- DryRun/Funnel 若依 ping 判斷「交易所可用、延遲低」，在最需要警覺的限流時段會得到相反訊號。
- 延遲數字（尤其 Pionex 184–2,499 ms）主要反映 payload 大小與握手，不能作為 T-30s 下單延遲預算的依據。

## Top 3 解方
### 1. 以輕量時間端點 + 熱連線 + 多樣本統計（推薦）
- 做法：Binance `/fapi/v1/time`、Bybit `/v5/market/time`、OKX `/api/v5/public/time`、Bitget `/api/v2/public/time`、Pionex 帶 symbol 的 `indexes?symbol=BTC_USDT_PERP`；檢查 `r.ok`、讀完 body；在共用 keep-alive Agent 上連打 5 次取 median/p95，回傳 `{ rtt_ms_p50, rtt_ms_p95, status, error }`。
- 預期效益：消除「429 顯示為健康」；Pionex 樣本位元組 100 KB → 0.2 KB；數值代表熱連線 RTT。
- 取捨：每次 ping 請求數 ×5，需要快取（例如 10 s）避免反成限流來源。
- 參考：https://www.okx.com/docs-v5/en/ — 「Get system time Retrieve API server time. Rate Limit: 10 requests per 2 seconds Rate limit rule: IP」
### 2. 被動量測：從實際業務請求蒐集延遲
- 做法：在 fetch wrapper（BE-02 的 `fetchJson`）記錄每所 header/total 時間與 status 到環形緩衝區，`/api/latency` 回傳最近 N 筆的分位數，不再主動打交易所。
- 預期效益：零額外上游請求；量到的就是真實資料路徑。
- 取捨：無流量時沒有新樣本。
- 參考：https://nodejs.org/api/globals.html — 「The implementation is based upon undici, an HTTP/1.1 client written from scratch for Node.js.」
### 3. 分段計時（DNS / connect / TLS / TTFB）
- 做法：以 undici `diagnostics_channel`（`undici:client:connected` 等）或 `performance` 標記分段，前端分開顯示「網路 RTT」與「交易所處理時間」。
- 預期效益：可區分是本機網路、TLS 還是交易所慢。
- 取捨：實作較繁瑣。
- 參考：https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md — 「Monitors the time between activity on a connected socket.」

## 驗收條件
- [ ] 上游回 429/5xx 時，ping 結果 `status` 反映錯誤且不回傳正常延遲數字
- [ ] Pionex ping 請求回應 < 1 KB
- [ ] 回傳 p50/p95（≥ 5 樣本），在熱連線下 p95/p50 < 2
