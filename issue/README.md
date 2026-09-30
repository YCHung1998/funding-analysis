# Issue 索引：量化正確性 × 效能 Review

- Review 日期：2026-09-30，基準 commit `95535ca`
- 角色：資深量化交易員（Q）＋ 後端效能工程師（BE）＋ 前端效能工程師（FE），三路平行審查
- 規則：未修改任何原始碼；每個 issue 附程式碼位置、實測數據、Top 3 解方與**實際打開並引述過**的參考來源；無法取得的來源標「未能取得」、無法確認的主張標「未查證」
- 修正時請遵守 [`../assets/HANDOFF.md`](../assets/HANDOFF.md) §3 規則與 §5 完成定義

## 1. 先讀這段：最嚴重的 5 件事

| # | Issue | 一句話 |
|---|-------|-------|
| 1 | [Q-01](Q-01-symbol-normalization-wrong-contract.md) | Pionex 的 22 個反向合約（如 `USDT_BTC_PERP`）與 `BTC_USDT_PERP` 被正規化成同一個 `BTC`，後處理者覆蓋前者；另有 33 個幣把價格差 >1.5 倍的不同合約（1000x、同名異幣）混在一起 |
| 2 | [Q-02](Q-02-settlement-schedule-misalignment.md) | 兩腿結算時間從未比對；Binance 469 個、Bitget 386 個合約其實是 4h。實測 61 組最佳配對兩腿結算相差 >60s，例如 CXMT 顯示 +1.50U、實際 −1.59U |
| 3 | [Q-03](Q-03-phantom-candidates-untradable-and-illiquid.md) | 12 組達門檻中有 7 組其中一腿費率為 0（下市中 / 股票永續）；89 筆候選的成交量是預設值 1,000 萬 |
| 4 | [BE-01](BE-01-live-scan-cache-stampede.md) + [BE-02](BE-02-silent-upstream-failure-masking.md) | 快取冷掉時 10 個併發請求 → 70 次上游呼叫；上游失敗被吞掉並以 `success:true` 快取殘缺資料（30 次併發中 5 次回 0 組、僅 1 次完整） |
| 5 | [Q-05](Q-05-slippage-double-count-and-liquidity-model.md) | 研究引擎把滑價算兩次（成交價已含滑價，淨利又再扣一次），回測結果系統性偏低 |

## 2. 全部 issue

### Q｜量化策略正確性（8）

| ID | 嚴重度 | 標題 | HANDOFF |
|----|-------|------|---------|
| [Q-01](Q-01-symbol-normalization-wrong-contract.md) | Critical | 符號正規化把不同合約併成同一幣（反向合約、1000x、同名異幣） | P6 / B5 |
| [Q-02](Q-02-settlement-schedule-misalignment.md) | Critical | 結算時程：兩腿不對齊、Bitget 無結算時間、週期寫死 8h | P1 P2 / B2 B3 |
| [Q-03](Q-03-phantom-candidates-untradable-and-illiquid.md) | High | 幻影機會：下市 / 股票永續 / 量缺值填 1,000 萬 | P3 / B4 |
| [Q-04](Q-04-forecast-rate-treated-as-locked.md) | High | 預測費率被當成確定收益；無 T-30s 複查與結算確認 | P5 P8 |
| [Q-05](Q-05-slippage-double-count-and-liquidity-model.md) | High | 滑價重複扣除；即時掃描用量能三級常數代替盤口 | P4 / B4 |
| [Q-07](Q-07-basis-and-price-risk-ignored.md) | High | 跨所價差 / 價格漂移未計入；資金費用名目本金而非持倉價值 | P7 |
| [Q-06](Q-06-fixed-fee-and-gross-spread-ranking.md) | Medium | 手續費一律 0.05%，以毛 spread 選對（Bybit×Bitget 實為 0.23%） | P9 / B9 |
| [Q-08](Q-08-dryrun-and-funnel-hardcoded.md) | Medium | Dry-run / Funnel 常數驅動；風控永遠 PASS；單腿失敗仍計資金費 | P7 P8 / B8 |

### BE｜後端 / 資料擷取效能（10）

