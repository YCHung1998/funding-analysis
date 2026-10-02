## Context

- 規格書 v0.2 已定義 Trade 階層與狀態，但「事件迴圈怎麼跑、何時進出場」為 C-05 待決。探索（`/opsx:explore paper-trading-event-loop`）後使用者決議：D-1 單次結算、D-2 場次模型、D-3 失效規則、D-4 可設定窗口、D-5 兩層資料、D-6 公開資料推定入帳、D-7 只做 ≥2h、D-8 時鐘注入、E-1 平倉不等入帳、E-2 平倉緩衝 +15s。
- 現況：研究原型的引擎在瀏覽器、以 REST 輪詢 + 5s 快取（BE-04），倒數在快取中凍結；時間直接讀 `Date.now()`，本機時鐘比交易所慢 57–62 ms（BE-07）；兩腿結算時間從未比對（Q-02）；預測費率被當成確定收益（Q-04）。
- 限制：HANDOFF §3 Invariants（不下真實單、策略層無交易所分支、不假設 8h、費率存小數、Cancel ≠ Close）；規格書 §25 時間戳規則（每個狀態轉換產生 TradingEvent）。
- 本 change 只做**純邏輯 + 單元測試**；資料來源（WebSocket、Instrument Registry）與撮合都以介面 / 假資料替代。

## Goals / Non-Goals

**Goals:**

- 定義並實作可注入的時鐘，讓 Paper 與 Backtest 跑同一套程式。
- 以「結算場次」把所有決策錨定在 T，並把 v0.1 三級漏斗轉成階段關卡。
- 定出可驗證的結單規範：進場截止、持倉鎖定區間、安心平倉時間、入帳推定與損益定案。
- 用交易所規則表吸收各所差異（Binance / Bybit，預留 OKX）。

**Non-Goals:**

- WebSocket 資料層、Instrument Registry、成本模型、Paper 撮合、Position 引擎、Kill Switch（C-16）、hedge ratio 基準（C-19）。
- 跨期持倉、週期 < 2h 的合約。

## Decisions

### 1. 雙觸發來源 + 單一決策佇列

```
  MarketState（行情事件，WS 推播）──┐
                                   ├──▶ Decision Actor（所有事件排入同一佇列，依序處理）
  Clock（時鐘事件，相對 T 排程）───┘        │
                                            ├─ SessionManager（本 change）
                                            ├─ Opportunity 失效判斷（本 change）
                                            ├─ Funding 入帳推定（本 change）
                                            └─ Trade Manager / Risk / Execution（後續 change）
```

- **為什麼**：收益只在離散的 T 發生；行情決定「值不值得」，時鐘決定「能不能做」。所有會改變資金保留、場次、Trade 狀態的事件走同一佇列，消除競態；CPU 成本極低（BE review 實測聚合 13–22 ms），Node 單執行緒足夠。
- **替代方案**：純連續掃描 + 固定 TTL（草稿版）→ 無法表達「T 前 3 小時的機會不可交易」，被否決（D-2）。多執行緒 / 多 process 決策 → 需要跨執行緒鎖，複雜度不值得。

### 2. 時鐘介面（D-8）與「每所各自的時鐘」

```typescript
interface Clock {
  now(): number;                                        // 參考時間軸（預設 Binance），epoch ms
  exchangeNow(ex: ExchangeId): number;                  // 該交易所的時間
  toLocal(ex: ExchangeId, exchangeTime: number): number;// 交易所時間 → 本地排程時間
  offset(ex: ExchangeId): { offsetMs: number; errorMs: number; calibratedAt: number };
  reference(): ExchangeId;                              // 目前的參考交易所
  at(time: number, cb: () => void): TimerHandle;        // 以參考時間軸排程
  after(ms: number, cb: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}
```

- **核心原則**：每一腿的資金費資格由**該腿交易所自己的時鐘**決定（T 是「該交易所時間的 08:00:00」）。因此：
  - **參考時間軸**（顯示、紀錄、重播）：`reference_clock_priority`，預設 `['Binance', 'Bybit', 'OKX']`（使用者決議以 Binance 為主）；目前參考所斷線或校正過期時自動改用下一順位，每筆事件記錄 `clock_reference`、`clock_offset_ms`。
  - **決策截止時間**：各腿以自己的 offset 換算，配對取保守值（見 Decision 3）。與配對是否包含 Binance 無關。
