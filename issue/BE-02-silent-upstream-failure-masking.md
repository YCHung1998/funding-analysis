# BE-02｜上游失敗被 `.catch(() => [])` 靜默吞掉，回 `success:true` 的殘缺資料並寫入快取

- **嚴重度**：Critical（實測 30 個回應中 5 個是 `success:true` 但 0 組配對，只有 1 個是完整資料；決策層無從分辨）
- **類別**：可靠性
- **位置**：`server.ts:69-107`（7 個 `.then(r => r.json()).catch(() => …)`）、`server.ts:357`（殘缺結果照樣寫快取）、`server.ts:435,438`（klines 同樣模式）
- **對應 HANDOFF**：P3（缺值填預設）同類問題；B4「缺資料 = 淘汰而非填預設值」

## 問題（技術描述）
每個上游都是：

```ts
fetch(url, { signal: AbortSignal.timeout(6000) })
  .then(r => r.json())              // 不檢查 r.ok：429/5xx 的 JSON 錯誤體也被當資料
  .catch(() => [])                  // timeout / DNS / 解析錯誤 → 空陣列
```

1. 不檢查 `r.ok`：OKX 429 回 `{"code":"50011",...}`，`okxFundingData?.data` 為 undefined → 等同空清單。
2. 失敗與「該所真的沒有合約」無法區分；回應沒有 per-exchange 狀態欄位。
3. 殘缺 payload 仍 `liveScanCache = {...}`，在接下來 5 秒內對所有人重播。
4. 某所消失時，配對會「換一組」出現（例如 Binance 缺 → 改配 Bybit/Bitget），spread 排名變動看起來像市場訊號。

## 證據（實測）
併發 30 個冷請求（放大失敗機率），統計每個回應的 `(success, total_matched_pairs, exchange_counts[P,Bn,By,Bg,OKX])`：

| 次數 | success | pairs | exchange_counts |
|---|---|---|---|
| 5 | true | **0** | (0,0,0,0,0) |
| 4 | true | 425 | (425,425,0,0,0) |
| 3 | true | 660 | (0,660,660,0,0) |
| 3 | true | 376 | (376,0,0,376,0) |
| … | true | … | 16 種不同組合 |
| **1** | true | **803** | (439,726,725,702,467) ← 唯一完整 |

同期上游 log：`TimeoutError` 125 次、OKX 429 ×24、Binance 429 ×7、Bitget 429 ×4——全部回到前端都只是 `success:true`。

klines：`symbol=foo` 時 Binance 回 HTTP 400，route 仍回 `success:true, binance_bars: []`。

官方文件：
- MDN（https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled）：「This returned promise fulfills when all of the input's promises settle (including when an empty iterable is passed), with an array of objects that describe the outcome of each promise.」
- Binance General Info（https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info）：「When a 429 is received, it's your obligation as an API to back off and not spam the API.」——吞掉 429 就不可能退避。
- RFC 5861（https://datatracker.ietf.org/doc/html/rfc5861）：「The stale-if-error Cache-Control extension indicates that when an error is encountered, a cached stale response MAY be used to satisfy the request, regardless of other freshness information.」

## 影響
- T-30s 若某一腿交易所資料缺失，系統會推薦「另一組」看似可行但未經比對的配對；Dry-run（未來 Live）據此下單即可能產生 LEG_IMBALANCE。
- 0 組配對被快取 5 秒 → 在結算前最後幾個刷新週期可能整個畫面清空。
- 無法監控：沒有 log、沒有指標，無法得知某所是否正被限流。

## Top 3 解方
### 1. 以 `Promise.allSettled` + 顯式錯誤分類回傳 per-exchange 健康狀態（推薦）
- 做法：每個上游包成 `fetchJson(url)`，`!r.ok` 時 throw（帶 status、`Retry-After`）；用 `Promise.allSettled` 收集，payload 增加 `sources: { Binance: { ok, status, latency_ms, age_ms, count } , ...}`；任一所失敗時該所欄位為 `null` 而非空，且 `console.warn` 結構化記錄。
- 預期效益：30 次併發中 29 次「殘缺但看似成功」的回應全部可被辨識；前端可顯示「OKX 限流中」。
- 取捨：API schema 變動，前端 `LiveScanResponse` 要跟著改。
- 參考：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled — 「In comparison, the Promise returned by Promise.all() may be more appropriate if the tasks are dependent on each other, or if you'd like to immediately reject upon any of them rejecting.」
### 2. Per-exchange last-known-good 快取（stale-if-error）
- 做法：每所各自快取最後一次成功的解析結果與時間戳；本次失敗時沿用舊值並標 `stale: true, age_ms`，超過上限（例如 30 s）才真的剔除。殘缺結果不得覆寫完整快取。
- 預期效益：單所短暫 429/timeout 不再讓配對數從 803 掉到 0。
- 取捨：需明確定義最大可接受 age，否則舊費率可能誤導；T-30s 時應更嚴格。
- 參考：https://datatracker.ietf.org/doc/html/rfc5861 — 「a cached stale response MAY be used to satisfy the request, regardless of other freshness information.」
### 3. 失敗時回 502/503 + 部分資料標記
- 做法：必要交易所（如使用者選定的兩腿）失敗時回 HTTP 503 與 `success:false`，其他所失敗則 200 + `partial: true`。
- 預期效益：前端既有的 `if (!res.ok) throw` 立即生效，不需大改 UI。
- 取捨：粒度較粗；多數情況仍需方案 1 的欄位。
- 參考：https://github.com/nodejs/undici/blob/main/README.md — 「it is important to always either consume or cancel the response body anyway」（錯誤回應同樣要讀完 body 以釋放連線）

## 驗收條件
- [ ] 模擬任一所 timeout / 429（例如以 nock 或本地 proxy），回應中該所 `sources.X.ok === false` 且帶 status
- [ ] 殘缺結果不會覆寫完整快取；30 併發測試中 `total_matched_pairs === 0 且 success === true` 的回應數 = 0
- [ ] 每次上游非 2xx 都有一行結構化 log（exchange、status、latency）
