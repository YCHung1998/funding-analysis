# BE-08｜live-scan 回應 686 KB 未壓縮、一次回傳全部 803 筆

- **嚴重度**：Medium（本機無感，但遠端/行動網路下每次刷新多傳 ~620 KB；gzip 可省 90%）
- **類別**：吞吐 / 資源
- **位置**：`server.ts:19`（只有 `express.json()`，無 compression）、`server.ts:300-335`（每筆候選欄位）、`server.ts:342-362`（全量回傳）、`server.ts:58-63`（快取命中每次重新序列化）
- **對應 HANDOFF**：無

## 問題（技術描述）
- Express 未掛 `compression`，回應 `Content-Length: 685977`、無 `Content-Encoding`。
- 回傳全部 803 個候選（每筆約 997 bytes：5 所 rate、5 所 mark、10 組 `pair_spreads` 等），但真正 `meets_threshold` 的只有 9 筆。沒有 `limit` / `min_spread` / 欄位篩選參數。
- 快取命中路徑 `res.json({ success, cached, cache_age_ms, ...liveScanCache.data })` 每次都做物件展開 + `JSON.stringify`（實測 1.27 ms/次；目前不是瓶頸，但可預先序列化）。

## 證據（實測）
```
curl -H 'Accept-Encoding: gzip' -D - localhost:3001/api/market/live-scan
Content-Length: 685977
ETag: W/"a7799-..."          # 無 Content-Encoding
```
- 原始 685,958 bytes；`gzip -6` 65,641 bytes（**9.6%**）；`gzip -9` 62,981 bytes。
- 803 候選、9 筆達門檻；單筆 JSON 997 bytes。
- 快取命中延遲 7–8 ms（本機）；冷請求 1,134 ms。
- 前端兩個分頁（`FunnelScannerView`、`DryRunConsole`）都拉整包。

官方文件：
- Express 效能最佳實務（https://expressjs.com/en/advanced/best-practice-performance.html）：「Gzip compressing can greatly decrease the size of the response body and hence increase the speed of a web app. Use the compression middleware for gzip compression in your Express app.」
- compression 中介軟體（https://expressjs.com/en/resources/middleware/compression.html）：threshold「Default: `1kb`」；用法 `app.use(compression());`

## 影響
- 以 10 Mbps 上行的遠端連線估算：686 KB ≈ 0.55 s 傳輸，壓縮後 66 KB ≈ 0.05 s（依頻寬換算，未實測遠端）。對 T-30s 刷新而言，這 0.5 s 是純浪費。
- 前端解析 686 KB JSON 的成本由前端 agent 評估；後端責任是不送不需要的資料。

## Top 3 解方
### 1. 掛 `compression` 中介軟體（推薦）
- 做法：`npm i compression`；`app.use(compression())` 放在路由之前（Vite 中介之前亦可）。
- 預期效益：live-scan 傳輸量 686 KB → ~66 KB（−90%，依實測 gzip 比例）。
- 取捨：每次壓縮耗 CPU（686 KB 約數 ms，未實測）；可搭配方案 3 預先壓縮。
- 參考：https://expressjs.com/en/resources/middleware/compression.html — 「The byte threshold for the response body size before compression is considered for the response.」
### 2. 伺服器端篩選與分頁
- 做法：支援 `?limit=50&min_spread=0.001&fields=...`；預設只回 Top N 與達門檻者，完整清單另開端點或分頁。
- 預期效益：典型請求從 803 筆降到 ≤ 50 筆（約 −94% 位元組）。
- 取捨：前端需傳參數；需決定預設值。
- 參考：https://expressjs.com/en/advanced/best-practice-performance.html — 「Gzip compressing can greatly decrease the size of the response body」（與篩選互補）
### 3. 預序列化 + 預壓縮快取、支援條件請求
- 做法：刷新時就把 payload `JSON.stringify` 並 gzip/brotli 一次存成 Buffer；handler 依 `Accept-Encoding` 直接送出；以快照時間戳為強 ETag，前端帶 `If-None-Match` 時回 304。
- 預期效益：快取命中路徑 CPU ≈ 0；同一快照期間重複請求只回 304（幾十 bytes）。
- 取捨：需自行處理 `Vary: Accept-Encoding` 與 ETag。
- 參考：https://datatracker.ietf.org/doc/html/rfc5861 — 「caches MAY serve the response in which it appears after it becomes stale, up to the indicated number of seconds.」

## 驗收條件
- [ ] `curl -H 'Accept-Encoding: gzip'` 回應帶 `Content-Encoding: gzip`，傳輸量 < 80 KB
- [ ] 預設請求回傳筆數 ≤ 50（或可設定），完整清單仍可取得
- [ ] 快取命中路徑 p95 < 5 ms（本機）
