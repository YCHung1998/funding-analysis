# Q-03｜幻影機會：已下市 / 結算中合約、TradFi 股票永續、24h 量缺值填 1,000 萬，佔據排行榜前段

- **嚴重度**：High（達門檻的 12 組中 7 組有一腿費率恰為 0，且多數是不可交易或極低流動性合約；排名第一頁幾乎沒有真實可做的機會）
- **類別**：資料品質 / 風險
- **位置**：`server.ts:119-128`（量只取 Binance）、`server.ts:171`（`volumeMap.get(base) || 10000000`）、`server.ts:178-188`（不檢查合約狀態）、`server.ts:183,198,214,229`（`parseFloat(x || '0')` 把缺值當 0 費率）、`server.ts:255`（只要 `rate !== undefined` 就算有效）
- **對應 HANDOFF**：P3 / B4

## 問題（技術描述）
```ts
agg.rates['Binance'] = parseFloat(item.lastFundingRate || '0');  // 下市合約回 "0.00000000" 也被收
volume24h: volumeMap.get(base) || 10000000,                        // 缺量 → 假設 1,000 萬 USDT
```
1. **不檢查合約狀態**：Binance `premiumIndex` 會回傳 `SETTLING`（下市結算中）合約，其 `lastFundingRate = 0`、`nextFundingTime = 0` 或過去時間；程式照樣配對。
2. **不區分合約類型**：Binance `TRADIFI_PERPETUAL`、Bybit `symbolType: "stock"` 等股票永續，資金費規則與加密永續不同（實測近 5 次結算全為 0），但 Bybit ticker 的預測費率可高達 1%。
3. **量只取 Binance、缺值填 1,000 萬**：非 Binance 上架的幣（或 Binance 已下市者）一律被當成中等流動性，滑價落在 0.03% 檔；即使有值也是 Binance 的量，不是實際下單那兩所的量。

## 證據
- `curl -s https://fapi.binance.com/fapi/v1/exchangeInfo`：USDT 合約狀態 `TRADING 739 / SETTLING 130 / PENDING_TRADING 1`。`STORJUSDT`：`status: SETTLING`；`premiumIndex` 回 `lastFundingRate: "0.00000000", nextFundingTime: 0`。
- 以同快照重跑 live-scan 邏輯：達 0.20% 門檻 12 組，其中 **7 組有一腿費率恰為 0**（SONY、FLY、HANMI、CYPH、STORJ、BOT、NAVER），`STORJ` 排第 7 是 Binance SETTLING 腿；SONY/HANMI/CYPH/BOT/NAVER 的 Binance 腿為 `TRADIFI_PERPETUAL`。**89** 個 candidate 使用 10,000,000 的預設量（FLY、XIAOMI、STORJ 皆在前 7 名）。
- SONYUSDT 實測：
  - `curl -s "https://api.bybit.com/v5/market/tickers?category=linear&symbol=SONYUSDT"` → `"fundingRate":"0.01009946"`（預測 1.01%）、`"turnover24h":"24677.9425"`（24h 成交僅 2.5 萬 USDT）、`bid1Price 23.91 / ask1Price 23.96`（價差 0.21%）。
  - `curl -s "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=SONYUSDT&limit=5"` → 近 5 次實際結算 `fundingRate: "0"` 全為 0。
  - `curl -s "https://fapi.binance.com/fapi/v1/fundingRate?symbol=SONYUSDT&limit=5"` → 近 5 次 `fundingRate: "0.00000000"`。
  - 但系統使用的 `volume_24h` 是 Binance 的 248,340，而非 Bybit 的 24,678。
- 官方文件：
  - Binance exchangeInfo（https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information）：`status`「Current trading state of the symbol」；`contractType` 含「TRADIFI_PERPETUAL」。
  - Bybit instruments（https://bybit-exchange.github.io/docs/v5/market/instrument）：`status` 可為「Trading, PendingOpen, PreLaunch, or Delivering」。
  - Bybit tickers（https://bybit-exchange.github.io/docs/v5/market/tickers）：`turnover24h`「Turnover for 24h」、`bid1Price`「Best bid price」——每所都有自己的量與盤口可用。

## 影響
- 前段排名被「不可能賺到」的機會佔據：STORJ 無法開倉；SONY 預測 1.01% 但歷史結算皆 0，且 Bybit 盤口一次 1000U 就吃穿多檔、價差 0.21%。
- 缺量填 1,000 萬使冷門幣滑價被低估（實際 24h 量 17 萬–36 萬的 HANMI/NAVER 也只在 0.05% 檔），4 筆 taker 在薄盤口上的真實成本可能數倍於模型。
- 使用者依排名下單時，容易挑到兩腿中有一腿根本不能交易或只能部分成交 → 裸曝險。

## Top 3 解方
### 1. 以 instrument metadata 建立可交易白名單（推薦）
- 做法：Binance 只收 `status === 'TRADING' && contractType === 'PERPETUAL'`；Bybit 只收 `status === 'Trading' && contractType === 'LinearPerpetual'`，排除 `symbolType === 'stock'` 或另開分類；OKX `state === 'live'`；Bitget contracts `symbolStatus === 'normal'`；Pionex `common/symbols` 的 `status === 'TRADING'`。另外把 `nextFundingTime <= now` 的腿視為無效，而非保留費率。
- 取捨：每所多一個 metadata 端點（可快取）；TradFi 永續若日後要做需獨立規則。
- 參考：Binance exchangeInfo — 「Current trading state of the symbol」；Bybit — 「Trading, PendingOpen, PreLaunch, or Delivering」。
### 2. 每所各自的 24h 量 + 最低量門檻；缺資料 = 淘汰
- 做法：Bybit `turnover24h`、Bitget `usdtVolume`/`quoteVolume`、OKX `volCcy24h`×價、Binance `quoteVolume`、Pionex 24h tickers；`pairVolume = min(volA, volB)`；低於門檻（例如 5,000,000 USDT，待使用者定，HANDOFF §8 Q3）直接淘汰，**移除 `|| 10000000`**。
- 取捨：需多抓 Pionex 24h 量；門檻需使用者決定。
- 參考：Bybit tickers — 「turnover24h: Turnover for 24h」。
### 3. 以歷史「已結算費率」與預測費率比對做異常過濾
- 做法：對候選抓最近 N 次實際結算（Binance `/fapi/v1/fundingRate`、Bybit `/v5/market/funding/history`、OKX `funding-rate-history`），若歷史全為 0 或與預測差距過大則標為「預測不可靠」。
- 取捨：每候選多一個請求，只對 Top-N 做即可。
- 參考：OKX 文件（https://www.okx.com/docs-v5/en/）— fundingRate「This is a forecast — the final settled rate may differ.」

## 驗收條件
- [ ] 單元測試：`status: 'SETTLING'` 或 `nextFundingTime: 0` 的 Binance 腿不得出現在 candidates。
- [ ] live-scan 輸出不含 `volume_24h === 10000000` 的預設值；缺量者有 `elimination_reason`。
- [ ] 每個 candidate 帶 `long_volume_24h`、`short_volume_24h`，且兩者皆取自該腿交易所。
- [ ] 以同一快照重跑：STORJ 不在結果中；SONY 等 stock 合約被排除或歸入獨立分類。
