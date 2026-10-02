# BE-09｜live-klines：symbol 未驗證/未編碼、1000x 合約對應錯誤、上游錯誤被當空資料、無快取

- **嚴重度**：Low（影響需求 #2 的 K 棒檢視；不在 T-30s 熱路徑上）
- **類別**：可靠性
- **位置**：`server.ts:425-473`（特別是 `:427-430` 符號轉換、`:433-438` 未編碼 URL 與 `.catch`）
- **對應 HANDOFF**：P6（`extractBaseSymbol` / `replace('USDT','')` 只換第一次）、B5、B7

## 問題（技術描述）
```ts
const symbol = (req.query.symbol as string || 'BTCUSDT').toUpperCase();
const pxSymbol = symbol.endsWith('USDT') ? `${symbol.replace('USDT', '')}_USDT_PERP` : `${symbol}_PERP`;
fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=10`)  // 未 encodeURIComponent
```
1. 使用者輸入直接拼進上游 URL（query 參數注入；大寫化部分緩解）。
2. `1000PEPEUSDT` → `1000PEPE_USDT_PERP`，但 Pionex 實際合約是 `PEPE_USDT_PERP` → Pionex 永遠 0 根。
3. Binance 400 / Pionex 錯誤被 `.catch` 變成空陣列，仍回 `success:true`。
4. 每次都打上游、無快取；只取最近 10 根再切 5 根（與 B7「結算 ±2m」需求不符，屬功能面）。

## 證據（實測）
| 輸入 | Binance bars | Pionex bars | 備註 |
|---|---|---|---|
| `BTCUSDT` | 5 | 5 | 正常，208 ms |
| `1000PEPEUSDT` | 5 | **0** | pionex_symbol=`1000PEPE_USDT_PERP`；Pionex 清單中為 `PEPE_USDT_PERP` |
| `BTCUSDT%26interval%3D1d%26limit%3D1500` | 5 | 0 | 參數被原樣拼進上游 URL（`BTCUSDT&INTERVAL=1D&LIMIT=1500_PERP`） |
| `foo` | 0 | 0 | Binance HTTP 400（fetch log），API 仍 `success:true` |

Pionex 清單查詢：`['PEPE_USDT_PERP', 'SHIB_USDT_PERP', 'USDT_PEPE_PERP']`。Binance klines（limit=10）實測權重 1。

官方文件：
- Pionex Get Klines（https://pionex-doc.gitbook.io/apidocs/restful/markets/get-klines.md）：「Weight: 1」；interval「1M，5M，15M，30M，60M，4H，8H，12H，1D」；limit「Default 100, range: 1-500.」（程式用 `1M` 正確）
- Node.js globals（https://nodejs.org/api/globals.html）：fetch 範例 `if (res.ok) { const data = await res.json(); ... }`——官方範例即先檢查 `res.ok`。

## 影響
- 1000x 系列（PEPE、SHIB、BONK 等常見高費率幣）在 K 棒檢視中 Pionex 側永遠空白，使用者可能誤判為「無成交」。
- 上游錯誤無法分辨，除錯困難。

## Top 3 解方
### 1. 以 instrument 對照表解析 symbol（推薦）
- 做法：live-scan 已持有 `rawSymbols[exchange]`；將 `base → {Binance: '1000PEPEUSDT', Pionex: 'PEPE_USDT_PERP', ...}` 存成共用 Map，klines 以 `base` 查表取各所原生 symbol；查無即 400。
- 預期效益：1000x 合約 Pionex 0 根 → 正確根數；同時解掉 P6 在此路由的症狀。
- 取捨：依賴 live-scan 快照已載入（或啟動時抓 instrument info）。
- 參考：https://pionex-doc.gitbook.io/apidocs/restful/markets/get-klines.md — 「symbol string YES Symbol.」
### 2. 輸入白名單 + `URLSearchParams`
- 做法：`/^[A-Z0-9]{2,20}$/` 驗證；以 `new URL(...)` + `searchParams.set('symbol', s)` 組 URL。
- 預期效益：杜絕參數注入。
- 取捨：無。
- 參考：https://nodejs.org/api/globals.html — 「A browser-compatible implementation of the fetch() function.」
### 3. 檢查 `res.ok` + 短 TTL 快取
- 做法：非 2xx 回傳 per-exchange `error`；以 `symbol` 為 key 快取 10–30 s（1m K 棒）。
- 預期效益：錯誤可見；重複查詢不打上游。
- 取捨：K 棒最多延遲一個 TTL。
- 參考：https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info — 「A `429` will be returned when either rate limit is violated」

## 驗收條件
- [ ] `?symbol=1000PEPEUSDT` 兩所 bars 皆 > 0
- [ ] 非法 symbol 回 HTTP 400；上游 4xx/5xx 在回應中可見
- [ ] 同一 symbol 10 s 內重複請求，上游呼叫數 = 1