- `RealClock`：本地單調時鐘（`process.hrtime`，不受系統校時跳動影響）+ 每所各自的 offset；offset 以查詢該所伺服器時間、取往返中點估算，誤差 `errorMs = RTT / 2`。
- **校正**：每 `clock_calibration_interval_ms`（預設 60 s）一次，SHORTLIST 與 ARM 開始時強制校正；offset 變動超過 `clock_jump_threshold_ms`（預設 100 ms）產生 `CLOCK_OFFSET_JUMP` 事件；任一交易腿 `errorMs > clock_max_error_ms`（預設 500 ms）或校正過期 → Pre-Trade Risk 阻擋新進場（`CLOCK_UNRELIABLE`）。
- **資料年齡**：`data_age_ms = local_received − toLocal(ex, exchange_timestamp)`，每所各自換算（技術書 §8、BE-07）。
- `VirtualClock`：`advanceTo(t)` 依序觸發排程；可設定每所的模擬 offset / 誤差，用於測試不同步情境。
- **規則**：`runtime/src/` 內除 `RealClock` 外禁止直接呼叫 `Date.now()` / `setTimeout`（以自動檢查把關）。
- **替代方案**：
  - 單一主時鐘（所有決策都用 Binance 時間）→ 配對不含 Binance 時，是用第三方時鐘量別人的截止時間；Binance 斷線時全部失準，否決。
  - 直接用本機系統時間（NTP）→ 無法量到與各所的實際偏差，否決。

### 3. 結算場次與階段時間表（D-2、D-4）

每個候選結算時刻 T 一個 `SettlementSession`。預設值（全部可設定，`PaperTradingConfig`）：

```
 T-30m        T-5m        T-60s   T-45s        T-25s   T-15s     T      T+15s  T+30s
   │            │           │       │            │       │       │        │      │
 WATCH ──▶ SHORTLIST ──▶ ARM ──▶ ENTRY ─────────────▶ LOCK ─────────────▶ CONFIRM/EXIT
                                    │  最後送單 ─┘       │  禁止減倉       │  平倉
                                    │                   └ 必須已 HEDGED    └ 不等入帳
```

| 時間點 | 計算方式 | Binance × Bybit 預設 |
|--------|---------|---------------------|
| `watch_start` | `T − watch_lead_ms` | T-30m |
| `shortlist_at` | `T − shortlist_lead_ms` | T-5m |
| `arm_at` | `T − arm_lead_ms`：重新讀取兩腿費率與週期、重算淨值、保留資金 | T-60s |
| `entry_open` | `T − entry_open_lead_ms` | T-45s |
| `entry_deadline`（最後送出新進場單） | `T − pair_guard_before − partial_hedge_max_duration − entry_buffer` | T − 15 − 5 − 5 = **T-25s** |
| `hedged_by`（LOCK 開始） | `T − pair_guard_before`；未達 HEDGED → LEG_IMBALANCE，立即緊急處理 | **T-15s** |
| `lock_end` | `T + pair_guard_after` | T+15s |
| `exit_at` | `T + pair_guard_after + exit_buffer`（E-2 預設 15s） | **T+30s** |

- `pair_guard_before/after = max(兩腿交易所的不確定區間)`。
- **換算成本地排程時間時各腿分別計算、取保守值**：
  `hedged_by_local = min over legs( toLocal(leg, T − guard_before_leg) − errorMs_leg )`；
  `lock_end_local = max over legs( toLocal(leg, T + guard_after_leg) + errorMs_leg )`；`exit_at = lock_end_local + exit_buffer`；`entry_deadline`、`entry_open`、`arm_at` 同理取最早。
- 場次階段：`WATCH → SHORTLIST → ARM → ENTRY → LOCK → CONFIRM → DONE`，另有 `SKIPPED`（無合格機會 / 被否決）。每次轉換產生 `SESSION_PHASE_CHANGED` 事件（規格書 §25）。
- **場次不重疊**：只交易 ≥ 2h 合約（D-7），且 WATCH 30 分鐘 < 2 小時，同一幣種的相鄰場次不會重疊；不同交易所的結算整點不同時（例：2h 合約在偶數整點、8h 在 00/08/16），全域持倉上限仍適用。
- **替代方案**：保留 v0.1 的「T-30m / T-5m / T-30s 輪詢」→ 輪詢語意與 WS 衝突，改為關卡。

### 4. 交易所結算規則表（由 Adapter 提供，策略層無分支）

