# Q-01｜符號正規化把不同合約併成同一個幣：Pionex 反向合約覆蓋主流幣、1000x 倍數與同名異幣混用

- **嚴重度**：Critical（核心配對 Pionex×Binance 在 BTC/ETH/SOL 等主流幣上實際讀到的是「另一個合約」的費率與價格，選對與 PnL 全錯）
- **類別**：資料品質 / 策略正確性
- **位置**：`server.ts:31-46`（`extractBaseSymbol`）、`server.ts:161-175`（`getOrCreate` 以 base 為唯一鍵）、`server.ts:192-204`（Pionex 解析）、`server.ts:184,199,215,230,245`（marks 直接並列）
- **對應 HANDOFF**：P6 / B5

## 問題（技術描述）
`extractBaseSymbol` 以字串替換推 base，且 `replace('USDT','')` 只替換第一次出現；之後所有交易所以 base 為鍵寫進同一個 `SymbolAggregate`，**後寫入者覆蓋前者**：

```ts
// server.ts:31-43
.replace('-SWAP','').replace('_PERP','').replace('_USDT','').replace('-USDT','').replace('USDT','').replace(/[-_]/g,'');
if (s.startsWith('1000000')) ... else if (s.startsWith('1000')) s = s.replace('1000','');
// server.ts:198
agg.rates['Pionex'] = parseFloat(item.nextFundingRate || '0');   // 同一 base 第二次出現直接覆蓋
```

三種錯誤併發：
1. **Pionex 反向報價合約**：Pionex 同時上架 `BTC_USDT_PERP`（base=BTC）與 `USDT_BTC_PERP`（base=USDT、quote=BTC）。`"USDT_BTC_PERP"` → 去 `_PERP` → `"USDT_BTC"` → 去第一個 `USDT` → `"_BTC"` → `"BTC"`。因 API 依字母序回傳，`USDT_*` 排在後面，**覆蓋了正確的線性合約**。
2. **1000x 倍數被丟掉**：`1000PEPEUSDT`（Binance）與 `PEPEUSDT`（Bitget）被視為同一合約，但每張價格差 1000 倍；另 `1MBABYDOGEUSDT`、Bybit `10000SATSUSDT` vs Binance `1000SATSUSDT` 等倍數不同也被合併。
3. **同名異幣**：已下市或不同項目的 ticker 撞名（例：Binance `ONUSDT` 0.1161 vs Bybit `ONUSDT` 75.91；`WAVES`、`SNT`、`B3` 價格差 1.7–3 倍）。

## 證據
- `curl -s "https://api.pionex.com/api/v1/common/symbols?type=PERP"`（Pionex 官方公開 API）：
  - `{'symbol': 'USDT_BTC_PERP', 'baseCurrency': 'USDT', 'quoteCurrency': 'BTC', ...}`
  - `{'symbol': 'BTC_USDT_PERP', 'baseCurrency': 'BTC', 'quoteCurrency': 'USDT', ...}`
- `curl -s https://api.pionex.com/api/v1/market/indexes`：`BTC_USDT_PERP` 位於 index 104（`nextFundingRate: 0.0000162713`, `markPrice: 83284.9`），`USDT_BTC_PERP` 位於 index 532（`nextFundingRate: -0.00003301704`, `markPrice: 0.00001200722`）。依 `server.ts` 邏輯重跑後，BTC 的 Pionex 費率 = **-0.0000330（取自 USDT_BTC_PERP）**，正確值應為 +0.0000163——**符號相反**。共 22 個 `USDT_*_PERP`，涵蓋 BTC、ETH、SOL、BNB、XRP、DOGE、ADA、AVAX、LINK、HYPE、PEPE、SUI、TRX、UNI 等全部主流幣。
- 同一次 5 所快照中，以 marks 最大/最小比 > 1.5 偵測到 33 個 base 被錯誤合併，例如：
  - `PEPE`：Binance `1000PEPEUSDT` 0.004295 / Bitget `PEPEUSDT` 0.000004 / Pionex（被 `USDT_PEPE_PERP` 覆蓋）232735.4
  - `SHIB`：Binance `1000SHIBUSDT` 0.00578 vs Pionex/Bitget 0.000006
  - `ON`：Binance/Pionex 0.1161 vs Bybit 75.91（不同資產）
