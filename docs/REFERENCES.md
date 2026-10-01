# REFERENCES 資金費率機制官方文件

> 交易所官方文件索引，供規格書 §19（Funding Eligibility）、技術書 §23（Funding Engine）與 `runtime/src/venue/`（交易所結算規則表）引用。
> 查證日期：2026-09-30（來源：OpenSpec change `paper-trading-event-loop` design §8）。標示「未逐字核對」者使用前須重新確認原文。
> 交易所文件會更新：引用前先打開連結確認內容未變，變更時更新本表與查證日期。

| 交易所 | 文件 | 重點（已查證原文者附引述） |
|--------|------|--------------------------|
| Binance | [Introduction to Binance Futures Funding Rates](https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031) | 「Binance calculates the premium index every 5 seconds (12 premium index data points in a minute).」；時間加權平均 `(1·P1 + 2·P2 + … + n·Pn)/(1+2+…+n)`；`F = [P + clamp(I − P, 0.05%, −0.05%)] / (8/N)`；「There is a 15-second deviation in the actual funding fee transaction time.」 |
| Binance | [Binance Academy — What Are Funding Rates in Crypto Markets?](https://academy.binance.com/en/articles/what-are-funding-rates-in-crypto-markets) | 概念教學：利率 + 溢價指數；預設每日 0.03% 分 3 次 |
| OKX | [Perpetual funding fee mechanism](https://www.okx.com/en-us/help/iv-introduction-to-perpetual-swap-funding-fee) | 「the funding rate at 07:59 will be calculated using the premium index for every minute between 00:00 to 07:59. In other words, n = 480.」；「The funding rate used … will be the most recent funding rate that was calculated in the previous minute before fee assessment.」；「The actual fee assessment may take up to a minute.」；觸頂時結算頻率逐級提高 |
| Bybit | [Introduction to Funding Rate](https://www.bybit.com/en/help-center/article/Introduction-to-Funding-Rate) | 「The funding rate is not fixed and is updated every minute, according to the Interest Rate and Premium Index」；觸及上下限時「automatically switch the settlement frequency to once per hour」 |
| Bybit | [Funding Rate（Announcement Info）](https://www.bybit.com/en/announcement-info/fund-rate/) | 即時費率與規格；每分鐘更新、N 小時 TWAP（**頁面逾時，僅取得搜尋摘要，未逐字核對**） |
| Bybit | [Funding Fee Calculation](https://www.bybit.com/en/help-center/article/Funding-fee-calculation) | 「opening or closing a position within 5 seconds before or after the funding time does not guarantee whether the position will be included in that funding cycle」（本 change 規則表依據，額外收錄） |

- **對設計的含意**：各所費率都是結算前持續更新的時間加權預測值，越接近 T 越接近最終值（OKX 直接採用 T 前一分鐘的值）→ ARM（T-60s）重新讀取的費率可信度高，是最後的進場決策點。