| 交易所 | 不確定區間（前 / 後） | 依據 | 已結算費率來源（公開） | 週期來源 |
|--------|---------------------|------|----------------------|---------|
| Binance | 15s / 15s（官方只寫「15-second deviation」未說方向，保守取雙向） | Binance FAQ | `GET /fapi/v1/fundingRate`（含 `fundingTime`、`fundingRate`、`markPrice`） | `GET /fapi/v1/fundingInfo`，缺值 = 8h（Binance 文件定義的預設） |
| Bybit | 5s / 5s | Bybit Help「within 5 seconds before or after the funding time does not guarantee」 | `GET /v5/market/funding/history`（`fundingRate`、`fundingRateTimestamp`，無 mark price） | instruments-info `fundingInterval` / tickers |
| OKX（未來） | 0s / 60s | OKX Help「The actual fee assessment may take up to a minute」 | `settFundingRate` / funding-rate-history | `nextFundingTime − fundingTime` |

- 加入 OKX 後，含 OKX 的配對 `exit_at` 會變成 T+75s（60 + 15），由公式自動得出，不需改策略。

### 5. Opportunity 失效規則（D-3）

Opportunity 在下列任一條件成立時失效（`EXPIRED` 或 `REJECTED` 並附原因），取代固定 2 秒 TTL：

1. **換階段**：場次進入下一階段時，舊階段的評估結果作廢、須重新評估（例：SHORTLIST 的結果到 ARM 必須重算）。
2. **輸入變動超過容忍值**：任一腿費率變動 > `rate_change_tolerance`、價差變動 > `price_change_tolerance_pct`、盤口可成交量低於需求。
3. **資料過舊**：任一輸入的 `data_age_ms > data_stale_threshold_ms`。
4. **最長存活**：`now − detected_at > opportunity_max_age_ms`（安全上限）。
5. **資格改變**：ARM 時重新讀取週期，任一腿 < 2h（例如 Bybit / OKX 因費率觸頂自動改為每小時結算）或兩腿結算時間不再對齊 → `REJECTED`。

### 6. 結單規範：安心平倉 vs 正式入帳（D-1、D-6、E-1、E-2）

- **安心平倉（時間條件）**：只要兩腿在 `[T − guard_before, T + guard_after]` 全程持倉，這一期的收付權利就已確定，平倉時間早晚不改變結果。因此 `now ≥ exit_at` 即送出平倉單，**不等待入帳確認**——等待只增加持倉風險，不增加收益（現金為王）。
- **正式入帳（確認條件）**：`FundingSettlement` 狀態
  - `EXPECTED`：建立於 ARM（預測費率 × 預估名目）
  - `ELIGIBLE`：`lock_end` 時確認該腿全程持倉
  - `SETTLED`：公開端點出現 `fundingTime == T` 的已結算費率；金額 = 結算時 mark price × 持倉數量 × 已結算費率（Binance 用回傳的 `markPrice`；Bybit 用 MarketState 在 T 的 mark price 快照）
  - `NOT_ELIGIBLE`：鎖定區間內任一時刻未持倉（例如緊急平倉）
  - `MISSED`：超過 `settlement_confirm_timeout_ms`（預設 10 分鐘）仍查不到已結算費率 → 需人工檢查
- **損益定案**：Trade 在部位歸零時轉 `CLOSED`；`TradeResult.funding_confirmed = false` 直到兩腿皆 `SETTLED`（或 `NOT_ELIGIBLE`）才寫入 `finalized_at`。UI 顯示「已平倉 · 待入帳」→「已定案」，並標示「推定結算（依公開已結算費率）」。
- **量測**：每次記錄 `settled_rate_published_at − T`（已結算費率公布延遲），供日後調整逾時與進入 Live 前評估是否改為「等確認才平倉」。
- **替代方案**：E-1 B「等入帳確認才平倉」→ 防範交易所異常延遲，但拉長持倉，使用者否決。

### 7. 兩層資料取得（D-5，記錄於文件，實作屬 WebSocket 資料層 change）

- 全市場層（WATCH）：Binance 全市場推播；Bybit 批次 REST 每 N 秒；Pionex / Bitget / OKX 低頻 REST。
- 入圍層（SHORTLIST → CONFIRM）：只對入圍幣種訂閱逐筆 ticker 與盤口深度。
- 理由：公開 API 無使用費，主要成本是限流 / IP 封鎖（BE-03 實測 429）、頻寬（Binance 全市場約 3–7 GB/天）、CPU（Bybit 全訂閱約 7,000 則/秒）、維護。

### 8. 參考文件（使用者指定，收錄於 `docs/REFERENCES.md`）