- Bybit 官方文件（https://bybit-exchange.github.io/docs/v5/market/instrument）說明 instruments-info 提供合約身分欄位：「`contractType`: Contract type」「`status`: Instrument status」，另提及 xStock 倍數：「stock_price = token_price / multiplier; stock_qty = token_qty * multiplier.」——代表倍數應以交易所 instrument metadata 為準，而非字串推斷。

## 影響
- **Pionex 為必選腿時的核心標的全部錯誤**：BTC 例中 Pionex 真實 +0.0016%、系統顯示 -0.0033%，方向判斷可能反轉（該 long 的腿被判成 short），而 `USDT_BTC_PERP` 本身是以 BTC 計價的「做空 USDT」合約，下單數量、保證金幣別都不同。
- 1000x 合約：資金費率本身與倍數無關（費率是比例），所以 **spread 數值不一定錯**；但 marks 比較、`quantity = notional / price`、未來以價格做基差/滑價計算時會差 1000 倍；volume 也會被掛到錯的合約上。
- 同名異幣：兩腿根本不是對沖關係，裸曝險 100%。

## Top 3 解方
### 1. 以各所 instrument metadata 建立 canonical 映射（推薦）
- 做法：啟動時抓 Pionex `GET /api/v1/common/symbols?type=PERP`（`baseCurrency`/`quoteCurrency`）、Binance `GET /fapi/v1/exchangeInfo`（`baseAsset`/`quoteAsset`/`contractType`/`status`）、Bybit `GET /v5/market/instruments-info?category=linear`（`baseCoin`/`quoteCoin`/`contractType`）、OKX `GET /api/v5/public/instruments?instType=SWAP`（`ctValCcy`/`settleCcy`/`ctVal`）、Bitget `GET /api/v2/mix/market/contracts`。以 `(baseAsset, quoteAsset=USDT, settle=USDT, linear)` 為鍵，只收 `quoteCurrency === 'USDT'` 的線性合約；以 `Map<ExchangeId, Map<canonicalKey, nativeSymbol>>` 取代 `extractBaseSymbol`。
- 取捨：多 5 個低頻請求（可快取數小時）；需要各所 adapter。
- 參考：https://bybit-exchange.github.io/docs/v5/market/instrument — 「Instrument status」「Contract type」；Binance exchangeInfo（https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information）提供 `contractType`：「PERPETUAL / CURRENT_QUARTER / NEXT_QUARTER / TRADIFI_PERPETUAL」。
### 2. 明確處理倍數欄位
- 做法：在 canonical 映射中存 `multiplier`（由 `1000`/`10000`/`1000000`/`1M` 前綴或 OKX `ctMult`/`ctVal` 解出），所有價格比較先換算為「每 1 單位 base」：`normPrice = markPrice / multiplier`。
- 取捨：前綴規則需白名單（避免把 `1INCH` 之類誤判）；最好仍以 metadata 為準。
- 參考：同上 Bybit 文件 — 「stock_price = token_price / multiplier」。
### 3. 價格一致性守門（sanity check）
- 做法：配對前檢查兩腿 `normPrice` 相對差 `|pA/pB - 1| < 2%`（依波動調整），超出即淘汰並記錄 `elimination_reason='price_mismatch'`。
- 取捨：只能當最後一道防線，無法取代正確映射；極端行情可能誤殺。
- 參考：未查證（常見實務作法，無官方文件）。

## 驗收條件
- [ ] 單元測試：輸入 `USDT_BTC_PERP` 不得映射到 BTC 線性合約；`BTC_USDT_PERP` 與 `BTCUSDT`、`BTC-USDT-SWAP` 映射到同一 key。
- [ ] 單元測試：`1000PEPEUSDT` 與 `PEPEUSDT` 的 `normPrice` 相對差 < 1%。
- [ ] 以真實快照跑 live-scan：所有 candidate 的兩腿 `normPrice` 相對差 < 2%（目前有 33 個 base 違反）。
- [ ] BTC 的 `pionex_rate` 等於 `BTC_USDT_PERP.nextFundingRate`。
