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

## 手續費率（Fee Schedule）

> 查證日期：2026-10-03（來源：使用者提供，未逐字核對原始費率頁面，僅記錄使用者提供的數值與連結）。使用前請重新開啟官方頁面確認費率未變、VIP 等級與本表一致。

| 交易所 | 會員等級 | 現貨 Maker | 現貨 Taker | USDT 永續合約 Maker | USDT 永續合約 Taker | 平台幣 / 費率折扣備註 | 官方費率說明頁面 |
|--------|----------|-----------|-----------|---------------------|---------------------|----------------------|------------------|
| Binance（幣安） | VIP 0 | 0.1000% | 0.1000% | 0.0200% | 0.0500% | 使用 BNB 支付合約手續費享 10% 折扣（0.018%/0.045%） | [Binance Fee Schedule](https://www.binance.com/en/fee/schedule) |
| Bybit | Non-VIP | 0.1000% | 0.1000% | 0.0200% | 0.0550% | 無平台幣費率折抵，以 30 天交易量/資產額升級 VIP | [Bybit Fee Structure](https://www.bybit.com/en/rates/) |
| OKX（歐易） | 普通用戶（Lv 1） | 0.0800% | 0.1000% | 0.0200% | 0.0500% | 持有 OKB 達標可額外享現貨/合約等級折扣 | [OKX Trading Fees](https://www.okx.com/fees) |
| Bitget | VIP 0 | 0.1000% | 0.1000% | 0.0200% | 0.0600% | 使用 BGB 支付現貨手續費享 20% 折扣 | [Bitget Fee Schedule](https://www.bitget.com/fee) |
| Pionex（派網） | 普通用戶 | 0.0500% | 0.0500% | 0.0200% | 0.0500% | 現貨預設採 0.05% 低費率 | [Pionex Fee Structure](https://www.pionex.com/fees) |

- **對設計的含意**：這份表可用來核對 `runtime/src/accounting/feeConfig.ts` 的 `DEFAULT_FEE_TABLE` 是否與官方一致（待辦清單中「`DEFAULT_FEE_TABLE` 未經官方驗證」的對照來源之一）；尚未逐字比對原始頁面內容，且平台幣折扣（BNB/OKB/BGB）屬於可選折扣而非預設費率，套用前需確認帳戶是否實際開啟折扣選項。