| 交易所 | 文件 | 重點（已查證原文者附引述） |
|--------|------|--------------------------|
| Binance | [Introduction to Binance Futures Funding Rates](https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031) | 「Binance calculates the premium index every 5 seconds (12 premium index data points in a minute).」；時間加權平均 `(1·P1 + 2·P2 + … + n·Pn)/(1+2+…+n)`；`F = [P + clamp(I − P, 0.05%, −0.05%)] / (8/N)`；「There is a 15-second deviation in the actual funding fee transaction time.」 |
| Binance | [Binance Academy — What Are Funding Rates in Crypto Markets?](https://academy.binance.com/en/articles/what-are-funding-rates-in-crypto-markets) | 概念教學：利率 + 溢價指數；預設每日 0.03% 分 3 次 |
| OKX | [Perpetual funding fee mechanism](https://www.okx.com/en-us/help/iv-introduction-to-perpetual-swap-funding-fee) | 「the funding rate at 07:59 will be calculated using the premium index for every minute between 00:00 to 07:59. In other words, n = 480.」；「The funding rate used … will be the most recent funding rate that was calculated in the previous minute before fee assessment.」；「The actual fee assessment may take up to a minute.」；觸頂時結算頻率逐級提高 |
| Bybit | [Introduction to Funding Rate](https://www.bybit.com/en/help-center/article/Introduction-to-Funding-Rate) | 「The funding rate is not fixed and is updated every minute, according to the Interest Rate and Premium Index」；觸及上下限時「automatically switch the settlement frequency to once per hour」 |
| Bybit | [Funding Rate（Announcement Info）](https://www.bybit.com/en/announcement-info/fund-rate/) | 即時費率與規格；每分鐘更新、N 小時 TWAP（**頁面逾時，僅取得搜尋摘要，未逐字核對**） |
| Bybit | [Funding Fee Calculation](https://www.bybit.com/en/help-center/article/Funding-fee-calculation) | 「opening or closing a position within 5 seconds before or after the funding time does not guarantee whether the position will be included in that funding cycle」（本 change 規則表依據，額外收錄） |

- **對設計的含意**：各所費率都是結算前持續更新的時間加權預測值，越接近 T 越接近最終值（OKX 直接採用 T 前一分鐘的值）→ ARM（T-60s）重新讀取的費率可信度高，是最後的進場決策點。

## Risks / Trade-offs

- [交易所實際結算延遲超過官方誤差，T+30s 平倉錯過資金費] → 記錄每次已結算費率公布延遲與 `ELIGIBLE` 判定；Paper 期間若出現推定與實際不符的樣本，重新評估 E-1。
- [Binance 15 秒誤差方向不明，保守取雙向，使進場截止提早到 T-25s] → 犧牲少量進場時間換取確定性；數值可設定。
- [週期在 SHORTLIST 與 T 之間臨時改變（觸頂轉每小時）] → ARM 與 `hedged_by` 前各重讀一次週期；改變即放棄 / 緊急處理。
- [Bybit 已結算費率端點不含 mark price] → 使用 MarketState 在 T 的快照；快照缺失時 `SETTLED` 金額標為估計值。
- [虛擬時鐘與真實時鐘行為不一致（排程順序、同時到期）] → 兩者共用同一組契約測試；同時到期依排程註冊順序觸發。
- [建置順序] → 使用者已同意本 change 在 vitest 完成後即可進行（不依賴 Registry / 成本 / WS）。
- [交易所時鐘不同步或網路抖動造成截止時間誤判] → 每腿各自 offset + 誤差納入保守換算；誤差過大阻擋進場。

## Migration Plan

- 全部為新增檔案（`runtime/src/`）與文件修改，不改動研究原型行為。
- 在 `feature-paper-trading-event-loop` 開發，`--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`（技術書 §51）。

## Open Questions

1. 已結算費率在 T 之後多久公布（Binance / Bybit）？決定 `settlement_confirm_timeout_ms` 與「待入帳」顯示時間——下一次結算時實測。
2. ~~建置順序~~ ✅ 使用者同意：`setup-vitest` 完成後即可進行本 change（C-09 第 5 項中的純邏輯部分提前）。
3. ~~容忍值預設~~ ✅ 使用者同意 `rate_change_tolerance = 0.0002`、`price_change_tolerance_pct = 0.1%`，以 Paper 數據校準。
4. ~~主時鐘~~ ✅ 使用者同意以 Binance 為參考時間軸；決策截止時間改為每腿以自己的交易所時鐘換算（Decision 2、3），配對不含 Binance 時同樣成立。
