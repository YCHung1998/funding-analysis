# BE-07｜未與交易所伺服器時間同步：T-30s 倒數以本機時鐘計算

- **嚴重度**：Medium（本機實測偏差 ~57–62 ms，目前尚小；但無任何偵測，時鐘漂移或 NTP 失效時會直接偏移進場時點）
- **類別**：延遲 / 可靠性
- **位置**：`server.ts:56`（`const now = Date.now()`）、`server.ts:287-289`（`timeToSettlementSec`）、`server.ts:418`（ping 的 `server_time`）
- **對應 HANDOFF**：P2、需求 #3（Dry-run 時間軸）

## 問題（技術描述）
所有時間判斷都以 `Date.now()`（本機牆鐘）為準；`nextFundingTime` 則是交易所時間。兩者差值直接當成「距結算秒數」，沒有 offset 估計、沒有 RTT 修正，也沒有「偏差過大」的警示。

```ts
const now = Date.now();
...
const timeToSettlementSec = Math.max(Math.floor((nextFundingTime - now) / 1000), 0);
```

## 證據（實測）
Node 腳本對 5 所時間端點做 Cristian 法估計（offset = serverTime − (t_send + t_recv)/2），第 2 輪（熱連線）：

| 交易所 | offset | RTT |
|---|---|---|
| Binance `/fapi/v1/time` | +58.5 ms | 65 ms |
| Bybit `/v5/market/time` | +57 ms | 68 ms |
| OKX `/api/v5/public/time` | +60 ms | 80 ms |
| Bitget `/api/v2/public/time` | +59 ms | 70 ms |
| Pionex（`indexes?symbol=…` 的 `timestamp`） | +62.5 ms | 177 ms |

`sntp time.apple.com` 同時得到 `+0.056349 ± 0.057204` s，交叉驗證：本機時鐘落後約 56–60 ms。第 1 輪（冷連線，RTT 208–300 ms）估計值 120–162 ms，說明**不做 RTT 修正/熱連線時估計誤差可達 100 ms**。

官方文件：
- chrony（https://chrony-project.org/）：「Typical accuracy between two machines synchronised over the Internet is within a few milliseconds」
- Bybit（https://bybit-exchange.github.io/docs/v5/market/time）：`GET /v5/market/time`；並註明「During periods of extreme market volatility, this interface may experience increased latency or temporary delays in data delivery」
- OKX（https://www.okx.com/docs-v5/en/）：「Get system time Retrieve API server time.」

## 影響
- 目前 ~60 ms 偏差對「秒級」倒數影響小；但此專案目標是 T-30s 進 / T+30s 出，未來下單若要貼近結算（例如 T-1s 檢查費率），數百 ms 的偏差會讓「結算前/後」判斷錯邊。
- 筆電/熱點環境（本次即為手機熱點）NTP 可能不穩，沒有監測就無從得知。
- 與 BE-04 的「倒數凍結 5 s」疊加時，誤差由快取主導。

## Top 3 解方
### 1. 主機層 NTP（chrony）+ 啟動時健康檢查（推薦）
- 做法：部署主機跑 chrony；伺服器啟動與每 5 分鐘對交易所時間端點做一次 offset 估計，|offset| > 250 ms 時在 payload 加 `clock_warning` 並 log。
- 預期效益：主機時鐘誤差降到數 ms（依 chrony 文件）；異常可被看見。
- 取捨：需要主機權限；筆電開發環境不一定可控。
- 參考：https://chrony-project.org/ — 「`chrony` is a versatile implementation of the Network Time Protocol (NTP).」
### 2. 應用層 per-exchange offset（Cristian 法，取最小 RTT 樣本）
- 做法：對每所打 N 次時間端點，取 RTT 最小的樣本計算 `offset = server − (send+recv)/2`，之後所有該所相關的倒數都用 `Date.now() + offset[ex]`；每分鐘更新。
- 預期效益：本次實測可把 ~60 ms 偏差修正到 ±RTT/2（熱連線 ~35 ms 以內）。
- 取捨：需要額外請求（每所 N 次，皆為權重 1 的輕端點）。
- 參考：https://www.okx.com/docs-v5/en/ — 「Get system time Retrieve API server time. Rate Limit: 10 requests per 2 seconds Rate limit rule: IP」
### 3. 以交易所事件時間戳為準
- 做法：WS 訊息自帶事件時間（Binance `E`、Bybit `ts`、OKX `ts`），以其推算交易所「現在」並與本機比對；payload 中的倒數以交易所時間表示。
- 預期效益：資料年齡與倒數都以交易所時間衡量，不依賴本機時鐘。
- 取捨：需先完成 BE-04 的 WS 化。
- 參考：https://bybit-exchange.github.io/docs/v5/websocket/public/ticker — 「Derivatives & Options - 100ms」（高頻推播可作為時間參考）

## 驗收條件
- [ ] `/api/latency/ping`（或新端點）回傳每所 `clock_offset_ms` 與取樣 RTT
- [ ] `time_to_settlement_sec` 以修正後時間計算；人工調快本機時鐘 2 s 時，倒數誤差仍 < 200 ms
- [ ] |offset| > 250 ms 時 payload 帶 `clock_warning: true`