| ID | 嚴重度 | 標題 |
|----|-------|------|
| [BE-01](BE-01-live-scan-cache-stampede.md) | Critical | 冷快取無 single-flight → cache stampede |
| [BE-02](BE-02-silent-upstream-failure-masking.md) | Critical | `.catch(() => [])` 吞錯並快取殘缺資料 |
| [BE-03](BE-03-rate-limit-budget-no-backoff.md) | High | 重量級端點、不讀限流標頭、不退避 → IP 封鎖風險（實測觸發 429） |
| [BE-04](BE-04-rest-polling-staleness-at-settlement.md) | High | REST 輪詢在 T-30s 新鮮度不足；倒數在快取內凍結 |
| [BE-05](BE-05-upstream-fetch-latency-connection-reuse.md) | High | 最慢上游閘住回應；keep-alive 4s < 快取 5s → 每次重新握手 |
| [BE-06](BE-06-latency-ping-measures-wrong-thing.md) | Medium | ping 量錯東西（429 當正常、Pionex 打 100 KB 端點） |
| [BE-07](BE-07-no-exchange-clock-sync.md) | Medium | 未與交易所時間同步（本機慢 57–62 ms） |
| [BE-08](BE-08-uncompressed-oversized-scan-payload.md) | Medium | 回應 686 KB 未壓縮（gzip 後 66 KB） |
| [BE-09](BE-09-klines-route-symbol-handling.md) | Low | klines 路由 symbol 未驗證 / 1000x 對應錯 / 無快取 |
| [BE-10](BE-10-dev-middleware-in-start-path.md) | Low | `npm start` 跑 Vite dev middleware；埠寫死；死碼 |

### FE｜前端效能（7）

| ID | 嚴重度 | 標題 |
|----|-------|------|
| [FE-01](FE-01-dryrun-polling-stale-closure-race.md) | High | Dry-Run 刷新 stale closure + 亂序回應 → 鎖定目標跳回舊幣 |
| [FE-02](FE-02-dryrun-full-scan-polling-cost.md) | High | 每 10 秒下載 686 KB 只取 1 筆；隱藏分頁不暫停 |
| [FE-03](FE-03-funnel-scanner-frozen-snapshot.md) | High | M3 掃描是一次性快照，倒數與「<30 分鐘」篩選用過期值 |
| [FE-04](FE-04-funnel-table-no-virtualization.md) | Medium | 顯示全部 803 列 / 2.8 萬元素，無虛擬化 |
| [FE-05](FE-05-kline-viewer-stale-symbol-bars.md) | Medium | K 棒檢視器切幣後仍顯示舊幣資料 |
| [FE-06](FE-06-no-tab-level-code-splitting.md) | Low | 無分頁級 `React.lazy`（實驗可降 29% 入口 gzip） |
| [FE-07](FE-07-cosmetic-timers-and-unstable-top-level-derivations.md) | Low | 假倒數計時器；App 頂層重算 mock（成本極低） |

### 同一根因、跨類別的 issue（修一個要一起看）

| 根因 | 相關 issue |
|------|-----------|
| 全量 JSON 輪詢架構 | BE-04、BE-08、FE-02、FE-03 |
| 結算時間 / 時鐘 | Q-02、BE-04、BE-07、FE-03 |
| 缺資料被當成正常值 | Q-03、BE-02、BE-06 |
| 符號對應 | Q-01、BE-09 |
| 成本模型 | Q-05、Q-06、Q-07 |

## 3. 全案 Top 3 優化方向

各 issue 內已有自己的 Top 3 解方；以下是跨 issue、效益最大的 3 個方向。建議執行順序：先補測試（HANDOFF B0）→ ① → ③ → ②（② 改動最大，放在結果可信之後）。

### ① 交易所商品註冊表（Instrument Registry）取代字串正規化
- **解決**：Q-01、Q-02、Q-03、BE-09（及 HANDOFF P1 P2 P6、B2 B3 B5）
- **做法**：啟動時與定期從各所 instrument / exchange-info 端點建立「交易所 × 合約」表，欄位含 base、quote、合約乘數、狀態（交易中 / 下市中）、資金費週期、下次結算時間；配對只在 `base + quote + 乘數正規化後` 相同、狀態為交易中、且兩腿結算時間差 ≤ 容忍值時成立。
- **業界依據**：各所官方文件都以 instrument 端點提供合約規格與資金費週期（Bybit instruments-info 見 Q-01；Binance fundingInfo、OKX `fundingTime` / `nextFundingTime` 差值見 Q-02）。

### ② 資料層改為「WebSocket 串流 + single-flight + stale-while-revalidate」
- **解決**：BE-01～BE-05、BE-08、FE-02、FE-03（及 BE-06、BE-07 的量測基礎）
- **做法**：伺服器常駐訂閱各所公開 WebSocket（實測 Bybit 約 100 ms 推送、Binance `!markPrice@arr` 744 個幣 0.4–2.4 s 一次）維護記憶體內快照；REST 只做啟動補齊與斷線回補，並用 single-flight 合併同時請求、`Promise.allSettled` 回報每一所的狀態、依限流標頭退避。前端改訂閱差量或只拉所需欄位，並開啟壓縮。
- **業界依據**：single-flight（Go `x/sync/singleflight`）、RFC 5861 stale-while-revalidate、各所官方 WebSocket 文件，引述見 BE-01、BE-04。

### ③ 成本 / PnL 模型改為「淨值口徑」並用測試鎖住
- **解決**：Q-04～Q-07、Q-08（及 HANDOFF P4 P5 P7 P8 P9、B8 B9）
- **做法**：移除重複扣除的滑價；手續費依各所設定；排序與門檻都用扣除成本後的淨 spread；資金費用 `mark price × 數量`；T-30s 重新取得費率、結算後以已結算費率確認；把跨所價差納入預期 PnL。每個公式先補單元測試（HANDOFF B0）再改。
- **業界依據**：Binance 官方 FAQ「Funding Amount = Nominal Value of Positions * Funding Rate」、OKX `fundingRate` 為預測值 / `settFundingRate` 為已結算值，引述見 Q-04、Q-07。

## 4. 已推翻或修正的既有假設（HANDOFF 需同步）

| 原假設 | 結論 |
|-------|------|
| P5：Binance `lastFundingRate` 與 Pionex `nextFundingRate` 語意不同 | **推翻**：兩者都是下次結算的即時預測值；真正的風險是「預測 vs 已結算」（Q-04） |
| P11：OKX `instId=ANY` 未查證 | **可結案**：實際呼叫 `instId=ANY` 回傳 717 筆（code 0）；agent 引述官方文件有記載，但文件頁由 JS 渲染，主審查者未能自行找到原文 |
| 1h/8h 費率需換算每小時 | **修正**：單次結算交易只要兩腿同時結算，直接比較單次費率即正確；換算每小時只在跨多次結算持倉時需要 |
| T-30s 進、T+30s 出 | Binance 官方寫明「There is a 15-second deviation in the actual funding fee transaction time」，T+30s 出場安全；其他 4 所**未查證** |
| live-scan 冷啟動 4.3 s | 重測為 0.52–1.27 s；4.3 s 可能來自一次 DNS 5 s 停頓（BE-05） |
| 前端 `App.tsx` 每次 render 重算很貴 | **推翻**：實測微秒級（FE-07 降為 Low） |
| aggregation CPU 是瓶頸 | **推翻**：非網路部分合計 13–22 ms |

## 5. 主審查者抽驗紀錄

以下由主審查者（非撰寫 issue 的 agent）獨立重做：

- Q-01：直接呼叫 Pionex `market/indexes`，確認有 22 個 `USDT_*_PERP` 反向合約，如 `USDT_BTC_PERP` rate −0.0000295 / mark 0.000012，並用 `extractBaseSymbol` 的邏輯確認會變成 `BTC`。
- Q-05：`arbitrageEngine.ts:122-128` 成交價已含滑價、`:200` 又扣 `totalSlippage`，確認。
- FE-01：`DryRunConsole.tsx:67-79` effect 只依賴 `symbol`、在 `setCountdown` updater 內觸發 fetch，確認。
- 參考抽驗：Binance 資金費 FAQ 的 3 段引述（15 秒偏差、只有持倉才計費、Funding Amount 公式）與 Go singleflight 文件引述逐字相符；OKX `instId=ANY` 以實際呼叫確認。

## 6. 仍未查證 / 未能取得

- Binance、Bybit、Pionex VIP0 手續費來自第三方來源（官方頁需登入或逾時）——Q-06
- Bitget v2 文件、Binance 各端點 weight 頁、`!markPrice@arr` 頁為 JS 渲染，改以實測或舊版文件代替——BE-03、BE-04、Q-02
- 結算後瞬間價格波動幅度——Q-07
- 各檔中標示「未查證」的項目共 22 處，可用 `grep -n "未查證\|未能取得" issue/*.md` 列出
